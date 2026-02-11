from __future__ import annotations

import json
import os
import re
from dataclasses import asdict
from typing import Any, Dict, Literal, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from mes_hft_halsey.mes_intraday_halsey import (
    TIMEFRAME_ORDER,
    HalseySignal,
    detect_halsey_signals,
    fetch_mes_databento,
    fetch_vix_fred,
    resample_mes,
    run_multi_timeframe_analysis,
    summarize_timeframe,
)

try:
    from fredapi import Fred
except Exception:  # pragma: no cover
    Fred = None

try:
    import yfinance as yf
except Exception:  # pragma: no cover
    yf = None

try:
    from sklearn.linear_model import LinearRegression
    from sklearn.metrics import mean_squared_error
    from sklearn.model_selection import train_test_split
    from sklearn.neural_network import MLPRegressor
except Exception:  # pragma: no cover
    LinearRegression = None
    mean_squared_error = None
    train_test_split = None
    MLPRegressor = None

try:
    from anthropic import Anthropic
except Exception:  # pragma: no cover
    Anthropic = None

try:
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None


Timeframe = Literal["5m", "15m", "1h", "4h", "1d"]
ModelMode = Literal["opus", "gpt", "quant"]

app = FastAPI(
    title="MES HFT Halsey API",
    description="Databento + FRED + Yahoo intraday measured-move API",
    version="1.2.0",
)

cors = [
    origin.strip()
    for origin in os.getenv(
        "MES_HFT_CORS_ORIGINS",
        "https://rabid-raccoon.vercel.app,http://localhost:3000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Environment variable {name} is required")
    return value


def _require_package(pkg: object, label: str) -> None:
    if pkg is None:
        raise RuntimeError(f"Missing optional dependency '{label}'")


def _safe_corr(a: pd.Series, b: pd.Series) -> float:
    ax = pd.to_numeric(a, errors="coerce")
    bx = pd.to_numeric(b, errors="coerce")
    mask = ax.notna() & bx.notna()
    if mask.sum() < 3:
        return 0.0
    axv = ax[mask].to_numpy(dtype=float)
    bxv = bx[mask].to_numpy(dtype=float)
    if np.std(axv) == 0 or np.std(bxv) == 0:
        return 0.0
    return float(np.corrcoef(axv, bxv)[0, 1])


def _index_to_session_date(index: pd.Index) -> pd.DatetimeIndex:
    dt = pd.to_datetime(index, errors="coerce")
    if not isinstance(dt, pd.DatetimeIndex):
        dt = pd.DatetimeIndex(dt)

    if dt.tz is not None:
        dt = dt.tz_convert("UTC").tz_localize(None)

    return dt.normalize()


def _get_fred_client() -> "Fred":
    _require_package(Fred, "fredapi")
    key = _require_env("FRED_API_KEY")
    return Fred(api_key=key)


def _fetch_fred_feature(
    fred: "Fred",
    series_code: str,
    index: pd.DatetimeIndex,
) -> pd.Series:
    start = (index.min() - pd.Timedelta(days=30)).date().isoformat()
    end = (index.max() + pd.Timedelta(days=2)).date().isoformat()

    raw = fred.get_series(series_code, observation_start=start, observation_end=end)
    s = pd.Series(raw).dropna()
    if s.empty:
        return pd.Series(index=index, dtype=float)

    s.index = _index_to_session_date(s.index)
    s = s[~s.index.duplicated(keep="last")].sort_index().astype(float)
    return s.reindex(index, method="ffill")


def _fetch_yahoo_close_feature(
    ticker: str,
    index: pd.DatetimeIndex,
    period: str = "6mo",
) -> pd.Series:
    _require_package(yf, "yfinance")

    df = yf.download(
        ticker,
        period=period,
        interval="1d",
        progress=False,
        auto_adjust=False,
        threads=False,
    )
    if df is None or df.empty:
        return pd.Series(index=index, dtype=float)

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]

    close_col = None
    for c in df.columns:
        if str(c).lower() == "close":
            close_col = c
            break
    if close_col is None:
        return pd.Series(index=index, dtype=float)

    close = pd.Series(df[close_col]).dropna()
    close.index = _index_to_session_date(close.index)
    close = close[~close.index.duplicated(keep="last")].sort_index().astype(float)
    return close.reindex(index, method="ffill")


