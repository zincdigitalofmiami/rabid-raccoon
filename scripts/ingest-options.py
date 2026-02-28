#!/usr/bin/env python3
"""
Ingest options data into Postgres.

Reads:
  datasets/options-ohlcv/{PARENT}/YYYY-MM.parquet   → mkt_options_ohlcv_1d
  datasets/options-statistics/{PARENT}/YYYY-MM.parquet → mkt_options_statistics_1d

Optional live pull:
  Databento GLBX.MDP3 / statistics / stype_in=parent
  (used when statistics parquets are missing or delayed)

Aggregates per day per parent, inserts via UPSERT (ON CONFLICT UPDATE).
Uses LOCAL_DATABASE_URL only.

Usage:
  .venv-finance/bin/python scripts/ingest-options.py
  .venv-finance/bin/python scripts/ingest-options.py --with-stats
  .venv-finance/bin/python scripts/ingest-options.py --ohlcv-only
  .venv-finance/bin/python scripts/ingest-options.py --stats-only
  .venv-finance/bin/python scripts/ingest-options.py --stats-only --stats-live
  .venv-finance/bin/python scripts/ingest-options.py --stats-only --stats-live --start 2020-01-01 --end 2026-02-24
  .venv-finance/bin/python scripts/ingest-options.py --parent ES_OPT
  .venv-finance/bin/python scripts/ingest-options.py --dry-run
"""
import json
import os
import sys
import time
from datetime import date, timedelta
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd

from lib.registry import get_symbols_by_role

# ─── Configuration ──────────────────────────────────────────────────────────

BASE = Path("datasets")
OHLCV_DIR = BASE / "options-ohlcv"
STATS_DIR = BASE / "options-statistics"

STAT_SETTLEMENT = 3
STAT_VOLUME = 6
STAT_OI = 9
STAT_IV = 14

WEEKLY_CHUNK_PARENTS = {"ES.OPT", "NQ.OPT"}
LIVE_STATS_START_DEFAULT = "2020-01-01"

BATCH_SIZE = 500
_DB_TARGET_LOGGED = False


# ─── Shared Helpers ────────────────────────────────────────────────────────

def _batch_upsert(conn, sql, rows: list[dict], batch_size: int = BATCH_SIZE) -> None:
    """Execute parameterised upsert SQL in batches."""
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        for row in batch:
            conn.execute(sql, row)


def _arg_value(flag: str) -> str | None:
    for i, arg in enumerate(sys.argv):
        if arg == flag and i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


def _to_parent_symbol(parent_arg: str) -> str:
    return parent_arg.replace("_", ".")


def _parse_date_or_fail(value: str, label: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"Invalid {label} date '{value}', expected YYYY-MM-DD") from exc


def resolve_live_window(start_arg: str | None, end_arg: str | None) -> tuple[date, date]:
    """
    Resolve live pull window as [start_date, end_exclusive).

    --end is treated as inclusive for CLI ergonomics.
    """
    start_date = _parse_date_or_fail(start_arg or LIVE_STATS_START_DEFAULT, "start")
    end_inclusive = _parse_date_or_fail(end_arg or date.today().isoformat(), "end")
    end_exclusive = end_inclusive + timedelta(days=1)
    if start_date >= end_exclusive:
        raise ValueError(
            f"Invalid window: start={start_date.isoformat()} must be <= end={end_inclusive.isoformat()}"
        )
    return start_date, end_exclusive


def _iter_date_chunks(start_date: date, end_exclusive: date, days_per_chunk: int):
    cursor = start_date
    while cursor < end_exclusive:
        nxt = min(cursor + timedelta(days=days_per_chunk), end_exclusive)
        yield cursor, nxt
        cursor = nxt


# ─── IngestionRun Tracking ───────────────────────────────────────────────────

