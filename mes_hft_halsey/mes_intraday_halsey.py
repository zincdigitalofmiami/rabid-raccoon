from __future__ import annotations

import argparse
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional, Sequence, Tuple

import numpy as np
import pandas as pd
from dotenv import load_dotenv

try:
    import databento as db
except Exception:  # pragma: no cover - import guard
    db = None

try:
    from fredapi import Fred
except Exception:  # pragma: no cover - import guard
    Fred = None

try:
    import yfinance as yf
except Exception:  # pragma: no cover - import guard
    yf = None

try:
    from scipy.signal import argrelextrema
except Exception:  # pragma: no cover - import guard
    argrelextrema = None


Timeframe = Literal["5m", "15m", "1h", "4h", "1d"]
Direction = Literal["LONG", "SHORT"]

TIMEFRAME_RULES: Dict[Timeframe, str] = {
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
}

TIMEFRAME_ORDER: Tuple[Timeframe, ...] = ("5m", "15m", "1h", "4h", "1d")

DEFAULT_DATABENTO_DATASET = "GLBX.MDP3"
DEFAULT_DATABENTO_SYMBOL = "MES.c.0"
DEFAULT_DATABENTO_SCHEMA = "ohlcv-1m"


@dataclass
class HalseySignal:
    timeframe: Timeframe
    timestamp: str
    direction: Direction
    pattern: str
    impulse_points: float
    retrace_pct: float
    entry: float
    stop: float
    target_100: float
    target_1236: float
    risk_reward_100: float
    risk_reward_1236: float
    enabled: bool
    filter_reason: str
    volume_confirmed: bool


@dataclass
class TimeframeSnapshot:
    timeframe: Timeframe
    signal_count: int
    enabled_signal_count: int
    latest_direction: Literal["LONG", "SHORT", "NEUTRAL"]
    latest_entry: Optional[float]
    latest_stop: Optional[float]
    latest_target_100: Optional[float]


def _require_package(package: object, label: str) -> None:
    if package is None:
        raise RuntimeError(
            f"Missing optional dependency '{label}'. Install from mes_hft_halsey/requirements.txt"
        )


def _require_env(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise RuntimeError(f"Environment variable {name} is required")
    return value


def _normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    if "ts_event" in df.columns:
        df = df.set_index("ts_event")

    if isinstance(df.index, pd.MultiIndex):
        df.index = df.index.get_level_values(0)

    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index, utc=True, errors="coerce")

    df = df[~df.index.isna()].copy()

    if df.index.tz is None:
        df.index = df.index.tz_localize("UTC")
    else:
        df.index = df.index.tz_convert("UTC")

    df.index = df.index.tz_convert("America/Chicago")

    lowered = {str(c).lower(): c for c in df.columns}
    required = ["open", "high", "low", "close", "volume"]
    missing = [c for c in required if c not in lowered]
    if missing:
        raise RuntimeError(f"OHLCV columns missing from source frame: {', '.join(missing)}")

    normalized = df[[lowered[c] for c in required]].copy()
    normalized.columns = required
    normalized = normalized.sort_index().dropna()
    return normalized


def fetch_mes_databento(
    days_back: int = 90,
    dataset: str = DEFAULT_DATABENTO_DATASET,
    symbol: str = DEFAULT_DATABENTO_SYMBOL,
    schema: str = DEFAULT_DATABENTO_SCHEMA,
) -> pd.DataFrame:
    """Fetch high-resolution MES futures candles from Databento."""
    _require_package(db, "databento")
    key = _require_env("DATABENTO_API_KEY")

    client = db.Historical(key=key)
    # Historical endpoint can trail real-time ingestion, so use a safety lag.
    end = datetime.now(timezone.utc) - timedelta(minutes=45)
    start = end - timedelta(days=days_back)

    params = {
        "dataset": dataset,
        "symbols": [symbol],
        "schema": schema,
        "start": start.isoformat(),
        "end": end.isoformat(),
    }

    try:
        response = client.timeseries.get_range(stype_in="continuous", **params)
    except TypeError:
        response = client.timeseries.get_range(**params)

    raw = response.to_df()
    df = _normalize_ohlcv(raw)

    if df.empty:
        raise RuntimeError("Databento returned no MES candles for requested range")
    return df