def _latest_signal(signals: list[HalseySignal], direction: Optional[str] = None) -> Optional[HalseySignal]:
    if direction is None:
        enabled = [s for s in signals if s.enabled]
    else:
        enabled = [s for s in signals if s.enabled and s.direction == direction]
    if enabled:
        return enabled[-1]
    return signals[-1] if signals else None


def _fit_linear_model(X: pd.DataFrame, y: pd.Series) -> Tuple[np.ndarray, float, float]:
    """Returns (coefficients, intercept, pred_for_last_row)."""
    Xn = X.to_numpy(dtype=float)
    yn = y.to_numpy(dtype=float)

    if LinearRegression is not None:
        model = LinearRegression()
        model.fit(Xn, yn)
        pred_last = float(model.predict(Xn[-1:])[0])
        return model.coef_.astype(float), float(model.intercept_), pred_last

    # Numpy fallback if sklearn is missing.
    Xd = np.c_[np.ones(len(Xn)), Xn]
    beta, *_ = np.linalg.lstsq(Xd, yn, rcond=None)
    intercept = float(beta[0])
    coefs = beta[1:].astype(float)
    pred_last = float(intercept + np.dot(Xn[-1], coefs))
    return coefs, intercept, pred_last


def _fit_nn_stub(X: pd.DataFrame, y: pd.Series) -> Dict[str, Optional[float]]:
    if MLPRegressor is None or train_test_split is None or mean_squared_error is None:
        return {
            "available": False,
            "corr_with_actual": None,
            "mse": None,
        }

    if len(X) < 40:
        return {
            "available": False,
            "corr_with_actual": None,
            "mse": None,
        }

    X_train, X_test, y_train, y_test = train_test_split(
        X,
        y,
        test_size=0.2,
        random_state=42,
        shuffle=False,
    )

    nn = MLPRegressor(hidden_layer_sizes=(16, 8), max_iter=700, random_state=42)
    nn.fit(X_train, y_train)

    preds = nn.predict(X_test)
    mse = float(mean_squared_error(y_test, preds))
    corr = _safe_corr(pd.Series(preds, index=y_test.index), pd.Series(y_test, index=y_test.index))

    return {
        "available": True,
        "corr_with_actual": round(corr, 4),
        "mse": round(mse, 8),
    }


def _series_tail_dict(series: pd.Series, n: int = 12, precision: int = 4) -> Dict[str, float]:
    tail = pd.Series(series).dropna().tail(n)
    out: Dict[str, float] = {}
    for idx, value in tail.items():
        ts = pd.Timestamp(idx)
        out[ts.strftime("%Y-%m-%d")] = round(float(value), precision)
    return out


def _halsey_signal_dict(signal: Optional[HalseySignal]) -> Optional[Dict[str, Any]]:
    if signal is None:
        return None
    data = asdict(signal)
    keep = {
        "timeframe",
        "timestamp",
        "direction",
        "entry",
        "stop",
        "target_100",
        "target_1236",
        "retrace_pct",
        "risk_reward_100",
        "enabled",
    }
    return {k: data[k] for k in keep if k in data}


def _unique(values: Sequence[str]) -> list[str]:
    out: list[str] = []
    for value in values:
        v = (value or "").strip()
        if not v or v in out:
            continue
        out.append(v)
    return out


def _extract_json_object(text: str) -> Dict[str, Any]:
    cleaned = text.strip()

    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)

    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{[\s\S]*\}", cleaned)
    if not match:
        raise ValueError("LLM did not return JSON object")

    parsed = json.loads(match.group(0))
    if not isinstance(parsed, dict):
        raise ValueError("LLM JSON payload is not an object")
    return parsed