def create_ingestion_run(conn, job: str, details: dict | None = None) -> int:
    """Create an IngestionRun record and return its ID."""
    from sqlalchemy import text
    result = conn.execute(text("""
        INSERT INTO "ingestion_runs" (job, status, details, "startedAt")
        VALUES (:job, 'RUNNING', CAST(:details AS jsonb), NOW())
        RETURNING id
    """), {"job": job, "details": json.dumps(details) if details else None})
    row = result.fetchone()
    return row[0] if row else None


def finalize_ingestion_run(conn, run_id: int, status: str, rows_inserted: int = 0, error: str | None = None) -> None:
    """Update IngestionRun with final status and row counts."""
    from sqlalchemy import text
    details = {"error": error} if error else {}
    conn.execute(text("""
        UPDATE "ingestion_runs"
        SET status = :status,
            "finishedAt" = NOW(),
            "rowsInserted" = :rows_inserted,
            details = COALESCE(details, '{}'::jsonb) || CAST(:details AS jsonb)
        WHERE id = :id
    """), {
        "id": run_id,
        "status": status,
        "rows_inserted": rows_inserted,
        "details": json.dumps(details)
    })


# ─── DB Connection ──────────────────────────────────────────────────────────

def load_env() -> dict[str, str]:
    """Load env vars from files + process env (process env wins)."""
    env: dict[str, str] = {}
    for envfile in [".env.local", ".env"]:
        p = Path(envfile)
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            eq = line.index("=") if "=" in line else -1
            if eq <= 0:
                continue
            key = line[:eq].strip()
            val = line[eq + 1:].strip().strip('"')
            if key not in env:
                env[key] = val
    for key, val in os.environ.items():
        if val:
            env[key] = val
    return env


def get_engine(db_target: str = "auto"):
    """Create SQLAlchemy engine for LOCAL_DATABASE_URL only."""
    from sqlalchemy import create_engine

    global _DB_TARGET_LOGGED
    if db_target not in {"auto", "local"}:
        raise ValueError(
            f"Invalid --db-target '{db_target}'. Local-only mode allows: auto|local"
        )

    env = load_env()
    local_url = env.get("LOCAL_DATABASE_URL")
    source = "LOCAL_DATABASE_URL"
    url = local_url
    if not url:
        raise RuntimeError("LOCAL_DATABASE_URL is required for scripts/ingest-options.py")

    parsed = urlparse(url)
    if not _DB_TARGET_LOGGED:
        print(f"[db-target] ingest-options source={source} protocol={parsed.scheme or 'unknown'} host={parsed.netloc.split('@')[-1]}")
        _DB_TARGET_LOGGED = True

    # SQLAlchemy requires postgresql:// not postgres://
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return create_engine(url)


# ─── Parquet Loading ────────────────────────────────────────────────────────

def load_parent_parquets(parent_dir: Path) -> pd.DataFrame:
    """Load all monthly parquet files for a parent into one DataFrame."""
    files = sorted(parent_dir.glob("*.parquet"))
    if not files:
        return pd.DataFrame()
    dfs = []
    for f in files:
        try:
            dfs.append(pd.read_parquet(f))
        except Exception as e:
            print(f"    WARNING: {f.name}: {e}")
    return pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()


def list_parents(data_dir: Path, target: str | None = None) -> list[Path]:
    """List parent directories, optionally filtered."""
    if not data_dir.exists():
        return []
    dirs = sorted(d for d in data_dir.iterdir() if d.is_dir() and not d.name.startswith("_"))
    if target:
        dirs = [d for d in dirs if d.name == target]
    return dirs


# ─── OHLCV Ingestion ───────────────────────────────────────────────────────