def resample_mes(df: pd.DataFrame, timeframe: Timeframe) -> pd.DataFrame:
    """Resample 1m candles to a target timeframe."""
    if timeframe not in TIMEFRAME_RULES:
        raise ValueError(f"Unsupported timeframe: {timeframe}")

    rule = TIMEFRAME_RULES[timeframe]
    out = (
        df.resample(rule, label="right", closed="right")
        .agg(
            {
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            }
        )
        .dropna()
    )
    return out


def fetch_vix_fred() -> float:
    """Fetch latest VIX close from FRED series VIXCLS."""
    _require_package(Fred, "fredapi")
    key = _require_env("FRED_API_KEY")

    fred = Fred(api_key=key)
    series = fred.get_series("VIXCLS")
    series = pd.Series(series).dropna()
    if series.empty:
        raise RuntimeError("FRED VIXCLS returned no values")
    return float(series.iloc[-1])


def fetch_yahoo_mes_daily(tickers: Sequence[str] = ("MES=F", "ES=F")) -> pd.DataFrame:
    """Use Yahoo as daily fallback/validation baseline for MES/ES futures."""
    _require_package(yf, "yfinance")

    for ticker in tickers:
        df = yf.download(
            ticker,
            period="6mo",
            interval="1d",
            progress=False,
            auto_adjust=False,
            threads=False,
        )
        if df is None or df.empty:
            continue

        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]

        lowered = {str(c).lower(): c for c in df.columns}
        required = ["open", "high", "low", "close", "volume"]
        if any(r not in lowered for r in required):
            continue

        out = df[[lowered[r] for r in required]].copy()
        out.columns = required
        out.index = pd.to_datetime(out.index)
        out = out.dropna()
        if not out.empty:
            return out

    return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])


def classify_vix_regime(vix_level: float) -> str:
    if vix_level >= 20:
        return "HIGH_VOL"
    if vix_level >= 18:
        return "ELEVATED"
    if vix_level < 16:
        return "LOW_VOL"
    return "MODERATE"