def _normalize_mode(model: str) -> ModelMode:
    m = model.strip().lower()
    if m in {"opus", "claude", "anthropic"}:
        return "opus"
    if m in {"gpt", "openai", "gpt5", "gpt-5"}:
        return "gpt"
    if m in {"quant", "numeric", "baseline", "off"}:
        return "quant"
    raise ValueError("Invalid model: choose 'opus', 'gpt', or 'quant'")


def _call_opus(prompt: str) -> Tuple[str, str]:
    _require_package(Anthropic, "anthropic")
    api_key = _require_env("ANTHROPIC_API_KEY")

    env_model = os.getenv("MES_LLM_OPUS_MODEL", "")
    candidates = _unique(
        [
            env_model,
            "claude-opus-4-6",
            "claude-opus-4-1",
        ]
    )

    client = Anthropic(api_key=api_key)
    last_error: Optional[Exception] = None

    for model in candidates:
        try:
            response = client.messages.create(
                model=model,
                max_tokens=1400,
                temperature=0,
                messages=[{"role": "user", "content": prompt}],
            )

            chunks: list[str] = []
            for block in getattr(response, "content", []):
                if getattr(block, "type", "") == "text":
                    text = getattr(block, "text", "")
                    if text:
                        chunks.append(text)

            text = "\n".join(chunks).strip()
            if not text:
                raise RuntimeError(f"Anthropic returned empty output for model {model}")

            return text, model
        except Exception as exc:  # pragma: no cover
            last_error = exc
            msg = str(exc)
            is_model_issue = bool(re.search(r"model|not found|access|permission|invalid", msg, re.I))
            if not is_model_issue:
                raise

    raise RuntimeError(f"Anthropic request failed for all models: {last_error}")


def _call_gpt(prompt: str) -> Tuple[str, str]:
    _require_package(OpenAI, "openai")
    api_key = _require_env("OPENAI_API_KEY")

    env_model = os.getenv("MES_LLM_GPT_MODEL", "")
    analysis_env = os.getenv("OPENAI_ANALYSIS_MODEL", "")
    candidates = _unique(
        [
            env_model,
            analysis_env,
            "gpt-5.2-pro",
            "gpt-5-pro",
            "gpt-5.2",
            "gpt-5.1",
            "gpt-5",
        ]
    )

    client = OpenAI(api_key=api_key)
    last_error: Optional[Exception] = None

    for model in candidates:
        try:
            text = ""

            if hasattr(client, "responses"):
                resp = client.responses.create(
                    model=model,
                    input=prompt,
                    max_output_tokens=1400,
                )
                text = (getattr(resp, "output_text", None) or "").strip()

                if not text:
                    parts: list[str] = []
                    for item in getattr(resp, "output", []) or []:
                        for content in getattr(item, "content", []) or []:
                            ctype = getattr(content, "type", "")
                            if ctype in {"output_text", "text"}:
                                ctext = getattr(content, "text", "")
                                if ctext:
                                    parts.append(str(ctext))
                    text = "\n".join(parts).strip()
            else:
                chat = client.chat.completions.create(
                    model=model,
                    messages=[
                        {"role": "system", "content": "You are a quantitative futures strategist."},
                        {"role": "user", "content": prompt},
                    ],
                    max_tokens=1400,
                )
                text = (chat.choices[0].message.content or "").strip()

            if not text:
                raise RuntimeError(f"OpenAI returned empty output for model {model}")

            return text, model
        except Exception as exc:  # pragma: no cover
            last_error = exc
            msg = str(exc)
            is_model_issue = bool(re.search(r"model|not found|access|permission|unsupported|invalid", msg, re.I))
            if not is_model_issue:
                raise

    raise RuntimeError(f"OpenAI request failed for all models: {last_error}")


