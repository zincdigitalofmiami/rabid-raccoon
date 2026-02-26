#!/usr/bin/env python3
"""
Convert raw Databento .dbn.zst batch downloads to filtered per-symbol per-month parquet files.

Input:
  datasets/options-ohlcv-raw/{job_id}/*.dbn.zst
  datasets/options-statistics-raw/{job_id}/*.dbn.zst

Output:
  datasets/options-ohlcv/{PARENT}/YYYY-MM.parquet
  datasets/options-statistics/{PARENT}/YYYY-MM.parquet

Statistics are filtered to keep only stat_types:
  3  = Settlement
  6  = Cleared Volume (daily)
  9  = Open Interest
  14 = Implied Volatility
  15 = Delta

Usage:
  source .env.local
  .venv-finance/bin/python scripts/convert-options-raw.py
  .venv-finance/bin/python scripts/convert-options-raw.py --stats-only
  .venv-finance/bin/python scripts/convert-options-raw.py --ohlcv-only
"""
import databento as db
import pandas as pd
from pathlib import Path
import sys
import re
import time

# ─── Configuration ──────────────────────────────────────────────────────────

# 15 CME option parents — loaded from symbol registry (AGENTS.md Rule #1)
from lib.registry import get_symbols_by_role
SYMBOLS = get_symbols_by_role("OPTIONS_PARENT")

# Stat types to keep for statistics schema
KEEP_STAT_TYPES = {3, 6, 9, 14, 15}

STAT_TYPE_NAMES = {
    1: "OpeningPrice",
    2: "IndicativeOpeningPrice",
    3: "Settlement",
    4: "SessionLow",
    5: "SessionHigh",
    6: "ClearedVolume",
    7: "LowestOffer",
    8: "HighestBid",
    9: "OpenInterest",
    10: "FixingPrice",
    14: "ImpliedVolatility",
    15: "Delta",
}

# Map root codes → parent symbols, sorted longest-first for prefix matching
ROOT_TO_PARENT = {sym.replace(".OPT", ""): sym for sym in SYMBOLS}
ROOTS_SORTED = sorted(ROOT_TO_PARENT.keys(), key=len, reverse=True)

# Paths
BASE = Path("datasets")
RAW_STATS = BASE / "options-statistics-raw"
RAW_OHLCV = BASE / "options-ohlcv-raw"
OUT_STATS = BASE / "options-statistics"
OUT_OHLCV = BASE / "options-ohlcv"


# ─── Helpers ────────────────────────────────────────────────────────────────

def symbol_to_parent(symbol_str: str) -> str | None:
    """Map individual contract symbol to its parent.

    Examples:
      'ESM5 C5000'  → 'ES.OPT'
      'NQZ5 P17000' → 'NQ.OPT'
      'OZN5 C11100' → 'OZN.OPT'
    """
    if not isinstance(symbol_str, str):
        return None
    for root in ROOTS_SORTED:
        if symbol_str.startswith(root):
            return ROOT_TO_PARENT[root]
    return None


def extract_month_from_filename(filename: str) -> str | None:
    """Extract YYYY-MM from Databento batch filename.

    Format: glbx-mdp3-{YYYYMMDD}-{YYYYMMDD}.{schema}.dbn.zst
    The first date is the start of the month.
    """
    m = re.search(r"(\d{4})(\d{2})\d{2}-\d{8}", filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}"
    return None