def find_swings(df: pd.DataFrame, order: int = 5) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Find local swing highs/lows using scipy extrema or rolling fallback."""
    if len(df) < order * 2 + 1:
        empty = pd.DataFrame(columns=["price"])
        return empty, empty

    highs = df["high"].to_numpy(dtype=float)
    lows = df["low"].to_numpy(dtype=float)

    if argrelextrema is not None:
        hi_idx = argrelextrema(highs, np.greater_equal, order=order)[0]
        lo_idx = argrelextrema(lows, np.less_equal, order=order)[0]
    else:
        # Fallback if scipy is unavailable.
        w = order * 2 + 1
        hi_roll = df["high"].rolling(w, center=True).max()
        lo_roll = df["low"].rolling(w, center=True).min()
        hi_idx = np.where(df["high"].eq(hi_roll).to_numpy())[0]
        lo_idx = np.where(df["low"].eq(lo_roll).to_numpy())[0]

    hi_swings = (
        df.iloc[hi_idx][["high"]]
        .rename(columns={"high": "price"})
        .sort_index()
        .loc[~df.iloc[hi_idx].index.duplicated(keep="last")]
    )
    lo_swings = (
        df.iloc[lo_idx][["low"]]
        .rename(columns={"low": "price"})
        .sort_index()
        .loc[~df.iloc[lo_idx].index.duplicated(keep="last")]
    )

    return hi_swings, lo_swings


def _build_swing_table(df: pd.DataFrame, order: int) -> pd.DataFrame:
    hi, lo = find_swings(df, order=order)
    if hi.empty and lo.empty:
        return pd.DataFrame(columns=["timestamp", "kind", "price"])

    hi_tbl = pd.DataFrame({"timestamp": hi.index, "kind": "HIGH", "price": hi["price"].values})
    lo_tbl = pd.DataFrame({"timestamp": lo.index, "kind": "LOW", "price": lo["price"].values})

    swings = pd.concat([hi_tbl, lo_tbl], ignore_index=True)
    swings = swings.sort_values("timestamp").reset_index(drop=True)
    return swings


def _volume_confirmed(df: pd.DataFrame, ts: pd.Timestamp, baseline_bars: int = 20) -> bool:
    idx = df.index.get_indexer([ts], method="pad")
    if len(idx) == 0 or idx[0] < 2:
        return False
    i = int(idx[0])
    start = max(0, i - baseline_bars)
    baseline = float(df["volume"].iloc[start : i + 1].mean())
    recent = float(df["volume"].iloc[max(0, i - 2) : i + 1].mean())
    if baseline <= 0:
        return False
    return recent >= baseline * 0.9


def _round2(x: float) -> float:
    return float(round(x, 2))


def detect_halsey_signals(
    df: pd.DataFrame,
    timeframe: Timeframe,
    vix_level: float,
    order: int = 5,
    min_rr: float = 2.0,
    require_volume_confirmation: bool = False,
) -> List[HalseySignal]:
    """
    Halsey-style setups:
    - Bullish: A(low) -> B(high) impulse, retrace to C(low) in 50-61.8% zone.
    - Bearish: A(high) -> B(low) impulse, retrace to C(high) in 50-61.8% zone.
    """
    swings = _build_swing_table(df, order=order)
    if swings.empty:
        return []

    signals: List[HalseySignal] = []

    for i in range(len(swings) - 2):
        a = swings.iloc[i]
        b = swings.iloc[i + 1]
        c = swings.iloc[i + 2]

        # Bullish impulse + retrace.
        if a["kind"] == "LOW" and b["kind"] == "HIGH" and c["kind"] == "LOW":
            if not (a["price"] < b["price"] and c["price"] < b["price"] and c["price"] > a["price"]):
                continue

            impulse = float(b["price"] - a["price"])
            retrace = float((b["price"] - c["price"]) / impulse)
            if not (0.50 <= retrace <= 0.618):
                continue

            entry_pad = impulse * 0.05
            entry = float(c["price"] + entry_pad)
            stop = float(c["price"] - entry_pad)
            target_100 = float(c["price"] + impulse)
            target_1236 = float(c["price"] + impulse * 1.236)
            risk = entry - stop
            rr100 = (target_100 - entry) / risk if risk > 0 else 0.0
            rr1236 = (target_1236 - entry) / risk if risk > 0 else 0.0
            vol_ok = _volume_confirmed(df, pd.Timestamp(c["timestamp"]))

            enabled = True
            reason = ""
            if vix_level > 18:
                enabled = False
                reason = f"Filtered long: VIX {vix_level:.2f} > 18.00"
            elif rr100 < min_rr:
                enabled = False
                reason = f"Filtered long: RR100 {rr100:.2f} < {min_rr:.2f}"
            elif require_volume_confirmation and not vol_ok:
                enabled = False
                reason = "Filtered long: no volume confirmation"

            signals.append(
                HalseySignal(
                    timeframe=timeframe,
                    timestamp=pd.Timestamp(c["timestamp"]).isoformat(),
                    direction="LONG",
                    pattern="A-B impulse, C retrace 50-61.8%",
                    impulse_points=_round2(impulse),
                    retrace_pct=_round2(retrace * 100),
                    entry=_round2(entry),
                    stop=_round2(stop),
                    target_100=_round2(target_100),
                    target_1236=_round2(target_1236),
                    risk_reward_100=_round2(rr100),
                    risk_reward_1236=_round2(rr1236),
                    enabled=enabled,
                    filter_reason=reason,
                    volume_confirmed=vol_ok,
                )
            )

        # Bearish impulse + retrace.
        if a["kind"] == "HIGH" and b["kind"] == "LOW" and c["kind"] == "HIGH":
            if not (a["price"] > b["price"] and c["price"] > b["price"] and c["price"] < a["price"]):
                continue

            impulse = float(a["price"] - b["price"])
            retrace = float((c["price"] - b["price"]) / impulse)
            if not (0.50 <= retrace <= 0.618):
                continue

            entry_pad = impulse * 0.05
            entry = float(c["price"] - entry_pad)
            stop = float(c["price"] + entry_pad)
            target_100 = float(c["price"] - impulse)
            target_1236 = float(c["price"] - impulse * 1.236)
            risk = stop - entry
            rr100 = (entry - target_100) / risk if risk > 0 else 0.0
            rr1236 = (entry - target_1236) / risk if risk > 0 else 0.0
            vol_ok = _volume_confirmed(df, pd.Timestamp(c["timestamp"]))

            enabled = True
            reason = ""
            if vix_level < 16:
                enabled = False
                reason = f"Filtered short: VIX {vix_level:.2f} < 16.00"
            elif rr100 < min_rr:
                enabled = False
                reason = f"Filtered short: RR100 {rr100:.2f} < {min_rr:.2f}"
            elif require_volume_confirmation and not vol_ok:
                enabled = False
                reason = "Filtered short: no volume confirmation"

            signals.append(
                HalseySignal(
                    timeframe=timeframe,
                    timestamp=pd.Timestamp(c["timestamp"]).isoformat(),
                    direction="SHORT",
                    pattern="A-B impulse, C retrace 50-61.8%",
                    impulse_points=_round2(impulse),
                    retrace_pct=_round2(retrace * 100),
                    entry=_round2(entry),
                    stop=_round2(stop),
                    target_100=_round2(target_100),
                    target_1236=_round2(target_1236),
                    risk_reward_100=_round2(rr100),
                    risk_reward_1236=_round2(rr1236),
                    enabled=enabled,
                    filter_reason=reason,
                    volume_confirmed=vol_ok,
                )
            )

    signals.sort(key=lambda s: s.timestamp)
    return signals


def summarize_timeframe(signals: List[HalseySignal], timeframe: Timeframe) -> TimeframeSnapshot:
    enabled = [s for s in signals if s.enabled]
    latest = enabled[-1] if enabled else (signals[-1] if signals else None)

    if latest is None:
        return TimeframeSnapshot(
            timeframe=timeframe,
            signal_count=0,
            enabled_signal_count=0,
            latest_direction="NEUTRAL",
            latest_entry=None,
            latest_stop=None,
            latest_target_100=None,
        )

    return TimeframeSnapshot(
        timeframe=timeframe,
        signal_count=len(signals),
        enabled_signal_count=len(enabled),
        latest_direction=latest.direction,
        latest_entry=latest.entry,
        latest_stop=latest.stop,
        latest_target_100=latest.target_100,
    )


def build_confluence_and_forecast(
    summaries: Dict[Timeframe, TimeframeSnapshot],
    vix_level: float,
) -> Dict[str, object]:
    weights = {"5m": 1.0, "15m": 1.5, "1h": 2.0, "4h": 2.5, "1d": 3.0}
    score = 0.0

    for tf, snapshot in summaries.items():
        if snapshot.latest_direction == "LONG":
            score += weights[tf]
        elif snapshot.latest_direction == "SHORT":
            score -= weights[tf]

    if score > 1.5:
        bias = "LONG"
    elif score < -1.5:
        bias = "SHORT"
    else:
        bias = "NEUTRAL"

    regime = classify_vix_regime(vix_level)

    # Lightweight directional range projection for planning horizons.
    long_ranges = {
        "1_week": (0.8, 2.8),
        "1_month": (2.0, 6.0),
        "1_quarter": (4.5, 12.0),
        "6_year": (25.0, 85.0),
    }
    short_ranges = {
        "1_week": (-2.8, -0.8),
        "1_month": (-6.0, -2.0),
        "1_quarter": (-12.0, -4.5),
        "6_year": (-85.0, -25.0),
    }

    if bias == "LONG":
        ranges = long_ranges
    elif bias == "SHORT":
        ranges = short_ranges
    else:
        ranges = {k: (-1.0, 1.0) for k in long_ranges}

    vol_mult = {"LOW_VOL": 1.1, "MODERATE": 1.0, "ELEVATED": 0.9, "HIGH_VOL": 0.75}[regime]

    adjusted = {
        k: (_round2(v[0] * vol_mult), _round2(v[1] * vol_mult)) for k, v in ranges.items()
    }

    return {
        "bias": bias,
        "score": _round2(score),
        "vix_level": _round2(vix_level),
        "vix_regime": regime,
        "forecast_ranges_pct": adjusted,
        "notes": [
            "Halsey confluence: 5m/15m entries filtered by 1h/4h/1d directional structure.",
            "Fib retrace window is strict 50%-61.8% for low-risk measured move setups.",
            "VIX filter applied: longs are damped above 18, shorts are damped below 16.",
        ],
    }


def run_multi_timeframe_analysis(
    days_back: int = 90,
    order: int = 5,
    min_rr: float = 2.0,
    require_volume_confirmation: bool = False,
) -> Dict[str, object]:
    raw_1m = fetch_mes_databento(days_back=days_back)
    vix_level = fetch_vix_fred()

    all_signals: List[HalseySignal] = []
    signals_by_tf: Dict[Timeframe, List[HalseySignal]] = {}
    summaries: Dict[Timeframe, TimeframeSnapshot] = {}

    for tf in TIMEFRAME_ORDER:
        tf_df = resample_mes(raw_1m, tf)
        signals = detect_halsey_signals(
            tf_df,
            tf,
            vix_level,
            order=order,
            min_rr=min_rr,
            require_volume_confirmation=require_volume_confirmation,
        )
        signals_by_tf[tf] = signals
        summaries[tf] = summarize_timeframe(signals, tf)
        all_signals.extend(signals)

    all_signals.sort(key=lambda s: s.timestamp)

    confluence = build_confluence_and_forecast(summaries, vix_level)

    yahoo_daily = fetch_yahoo_mes_daily()
    yahoo_latest_close = None
    if not yahoo_daily.empty:
        yahoo_latest_close = _round2(float(yahoo_daily.iloc[-1]["close"]))

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "primary": "Databento",
            "macro_filter": "FRED VIXCLS",
            "daily_validation": "Yahoo Finance",
        },
        "vix_level": _round2(vix_level),
        "vix_regime": classify_vix_regime(vix_level),
        "timeframe_summaries": {k: asdict(v) for k, v in summaries.items()},
        "confluence": confluence,
        "signals": [asdict(s) for s in all_signals],
        "yahoo_latest_close": yahoo_latest_close,
    }


def signals_to_frame(signals: Sequence[HalseySignal]) -> pd.DataFrame:
    if not signals:
        return pd.DataFrame()
    return pd.DataFrame([asdict(s) for s in signals])


def print_report(result: Dict[str, object], last_n_per_tf: int = 3) -> None:
    print("=" * 88)
    print("MES Intraday Halsey MM Module")
    print(f"Generated UTC: {result['generated_at']}")
    print(
        f"VIX (FRED): {result['vix_level']:.2f} | Regime: {result['vix_regime']}"
    )
    print(f"Confluence bias: {result['confluence']['bias']} (score={result['confluence']['score']})")

    ranges = result["confluence"]["forecast_ranges_pct"]
    print("Forecast ranges (%):")
    for horizon in ["1_week", "1_month", "1_quarter", "6_year"]:
        lo, hi = ranges[horizon]
        print(f"  {horizon}: {lo:+.2f}% to {hi:+.2f}%")

    print("\nLatest timeframe snapshots:")
    for tf in TIMEFRAME_ORDER:
        snap = result["timeframe_summaries"][tf]
        print(
            f"  {tf:>3} | dir={snap['latest_direction']:<7} "
            f"signals={snap['signal_count']:>3} enabled={snap['enabled_signal_count']:>3} "
            f"entry={snap['latest_entry']} target={snap['latest_target_100']}"
        )

    signals = pd.DataFrame(result["signals"])
    if signals.empty:
        print("\nNo Halsey MM signals found for the current lookback/order settings.")
        print("=" * 88)
        return

    print("\nMost recent signals per timeframe:")
    for tf in TIMEFRAME_ORDER:
        tf_rows = signals[signals["timeframe"] == tf].tail(last_n_per_tf)
        if tf_rows.empty:
            print(f"  {tf}: none")
            continue
        print(f"  {tf}:")
        for _, row in tf_rows.iterrows():
            status = "ON" if row["enabled"] else f"OFF ({row['filter_reason']})"
            print(
                "    "
                f"{row['timestamp']} {row['direction']:<5} "
                f"entry={row['entry']:.2f} stop={row['stop']:.2f} "
                f"t100={row['target_100']:.2f} rr={row['risk_reward_100']:.2f} {status}"
            )

    yahoo_close = result.get("yahoo_latest_close")
    if yahoo_close is not None:
        print(f"\nYahoo daily validation close: {yahoo_close:.2f}")

    print("=" * 88)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Standalone MES intraday Halsey measured-move scanner (Databento + FRED + Yahoo)."
    )
    parser.add_argument("--days-back", type=int, default=90)
    parser.add_argument("--swing-order", type=int, default=5)
    parser.add_argument("--min-rr", type=float, default=2.0)
    parser.add_argument("--require-volume-confirmation", action="store_true")
    parser.add_argument("--last-n", type=int, default=3)
    parser.add_argument(
        "--csv",
        type=Path,
        default=Path("mes_halsey_signals.csv"),
        help="Where to write signal rows",
    )
    return parser.parse_args()


def main() -> None:
    load_dotenv()
    args = parse_args()

    result = run_multi_timeframe_analysis(
        days_back=args.days_back,
        order=args.swing_order,
        min_rr=args.min_rr,
        require_volume_confirmation=args.require_volume_confirmation,
    )
    print_report(result, last_n_per_tf=args.last_n)

    signals_df = pd.DataFrame(result["signals"])
    if not signals_df.empty:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        signals_df.to_csv(args.csv, index=False)
        print(f"Saved {len(signals_df)} signals to {args.csv}")
    else:
        print("No signal rows to save")


if __name__ == "__main__":
    main()