def _normalize_llm_payload(raw: Dict[str, Any], quant: Dict[str, Any]) -> Dict[str, Any]:
    horizons = ("1_week", "1_month", "1_quarter", "6_year")

    raw_forecasts = raw.get("forecasts") if isinstance(raw.get("forecasts"), dict) else {}
    normalized_forecasts: Dict[str, str] = {}
    for h in horizons:
        val = raw_forecasts.get(h)
        if isinstance(val, (int, float)):
            normalized_forecasts[h] = f"{float(val):+.2f}%"
        elif isinstance(val, str) and val.strip():
            normalized_forecasts[h] = val.strip()
        else:
            normalized_forecasts[h] = quant["forecasts"][h]

    raw_corr = raw.get("correlations") if isinstance(raw.get("correlations"), dict) else {}
    normalized_corr = {}
    for key, fallback in quant["correlations"].items():
        value = raw_corr.get(key, fallback)
        try:
            normalized_corr[key] = round(float(value), 4)
        except Exception:
            normalized_corr[key] = fallback

    raw_sharpe = raw.get("sharpe", quant["sharpe"])
    try:
        sharpe = round(float(raw_sharpe), 4)
    except Exception:
        sharpe = quant["sharpe"]

    raw_shap = raw.get("shap") if isinstance(raw.get("shap"), dict) else {}
    if not raw_shap:
        raw_shap = raw.get("shap_proxy") if isinstance(raw.get("shap_proxy"), dict) else {}
    normalized_shap = {}
    for key, fallback in quant["shap_proxy"].items():
        value = raw_shap.get(key, fallback)
        try:
            normalized_shap[key] = round(float(value), 6)
        except Exception:
            normalized_shap[key] = fallback

    new_corrs = raw.get("new_corrs") or raw.get("new_correlations") or raw.get("new_corrs_description")
    if not isinstance(new_corrs, str) or not new_corrs.strip():
        new_corrs = "No additional statistically stable correlation beyond baseline feature set."

    return {
        "forecasts": normalized_forecasts,
        "correlations": normalized_corr,
        "sharpe": sharpe,
        "shap": normalized_shap,
        "new_corrs": new_corrs.strip(),
    }


def _build_llm_prompt(
    mode: ModelMode,
    quant: Dict[str, Any],
    confluence: Dict[str, Any],
) -> str:
    model_label = "Claude Opus" if mode == "opus" else "GPT-5"

    context = {
        "latest_mes_close": quant["latest_mes_close"],
        "vix_level": quant["vix_level"],
        "mm_adjust_points_1d_4h": quant["mm_adjust_1d_4h_points"],
        "mm_adjust_return_1d_4h": quant["mm_adjust_1d_4h_return"],
        "mes_recent_closes": quant.get("context", {}).get("mes_recent_closes", {}),
        "vix_recent": quant.get("context", {}).get("vix_recent", {}),
        "fed_rates_recent": quant.get("context", {}).get("fed_rates_recent", {}),
        "usd_index_recent": quant.get("context", {}).get("usd_index_recent", {}),
        "china_fxi_recent": quant.get("context", {}).get("china_fxi_recent", {}),
        "halsey_mm_1d_latest": quant.get("context", {}).get("mm_signal_1d_latest"),
        "halsey_mm_4h_latest": quant.get("context", {}).get("mm_signal_4h_latest"),
        "quant_baseline": {
            "forecasts": quant["forecasts"],
            "correlations": quant["correlations"],
            "sharpe": quant["sharpe"],
            "shap_proxy": quant["shap_proxy"],
        },
        "confluence": {
            "bias": confluence["confluence"]["bias"],
            "score": confluence["confluence"]["score"],
            "vix_regime": confluence["vix_regime"],
            "timeframe_summaries": confluence["timeframe_summaries"],
        },
    }

    return (
        f"You are {model_label}, acting as a quantitative futures strategist.\n"
        "Task: produce MES forecast outputs from the supplied numeric data only.\n"
        "Hard rules:\n"
        "- Use measured-move context as the short-term anchor.\n"
        "- Keep correlations numerically plausible.\n"
        "- Return JSON only (no markdown, no commentary).\n"
        "- JSON schema:\n"
        "{\n"
        "  \"forecasts\": {\"1_week\": \"+X.XX%\", \"1_month\": \"+X.XX%\", \"1_quarter\": \"+X.XX%\", \"6_year\": \"+X.XX%\"},\n"
        "  \"correlations\": {\"vix\": number, \"fed_rates\": number, \"usd_fx\": number, \"china\": number},\n"
        "  \"sharpe\": number,\n"
        "  \"shap\": {\"vix\": number, \"fed_rates\": number, \"usd_index\": number, \"china_fxi\": number},\n"
        "  \"new_corrs\": \"short description\"\n"
        "}\n"
        f"Data context:\n{json.dumps(context, indent=2)}"
    )


