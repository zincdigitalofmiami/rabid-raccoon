#!/usr/bin/env python3
"""
Aggregate per-contract options parquet data into daily parent-level summaries.

Reads:
  datasets/options-statistics/{PARENT}/YYYY-MM.parquet
  datasets/options-ohlcv/{PARENT}/YYYY-MM.parquet

Writes:
  datasets/options-agg/{PARENT}/stats-agg.parquet   (daily stats summary)
  datasets/options-agg/{PARENT}/ohlcv-agg.parquet   (daily OHLCV summary)

These aggregated files can be loaded into the MktOptionsStatistics1d and MktOptionsOhlcv1d
tables via the ingestion pipeline, or used directly by the dataset builders.

Usage:
  .venv-finance/bin/python scripts/aggregate-options.py
  .venv-finance/bin/python scripts/aggregate-options.py --parent ES_OPT
  .venv-finance/bin/python scripts/aggregate-options.py --stats-only
  .venv-finance/bin/python scripts/aggregate-options.py --ohlcv-only
"""
import pandas as pd
import numpy as np
from pathlib import Path
import sys
import time

# ─── Configuration ──────────────────────────────────────────────────────────

BASE = Path("datasets")
STATS_DIR = BASE / "options-statistics"
OHLCV_DIR = BASE / "options-ohlcv"
AGG_DIR = BASE / "options-agg"

# Stat type enum from Databento
STAT_SETTLEMENT = 3
STAT_VOLUME = 6
STAT_OI = 9
STAT_IV = 14
STAT_DELTA = 15


# ─── Helpers ────────────────────────────────────────────────────────────────

def load_parent_parquets(parent_dir: Path) -> pd.DataFrame:
    """Load all monthly parquet files for a parent symbol into one DataFrame."""
    files = sorted(parent_dir.glob("*.parquet"))
    if not files:
        return pd.DataFrame()

    dfs = []
    for f in files:
        try:
            df = pd.read_parquet(f)
            dfs.append(df)
        except Exception as e:
            print(f"    WARNING: Failed to read {f.name}: {e}")

    if not dfs:
        return pd.DataFrame()

    return pd.concat(dfs, ignore_index=True)


