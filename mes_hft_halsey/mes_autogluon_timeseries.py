from __future__ import annotations

import argparse
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, List, Literal, Optional, Sequence, Tuple

import pandas as pd
from dotenv import load_dotenv

try:
    from mes_hft_halsey.mes_intraday_halsey import (
        Timeframe,
        fetch_mes_databento,
        resample_mes,
    )
except ModuleNotFoundError:
    from mes_intraday_halsey import (
        Timeframe,
        fetch_mes_databento,
        resample_mes,
    )

try:
    from autogluon.timeseries import TimeSeriesDataFrame, TimeSeriesPredictor
except Exception as exc:  # pragma: no cover
    raise RuntimeError(
        "AutoGluon TimeSeries is not available. Activate .venv-autogluon and install autogluon."
    ) from exc


DEFAULT_SYMBOLS: tuple[str, ...] = (
    "MES",
    "ES",
    "NQ",
    "MNQ",
    "YM",
    "MYM",
    "RTY",
    "M2K",
    "ZN",
    "ZB",
    "ZF",
    "ZT",
    "GC",
    "MGC",
    "SI",
    "HG",
    "CL",
    "MCL",
    "NG",
    "6E",
    "6J",
    "6B",
)

DEFAULT_HORIZONS: tuple[str, ...] = ("5m", "15m", "60m", "4h", "24h", "7d")

TIMEFRAME_MINUTES: Dict[Timeframe, int] = {
    "5m": 5,
    "15m": 15,
    "1h": 60,
    "4h": 240,
    "1d": 1440,
}

AG_FREQ_MAP: Dict[Timeframe, str] = {
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1D",
}

SOURCE_SCHEMA_CANDIDATES: Dict[Timeframe, Tuple[str, ...]] = {
    "5m": ("ohlcv-1m",),
    "15m": ("ohlcv-1m",),
    "1h": ("ohlcv-1h", "ohlcv-1m"),
    "4h": ("ohlcv-1h", "ohlcv-1m"),
    "1d": ("ohlcv-1d", "ohlcv-1m"),
}

DEFAULT_PREDICTION_LENGTH: Dict[Timeframe, int] = {
    "5m": 2016,  # 7d in 5m bars
    "15m": 672,  # 7d in 15m bars
    "1h": 168,   # 7d in 1h bars
    "4h": 42,    # 7d in 4h bars
    "1d": 7,     # 7d in 1d bars
}

QUALITY_TO_PRESET: Dict[str, str] = {
    "fast": "fast_training",
    "medium": "medium_quality",
    "high": "high_quality",
    "best": "best_quality",
    "extreme": "best_quality",
}

BIAS_THRESHOLD_PCT = 0.05


@dataclass
class MesRealModelSummary:
    timeframe: Timeframe
    quality: str
    presets: str
    days_back: int
    symbols_requested: List[str]
    symbols_used: List[str]
    symbols_failed: Dict[str, str]
    bars_per_symbol: Dict[str, int]
    prediction_length: int
    requested_horizons: List[str]
    modeled_horizons: List[str]
    skipped_horizons: Dict[str, str]
    horizon_steps_bars: Dict[str, int]
    synthetic_data_used: bool
    last_close: float
    first_forecast: float
    delta_points: float
    delta_pct: float
    bias: Literal["LONG", "SHORT", "FLAT"]
    horizon_forecast: Dict[str, float]
    horizon_delta_points: Dict[str, float]
    horizon_delta_pct: Dict[str, float]
    horizon_bias: Dict[str, Literal["LONG", "SHORT", "FLAT"]]
    holdout_horizon_abs_pct_error: Dict[str, float]
    model_path: str
    leaderboard_top_model: str
    leaderboard_top_score: float
    forecast_csv: str


@dataclass
class MesSymbolAuditSummary:
    timeframe: Timeframe
    days_back: int
    symbols_requested: List[str]
    symbols_used: List[str]
    symbols_failed: Dict[str, str]
    bars_per_symbol: Dict[str, int]
    source_schema_per_symbol: Dict[str, str]
    first_timestamp_utc: Dict[str, str]
    last_timestamp_utc: Dict[str, str]
    synthetic_data_used: bool