def _build_ohlcv_rows(parent_symbol: str, df: pd.DataFrame) -> list[dict]:
    """Aggregate OHLCV data per day and return upsert-ready row dicts."""
    count_col = "instrument_id" if "instrument_id" in df.columns else (
        "symbol" if "symbol" in df.columns else None
    )

    rows = []
    for date, day_df in df.groupby("eventDate"):
        volume = int(day_df["volume"].sum()) if "volume" in day_df.columns else None
        contract_count = int(day_df[count_col].nunique()) if count_col else None
        avg_close = float(day_df["close"].mean()) if "close" in day_df.columns else None
        max_high = float(day_df["high"].max()) if "high" in day_df.columns else None
        low_series = (
            day_df[day_df["low"] > 0]["low"]
            if "low" in day_df.columns
            else pd.Series(dtype=float)
        )
        min_low = float(low_series.min()) if len(low_series) > 0 else None

        row_hash = sha256(f"{parent_symbol}|{date}|ohlcv|{volume}".encode()).hexdigest()

        rows.append({
            "parentSymbol": parent_symbol,
            "eventDate": date,
            "totalVolume": volume,
            "contractCount": contract_count,
            "avgClose": avg_close,
            "maxHigh": max_high,
            "minLow": min_low,
            "source": "DATABENTO",
            "sourceDataset": "GLBX.MDP3",
            "sourceSchema": "ohlcv-1d",
            "rowHash": row_hash,
        })
    return rows


def ingest_ohlcv(engine, target_parent: str | None, dry_run: bool) -> int:
    """Read OHLCV parquets → aggregate per day → upsert into mkt_options_ohlcv_1d."""
    from sqlalchemy import text

    parents = list_parents(OHLCV_DIR, target_parent)
    if not parents:
        print(f"  No OHLCV parent dirs found in {OHLCV_DIR}")
        return 0

    print(f"\n{'='*60}")
    print(f"OHLCV Ingestion: {len(parents)} parents → mkt_options_ohlcv_1d")
    print(f"{'='*60}")

    total_rows = 0

    for parent_dir in parents:
        parent_name = parent_dir.name  # ES_OPT
        parent_symbol = parent_name.replace("_", ".")  # ES.OPT

        df = load_parent_parquets(parent_dir)
        if df.empty:
            print(f"  {parent_name}: (no data)")
            continue

        if "ts_event" not in df.columns:
            print(f"  {parent_name}: WARNING — no ts_event column, skipping")
            continue

        df["eventDate"] = pd.to_datetime(df["ts_event"]).dt.date
        rows = _build_ohlcv_rows(parent_symbol, df)

        if dry_run:
            print(f"  {parent_name}: {len(rows)} daily rows (dry run)")
            total_rows += len(rows)
            continue

        upsert_sql = text("""
            INSERT INTO mkt_options_ohlcv_1d
                ("parentSymbol", "eventDate", "totalVolume", "contractCount",
                 "avgClose", "maxHigh", "minLow",
                 source, "sourceDataset", "sourceSchema", "rowHash",
                 "ingestedAt", "knowledgeTime")
            VALUES
                (:parentSymbol, :eventDate, :totalVolume, :contractCount,
                 :avgClose, :maxHigh, :minLow,
                 :source, :sourceDataset, :sourceSchema, :rowHash,
                 NOW(), NOW())
            ON CONFLICT ("parentSymbol", "eventDate")
            DO UPDATE SET
                "totalVolume" = EXCLUDED."totalVolume",
                "contractCount" = EXCLUDED."contractCount",
                "avgClose" = EXCLUDED."avgClose",
                "maxHigh" = EXCLUDED."maxHigh",
                "minLow" = EXCLUDED."minLow",
                "rowHash" = EXCLUDED."rowHash",
                "ingestedAt" = NOW()
        """)

        with engine.begin() as conn:
            _batch_upsert(conn, upsert_sql, rows)

        date_range = f"{rows[0]['eventDate']} → {rows[-1]['eventDate']}"
        print(f"  {parent_name}: {len(rows)} daily rows ingested ({date_range})")
        total_rows += len(rows)

    return total_rows


# ─── Statistics Ingestion ───────────────────────────────────────────────────