def _build_forecast_payload(days_back: int = 90) -> Dict[str, Any]:
    raw_1m = fetch_mes_databento(days_back=days_back)
    mes_daily = resample_mes(raw_1m, "1d")
    if mes_daily.empty or len(mes_daily) < 25:
        raise RuntimeError("Insufficient MES daily data for forecast model")

    mes_daily = mes_daily.copy()
    mes_daily.index = _index_to_session_date(mes_daily.index)
    mes_daily = mes_daily[~mes_daily.index.duplicated(keep="last")].sort_index()

    fred = _get_fred_client()

    vix_series = _fetch_fred_feature(fred, "VIXCLS", mes_daily.index)
    fed_funds = _fetch_fred_feature(fred, "FEDFUNDS", mes_daily.index)
    usd_index = _fetch_fred_feature(fred, "DTWEXBGS", mes_daily.index)
    china_fxi = _fetch_yahoo_close_feature("FXI", mes_daily.index)

    features = pd.DataFrame(
        {
            "vix": vix_series,
            "fed_rates": fed_funds,
            "usd_index": usd_index,
            "china_fxi": china_fxi,
        },
        index=mes_daily.index,
    )

    target = mes_daily["close"].pct_change().shift(-1).rename("target")
    joined = features.join(target, how="inner").dropna()
    if joined.empty or len(joined) < 20:
        raise RuntimeError("Insufficient aligned feature rows for regression")

    X = joined[["vix", "fed_rates", "usd_index", "china_fxi"]]
    y = joined["target"]

    coefs, intercept, base_pred_1d = _fit_linear_model(X, y)

    shap_proxy = {col: round(float(val), 6) for col, val in zip(X.columns, coefs)}

    correlations = {
        "vix": round(_safe_corr(X["vix"], y), 4),
        "fed_rates": round(_safe_corr(X["fed_rates"], y), 4),
        "usd_fx": round(_safe_corr(X["usd_index"], y), 4),
        "china": round(_safe_corr(X["china_fxi"], y), 4),
    }

    current_vix = fetch_vix_fred()

    signals_1d = detect_halsey_signals(resample_mes(raw_1m, "1d"), "1d", current_vix)
    signals_4h = detect_halsey_signals(resample_mes(raw_1m, "4h"), "4h", current_vix)

    latest_close = float(mes_daily["close"].iloc[-1])
    mm_adjust_points = 0.0

    s1d = _latest_signal(signals_1d)
    if s1d is not None:
        mm_adjust_points += (s1d.target_1236 - latest_close) * 0.65

    s4h = _latest_signal(signals_4h)
    if s4h is not None:
        mm_adjust_points += (s4h.target_1236 - latest_close) * 0.35

    mm_adjust_return = (mm_adjust_points / latest_close) if latest_close > 0 else 0.0

    horizon_days = {
        "1_week": 5,
        "1_month": 21,
        "1_quarter": 63,
        "6_year": 1512,
    }
    mm_decay = {
        "1_week": 1.0,
        "1_month": 0.60,
        "1_quarter": 0.30,
        "6_year": 0.05,
    }

    forecast_numeric: Dict[str, float] = {}
    forecast_label: Dict[str, str] = {}

    for horizon, days in horizon_days.items():
        projected = (base_pred_1d * days) + (mm_adjust_return * mm_decay[horizon])
        pct = float(projected * 100)
        forecast_numeric[horizon] = round(pct, 3)
        forecast_label[horizon] = f"{pct:+.2f}%"

    hist_returns = mes_daily["close"].pct_change().dropna()
    if hist_returns.std(ddof=0) > 0:
        sharpe = float(hist_returns.mean() / hist_returns.std(ddof=0) * np.sqrt(252))
    else:
        sharpe = 0.0

    nn_stub = _fit_nn_stub(X, y)

    return {
        "forecasts": forecast_label,
        "forecast_numeric_pct": forecast_numeric,
        "sharpe": round(sharpe, 4),
        "correlations": correlations,
        "shap_proxy": shap_proxy,
        "linear_model": {
            "intercept": round(float(intercept), 8),
            "base_pred_1d": round(float(base_pred_1d), 8),
            "samples": int(len(X)),
        },
        "nn_new_corr_example": nn_stub.get("corr_with_actual"),
        "nn_mse": nn_stub.get("mse"),
        "nn_available": nn_stub.get("available", False),
        "mm_adjust_1d_4h_points": round(float(mm_adjust_points), 4),
        "mm_adjust_1d_4h_return": round(float(mm_adjust_return), 8),
        "vix_level": round(float(current_vix), 4),
        "latest_mes_close": round(float(latest_close), 4),
        "features_last_row": {c: round(float(X.iloc[-1][c]), 6) for c in X.columns},
        "context": {
            "mes_recent_closes": _series_tail_dict(mes_daily["close"], n=12, precision=2),
            "vix_recent": _series_tail_dict(vix_series, n=8, precision=3),
            "fed_rates_recent": _series_tail_dict(fed_funds, n=8, precision=3),
            "usd_index_recent": _series_tail_dict(usd_index, n=8, precision=3),
            "china_fxi_recent": _series_tail_dict(china_fxi, n=8, precision=3),
            "mm_signal_1d_latest": _halsey_signal_dict(s1d),
            "mm_signal_4h_latest": _halsey_signal_dict(s4h),
        },
    }