def _normalize_root_symbol(symbol: str) -> str:
    s = symbol.strip().upper()
    if not s:
        raise ValueError("Empty symbol")
    if ".C." in s:
        return s.split(".C.")[0]
    return s


def _to_databento_continuous(symbol: str) -> str:
    s = symbol.strip().upper()
    return s if ".C." in s else f"{s}.c.0"


def _parse_horizon_to_minutes(horizon: str) -> int:
    raw = horizon.strip().lower()
    if not raw:
        raise ValueError("Empty horizon value")
    unit = raw[-1]
    value = int(raw[:-1])
    if value <= 0:
        raise ValueError(f"Horizon must be positive: {horizon}")
    if unit == "m":
        return value
    if unit == "h":
        return value * 60
    if unit == "d":
        return value * 1440
    raise ValueError(f"Unsupported horizon unit: {horizon}")


def _horizon_steps(timeframe: Timeframe, horizons: Sequence[str]) -> Dict[str, int]:
    base = TIMEFRAME_MINUTES[timeframe]
    out: Dict[str, int] = {}
    for h in horizons:
        minutes = _parse_horizon_to_minutes(h)
        out[h] = max(1, int(math.ceil(minutes / base)))
    return out


def _split_horizons_for_timeframe(
    timeframe: Timeframe, horizons: Sequence[str]
) -> Tuple[List[str], Dict[str, str]]:
    base_minutes = TIMEFRAME_MINUTES[timeframe]
    modeled: List[str] = []
    skipped: Dict[str, str] = {}
    for h in horizons:
        h_minutes = _parse_horizon_to_minutes(h)
        if h_minutes < base_minutes:
            skipped[h] = (
                f"Horizon {h} is shorter than base timeframe {timeframe}. "
                "Use a lower-timeframe model for this horizon."
            )
        else:
            modeled.append(h)
    return modeled, skipped


def _bias_from_delta(delta_pct: float) -> Literal["LONG", "SHORT", "FLAT"]:
    if delta_pct > BIAS_THRESHOLD_PCT:
        return "LONG"
    if delta_pct < -BIAS_THRESHOLD_PCT:
        return "SHORT"
    return "FLAT"


def _to_naive_utc(ts_index: pd.Index) -> pd.DatetimeIndex:
    ts = pd.to_datetime(ts_index)
    if getattr(ts, "tz", None) is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts


def _build_multiseries_frame(
    roots: Sequence[str],
    timeframe: Timeframe,
    days_back: int,
) -> Tuple[
    pd.DataFrame,
    Dict[str, int],
    Dict[str, str],
    Dict[str, str],
    Dict[str, str],
    Dict[str, str],
]:
    rows: List[pd.DataFrame] = []
    bars_per_symbol: Dict[str, int] = {}
    failed: Dict[str, str] = {}
    first_ts: Dict[str, str] = {}
    last_ts: Dict[str, str] = {}
    source_schema_per_symbol: Dict[str, str] = {}

    for root in roots:
        db_symbol = _to_databento_continuous(root)
        schema_candidates = SOURCE_SCHEMA_CANDIDATES[timeframe]
        try:
            fetch_errors: List[str] = []
            raw_df: Optional[pd.DataFrame] = None
            used_schema: Optional[str] = None
            for schema in schema_candidates:
                try:
                    print(f"[audit] fetching {db_symbol} schema={schema} -> {timeframe} ({days_back}d)")
                    raw_df = fetch_mes_databento(days_back=days_back, symbol=db_symbol, schema=schema)
                    used_schema = schema
                    break
                except Exception as exc:
                    err = str(exc).splitlines()[0][:280]
                    fetch_errors.append(f"{schema}: {err}")
                    print(f"[audit] schema fallback {db_symbol} {schema} failed: {err}")

            if raw_df is None or used_schema is None:
                failed[root] = " | ".join(fetch_errors)[:280]
                continue

            if (used_schema == "ohlcv-1h" and timeframe == "1h") or (
                used_schema == "ohlcv-1d" and timeframe == "1d"
            ):
                tf_df = raw_df
            else:
                tf_df = resample_mes(raw_df, timeframe)
            tf_df = tf_df[["close"]].dropna()
            if tf_df.empty:
                failed[root] = "No candles after resampling"
                continue

            normalized_root = _normalize_root_symbol(root)
            frame = pd.DataFrame(
                {
                    "item_id": normalized_root,
                    "timestamp": _to_naive_utc(tf_df.index),
                    "target": tf_df["close"].astype(float).to_numpy(),
                }
            )
            frame = frame.dropna().sort_values("timestamp")
            if frame.empty:
                failed[root] = "No valid rows after cleaning"
                continue

            rows.append(frame)
            bars_per_symbol[normalized_root] = int(len(frame))
            source_schema_per_symbol[normalized_root] = used_schema
            first_ts[normalized_root] = pd.Timestamp(frame["timestamp"].iloc[0]).isoformat()
            last_ts[normalized_root] = pd.Timestamp(frame["timestamp"].iloc[-1]).isoformat()
            print(
                f"[audit] ok {db_symbol} schema={used_schema} rows={len(frame)} "
                f"first={first_ts[normalized_root]} last={last_ts[normalized_root]}"
            )
        except Exception as exc:
            failed[root] = str(exc).splitlines()[0][:280]
            print(f"[audit] failed {db_symbol}: {failed[root]}")

    if not rows:
        raise RuntimeError("No symbols could be fetched from Databento")

    out = pd.concat(rows, ignore_index=True).sort_values(["item_id", "timestamp"])
    return out, bars_per_symbol, failed, first_ts, last_ts, source_schema_per_symbol


def _select_presets(quality: str, override: str | None) -> str:
    if override:
        return override
    return QUALITY_TO_PRESET.get(quality, "best_quality")