def _build_stats_rows(parent_symbol: str, df: pd.DataFrame) -> list[dict]:
    """Aggregate statistics data per day and return upsert-ready row dicts."""
    count_col = "instrument_id" if "instrument_id" in df.columns else (
        "symbol" if "symbol" in df.columns else None
    )

    rows = []
    for date, day_df in df.groupby("eventDate"):
        vol_rows = day_df[day_df["stat_type"] == STAT_VOLUME]
        total_volume = int(vol_rows["quantity"].sum()) if len(vol_rows) > 0 and "quantity" in vol_rows.columns else None

        oi_rows = day_df[day_df["stat_type"] == STAT_OI]
        total_oi = int(oi_rows["quantity"].sum()) if len(oi_rows) > 0 and "quantity" in oi_rows.columns else None

        settle_rows = day_df[day_df["stat_type"] == STAT_SETTLEMENT]
        settlement = float(settle_rows["price"].median()) if len(settle_rows) > 0 and "price" in settle_rows.columns else None

        iv_rows = day_df[day_df["stat_type"] == STAT_IV]
        avg_iv = float(iv_rows["price"].mean()) if len(iv_rows) > 0 and "price" in iv_rows.columns else None

        contract_count = int(day_df[count_col].nunique()) if count_col else None

        row_hash = sha256(f"{parent_symbol}|{date}|stats|{total_volume}".encode()).hexdigest()

        rows.append({
            "parentSymbol": parent_symbol,
            "eventDate": date,
            "totalVolume": total_volume,
            "totalOI": total_oi,
            "settlement": settlement,
            "avgIV": avg_iv,
            "contractCount": contract_count,
            "source": "DATABENTO",
            "sourceDataset": "GLBX.MDP3",
            "sourceSchema": "statistics",
            "rowHash": row_hash,
        })
    return rows


def _stats_upsert_sql():
    from sqlalchemy import text

    return text("""
        INSERT INTO mkt_options_statistics_1d
            ("parentSymbol", "eventDate", "totalVolume", "totalOI",
             settlement, "avgIV", "contractCount",
             source, "sourceDataset", "sourceSchema", "rowHash",
             "ingestedAt", "knowledgeTime")
        VALUES
            (:parentSymbol, :eventDate, :totalVolume, :totalOI,
             :settlement, :avgIV, :contractCount,
             :source, :sourceDataset, :sourceSchema, :rowHash,
             NOW(), NOW())
        ON CONFLICT ("parentSymbol", "eventDate")
        DO UPDATE SET
            "totalVolume" = EXCLUDED."totalVolume",
            "totalOI" = EXCLUDED."totalOI",
            settlement = EXCLUDED.settlement,
            "avgIV" = EXCLUDED."avgIV",
            "contractCount" = EXCLUDED."contractCount",
            "rowHash" = EXCLUDED."rowHash",
            "ingestedAt" = NOW()
    """)


def ingest_statistics(engine, target_parent: str | None, dry_run: bool) -> int:
    """Read statistics parquets → aggregate per day → upsert into mkt_options_statistics_1d."""
    parents = list_parents(STATS_DIR, target_parent)
    if not parents:
        print(f"  No statistics parent dirs found in {STATS_DIR}")
        return 0

    print(f"\n{'='*60}")
    print(f"Statistics Ingestion: {len(parents)} parents → mkt_options_statistics_1d")
    print(f"{'='*60}")

    total_rows = 0

    for parent_dir in parents:
        parent_name = parent_dir.name
        parent_symbol = parent_name.replace("_", ".")

        df = load_parent_parquets(parent_dir)
        if df.empty:
            print(f"  {parent_name}: (no data)")
            continue

        date_col = "ts_event" if "ts_event" in df.columns else ("ts_ref" if "ts_ref" in df.columns else None)
        if date_col is None:
            print(f"  {parent_name}: WARNING — no timestamp column, skipping")
            continue

        if "stat_type" not in df.columns:
            print(f"  {parent_name}: WARNING — no stat_type column, skipping")
            continue

        # Use ts_ref first for statistics: ts_event can be publish time on next day.
        date_col = "ts_ref" if "ts_ref" in df.columns else date_col
        df["eventDate"] = pd.to_datetime(df[date_col], errors="coerce").dt.date
        df = df.dropna(subset=["eventDate"])
        rows = _build_stats_rows(parent_symbol, df)

        if dry_run:
            print(f"  {parent_name}: {len(rows)} daily rows (dry run)")
            total_rows += len(rows)
            continue

        upsert_sql = _stats_upsert_sql()

        with engine.begin() as conn:
            _batch_upsert(conn, upsert_sql, rows)

        date_range = f"{rows[0]['eventDate']} → {rows[-1]['eventDate']}"
        print(f"  {parent_name}: {len(rows)} daily rows ingested ({date_range})")
        total_rows += len(rows)

    return total_rows