def aggregate_statistics(parent_name: str, df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per-contract statistics into daily parent-level summary.

    Output columns: eventDate, totalVolume, totalOI, settlement, avgIV, contractCount
    """
    if df.empty:
        return pd.DataFrame()

    # Determine the date column — ts_event is typically a datetime
    date_col = None
    for col in ["ts_event", "ts_ref"]:
        if col in df.columns:
            date_col = col
            break

    if date_col is None:
        print(f"    WARNING: No timestamp column found for {parent_name}")
        return pd.DataFrame()

    df["eventDate"] = pd.to_datetime(df[date_col]).dt.date

    # stat_type column from Databento statistics schema
    if "stat_type" not in df.columns:
        print(f"    WARNING: No stat_type column for {parent_name}")
        return pd.DataFrame()

    # Pivot by stat type for each day
    results = []

    for date, day_df in df.groupby("eventDate"):
        row = {"eventDate": date, "parentSymbol": parent_name.replace("_", ".")}

        # Cleared Volume (stat_type=6): sum of quantity across all contracts
        vol_rows = day_df[day_df["stat_type"] == STAT_VOLUME]
        row["totalVolume"] = int(vol_rows["quantity"].sum()) if len(vol_rows) > 0 and "quantity" in vol_rows.columns else None

        # Open Interest (stat_type=9): sum of quantity
        oi_rows = day_df[day_df["stat_type"] == STAT_OI]
        row["totalOI"] = int(oi_rows["quantity"].sum()) if len(oi_rows) > 0 and "quantity" in oi_rows.columns else None

        # Settlement (stat_type=3): use the first/front-month settlement price
        settle_rows = day_df[day_df["stat_type"] == STAT_SETTLEMENT]
        if len(settle_rows) > 0 and "price" in settle_rows.columns:
            # Use median settlement as representative (front-month is noisy to detect)
            row["settlement"] = float(settle_rows["price"].median())
        else:
            row["settlement"] = None

        # Implied Volatility (stat_type=14): volume-weighted average
        iv_rows = day_df[day_df["stat_type"] == STAT_IV]
        if len(iv_rows) > 0 and "price" in iv_rows.columns:
            # Price field holds the IV value for stat_type=14
            if "quantity" in iv_rows.columns and iv_rows["quantity"].sum() > 0:
                weights = iv_rows["quantity"].fillna(1)
                row["avgIV"] = float(np.average(iv_rows["price"], weights=weights))
            else:
                row["avgIV"] = float(iv_rows["price"].mean())
        else:
            row["avgIV"] = None

        # Contract count: unique instruments seen this day
        if "instrument_id" in day_df.columns:
            row["contractCount"] = int(day_df["instrument_id"].nunique())
        elif "symbol" in day_df.columns:
            row["contractCount"] = int(day_df["symbol"].nunique())
        else:
            row["contractCount"] = None

        results.append(row)

    return pd.DataFrame(results)


def aggregate_ohlcv(parent_name: str, df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate per-contract OHLCV into daily parent-level summary.

    Straight aggregation of raw fields — no derived calculations.
    """
    if df.empty:
        return pd.DataFrame()

    date_col = "ts_event" if "ts_event" in df.columns else None
    if date_col is None:
        print(f"    WARNING: No timestamp column found for {parent_name}")
        return pd.DataFrame()

    df["eventDate"] = pd.to_datetime(df[date_col]).dt.date

    count_col = "instrument_id" if "instrument_id" in df.columns else (
        "symbol" if "symbol" in df.columns else None
    )

    results = []
    for date, day_df in df.groupby("eventDate"):
        row = {"eventDate": date, "parentSymbol": parent_name.replace("_", ".")}
        row["volume"] = int(day_df["volume"].sum()) if "volume" in day_df.columns else None
        row["open"] = float(day_df["open"].mean()) if "open" in day_df.columns else None
        row["high"] = float(day_df["high"].max()) if "high" in day_df.columns else None
        row["low"] = float(day_df["low"].min()) if "low" in day_df.columns else None
        row["close"] = float(day_df["close"].mean()) if "close" in day_df.columns else None
        row["contractCount"] = int(day_df[count_col].nunique()) if count_col else None
        results.append(row)

    return pd.DataFrame(results)


def process_parents(data_dir: Path, schema_type: str, target_parent: str | None = None):
    """Process all parent directories for a given schema."""
    if not data_dir.exists():
        print(f"  Directory not found: {data_dir}")
        return

    parent_dirs = sorted(data_dir.iterdir())
    parent_dirs = [d for d in parent_dirs if d.is_dir() and not d.name.startswith("_")]

    if target_parent:
        parent_dirs = [d for d in parent_dirs if d.name == target_parent]
        if not parent_dirs:
            print(f"  Parent {target_parent} not found in {data_dir}")
            return

    print(f"\n{'='*70}")
    print(f"Aggregating {schema_type}: {len(parent_dirs)} parents")
    print(f"{'='*70}")

    for parent_dir in parent_dirs:
        parent_name = parent_dir.name  # e.g., ES_OPT
        parquet_count = len(list(parent_dir.glob("*.parquet")))
        print(f"\n  {parent_name} ({parquet_count} monthly files)")

        df = load_parent_parquets(parent_dir)
        if df.empty:
            print(f"    (no data)")
            continue

        print(f"    Loaded {len(df):,} rows across {parquet_count} months")

        if schema_type == "statistics":
            agg_df = aggregate_statistics(parent_name, df)
        else:
            agg_df = aggregate_ohlcv(parent_name, df)

        if agg_df.empty:
            print(f"    (no aggregated output)")
            continue

        # Save aggregated parquet
        out_dir = AGG_DIR / parent_name
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{schema_type}-agg.parquet"
        agg_df.to_parquet(out_path, index=False)

        date_range = f"{agg_df['eventDate'].min()} to {agg_df['eventDate'].max()}"
        print(f"    Aggregated: {len(agg_df):,} daily rows ({date_range})")
        print(f"    Saved: {out_path}")


def main():
    t0 = time.time()

    target_parent = None
    do_stats = "--stats-only" in sys.argv or ("--ohlcv-only" not in sys.argv)
    do_ohlcv = "--ohlcv-only" in sys.argv or ("--stats-only" not in sys.argv)

    for arg in sys.argv[1:]:
        if arg.startswith("--parent"):
            idx = sys.argv.index(arg)
            if idx + 1 < len(sys.argv):
                target_parent = sys.argv[idx + 1]

    print("Options Data Aggregator")
    if target_parent:
        print(f"  Target: {target_parent}")

    if do_stats:
        process_parents(STATS_DIR, "statistics", target_parent)

    if do_ohlcv:
        process_parents(OHLCV_DIR, "ohlcv-1d", target_parent)

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