def train_real_mes_model(
    roots: Sequence[str],
    timeframe: Timeframe,
    days_back: int,
    horizons: Sequence[str],
    prediction_length: int,
    quality: str,
    presets: str,
    time_limit: int,
    model_dir: Path,
    forecast_csv: Path,
) -> MesRealModelSummary:
    modeled_horizons, skipped_horizons = _split_horizons_for_timeframe(timeframe, horizons)
    if not modeled_horizons:
        raise RuntimeError(
            "No valid horizons for this timeframe. All requested horizons are shorter than the base timeframe."
        )

    horizon_steps = _horizon_steps(timeframe, modeled_horizons)
    required_pred_len = max(horizon_steps.values()) if horizon_steps else prediction_length
    prediction_length = max(prediction_length, required_pred_len)

    multi_df, bars_per_symbol, failed, _, _, _ = _build_multiseries_frame(
        roots=roots, timeframe=timeframe, days_back=days_back
    )
    tsdf = TimeSeriesDataFrame.from_data_frame(
        multi_df,
        id_column="item_id",
        timestamp_column="timestamp",
    )
    # Keep only real observed bars (no generated fills / no synthetic carry-forward rows).
    tsdf = tsdf.dropna()

    used_symbols = sorted(str(s) for s in tsdf.item_ids)
    if "MES" not in used_symbols:
        raise RuntimeError("MES missing from fetched symbol universe; cannot train MES model")
    if len(tsdf) <= prediction_length * max(2, len(used_symbols)):
        raise RuntimeError(
            f"Not enough rows for prediction_length={prediction_length}. total_rows={len(tsdf)}"
        )

    train_data, test_data = tsdf.train_test_split(prediction_length=prediction_length)

    model_dir.mkdir(parents=True, exist_ok=True)
    predictor = TimeSeriesPredictor(
        prediction_length=prediction_length,
        target="target",
        freq=AG_FREQ_MAP[timeframe],
        path=str(model_dir),
        eval_metric="MASE",
        verbosity=2,
    )
    predictor.fit(
        train_data=train_data,
        presets=presets,
        time_limit=time_limit,
    )

    leaderboard = predictor.leaderboard(test_data, silent=True)
    top_row = leaderboard.iloc[0]
    top_model = str(top_row["model"])
    top_score = float(top_row["score_test"])

    forecasts_all = predictor.predict(tsdf)
    mes_forecast = forecasts_all.loc["MES"].copy()
    forecast_csv.parent.mkdir(parents=True, exist_ok=True)
    mes_forecast.to_csv(forecast_csv)

    holdout_preds = predictor.predict(train_data).loc["MES"]["mean"].reset_index(drop=True)
    holdout_actual = test_data.loc["MES"]["target"].reset_index(drop=True)

    mes_history = tsdf.loc["MES"]["target"]
    last_close = float(mes_history.iloc[-1])
    first_forecast = float(mes_forecast.iloc[0]["mean"])
    delta_points = first_forecast - last_close
    delta_pct = (delta_points / last_close) * 100 if last_close else 0.0
    bias = _bias_from_delta(delta_pct)

    mean_series = mes_forecast["mean"].reset_index(drop=True)
    horizon_forecast: Dict[str, float] = {}
    horizon_delta_points: Dict[str, float] = {}
    horizon_delta_pct: Dict[str, float] = {}
    horizon_bias: Dict[str, Literal["LONG", "SHORT", "FLAT"]] = {}
    holdout_horizon_abs_pct_error: Dict[str, float] = {}

    for h in modeled_horizons:
        step = horizon_steps[h]
        idx = min(step - 1, len(mean_series) - 1)
        forecast_value = float(mean_series.iloc[idx])
        dp = forecast_value - last_close
        dpct = (dp / last_close) * 100 if last_close else 0.0
        horizon_forecast[h] = round(forecast_value, 4)
        horizon_delta_points[h] = round(dp, 4)
        horizon_delta_pct[h] = round(dpct, 4)
        horizon_bias[h] = _bias_from_delta(dpct)

        if step <= len(holdout_actual):
            pred_v = float(holdout_preds.iloc[step - 1])
            act_v = float(holdout_actual.iloc[step - 1])
            if act_v != 0:
                holdout_horizon_abs_pct_error[h] = round(abs((pred_v - act_v) / act_v) * 100, 4)

    return MesRealModelSummary(
        timeframe=timeframe,
        quality=quality,
        presets=presets,
        days_back=days_back,
        symbols_requested=[_normalize_root_symbol(s) for s in roots],
        symbols_used=used_symbols,
        symbols_failed=failed,
        bars_per_symbol=bars_per_symbol,
        prediction_length=prediction_length,
        requested_horizons=list(horizons),
        modeled_horizons=modeled_horizons,
        skipped_horizons=skipped_horizons,
        horizon_steps_bars=horizon_steps,
        synthetic_data_used=False,
        last_close=round(last_close, 4),
        first_forecast=round(first_forecast, 4),
        delta_points=round(delta_points, 4),
        delta_pct=round(delta_pct, 4),
        bias=bias,
        horizon_forecast=horizon_forecast,
        horizon_delta_points=horizon_delta_points,
        horizon_delta_pct=horizon_delta_pct,
        horizon_bias=horizon_bias,
        holdout_horizon_abs_pct_error=holdout_horizon_abs_pct_error,
        model_path=str(model_dir),
        leaderboard_top_model=top_model,
        leaderboard_top_score=round(top_score, 6),
        forecast_csv=str(forecast_csv),
    )