def _get_stats_live_symbols(target_parent: str | None) -> list[str]:
    role_symbols = get_symbols_by_role("OPTIONS_PARENT")
    if target_parent:
        parent_symbol = _to_parent_symbol(target_parent)
        return [s for s in role_symbols if s == parent_symbol]
    return role_symbols


def _fetch_stats_df_chunk(client, parent_symbol: str, chunk_start: date, chunk_end_exclusive: date) -> pd.DataFrame:
    store = client.timeseries.get_range(
        dataset="GLBX.MDP3",
        schema="statistics",
        symbols=[parent_symbol],
        stype_in="parent",
        start=chunk_start.isoformat(),
        end=chunk_end_exclusive.isoformat(),
    )
    df = store.to_df()
    if df.empty:
        return df

    # DBNStore often places a timestamp index (e.g., ts_recv). Make timestamps explicit columns.
    if df.index.name is not None:
        df = df.reset_index()

    if "stat_type" not in df.columns:
        return pd.DataFrame()

    df = df[df["stat_type"].isin({STAT_SETTLEMENT, STAT_VOLUME, STAT_OI, STAT_IV})]
    if df.empty:
        return df

    date_col = "ts_ref" if "ts_ref" in df.columns else ("ts_event" if "ts_event" in df.columns else None)
    if date_col is None:
        return pd.DataFrame()

    df["eventDate"] = pd.to_datetime(df[date_col], errors="coerce").dt.date
    df = df.dropna(subset=["eventDate"])
    return df