def _mes_signals_impl(
    timeframe: Timeframe,
    days_back: int,
    swing_order: int,
    min_rr: float,
    latest: int,
    require_volume_confirmation: bool,
) -> Dict[str, Any]:
    raw = fetch_mes_databento(days_back=days_back)
    vix = fetch_vix_fred()
    tf_df = resample_mes(raw, timeframe)
    signals = detect_halsey_signals(
        tf_df,
        timeframe,
        vix,
        order=swing_order,
        min_rr=min_rr,
        require_volume_confirmation=require_volume_confirmation,
    )
    summary = summarize_timeframe(signals, timeframe)

    return {
        "timeframe": timeframe,
        "vix_level": vix,
        "summary": asdict(summary),
        "signals": [asdict(s) for s in signals[-latest:]],
    }


def _mes_forecast_impl(mode: ModelMode, days_back: int) -> Dict[str, Any]:
    quant = _build_forecast_payload(days_back=days_back)
    confluence = run_multi_timeframe_analysis(days_back=max(30, min(days_back, 120)))

    base_payload: Dict[str, Any] = {
        **quant,
        "generated_at": confluence["generated_at"],
        "vix_regime": confluence["vix_regime"],
        "timeframe_summaries": confluence["timeframe_summaries"],
        "confluence": confluence["confluence"],
        "signals_count": len(confluence["signals"]),
        "timeframes": list(TIMEFRAME_ORDER),
        "llm_metadata": {
            "mode": mode,
            "fallback_used": mode == "quant",
            "provider": None,
            "requested_model": mode,
            "resolved_model": None,
            "error": None,
        },
    }

    if mode == "quant":
        base_payload["shap"] = quant["shap_proxy"]
        base_payload["new_corrs"] = "Quant baseline mode enabled; LLM override skipped."
        return base_payload

    prompt = _build_llm_prompt(mode, quant, confluence)

    try:
        if mode == "opus":
            text, resolved_model = _call_opus(prompt)
            provider = "anthropic"
        else:
            text, resolved_model = _call_gpt(prompt)
            provider = "openai"

        parsed = _extract_json_object(text)
        normalized = _normalize_llm_payload(parsed, quant)

        base_payload.update(
            {
                "forecasts": normalized["forecasts"],
                "correlations": normalized["correlations"],
                "sharpe": normalized["sharpe"],
                "shap": normalized["shap"],
                "shap_proxy": normalized["shap"],
                "new_corrs": normalized["new_corrs"],
                "llm_metadata": {
                    "mode": mode,
                    "fallback_used": False,
                    "provider": provider,
                    "requested_model": mode,
                    "resolved_model": resolved_model,
                    "error": None,
                },
                "baseline_quant": {
                    "forecasts": quant["forecasts"],
                    "correlations": quant["correlations"],
                    "sharpe": quant["sharpe"],
                    "shap_proxy": quant["shap_proxy"],
                },
            }
        )
        return base_payload
    except Exception as exc:  # pragma: no cover
        base_payload.update(
            {
                "shap": quant["shap_proxy"],
                "new_corrs": "LLM call failed; using quantitative baseline.",
                "llm_metadata": {
                    "mode": mode,
                    "fallback_used": True,
                    "provider": "anthropic" if mode == "opus" else "openai",
                    "requested_model": mode,
                    "resolved_model": None,
                    "error": str(exc),
                },
            }
        )
        return base_payload


