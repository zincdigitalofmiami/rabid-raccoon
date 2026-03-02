#!/usr/bin/env python3
"""
Backfill MES 1m OHLCV bars from Databento ohlcv-1s zip on disk.

Reads the local zip of daily .dbn.zst files (ohlcv-1s schema), aggregates
1-second bars into 1-minute OHLCV, and inserts into mkt_futures_mes_1m.

Usage:
    .venv-finance/bin/python scripts/backfill-mes-1m.py
    .venv-finance/bin/python scripts/backfill-mes-1m.py --start 2025-11-01  # partial
    .venv-finance/bin/python scripts/backfill-mes-1m.py --dry-run           # count only

Source: datasets/MES Data/GLBX-20260302-T7B4GX4ACJ.zip
        Contains ohlcv-1s.dbn.zst files from 2025-09-02 to 2026-03-01
"""

import argparse
import hashlib
import os
import re
import sys
import tempfile
import time
import zipfile
from datetime import datetime, timezone

import databento as db
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

# ── Config ────────────────────────────────────────────────────────────────────

ZIP_PATH = "datasets/MES Data/GLBX-20260302-T7B4GX4ACJ.zip"
DBN_FILE_PATTERN = re.compile(r"glbx-mdp3-(\d{8})\.ohlcv-1s\.dbn\.zst")
BATCH_SIZE = 500
SOURCE = "DATABENTO"
SOURCE_DATASET = "GLBX.MDP3"
SOURCE_SCHEMA = "ohlcv-1s->1m"