def process_file(dbn_path: Path, schema_type: str, out_base: Path) -> dict:
    """Process a single .dbn.zst file. Returns stats dict."""
    stats = {"file": dbn_path.name, "input_rows": 0, "output_rows": 0, "parents": []}

    print(f"  Reading {dbn_path.name} ...")
    store = db.DBNStore.from_file(str(dbn_path))
    df = store.to_df()

    # DBNStore.to_df() puts ts_event as the index — reset it to a column
    if df.index.name == "ts_event" or df.index.name is not None:
        df = df.reset_index()

    if df.empty:
        print(f"    (empty — skipping)")
        return stats

    stats["input_rows"] = len(df)
    initial_rows = len(df)

    # Filter statistics to keep only desired stat types
    if schema_type == "statistics" and "stat_type" in df.columns:
        df = df[df["stat_type"].isin(KEEP_STAT_TYPES)]
        filtered_rows = len(df)
        print(f"    Filtered stats: {initial_rows:,} → {filtered_rows:,} rows")
        if df.empty:
            print(f"    (no matching stat_types — skipping)")
            return stats

    # Determine the month from filename or data
    month_str = extract_month_from_filename(dbn_path.name)
    if not month_str:
        # Fallback: use first event timestamp
        ts_col = "ts_event" if "ts_event" in df.columns else None
        if ts_col is None:
            # Check for index-based timestamp
            if hasattr(df.index, 'name') and df.index.name == "ts_event":
                month_str = pd.Timestamp(df.index[0]).strftime("%Y-%m")
        else:
            month_str = pd.Timestamp(df[ts_col].iloc[0]).strftime("%Y-%m")

    if not month_str:
        print(f"    WARNING: Could not determine month, skipping")
        return stats

    # Resolve symbol column
    # DBNStore.to_df() may put symbol as a column or the index may have ts_event
    # The symbol is resolved from the DBN metadata's symbology mappings
    symbol_col = None
    for col_name in ["symbol", "raw_symbol", "stype_out_symbol"]:
        if col_name in df.columns:
            symbol_col = col_name
            break

    if symbol_col is None:
        # Maybe the index contains the symbol info, or we need instrument_id mapping
        print(f"    WARNING: No symbol column found. Columns: {list(df.columns)}")
        print(f"    Saving entire file without parent split as {month_str}.parquet")
        out_dir = out_base / "_unsorted"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{month_str}.parquet"
        df.to_parquet(out_path, index=False)
        stats["output_rows"] = len(df)
        return stats

    # Map symbols to parents
    df["parent"] = df[symbol_col].apply(symbol_to_parent)

    unmapped = df["parent"].isna().sum()
    if unmapped > 0:
        unmapped_examples = df[df["parent"].isna()][symbol_col].unique()[:5]
        print(f"    WARNING: {unmapped:,} rows with unmapped symbols: {list(unmapped_examples)}")

    df = df.dropna(subset=["parent"])

    if df.empty:
        print(f"    (no rows after parent mapping — skipping)")
        return stats

    # Save per-parent
    parents_seen = []
    for parent, group in df.groupby("parent"):
        safe_parent = parent.replace(".", "_")  # ES.OPT → ES_OPT
        out_dir = out_base / safe_parent
        out_dir.mkdir(parents=True, exist_ok=True)
        out_path = out_dir / f"{month_str}.parquet"

        # Drop the parent column before saving
        save_df = group.drop(columns=["parent"])
        save_df.to_parquet(out_path, index=False)
        print(f"    {parent}: {len(save_df):,} rows → {out_path}")
        parents_seen.append(parent)
        stats["output_rows"] += len(save_df)

    stats["parents"] = parents_seen
    return stats


def process_raw_dir(raw_dir: Path, schema_type: str, out_base: Path) -> list[dict]:
    """Process all .dbn.zst files in a raw download directory tree."""
    if not raw_dir.exists():
        print(f"\n  Raw directory not found: {raw_dir}")
        return []

    dbn_files = sorted(raw_dir.rglob("*.dbn.zst"))
    if not dbn_files:
        print(f"\n  No .dbn.zst files found in {raw_dir}")
        return []

    print(f"\n{'='*70}")
    print(f"Processing {schema_type}: {len(dbn_files)} files")
    print(f"  Input:  {raw_dir}/")
    print(f"  Output: {out_base}/")
    if schema_type == "statistics":
        print(f"  Filter: stat_types {KEEP_STAT_TYPES}")
    print(f"{'='*70}")

    all_stats = []
    for i, f in enumerate(dbn_files, 1):
        print(f"\n[{i}/{len(dbn_files)}] {f.relative_to(raw_dir)}")
        try:
            file_stats = process_file(f, schema_type, out_base)
            all_stats.append(file_stats)
        except Exception as e:
            print(f"    ERROR: {e}")
            all_stats.append({"file": f.name, "error": str(e)})

    return all_stats


def print_summary(ohlcv_stats: list[dict], stats_stats: list[dict]) -> None:
    """Print per-schema row counts and parent breakdowns after conversion."""
    print(f"\n{'='*70}")
    print("CONVERSION SUMMARY")
    print(f"{'='*70}")

    for label, stats_list in [("OHLCV-1D", ohlcv_stats), ("Statistics", stats_stats)]:
        if not stats_list:
            continue
        total_in = sum(s.get("input_rows", 0) for s in stats_list)
        total_out = sum(s.get("output_rows", 0) for s in stats_list)
        errors = sum(1 for s in stats_list if "error" in s)
        all_parents = set()
        for s in stats_list:
            all_parents.update(s.get("parents", []))

        print(f"\n  {label}:")
        print(f"    Files processed: {len(stats_list)}")
        print(f"    Input rows:      {total_in:,}")
        print(f"    Output rows:     {total_out:,}")
        print(f"    Parents found:   {len(all_parents)} — {sorted(all_parents)}")
        if errors:
            print(f"    Errors:          {errors}")


def main() -> None:
    """CLI entrypoint — convert raw .dbn.zst downloads to per-parent parquet files."""
    t0 = time.time()

    do_stats = "--stats-only" in sys.argv or ("--ohlcv-only" not in sys.argv)
    do_ohlcv = "--ohlcv-only" in sys.argv or ("--stats-only" not in sys.argv)

    print("Databento Options Data Converter")
    print(f"  Parents: {len(SYMBOLS)}")
    print(f"  Stat filter: {sorted(KEEP_STAT_TYPES)} → {[STAT_TYPE_NAMES[t] for t in sorted(KEEP_STAT_TYPES)]}")

    ohlcv_stats = []
    stats_stats = []

    if do_ohlcv:
        ohlcv_stats = process_raw_dir(RAW_OHLCV, "ohlcv-1d", OUT_OHLCV)

    if do_stats:
        stats_stats = process_raw_dir(RAW_STATS, "statistics", OUT_STATS)

    print_summary(ohlcv_stats, stats_stats)

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