def audit_symbol_universe(
    roots: Sequence[str],
    timeframe: Timeframe,
    days_back: int,
) -> MesSymbolAuditSummary:
    _, bars_per_symbol, failed, first_ts, last_ts, schema_per_symbol = _build_multiseries_frame(
        roots=roots,
        timeframe=timeframe,
        days_back=days_back,
    )
    used = sorted(bars_per_symbol.keys())
    return MesSymbolAuditSummary(
        timeframe=timeframe,
        days_back=days_back,
        symbols_requested=[_normalize_root_symbol(s) for s in roots],
        symbols_used=used,
        symbols_failed=failed,
        bars_per_symbol=bars_per_symbol,
        source_schema_per_symbol=schema_per_symbol,
        first_timestamp_utc=first_ts,
        last_timestamp_utc=last_ts,
        synthetic_data_used=False,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Real-data AutoGluon MES model (multi-symbol global training, local machine)."
    )
    parser.add_argument(
        "--days-back",
        type=int,
        default=730,
        help="Lookback window in days (default: 2 years)",
    )
    parser.add_argument(
        "--timeframe",
        type=str,
        default="1h",
        choices=["5m", "15m", "1h", "4h", "1d"],
        help="Modeling timeframe",
    )
    parser.add_argument(
        "--symbols",
        type=str,
        default=",".join(DEFAULT_SYMBOLS),
        help="Comma-separated root symbols (e.g. MES,ES,NQ,ZN,CL,GC,...).",
    )
    parser.add_argument(
        "--horizons",
        type=str,
        default=",".join(DEFAULT_HORIZONS),
        help="Comma-separated horizons (5m,15m,60m,4h,24h,7d).",
    )
    parser.add_argument(
        "--prediction-length",
        type=int,
        default=0,
        help="Forecast horizon in bars; auto-expanded to cover max requested horizon.",
    )
    parser.add_argument(
        "--quality",
        type=str,
        default="extreme",
        choices=["fast", "medium", "high", "best", "extreme"],
        help="Quality profile. extreme -> best_quality",
    )
    parser.add_argument(
        "--presets",
        type=str,
        default="",
        help="Optional explicit AutoGluon presets override.",
    )
    parser.add_argument(
        "--time-limit",
        type=int,
        default=3600,
        help="Training time limit in seconds.",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=Path("mes_hft_halsey/models/autogluon_mes_real"),
        help="Directory to store trained model artifacts.",
    )
    parser.add_argument(
        "--forecast-csv",
        type=Path,
        default=Path("mes_hft_halsey/output/mes_autogluon_forecast.csv"),
        help="Path to write MES forecast rows.",
    )
    parser.add_argument(
        "--summary-json",
        type=Path,
        default=Path("mes_hft_halsey/output/mes_autogluon_summary.json"),
        help="Path to write run summary JSON.",
    )
    parser.add_argument(
        "--audit-only",
        action="store_true",
        help="Only run Databento symbol audit and exit (no model training).",
    )
    return parser.parse_args()


def main() -> None:
    load_dotenv(".env.local")
    load_dotenv(".env")

    args = parse_args()
    timeframe: Timeframe = args.timeframe
    roots = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    horizons = [h.strip().lower() for h in args.horizons.split(",") if h.strip()]
    if "MES" not in roots:
        roots = ["MES", *roots]

    horizon_steps = _horizon_steps(timeframe, horizons)
    min_required = max(horizon_steps.values()) if horizon_steps else 1
    prediction_length = (
        args.prediction_length
        if args.prediction_length > 0
        else max(DEFAULT_PREDICTION_LENGTH[timeframe], min_required)
    )
    presets = _select_presets(args.quality, args.presets or None)

    run_model_dir = Path(f"{args.model_dir}_{timeframe}")
    if args.audit_only:
        audit = audit_symbol_universe(
            roots=roots,
            timeframe=timeframe,
            days_back=args.days_back,
        )
        args.summary_json.parent.mkdir(parents=True, exist_ok=True)
        args.summary_json.write_text(json.dumps(asdict(audit), indent=2))
        print("MES symbol audit complete")
        print(json.dumps(asdict(audit), indent=2))
        return

    summary = train_real_mes_model(
        roots=roots,
        timeframe=timeframe,
        days_back=args.days_back,
        horizons=horizons,
        prediction_length=prediction_length,
        quality=args.quality,
        presets=presets,
        time_limit=args.time_limit,
        model_dir=run_model_dir,
        forecast_csv=args.forecast_csv,
    )

    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    args.summary_json.write_text(json.dumps(asdict(summary), indent=2))

    print("MES real model training complete")
    print(json.dumps(asdict(summary), indent=2))


if __name__ == "__main__":
    main()