@app.get("/health")
def health() -> Dict[str, bool]:
    return {"ok": True}


@app.get("/mes/signals")
def mes_signals(
    timeframe: Timeframe = Query(default="15m"),
    days_back: int = Query(default=20, ge=1, le=180),
    swing_order: int = Query(default=5, ge=2, le=20),
    min_rr: float = Query(default=2.0, ge=0.5, le=20.0),
    latest: int = Query(default=20, ge=1, le=200),
    require_volume_confirmation: bool = Query(default=False),
) -> Dict[str, Any]:
    try:
        return _mes_signals_impl(
            timeframe=timeframe,
            days_back=days_back,
            swing_order=swing_order,
            min_rr=min_rr,
            latest=latest,
            require_volume_confirmation=require_volume_confirmation,
        )
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/mes_forecast")
def mes_forecast_compat(
    model: str = Query(
        default="opus",
        description="Forecast mode: opus (Claude), gpt (OpenAI GPT-5.x), or quant baseline",
    ),
    days_back: int = Query(default=90, ge=20, le=365),
) -> Dict[str, Any]:
    try:
        mode = _normalize_mode(model)
        return _mes_forecast_impl(mode=mode, days_back=days_back)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/mes/forecast")
def mes_forecast(
    model: str = Query(
        default="opus",
        description="Forecast mode: opus (Claude), gpt (OpenAI GPT-5.x), or quant baseline",
    ),
    days_back: int = Query(default=90, ge=20, le=365),
) -> Dict[str, Any]:
    try:
        mode = _normalize_mode(model)
        return _mes_forecast_impl(mode=mode, days_back=days_back)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/mes_signals")
def mes_signals_compat(
    timeframe: Timeframe = Query(default="15m"),
    days_back: int = Query(default=20, ge=1, le=180),
    swing_order: int = Query(default=5, ge=2, le=20),
    min_rr: float = Query(default=2.0, ge=0.5, le=20.0),
    latest: int = Query(default=20, ge=1, le=200),
    require_volume_confirmation: bool = Query(default=False),
) -> Dict[str, Any]:
    try:
        return _mes_signals_impl(
            timeframe=timeframe,
            days_back=days_back,
            swing_order=swing_order,
            min_rr=min_rr,
            latest=latest,
            require_volume_confirmation=require_volume_confirmation,
        )
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.get("/mes/full")
def mes_full(
    days_back: int = Query(default=30, ge=1, le=365),
    swing_order: int = Query(default=5, ge=2, le=20),
    min_rr: float = Query(default=2.0, ge=0.5, le=20.0),
    require_volume_confirmation: bool = Query(default=False),
) -> Dict[str, Any]:
    """Full payload with all signal rows across all timeframes."""
    try:
        return run_multi_timeframe_analysis(
            days_back=days_back,
            order=swing_order,
            min_rr=min_rr,
            require_volume_confirmation=require_volume_confirmation,
        )
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=str(exc)) from exc
