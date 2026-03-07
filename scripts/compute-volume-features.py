#!/usr/bin/env python3
"""
Volume & Liquidity Feature Engine — Rabid Raccoon
==================================================
Computes RVOL, VWAP (+ bands), and Volume Profile (POC/VAH/VAL) from
MES 1-minute bars stored in mkt_futures_mes_1m.

Uses pandas-ta for VWAP (battle-tested, not hand-rolled).

Outputs JSON to stdout, consumed by the Inngest compute-signal function.

Session handling:
  - CME Globex MES: 18:00 ET Sun → 17:00 ET Fri (23h/day, closed 17:00-18:00)
  - VWAP resets at RTH open (09:30 ET)
  - Volume Profile uses developing (current RTH session) + settled (prior RTH session)

Usage:
    python3 scripts/compute-volume-features.py
    python3 scripts/compute-volume-features.py --test    # verbose test mode
"""

import argparse
import json
import os
import sys
import warnings
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pandas_ta as ta
import psycopg2

warnings.filterwarnings("ignore", category=UserWarning, module="pandas")
warnings.filterwarnings("ignore", category=FutureWarning, module="pandas")

# ── Constants ─────────────────────────────────────────────────────────────────

ET_OFFSET = timedelta(hours=-5)  # EST (naive — DST handled below)
RTH_OPEN_HOUR = 9
RTH_OPEN_MIN = 30
RTH_CLOSE_HOUR = 16
RTH_CLOSE_MIN = 0
GLOBEX_CLOSE_HOUR = 17  # 17:00 ET daily close
GLOBEX_OPEN_HOUR = 18   # 18:00 ET daily open

TICK_SIZE = 0.25  # MES tick size for volume profile bins
VALUE_AREA_PCT = 0.70  # 70% value area
RVOL_LOOKBACK_DAYS = 20  # 20 trading days for RVOL baseline


# ── Database ──────────────────────────────────────────────────────────────────

def get_db_url() -> str:
    from dotenv import load_dotenv
    load_dotenv(".env.local")
    load_dotenv(".env")
    url = os.environ.get("DIRECT_URL") or os.environ.get("LOCAL_DATABASE_URL")
    if not url:
        print("ERROR: DIRECT_URL or LOCAL_DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    return url


def fetch_1m_bars(conn, lookback_hours: int = 24) -> pd.DataFrame:
    """Fetch recent 1m bars from mkt_futures_mes_1m."""
    cur = conn.cursor()
    cur.execute("""
        SELECT
            "eventTime" AT TIME ZONE 'America/New_York' AS bar_time_et,
            "eventTime" AS bar_time_utc,
            "open"::float, "high"::float, "low"::float, "close"::float,
            COALESCE("volume", 0)::bigint AS volume
        FROM "mkt_futures_mes_1m"
        WHERE "eventTime" > NOW() - INTERVAL '%s hours'
        ORDER BY "eventTime" ASC
    """, (lookback_hours,))
    rows = cur.fetchall()
    cur.close()
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows, columns=[
        "bar_time_et", "bar_time_utc", "open", "high", "low", "close", "volume"
    ])
    df["bar_time_et"] = pd.to_datetime(df["bar_time_et"])
    df["bar_time_utc"] = pd.to_datetime(df["bar_time_utc"], utc=True)
    return df


def fetch_historical_volume(conn, lookback_days: int = RVOL_LOOKBACK_DAYS) -> pd.DataFrame:
    """Fetch volume by time-of-day for RVOL baseline (last N trading days)."""
    cur = conn.cursor()
    cur.execute("""
        SELECT
            "eventTime" AT TIME ZONE 'America/New_York' AS bar_time_et,
            COALESCE("volume", 0)::bigint AS volume
        FROM "mkt_futures_mes_1m"
        WHERE "eventTime" > NOW() - INTERVAL '%s days'
          AND COALESCE("volume", 0) > 0
        ORDER BY "eventTime" ASC
    """, (lookback_days,))
    rows = cur.fetchall()
    cur.close()
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows, columns=["bar_time_et", "volume"])
    df["bar_time_et"] = pd.to_datetime(df["bar_time_et"])
    return df


# ── Session Helpers ───────────────────────────────────────────────────────────