def get_db_url() -> str:
    """Get the direct Postgres connection URL."""
    from dotenv import load_dotenv
    load_dotenv(".env.local")
    load_dotenv(".env")
    url = os.environ.get("DIRECT_URL") or os.environ.get("LOCAL_DATABASE_URL")
    if not url:
        print("ERROR: DIRECT_URL or LOCAL_DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)
    return url


def hash_1m_row(event_time: datetime, close: float) -> str:
    """SHA-256 hash for dedup."""
    raw = f"MES-1M|{event_time.isoformat()}|{close}"
    return hashlib.sha256(raw.encode()).hexdigest()


def aggregate_1s_to_1m(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 1-second OHLCV bars to 1-minute bars."""
    if df.empty:
        return pd.DataFrame()

    # df index = ts_event (timezone-aware UTC datetime)
    # Floor to the minute
    df = df.copy()
    df["minute"] = df.index.floor("min")

    agg = df.groupby("minute").agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    )

    return agg


def list_dbn_files(zf: zipfile.ZipFile, start_date: str | None = None) -> list[tuple[str, str]]:
    """List (filename, date_str) pairs from zip, sorted by date."""
    files = []
    for name in zf.namelist():
        m = DBN_FILE_PATTERN.match(name)
        if m:
            date_str = m.group(1)
            if start_date and date_str < start_date.replace("-", ""):
                continue
            files.append((name, date_str))
    files.sort(key=lambda x: x[1])
    return files


def process_day(zf: zipfile.ZipFile, filename: str, date_str: str) -> pd.DataFrame:
    """Extract, read, and aggregate a single day's 1s data to 1m."""
    with tempfile.NamedTemporaryFile(suffix=".dbn.zst", delete=False) as tmp:
        tmp.write(zf.read(filename))
        tmp_path = tmp.name

    try:
        store = db.DBNStore.from_file(tmp_path)
        df_1s = store.to_df()
        if df_1s.empty:
            return pd.DataFrame()
        df_1m = aggregate_1s_to_1m(df_1s)
        return df_1m
    finally:
        os.unlink(tmp_path)


def upsert_batch(cursor, rows: list[tuple]) -> int:
    """Upsert a batch of 1m rows into the database."""
    sql = """
        INSERT INTO "mkt_futures_mes_1m" (
            "eventTime", "open", "high", "low", "close", "volume",
            "source", "sourceDataset", "sourceSchema", "rowHash",
            "ingestedAt", "knowledgeTime"
        )
        VALUES %s
        ON CONFLICT ("eventTime") DO UPDATE SET
            "open" = EXCLUDED."open",
            "high" = EXCLUDED."high",
            "low" = EXCLUDED."low",
            "close" = EXCLUDED."close",
            "volume" = EXCLUDED."volume",
            "rowHash" = EXCLUDED."rowHash",
            "ingestedAt" = NOW(),
            "knowledgeTime" = NOW()
    """
    template = "(%(eventTime)s, %(open)s, %(high)s, %(low)s, %(close)s, %(volume)s, " \
               "%(source)s::\"DataSource\", %(sourceDataset)s, %(sourceSchema)s, %(rowHash)s, NOW(), NOW())"

    execute_values(cursor, sql, rows, template=template, page_size=BATCH_SIZE)
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description="Backfill MES 1m OHLCV from disk")
    parser.add_argument("--start", type=str, default=None,
                        help="Start date (YYYY-MM-DD), default: all data in zip")
    parser.add_argument("--dry-run", action="store_true",
                        help="Count bars without writing to DB")
    parser.add_argument("--zip-path", type=str, default=ZIP_PATH,
                        help=f"Path to source zip (default: {ZIP_PATH})")
    args = parser.parse_args()

    zip_path = args.zip_path
    if not os.path.exists(zip_path):
        print(f"ERROR: Zip file not found: {zip_path}", file=sys.stderr)
        sys.exit(1)

    zf = zipfile.ZipFile(zip_path)
    files = list_dbn_files(zf, args.start)
    print(f"Found {len(files)} daily files in {zip_path}")

    if not files:
        print("No files to process.")
        return

    print(f"Date range: {files[0][1]} → {files[-1][1]}")

    if args.dry_run:
        total_bars = 0
        for filename, date_str in files:
            df_1m = process_day(zf, filename, date_str)
            count = len(df_1m)
            total_bars += count
            print(f"  {date_str}: {count:,} 1m bars")
        print(f"\nTotal: {total_bars:,} 1m bars (dry run, nothing written)")
        return

    # Connect to DB
    conn = psycopg2.connect(get_db_url())
    conn.autocommit = False
    cursor = conn.cursor()

    total_upserted = 0
    total_days = 0
    start_time = time.time()

    for i, (filename, date_str) in enumerate(files):
        day_start = time.time()

        try:
            df_1m = process_day(zf, filename, date_str)
            if df_1m.empty:
                print(f"  [{i+1}/{len(files)}] {date_str}: 0 bars (skip)")
                continue

            # Build row dicts for upsert
            rows = []
            for ts, row in df_1m.iterrows():
                event_time = ts.to_pydatetime()
                if event_time.tzinfo is None:
                    event_time = event_time.replace(tzinfo=timezone.utc)
                rows.append({
                    "eventTime": event_time,
                    "open": float(row["open"]),
                    "high": float(row["high"]),
                    "low": float(row["low"]),
                    "close": float(row["close"]),
                    "volume": max(0, int(row["volume"])),
                    "source": SOURCE,
                    "sourceDataset": SOURCE_DATASET,
                    "sourceSchema": SOURCE_SCHEMA,
                    "rowHash": hash_1m_row(event_time, float(row["close"])),
                })

            # Upsert in batches
            day_upserted = 0
            for batch_start in range(0, len(rows), BATCH_SIZE):
                batch = rows[batch_start:batch_start + BATCH_SIZE]
                day_upserted += upsert_batch(cursor, batch)

            conn.commit()
            total_upserted += day_upserted
            total_days += 1

            elapsed = time.time() - day_start
            print(f"  [{i+1}/{len(files)}] {date_str}: {day_upserted:,} bars ({elapsed:.1f}s)")

        except Exception as e:
            conn.rollback()
            print(f"  [{i+1}/{len(files)}] {date_str}: ERROR — {e}", file=sys.stderr)

    elapsed_total = time.time() - start_time
    print(f"\n{'='*60}")
    print(f"Done. {total_upserted:,} rows upserted across {total_days} days in {elapsed_total:.1f}s")
    print(f"Rate: {total_upserted / max(elapsed_total, 1):.0f} rows/sec")

    # Final count
    cursor.execute('SELECT count(*) FROM "mkt_futures_mes_1m"')
    db_count = cursor.fetchone()[0]
    cursor.execute('SELECT min("eventTime"), max("eventTime") FROM "mkt_futures_mes_1m"')
    db_range = cursor.fetchone()
    print(f"DB total: {db_count:,} rows, range: {db_range[0]} → {db_range[1]}")

    cursor.close()
    conn.close()
    zf.close()


if __name__ == "__main__":
    main()
