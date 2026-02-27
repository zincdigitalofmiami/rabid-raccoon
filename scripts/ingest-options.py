#!/usr/bin/env python3
"""
Ingest options data from per-parent parquet files into Postgres.

Reads:
  datasets/options-ohlcv/{PARENT}/YYYY-MM.parquet   → mkt_options_ohlcv_1d
  datasets/options-statistics/{PARENT}/YYYY-MM.parquet → mkt_options_agg_1d

Aggregates per day per parent, inserts via UPSERT (ON CONFLICT UPDATE).
Uses DIRECT_URL from .env.local for Postgres connection.

Usage:
  .venv-finance/bin/python scripts/ingest-options.py
  .venv-finance/bin/python scripts/ingest-options.py --ohlcv-only
  .venv-finance/bin/python scripts/ingest-options.py --stats-only
  .venv-finance/bin/python scripts/ingest-options.py --parent ES_OPT
  .venv-finance/bin/python scripts/ingest-options.py --dry-run
"""
import pandas as pd
import numpy as np
from pathlib import Path
from decimal import Decimal
from hashlib import sha256
import sys
import time
import json

# ─── Configuration ──────────────────────────────────────────────────────────

BASE = Path("datasets")
OHLCV_DIR = BASE / "options-ohlcv"
STATS_DIR = BASE / "options-statistics"

STAT_SETTLEMENT = 3
STAT_VOLUME = 6
STAT_OI = 9
STAT_IV = 14

BATCH_SIZE = 500  # Direct Postgres connection via DIRECT_URL — no Accelerate timeout


# ─── Shared Helpers ────────────────────────────────────────────────────────

def _batch_upsert(conn, sql, rows: list[dict], batch_size: int = BATCH_SIZE) -> None:
    """Execute parameterised upsert SQL in batches."""
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        for row in batch:
            conn.execute(sql, row)


# ─── IngestionRun Tracking ───────────────────────────────────────────────────

def create_ingestion_run(conn, job: str, details: dict | None = None) -> int:
    """Create an IngestionRun record and return its ID."""
    from sqlalchemy import text
    result = conn.execute(text("""
        INSERT INTO "ingestionRun" (job, status, details, "createdAt", "updatedAt")
        VALUES (:job, 'RUNNING', :details::jsonb, NOW(), NOW())
        RETURNING id
    """), {"job": job, "details": json.dumps(details) if details else None})
    row = result.fetchone()
    return row[0] if row else None


def finalize_ingestion_run(conn, run_id: int, status: str, rows_inserted: int = 0, error: str | None = None) -> None:
    """Update IngestionRun with final status and row counts."""
    from sqlalchemy import text
    details = {"error": error} if error else {}
    conn.execute(text("""
        UPDATE "ingestionRun"
        SET status = :status,
            "finishedAt" = NOW(),
            "updatedAt" = NOW(),
            "rowsInserted" = :rows_inserted,
            details = details || :details::jsonb
        WHERE id = :id
    """), {
        "id": run_id,
        "status": status,
        "rows_inserted": rows_inserted,
        "details": json.dumps(details)
    })


# ─── DB Connection ──────────────────────────────────────────────────────────

def load_env() -> dict[str, str]:
    """Load .env.local vars."""
    env = {}
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
    return env


def get_engine():
    """Create SQLAlchemy engine. Uses LOCAL_DATABASE_URL when available
    (local dev, zero Accelerate cost), falls back to DIRECT_URL (production)."""
    from sqlalchemy import create_engine
    env = load_env()
    url = env.get("LOCAL_DATABASE_URL") or env.get("DIRECT_URL")
    if not url:
        raise RuntimeError("Neither LOCAL_DATABASE_URL nor DIRECT_URL found in .env.local")
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
        low_series = day_df[day_df["low"] > 0]["low"] if "low" in day_df.columns else pd.Series()
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


def ingest_statistics(engine, target_parent: str | None, dry_run: bool) -> int:
    """Read statistics parquets → aggregate per day → upsert into mkt_options_agg_1d."""
    from sqlalchemy import text

    parents = list_parents(STATS_DIR, target_parent)
    if not parents:
        print(f"  No statistics parent dirs found in {STATS_DIR}")
        return 0

    print(f"\n{'='*60}")
    print(f"Statistics Ingestion: {len(parents)} parents → mkt_options_agg_1d")
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

        df["eventDate"] = pd.to_datetime(df[date_col]).dt.date
        rows = _build_stats_rows(parent_symbol, df)

        if dry_run:
            print(f"  {parent_name}: {len(rows)} daily rows (dry run)")
            total_rows += len(rows)
            continue

        upsert_sql = text("""
            INSERT INTO mkt_options_agg_1d
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

        with engine.begin() as conn:
            _batch_upsert(conn, upsert_sql, rows)

        date_range = f"{rows[0]['eventDate']} → {rows[-1]['eventDate']}"
        print(f"  {parent_name}: {len(rows)} daily rows ingested ({date_range})")
        total_rows += len(rows)

    return total_rows


# ─── Main ───────────────────────────────────────────────────────────────────

def main():
    """CLI entrypoint — parse args and run OHLCV/statistics ingestion."""
    from sqlalchemy import text

    t0 = time.time()

    do_ohlcv = "--ohlcv-only" in sys.argv or "--stats-only" not in sys.argv
    do_stats = "--stats-only" in sys.argv or "--ohlcv-only" not in sys.argv
    dry_run = "--dry-run" in sys.argv

    target_parent = None
    for i, arg in enumerate(sys.argv):
        if arg == "--parent" and i + 1 < len(sys.argv):
            target_parent = sys.argv[i + 1]

    print("Options Data Ingestion → Postgres")
    if dry_run:
        print("  MODE: DRY RUN (no writes)")
    if target_parent:
        print(f"  TARGET: {target_parent}")

    engine = get_engine()

    # Create IngestionRun record
    run_id = None
    try:
        with engine.begin() as conn:
            run_id = create_ingestion_run(conn, "ingest-options", {
                "do_ohlcv": do_ohlcv,
                "do_stats": do_stats,
                "target_parent": target_parent,
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