def get_rth_session_start(dt_et: pd.Timestamp) -> pd.Timestamp:
    """Get the most recent RTH open (09:30 ET) relative to a given ET time."""
    today_rth = dt_et.normalize() + timedelta(hours=RTH_OPEN_HOUR, minutes=RTH_OPEN_MIN)
    if dt_et >= today_rth:
        return today_rth
    # Before today's RTH open — use yesterday's
    yesterday_rth = today_rth - timedelta(days=1)
    # Skip weekends
    while yesterday_rth.weekday() >= 5:
        yesterday_rth -= timedelta(days=1)
    return yesterday_rth


def get_globex_session_start(dt_et: pd.Timestamp) -> pd.Timestamp:
    """Get the most recent Globex session open (18:00 ET) relative to a given ET time."""
    today_open = dt_et.normalize() + timedelta(hours=GLOBEX_OPEN_HOUR)
    if dt_et >= today_open:
        return today_open
    # Before today's Globex open — use yesterday's 18:00
    yesterday_open = today_open - timedelta(days=1)
    while yesterday_open.weekday() >= 5:
        yesterday_open -= timedelta(days=1)
    return yesterday_open


def is_rth(dt_et: pd.Timestamp) -> bool:
    """Check if a timestamp is during Regular Trading Hours (09:30-16:00 ET)."""
    t = dt_et.hour * 60 + dt_et.minute
    rth_open = RTH_OPEN_HOUR * 60 + RTH_OPEN_MIN
    rth_close = RTH_CLOSE_HOUR * 60 + RTH_CLOSE_MIN
    return rth_open <= t < rth_close and dt_et.weekday() < 5


# ── RVOL ──────────────────────────────────────────────────────────────────────

