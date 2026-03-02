#!/usr/bin/env python3
"""
backfill-mes-1m-from-disk.py

Reads 1-second OHLCV .dbn.zst files from the Databento zip on disk,
aggregates them to 1-minute bars, and bulk-loads into mkt_futures_mes_1m.

Source: datasets/MES Data/GLBX-20260302-T7B4GX4ACJ.zip
  - 155 daily .dbn.zst files, ohlcv-1s schema
  - Date range: 2025-09-02 → 2026-03-01 (6 months)

Usage:
  .venv-finance/bin/python scripts/backfill-mes-1m-from-disk.py
  .venv-finance/bin/python scripts/backfill-mes-1m-from-disk.py --dry-run
"""

import os
import sys
import hashlib
import tempfile
import zipfile
import argparse
from datetime import datetime, timezone
from pathlib import Path

import databento as db
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

# ─── Config ──────────────────────────────────────────────────────────────────

ZIP_PATH = Path("datasets/MES Data/GLBX-20260302-T7B4GX4ACJ.zip")
BATCH_SIZE = 500
SOURCE = "DATABENTO"
SOURCE_DATASET = "GLBX.MDP3"
SOURCE_SCHEMA = "ohlcv-1s->1m"

# ─── Helpers ─────────────────────────────────────────────────────────────────

def hash_row(event_time: datetime, close: float) -> str:
    raw = f"MES-1M|{event_time.isoformat()}|{close}"
    return hashlib.sha256(raw.encode()).hexdigest()


def aggregate_1s_to_1m(df: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 1-second OHLCV bars to 1-minute OHLCV bars."""
    # ts_event is the index (DatetimeIndex, UTC)
    # Floor to minute
    df = df.copy()
    df["minute"] = df.index.floor("1min")

    agg = df.groupby("minute").agg(
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
    )
    agg.index.name = "ts_event"
    return agg


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Backfill MES 1m from disk")
    parser.add_argument("--dry-run", action="store_true", help="Parse & aggregate but don't write to DB")
    args = parser.parse_args()

    # Load env
    load_dotenv(".env.local")
    direct_url = os.environ.get("DIRECT_URL") or os.environ.get("LOCAL_DATABASE_URL")
    if not direct_url:
        print("ERROR: DIRECT_URL not set in .env.local")
        sys.exit(1)

    if not ZIP_PATH.exists():
        print(f"ERROR: Zip file not found at {ZIP_PATH}")
        sys.exit(1)

    print(f"[backfill-1m] Source: {ZIP_PATH}")
    print(f"[backfill-1m] Target: mkt_futures_mes_1m")
    print(f"[backfill-1m] Mode: {'DRY RUN' if args.dry_run else 'LIVE'}")
    print()

    # Open zip and find all .dbn.zst files
    with zipfile.ZipFile(ZIP_PATH) as zf:
        dbn_files = sorted([n for n in zf.namelist() if n.endswith(".dbn.zst")])
        print(f"[backfill-1m] Found {len(dbn_files)} daily .dbn.zst files")

        total_1m_bars = 0
        total_inserted = 0
        all_1m_frames: list[pd.DataFrame] = []

        for idx, fname in enumerate(dbn_files):
            # Extract date from filename: glbx-mdp3-YYYYMMDD.ohlcv-1s.dbn.zst
            parts = fname.replace(".ohlcv-1s.dbn.zst", "").split("-")
            date_str = parts[-1] if len(parts) >= 3 else "unknown"

            # Read .dbn.zst from zip into temp file
            with zf.open(fname) as f:
                data = f.read()

            tmpf = tempfile.NamedTemporaryFile(suffix=".dbn.zst", delete=False)
            tmpf.write(data)
            tmpf.close()

            try:
                store = db.DBNStore.from_file(tmpf.name)
                df_1s = store.to_df()

                if df_1s.empty:
                    print(f"  [{idx+1}/{len(dbn_files)}] {date_str}: empty, skipping")
                    continue

                # Filter out rows with suspicious prices (< 100 = clearly wrong)
                df_1s = df_1s[df_1s["close"] >= 100]

                # Aggregate 1s → 1m
                df_1m = aggregate_1s_to_1m(df_1s)
                n_bars = len(df_1m)
                total_1m_bars += n_bars
                all_1m_frames.append(df_1m)

                if (idx + 1) % 10 == 0 or idx == 0 or idx == len(dbn_files) - 1:
                    print(
                        f"  [{idx+1}/{len(dbn_files)}] {date_str}: "
                        f"{len(df_1s)} 1s bars → {n_bars} 1m bars"
                    )
            finally:
                os.unlink(tmpf.name)

        print(f"\n[backfill-1m] Total 1m bars aggregated: {total_1m_bars}")

        if args.dry_run:
            print("[backfill-1m] DRY RUN — no DB writes")
            return

        # Concatenate all 1m frames and deduplicate
        print("[backfill-1m] Deduplicating...")
        all_1m = pd.concat(all_1m_frames)
        all_1m = all_1m[~all_1m.index.duplicated(keep="last")]
        all_1m = all_1m.sort_index()
        print(f"[backfill-1m] After dedup: {len(all_1m)} unique 1m bars")

        # Connect to DB and bulk insert
        print("[backfill-1m] Connecting to database...")
        conn = psycopg2.connect(direct_url)
        conn.autocommit = False
        cur = conn.cursor()

        upsert_sql = """
            INSERT INTO mkt_futures_mes_1m (
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

        rows_to_insert = []
        for ts, row in all_1m.iterrows():
            event_time = ts.to_pydatetime().replace(tzinfo=timezone.utc)
            rows_to_insert.append((
                event_time,
                round(float(row["open"]), 6),
                round(float(row["high"]), 6),
                round(float(row["low"]), 6),
                round(float(row["close"]), 6),
                int(row["volume"]),
                SOURCE,
                SOURCE_DATASET,
                SOURCE_SCHEMA,
                hash_row(event_time, float(row["close"])),
                datetime.now(timezone.utc),
                datetime.now(timezone.utc),
            ))

        print(f"[backfill-1m] Inserting {len(rows_to_insert)} rows in batches of {BATCH_SIZE}...")

        for i in range(0, len(rows_to_insert), BATCH_SIZE):
            batch = rows_to_insert[i : i + BATCH_SIZE]
            execute_values(
                cur,
                upsert_sql,
                batch,
                template="(%s, %s, %s, %s, %s, %s, %s::\"DataSource\", %s, %s, %s, %s, %s)",
                page_size=BATCH_SIZE,
            )
            conn.commit()
            total_inserted += len(batch)

            if (i // BATCH_SIZE) % 100 == 0 or i + BATCH_SIZE >= len(rows_to_insert):
                pct = (total_inserted / len(rows_to_insert)) * 100
                print(f"  Committed {total_inserted}/{len(rows_to_insert)} ({pct:.1f}%)")

        cur.close()
        conn.close()

        print(f"\n[backfill-1m] DONE — {total_inserted} rows upserted into mkt_futures_mes_1m")
        print(f"[backfill-1m] Date range: {all_1m.index.min()} → {all_1m.index.max()}")


if __name__ == "__main__":
    main()
