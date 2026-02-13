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

try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
    PSYCOPG2_AVAILABLE = True
except ImportError:
    PSYCOPG2_AVAILABLE = False
    print("[warn] psycopg2 not available; database source disabled")


DEFAULT_SYMBOLS: tuple[str, ...] = (
    # Equity Index Futures (Micro & Standard)
    "MES", "ES",     # E-mini & Micro S&P 500
    "MNQ", "NQ",     # Micro & E-mini Nasdaq-100
    "MYM", "YM",     # Micro & E-mini Dow
    "M2K", "RTY",    # Micro & E-mini Russell 2000
    "MXP",           # Micro Nikkei 225

    # Interest Rate Futures
    "ZT",            # 2-Year T-Note
    "ZF",            # 5-Year T-Note
    "ZN",            # 10-Year T-Note
    "ZB",            # 30-Year T-Bond
    "UB",            # Ultra T-Bond
    "GE",            # Eurodollar
    "ZQ",            # 30-Day Fed Funds

    # Energy Futures
    "CL", "MCL",     # Crude Oil & Micro
    "HO",            # Heating Oil
    "RB",            # RBOB Gasoline
    "NG", "QG",      # Natural Gas & E-mini
    "BZ",            # Brent Crude

    # Metals Futures
    "GC", "MGC",     # Gold & Micro
    "SI", "SIL",     # Silver & Micro
    "HG",            # Copper
    "PL",            # Platinum
    "PA",            # Palladium

    # Agricultural Futures
    "ZC",            # Corn
    "ZS",            # Soybeans
    "ZW",            # Wheat
    "ZL",            # Soybean Oil
    "ZM",            # Soybean Meal
    "KE",            # KC Hard Red Winter Wheat
    "ZO",            # Oats
    "ZR",            # Rough Rice
    "GF",            # Feeder Cattle
    "HE",            # Lean Hogs
    "LE",            # Live Cattle

    # FX Futures
    "6E",            # Euro
    "6J",            # Japanese Yen
    "6B",            # British Pound
    "6C",            # Canadian Dollar
    "6A",            # Australian Dollar
    "6S",            # Swiss Franc
    "6N",            # New Zealand Dollar
    "6M",            # Mexican Peso
    "DX",            # US Dollar Index

    # Crypto Futures
    "BTC", "MBT",    # Bitcoin & Micro
    "ETH", "MET",    # Ethereum & Micro

    # Volatility & Other
    "VX",            # VIX Futures
    "VXM",           # Micro VIX
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

QUALITY_TO_TIME_LIMIT: Dict[str, int] = {
    "fast": 300,      # 5 minutes
    "medium": 1800,   # 30 minutes
    "high": 3600,     # 1 hour
    "best": 7200,     # 2 hours
    "extreme": 14400, # 4 hours (full model zoo)
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


def _fetch_from_database(
    timeframe: Timeframe,
    days_back: int,
) -> Tuple[pd.DataFrame, Dict[str, int], Dict[str, str], Dict[str, str], Dict[str, str], Dict[str, str]]:
    """Fetch ALL symbols from local database instead of Databento."""
    import os
    if not PSYCOPG2_AVAILABLE:
        raise RuntimeError("psycopg2 not installed; cannot fetch from database")

    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        raise RuntimeError("DATABASE_URL not set")

    # Map timeframe to table
    table_map = {
        "1h": "futures_ex_mes_1h",
        "1d": "futures_ex_mes_1d",
    }
    table = table_map.get(timeframe)
    if not table:
        raise ValueError(f"Database source only supports 1h, 1d timeframes; got {timeframe}")

    cutoff_date = f"NOW() - INTERVAL '{days_back} days'"
    time_col = "event_time" if timeframe == "1h" else "event_date"

    conn = psycopg2.connect(db_url)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Get all symbols
            cur.execute(f"SELECT DISTINCT symbol_code FROM {table} ORDER BY symbol_code")
            all_symbols = [row["symbol_code"] for row in cur.fetchall()]
            print(f"[db] Found {len(all_symbols)} symbols in {table}: {', '.join(all_symbols[:20])}{'...' if len(all_symbols) > 20 else ''}")

            rows = []
            bars_per_symbol = {}
            failed = {}
            first_ts = {}
            last_ts = {}
            source_schema = {}

            for symbol in all_symbols:
                try:
                    query = f"""
                        SELECT {time_col} as timestamp, close as target
                        FROM {table}
                        WHERE symbol_code = %s AND {time_col} >= {cutoff_date}
                        ORDER BY {time_col} ASC
                    """
                    cur.execute(query, (symbol,))
                    symbol_data = cur.fetchall()

                    if not symbol_data:
                        failed[symbol] = "No data in timeframe"
                        continue

                    df = pd.DataFrame([
                        {
                            "item_id": symbol,
                            "timestamp": row["timestamp"],
                            "target": float(row["target"])
                        }
                        for row in symbol_data
                    ])

                    df = df.dropna().sort_values("timestamp")
                    if df.empty:
                        failed[symbol] = "No valid rows"
                        continue

                    rows.append(df)
                    bars_per_symbol[symbol] = len(df)
                    source_schema[symbol] = table
                    first_ts[symbol] = pd.Timestamp(df["timestamp"].iloc[0]).isoformat()
                    last_ts[symbol] = pd.Timestamp(df["timestamp"].iloc[-1]).isoformat()
                    print(f"[db]   {symbol}: {len(df)} bars, {first_ts[symbol]} to {last_ts[symbol]}")

                except Exception as exc:
                    failed[symbol] = str(exc).splitlines()[0][:280]
                    print(f"[db]   {symbol}: FAILED - {failed[symbol]}")

            if not rows:
                raise RuntimeError("No symbols could be fetched from database")

            combined = pd.concat(rows, ignore_index=True).sort_values(["item_id", "timestamp"])
            return combined, bars_per_symbol, failed, first_ts, last_ts, source_schema

    finally:
        conn.close()


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
    use_database: bool = False,
) -> MesRealModelSummary:
    modeled_horizons, skipped_horizons = _split_horizons_for_timeframe(timeframe, horizons)
    if not modeled_horizons:
        raise RuntimeError(
            "No valid horizons for this timeframe. All requested horizons are shorter than the base timeframe."
        )

    horizon_steps = _horizon_steps(timeframe, modeled_horizons)
    required_pred_len = max(horizon_steps.values()) if horizon_steps else prediction_length
    prediction_length = max(prediction_length, required_pred_len)

    if use_database:
        print(f"[train] Fetching ALL symbols from database (ignoring --symbols argument)")
        multi_df, bars_per_symbol, failed, _, _, _ = _fetch_from_database(
            timeframe=timeframe, days_back=days_back
        )
    else:
        print(f"[train] Fetching {len(roots)} symbols from Databento API")
        multi_df, bars_per_symbol, failed, _, _, _ = _build_multiseries_frame(
            roots=roots, timeframe=timeframe, days_back=days_back
        )
    tsdf = TimeSeriesDataFrame.from_data_frame(
        multi_df,
        id_column="item_id",
        timestamp_column="timestamp",
    )
    # Keep only real observed bars per symbol (no NaN targets within each series).
    # Use subset=['target'] to avoid dropping rows just because timestamp/item_id exist.
    tsdf = tsdf.dropna(subset=["target"])

    used_symbols = sorted(str(s) for s in tsdf.item_ids)
    print(f"[train] Training on {len(used_symbols)} symbols: {used_symbols}")
    for sym in used_symbols:
        sym_len = len(tsdf.loc[sym])
        print(f"[train]   {sym}: {sym_len} bars")

    if "MES" not in used_symbols:
        raise RuntimeError("MES missing from fetched symbol universe; cannot train MES model")
    if len(tsdf) <= prediction_length * max(2, len(used_symbols)):
        raise RuntimeError(
            f"Not enough rows for prediction_length={prediction_length}. total_rows={len(tsdf)}"
        )

    train_data, test_data = tsdf.train_test_split(prediction_length=prediction_length)
    print(f"[train] train_data: {len(train_data)} rows across {len(train_data.item_ids)} symbols")
    print(f"[train] test_data: {len(test_data)} rows across {len(test_data.item_ids)} symbols")

    model_dir.mkdir(parents=True, exist_ok=True)

    # Known covariates are features we know in advance (time-based)
    # Note: Only works if these columns exist in the training data
    known_covariates = []  # Would be ['hour', 'day_of_week', etc] if we had them

    predictor = TimeSeriesPredictor(
        prediction_length=prediction_length,
        target="target",
        freq=AG_FREQ_MAP[timeframe],
        path=str(model_dir),
        eval_metric="MASE",
        known_covariates_names=known_covariates,
        verbosity=2,
    )

    # FULL MODEL ZOO - ALL AutoGluon 1.5 TimeSeries Models
    all_models_hyperparameters = {
        # ================== STATISTICAL MODELS ==================
        "Naive": {},
        "SeasonalNaive": {},
        "Average": {},
        "SeasonalAverage": {},
        "Zero": {},  # Always predicts zero baseline
        "Theta": {},
        "AutoETS": {"max_ts_length": 2500},
        "AutoARIMA": {"max_ts_length": 2500},
        "DynamicOptimizedTheta": {},
        "ADIDA": {},  # Aggregate-Disaggregate Intermittent Demand Approach

        # ================== TABULAR ML MODELS ==================
        "RecursiveTabular": {"n_repeat_predictions": 10},
        "DirectTabular": {},

        # ================== DEEP LEARNING MODELS ==================
        # Transformer-based
        "TemporalFusionTransformer": {"epochs": 100, "num_batches_per_epoch": 50},
        "Transformer": {"epochs": 100, "num_batches_per_epoch": 50},
        "PatchTST": {"epochs": 100, "num_batches_per_epoch": 50},

        # RNN-based
        "DeepAR": {"epochs": 100, "num_batches_per_epoch": 50},
        "MQRNNRegressor": {"epochs": 100},  # Multi-Quantile RNN
        "SimpleFeedForward": {"epochs": 100, "num_batches_per_epoch": 50},

        # CNN-based
        "WaveNet": {"epochs": 100, "num_batches_per_epoch": 50},
        "MQCNN": {"epochs": 100},  # Multi-Quantile CNN

        # Quantile-based deep models
        "MQF2": {"epochs": 100},  # Multi-Quantile Feedforward v2

        # ================== CHRONOS FOUNDATION MODELS ==================
        # Pre-trained zero-shot models (if available)
        "Chronos[tiny]": {},     # Fastest, least accurate
        "Chronos[mini]": {},     # Fast, good accuracy
        "Chronos[small]": {},    # Balanced
        "Chronos[base]": {},     # Standard (recommended)
        "Chronos[large]": {},    # Slower, more accurate

        # ================== ENSEMBLE MODELS ==================
        # WeightedEnsemble is auto-created if enable_ensemble=True
    }

    print(f"[train] ========================================")
    print(f"[train] FULL AUTOGLUON 1.5 MODEL ZOO")
    print(f"[train] {len(all_models_hyperparameters)} models configured")
    print(f"[train] ========================================")
    print(f"[train] Statistical: Naive, SeasonalNaive, Theta, AutoETS, AutoARIMA, etc")
    print(f"[train] Tabular: RecursiveTabular, DirectTabular")
    print(f"[train] Deep Learning: TFT, PatchTST, DeepAR, WaveNet, Transformer")
    print(f"[train] Chronos: tiny→mini→small→base→large")
    print(f"[train] Time limit: {time_limit}s ({time_limit/3600:.1f}h)")
    print(f"[train] ========================================")

    predictor.fit(
        train_data=train_data,
        hyperparameters=all_models_hyperparameters,
        time_limit=time_limit,
        enable_ensemble=True,
        num_val_windows=1,
        skip_model_selection=False,
        random_seed=42,  # Reproducibility
    )

    print(f"[train] ========================================")
    print(f"[train] Training complete!")
    print(f"[train] Generating leaderboard...")

    leaderboard = predictor.leaderboard(test_data, silent=True)
    top_row = leaderboard.iloc[0]
    top_model = str(top_row["model"])
    top_score = float(top_row["score_test"])

    forecasts_all = predictor.predict(tsdf)
    mes_forecast = forecasts_all.loc["MES"].copy()
    forecast_csv.parent.mkdir(parents=True, exist_ok=True)
    mes_forecast.to_csv(forecast_csv)

    # Holdout evaluation: predict() forecasts prediction_length steps forward
    # from the end of train_data, which overlaps the test window. This is NOT
    # in-sample — AutoGluon TimeSeries always forecasts forward, never in-sample.
    # Guard against length mismatch if prediction_length != len(test window).
    holdout_preds = predictor.predict(train_data).loc["MES"]["mean"].reset_index(drop=True)
    holdout_actual = test_data.loc["MES"]["target"].reset_index(drop=True)
    _holdout_len = min(len(holdout_preds), len(holdout_actual))
    holdout_preds = holdout_preds.iloc[:_holdout_len]
    holdout_actual = holdout_actual.iloc[:_holdout_len]

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

        if step <= len(holdout_actual) and step <= len(holdout_preds):
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
        default=0,
        help="Training time limit in seconds (0=auto based on quality: extreme=14400s/4h).",
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
    parser.add_argument(
        "--use-database",
        action="store_true",
        help="Fetch ALL symbols from local database instead of Databento (trains on EVERYTHING).",
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

    # Auto-select time limit based on quality if not explicitly provided
    time_limit = args.time_limit if args.time_limit > 0 else QUALITY_TO_TIME_LIMIT[args.quality]

    print(f"[config] Quality: {args.quality} -> Presets: {presets}, Time limit: {time_limit}s ({time_limit/3600:.1f}h)")
    print(f"[config] Training on {len(roots)} symbols: {roots}")
    print(f"[config] Prediction length: {prediction_length} bars, Horizons: {horizons}")

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
        forecast_csv=args.forecast_csv,        use_database=args.use_database,    )

    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    args.summary_json.write_text(json.dumps(asdict(summary), indent=2))

    print("MES real model training complete")
    print(json.dumps(asdict(summary), indent=2))


if __name__ == "__main__":
    main()