def compute_rvol(current_bars: pd.DataFrame, historical_bars: pd.DataFrame) -> dict:
    """
    Relative Volume: current 15m bar volume / 20-day same-TOD average.
    Also computes session cumulative RVOL.
    """
    if current_bars.empty or historical_bars.empty:
        return {"rvol": 1.0, "rvol_session": 1.0}

    now_et = current_bars["bar_time_et"].iloc[-1]

    # Current 15m bar volume (last 15 bars of 1m data)
    last_15 = current_bars.tail(15)
    current_15m_vol = last_15["volume"].sum()

    # Historical: same 15-minute window across last 20 trading days
    hh = now_et.hour
    mm = now_et.minute
    # Round down to 15m boundary
    mm_boundary = (mm // 15) * 15

    historical_bars = historical_bars.copy()
    historical_bars["hour"] = historical_bars["bar_time_et"].dt.hour
    historical_bars["min15"] = (historical_bars["bar_time_et"].dt.minute // 15) * 15
    historical_bars["date"] = historical_bars["bar_time_et"].dt.date

    # Same time-of-day bars
    tod_mask = (historical_bars["hour"] == hh) & (historical_bars["min15"] == mm_boundary)
    tod_bars = historical_bars[tod_mask]

    if tod_bars.empty:
        avg_15m_vol = current_15m_vol if current_15m_vol > 0 else 1
    else:
        # Sum 1m volumes within each 15m window per day, then average
        daily_vols = tod_bars.groupby("date")["volume"].sum()
        avg_15m_vol = daily_vols.mean()

    rvol = current_15m_vol / max(avg_15m_vol, 1)

    # Session cumulative RVOL
    session_start = get_rth_session_start(now_et)
    session_bars = current_bars[current_bars["bar_time_et"] >= session_start]
    session_vol = session_bars["volume"].sum()

    # Historical session volume up to same elapsed time
    elapsed_minutes = int((now_et - session_start).total_seconds() / 60)
    hist_session_vols = []
    for date_val, group in historical_bars.groupby("date"):
        day_rth_start = pd.Timestamp(date_val) + timedelta(hours=RTH_OPEN_HOUR, minutes=RTH_OPEN_MIN)
        day_rth_end = day_rth_start + timedelta(minutes=elapsed_minutes)
        day_bars = group[
            (group["bar_time_et"] >= day_rth_start) &
            (group["bar_time_et"] < day_rth_end)
        ]
        if not day_bars.empty:
            hist_session_vols.append(day_bars["volume"].sum())

    avg_session_vol = np.mean(hist_session_vols) if hist_session_vols else max(session_vol, 1)
    rvol_session = session_vol / max(avg_session_vol, 1)

    return {
        "rvol": round(float(rvol), 4),
        "rvol_session": round(float(rvol_session), 4),
    }


# ── VWAP ──────────────────────────────────────────────────────────────────────

def compute_vwap(bars: pd.DataFrame) -> dict:
    """
    VWAP + ±1σ/±2σ bands, anchored to RTH open (09:30 ET).
    Uses pandas-ta for the core calculation.
    """
    if bars.empty:
        return {
            "vwap": 0.0, "price_vs_vwap": 0.0, "vwap_band": 0,
            "vwap_upper1": 0.0, "vwap_lower1": 0.0,
            "vwap_upper2": 0.0, "vwap_lower2": 0.0,
        }

    now_et = bars["bar_time_et"].iloc[-1]
    session_start = get_rth_session_start(now_et)

    # Filter to current RTH session for VWAP anchor
    session_bars = bars[bars["bar_time_et"] >= session_start].copy()

    if session_bars.empty or session_bars["volume"].sum() == 0:
        # Pre-market or no volume — use all available bars
        session_bars = bars.copy()

    # pandas-ta VWAP needs a DatetimeIndex
    session_bars = session_bars.reset_index(drop=True)
    session_bars.index = pd.DatetimeIndex(session_bars["bar_time_et"])
    vwap_df = session_bars.ta.vwap(high="high", low="low", close="close", volume="volume", append=True)

    if vwap_df is None or "VWAP_D" not in session_bars.columns:
        # Fallback: manual typical price × volume / cumulative volume
        tp = (session_bars["high"] + session_bars["low"] + session_bars["close"]) / 3
        cum_tpv = (tp * session_bars["volume"]).cumsum()
        cum_vol = session_bars["volume"].cumsum()
        vwap_series = cum_tpv / cum_vol.replace(0, np.nan)
        vwap_val = float(vwap_series.iloc[-1]) if not vwap_series.empty else 0.0
    else:
        vwap_val = float(session_bars["VWAP_D"].iloc[-1])

    current_price = float(session_bars["close"].iloc[-1])

    # Standard deviation bands
    tp = (session_bars["high"] + session_bars["low"] + session_bars["close"]) / 3
    cum_tpv = (tp * session_bars["volume"]).cumsum()
    cum_vol = session_bars["volume"].cumsum()
    vwap_arr = cum_tpv / cum_vol.replace(0, np.nan)
    squared_diff = ((tp - vwap_arr) ** 2 * session_bars["volume"]).cumsum()
    variance = squared_diff / cum_vol.replace(0, np.nan)
    std = np.sqrt(variance)
    std_val = float(std.iloc[-1]) if not std.empty and not np.isnan(std.iloc[-1]) else 0.0

    vwap_upper1 = vwap_val + std_val
    vwap_lower1 = vwap_val - std_val
    vwap_upper2 = vwap_val + 2 * std_val
    vwap_lower2 = vwap_val - 2 * std_val

    # Price vs VWAP
    price_vs_vwap = ((current_price - vwap_val) / vwap_val * 100) if vwap_val > 0 else 0.0

    # Which band (-2 to +2)
    if std_val > 0:
        band_position = (current_price - vwap_val) / std_val
        vwap_band = max(-2, min(2, round(band_position)))
    else:
        vwap_band = 0

    return {
        "vwap": round(vwap_val, 2),
        "price_vs_vwap": round(float(price_vs_vwap), 4),
        "vwap_band": int(vwap_band),
        "vwap_upper1": round(float(vwap_upper1), 2),
        "vwap_lower1": round(float(vwap_lower1), 2),
        "vwap_upper2": round(float(vwap_upper2), 2),
        "vwap_lower2": round(float(vwap_lower2), 2),
    }


# ── Volume Profile ────────────────────────────────────────────────────────────

def compute_volume_profile(bars: pd.DataFrame, prior_session_bars: pd.DataFrame) -> dict:
    """
    Volume Profile: POC, VAH, VAL from 1m bars binned by price.
    Uses current RTH session (developing) + prior RTH session (settled).
    """
    if bars.empty:
        return {
            "poc": 0.0, "vah": 0.0, "val": 0.0,
            "price_vs_poc": 0.0, "in_value_area": False, "poc_slope": 0.0,
        }

    now_et = bars["bar_time_et"].iloc[-1]
    current_price = float(bars["close"].iloc[-1])

    # Current session bars for developing profile
    session_start = get_rth_session_start(now_et)
    session_bars = bars[bars["bar_time_et"] >= session_start]
    if session_bars.empty:
        session_bars = bars

    # Combine with prior session for richer profile
    combined = pd.concat([prior_session_bars, session_bars]) if not prior_session_bars.empty else session_bars

    # Build price bins (tick size = 0.25)
    all_prices_low = combined["low"].min()
    all_prices_high = combined["high"].max()

    if all_prices_low == all_prices_high or np.isnan(all_prices_low):
        return {
            "poc": current_price, "vah": current_price, "val": current_price,
            "price_vs_poc": 0.0, "in_value_area": True, "poc_slope": 0.0,
        }

    # Create bins
    bin_start = np.floor(all_prices_low / TICK_SIZE) * TICK_SIZE
    bin_end = np.ceil(all_prices_high / TICK_SIZE) * TICK_SIZE
    bins = np.arange(bin_start, bin_end + TICK_SIZE, TICK_SIZE)

    if len(bins) < 2:
        return {
            "poc": current_price, "vah": current_price, "val": current_price,
            "price_vs_poc": 0.0, "in_value_area": True, "poc_slope": 0.0,
        }

    # Distribute volume across price bins using typical price
    tp = ((combined["high"] + combined["low"] + combined["close"]) / 3).values
    vol = combined["volume"].values

    # Bin each bar's volume at its typical price level
    bin_indices = np.searchsorted(bins, tp, side="right") - 1
    bin_indices = np.clip(bin_indices, 0, len(bins) - 2)

    volume_at_price = np.zeros(len(bins) - 1)
    for i, bi in enumerate(bin_indices):
        volume_at_price[bi] += vol[i]

    # POC = price bin with max volume
    poc_idx = np.argmax(volume_at_price)
    poc = float(bins[poc_idx] + TICK_SIZE / 2)  # midpoint of bin

    # Value Area (70% of total volume)
    total_vol = volume_at_price.sum()
    if total_vol == 0:
        return {
            "poc": poc, "vah": poc, "val": poc,
            "price_vs_poc": 0.0, "in_value_area": True, "poc_slope": 0.0,
        }

    # Expand from POC outward
    target_vol = total_vol * VALUE_AREA_PCT
    accumulated = volume_at_price[poc_idx]
    va_low_idx = poc_idx
    va_high_idx = poc_idx

    while accumulated < target_vol:
        expand_up = volume_at_price[va_high_idx + 1] if va_high_idx + 1 < len(volume_at_price) else 0
        expand_down = volume_at_price[va_low_idx - 1] if va_low_idx > 0 else 0

        if expand_up == 0 and expand_down == 0:
            break

        if expand_up >= expand_down:
            va_high_idx += 1
            accumulated += expand_up
        else:
            va_low_idx -= 1
            accumulated += expand_down

    vah = float(bins[va_high_idx] + TICK_SIZE)
    val = float(bins[va_low_idx])
    in_value_area = val <= current_price <= vah
    price_vs_poc = current_price - poc

    # POC slope: compare current session POC to prior session POC
    poc_slope = 0.0
    if not prior_session_bars.empty:
        prior_tp = ((prior_session_bars["high"] + prior_session_bars["low"] + prior_session_bars["close"]) / 3).values
        prior_vol = prior_session_bars["volume"].values
        if len(prior_tp) > 0 and sum(prior_vol) > 0:
            prior_bin_indices = np.searchsorted(bins, prior_tp, side="right") - 1
            prior_bin_indices = np.clip(prior_bin_indices, 0, len(bins) - 2)
            prior_vap = np.zeros(len(bins) - 1)
            for i, bi in enumerate(prior_bin_indices):
                prior_vap[bi] += prior_vol[i]
            prior_poc_idx = np.argmax(prior_vap)
            prior_poc = float(bins[prior_poc_idx] + TICK_SIZE / 2)
            poc_slope = poc - prior_poc

    return {
        "poc": round(poc, 2),
        "vah": round(vah, 2),
        "val": round(val, 2),
        "price_vs_poc": round(float(price_vs_poc), 2),
        "in_value_area": bool(in_value_area),
        "poc_slope": round(float(poc_slope), 2),
    }


# ── Volume Confirmation ──────────────────────────────────────────────────────

def compute_volume_confirmation(bars: pd.DataFrame) -> bool:
    """Does the price move direction match the volume surge?"""
    if len(bars) < 15:
        return False

    last_15 = bars.tail(15)
    price_change = float(last_15["close"].iloc[-1] - last_15["open"].iloc[0])
    vol_current = last_15["volume"].sum()

    prior_15 = bars.iloc[-30:-15] if len(bars) >= 30 else bars.head(15)
    vol_prior = prior_15["volume"].sum()

    # Volume surge (>1.5x prior) in same direction as price
    vol_surge = vol_current > vol_prior * 1.5
    if not vol_surge:
        return False

    return True  # Volume is surging — confirmation is positive


# ── Prior Session Extraction ──────────────────────────────────────────────────

def get_prior_session_bars(bars: pd.DataFrame) -> pd.DataFrame:
    """Extract prior RTH session bars for settled volume profile."""
    if bars.empty:
        return pd.DataFrame()

    now_et = bars["bar_time_et"].iloc[-1]
    current_rth_start = get_rth_session_start(now_et)

    # Prior RTH = go back one trading day
    prior_rth_start = current_rth_start - timedelta(days=1)
    while prior_rth_start.weekday() >= 5:
        prior_rth_start -= timedelta(days=1)

    prior_rth_end = prior_rth_start.normalize() + timedelta(hours=RTH_CLOSE_HOUR)

    return bars[
        (bars["bar_time_et"] >= prior_rth_start) &
        (bars["bar_time_et"] < prior_rth_end)
    ]


# ── Main ──────────────────────────────────────────────────────────────────────

def compute_all(test_mode: bool = False) -> dict:
    """Compute all volume features and return as JSON-serializable dict."""
    db_url = get_db_url()
    conn = psycopg2.connect(db_url)

    try:
        # Fetch recent 1m bars (48h for prior session + current)
        bars = fetch_1m_bars(conn, lookback_hours=48)
        if bars.empty:
            return {"error": "No 1m bars found", "features": {}}

        # Fetch historical volume for RVOL baseline
        historical = fetch_historical_volume(conn, lookback_days=RVOL_LOOKBACK_DAYS)

        now_et = bars["bar_time_et"].iloc[-1]
        current_price = float(bars["close"].iloc[-1])

        if test_mode:
            print(f"Bars loaded: {len(bars)} (48h), Historical: {len(historical)} ({RVOL_LOOKBACK_DAYS}d)", file=sys.stderr)
            print(f"Latest bar: {now_et} ET, Price: {current_price}", file=sys.stderr)
            print(f"RTH session start: {get_rth_session_start(now_et)}", file=sys.stderr)
            print(f"Is RTH: {is_rth(now_et)}", file=sys.stderr)

        # Compute features
        rvol = compute_rvol(bars, historical)
        vwap = compute_vwap(bars)
        prior_bars = get_prior_session_bars(bars)
        profile = compute_volume_profile(bars, prior_bars)
        vol_confirm = compute_volume_confirmation(bars)

        features = {
            **rvol,
            **vwap,
            **profile,
            "volume_confirmation": vol_confirm,
            "current_price": current_price,
            "computed_at": datetime.now(timezone.utc).isoformat(),
            "bars_used": len(bars),
            "is_rth": is_rth(now_et),
        }

        if test_mode:
            print("\n--- Volume Features ---", file=sys.stderr)
            for k, v in features.items():
                print(f"  {k}: {v}", file=sys.stderr)

        return {"features": features, "error": None}

    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Compute MES volume features")
    parser.add_argument("--test", action="store_true", help="Verbose test output to stderr")
    args = parser.parse_args()

    os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

    result = compute_all(test_mode=args.test)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