def ingest_statistics_live(
    engine,
    target_parent: str | None,
    dry_run: bool,
    start_date: date,
    end_exclusive: date,
) -> int:
    """Pull statistics directly from Databento and upsert daily parent aggregates."""
    import databento as db

    env = load_env()
    api_key = env.get("DATABENTO_API_KEY")
    if not api_key:
        raise RuntimeError("DATABENTO_API_KEY is required for --stats-live")

    symbols = _get_stats_live_symbols(target_parent)
    if not symbols:
        print("  No options parents resolved for --stats-live")
        return 0

    print(f"\n{'='*60}")
    print(f"Statistics Live Pull: {len(symbols)} parents → mkt_options_statistics_1d")
    print(f"Window: {start_date.isoformat()} → {(end_exclusive - timedelta(days=1)).isoformat()} (inclusive)")
    print(f"{'='*60}")

    client = db.Historical(api_key)
    upsert_sql = _stats_upsert_sql()
    total_rows = 0

    for parent_symbol in symbols:
        parent_rows = 0
        chunk_days = 7 if parent_symbol in WEEKLY_CHUNK_PARENTS else 31
        print(f"  {parent_symbol} ({chunk_days}-day chunks)")

        for chunk_start, chunk_end in _iter_date_chunks(start_date, end_exclusive, chunk_days):
            df = _fetch_stats_df_chunk(client, parent_symbol, chunk_start, chunk_end)
            if df.empty:
                continue

            rows = _build_stats_rows(parent_symbol, df)
            if not rows:
                continue

            if dry_run:
                parent_rows += len(rows)
                continue

            with engine.begin() as conn:
                _batch_upsert(conn, upsert_sql, rows)

            parent_rows += len(rows)

        print(f"    {parent_rows} daily rows")
        total_rows += parent_rows

    return total_rows


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    """CLI entrypoint — parse args and run OHLCV/statistics ingestion."""
    t0 = time.time()

    ohlcv_only = "--ohlcv-only" in sys.argv
    stats_only = "--stats-only" in sys.argv
    with_stats = "--with-stats" in sys.argv

    if ohlcv_only and stats_only:
        raise ValueError("Cannot combine --ohlcv-only and --stats-only")
    if ohlcv_only and with_stats:
        raise ValueError("Cannot combine --ohlcv-only and --with-stats")

    do_ohlcv = not stats_only
    do_stats = stats_only or with_stats
    if ohlcv_only:
        do_ohlcv = True
        do_stats = False
    stats_live = "--stats-live" in sys.argv
    dry_run = "--dry-run" in sys.argv

    if stats_live and not do_stats:
        raise ValueError("--stats-live requires --with-stats or --stats-only")

    target_parent = _arg_value("--parent")
    db_target = _arg_value("--db-target") or "auto"
    start_arg = _arg_value("--start")
    end_arg = _arg_value("--end")

    if db_target not in {"auto", "local"}:
        raise ValueError(
            "--db-target direct is disabled. This script is local-only and uses LOCAL_DATABASE_URL."
        )

    start_date, end_exclusive = resolve_live_window(start_arg, end_arg)

    print("Options Data Ingestion → Postgres")
    if dry_run:
        print("  MODE: DRY RUN (no writes)")
    if target_parent:
        print(f"  TARGET: {target_parent}")
    if not do_stats:
        print("  STATS: DISABLED (default). Use --with-stats or --stats-only to enable.")
    else:
        print("  STATS: ENABLED")
    if stats_live:
        print("  STATS SOURCE: Databento live pull")
        print(f"  WINDOW: {start_date.isoformat()} → {(end_exclusive - timedelta(days=1)).isoformat()} (inclusive)")
    print(f"  DB TARGET: {db_target}")

    engine = get_engine(db_target)

    # Create IngestionRun record
    run_id = None
    try:
        with engine.begin() as conn:
            run_id = create_ingestion_run(conn, "ingest-options", {
                "do_ohlcv": do_ohlcv,
                "do_stats": do_stats,
                "stats_live": stats_live,
                "target_parent": target_parent,
                "db_target": db_target,
                "start": start_date.isoformat(),
                "end_inclusive": (end_exclusive - timedelta(days=1)).isoformat(),
                "dry_run": dry_run,
            })
    except Exception as e:
        print(f"  WARNING: Could not create IngestionRun: {e}")

    ohlcv_rows = 0
    stats_rows = 0
    error_msg = None

    try:
        if do_ohlcv:
            ohlcv_rows = ingest_ohlcv(engine, target_parent, dry_run)

        if do_stats:
            if stats_live:
                stats_rows = ingest_statistics_live(engine, target_parent, dry_run, start_date, end_exclusive)
            else:
                stats_rows = ingest_statistics(engine, target_parent, dry_run)
    except Exception as e:
        error_msg = str(e)
        print(f"ERROR: {e}")

    elapsed = time.time() - t0
    print(f"\nDone in {elapsed:.1f}s")
    print(f"  OHLCV: {ohlcv_rows:,} daily rows")
    print(f"  Stats: {stats_rows:,} daily rows")

    # Finalize IngestionRun
    if run_id:
        try:
            with engine.begin() as conn:
                status = "FAILED" if error_msg else "COMPLETED"
                finalize_ingestion_run(conn, run_id, status, ohlcv_rows + stats_rows, error_msg)
        except Exception as e:
            print(f"  WARNING: Could not finalize IngestionRun: {e}")


if __name__ == "__main__":
    main()
