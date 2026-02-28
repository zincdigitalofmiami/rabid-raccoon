#!/usr/bin/env python3
"""
Databento Live MES 15m Candle Ingestion

Connects to the Databento Live Subscription Gateway, subscribes to
MES.c.0 ohlcv-1m (1-minute OHLCV bars), aggregates them into 15-minute
candles in-memory, and upserts into mkt_futures_mes_15m every ~5 seconds.

This replaces the historical-API polling approach with true real-time data.

Requirements:
  - DATABENTO_API_KEY in .env.local / environment
  - LOCAL_DATABASE_URL for Postgres
  - databento Python SDK (installed in .venv-finance)

Usage:
  .venv-finance/bin/python scripts/ingest-mes-live-databento.py
  .venv-finance/bin/python scripts/ingest-mes-live-databento.py --backfill-minutes=60
"""

import os
import sys
import time
import json
import signal
import threading
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from urllib.parse import urlparse

# ─── Load .env files ────────────────────────────────────────────────────────

def load_env() -> dict[str, str]:
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
            val = line[eq + 1 :].strip().strip('"')
            if key not in env:
                env[key] = val
    return env


ENV = load_env()
for k, v in ENV.items():
    if k not in os.environ:
        os.environ[k] = v


# ─── DB connection ──────────────────────────────────────────────────────────

def get_engine():
    from sqlalchemy import create_engine

    source = "LOCAL_DATABASE_URL"
    url = os.environ.get("LOCAL_DATABASE_URL")
    if not url:
        raise RuntimeError("LOCAL_DATABASE_URL is required for scripts/ingest-mes-live-databento.py")
    parsed = urlparse(url)
    print(
        f"[db-target] ingest-mes-live-databento source={source} "
        f"protocol={parsed.scheme or 'unknown'} host={parsed.netloc.split('@')[-1]}"
    )
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    return create_engine(url)


# ─── Constants ──────────────────────────────────────────────────────────────

DATASET = "GLBX.MDP3"
SYMBOL = "MES.c.0"
FIXED_PRICE_SCALE = 1_000_000_000
FIFTEEN_MIN_SEC = 15 * 60
FLUSH_INTERVAL_SEC = 5
BATCH_SIZE = 50

# ─── Registry lookup (optional — falls back to hardcoded symbol) ────────────

def _registry_symbol() -> str:
    """Read primary Databento continuous symbol from the registry snapshot."""
    try:
        snapshot_path = (
            Path(__file__).resolve().parent.parent
            / "src"
            / "lib"
            / "symbol-registry"
            / "snapshot.json"
        )
        data = json.loads(snapshot_path.read_text())
        primary_symbol = data.get("primarySymbol")
        if not primary_symbol:
            return SYMBOL

        for m in data.get("providerMappings", []):
            if (
                m.get("symbolCode") == primary_symbol
                and m.get("source") == "DATABENTO"
                and m.get("sourceTable") == "databento.continuous"
            ):
                return m["sourceSymbol"]
    except Exception:
        pass
    return SYMBOL


# ─── IngestionRun tracking ──────────────────────────────────────────────────

def create_ingestion_run(conn, details: dict | None = None) -> int:
    from sqlalchemy import text

    result = conn.execute(
        text(
            """
        INSERT INTO "ingestion_runs" (job, status, details, "startedAt")
        VALUES (:job, 'RUNNING', :details::jsonb, NOW())
        RETURNING id
    """
        ),
        {"job": "mes-live-databento", "details": json.dumps(details) if details else None},
    )
    row = result.fetchone()
    return row[0] if row else 0


def finalize_ingestion_run(
    conn, run_id: int, status: str, rows_inserted: int = 0, error: str | None = None
) -> None:
    from sqlalchemy import text

    details = {"error": error} if error else {}
    conn.execute(
        text(
            """
        UPDATE "ingestion_runs"
        SET status = :status,
            "finishedAt" = NOW(),
            "rowsInserted" = :rows_inserted,
            details = COALESCE(details, '{}'::jsonb) || :details::jsonb
        WHERE id = :id
    """
        ),
        {
            "id": run_id,
            "status": status,
            "rows_inserted": rows_inserted,
            "details": json.dumps(details),
        },
    )


# ─── 15m candle aggregator ─────────────────────────────────────────────────

class CandleAggregator:
    """Aggregates 1-minute OHLCV records into 15-minute candles."""

    def __init__(self):
        self.buckets: dict[int, dict] = {}  # bucket_start_sec → {o,h,l,c,v}
        self.lock = threading.Lock()

    def ingest(self, ts_event_ns: int, open_raw: int, high_raw: int, low_raw: int, close_raw: int, volume: int):
        ts_sec = ts_event_ns // 1_000_000_000
        bucket = (ts_sec // FIFTEEN_MIN_SEC) * FIFTEEN_MIN_SEC

        o = open_raw / FIXED_PRICE_SCALE
        h = high_raw / FIXED_PRICE_SCALE
        l_ = low_raw / FIXED_PRICE_SCALE
        c = close_raw / FIXED_PRICE_SCALE

        if o <= 0 or h <= 0 or l_ <= 0 or c <= 0:
            return

        with self.lock:
            if bucket not in self.buckets:
                self.buckets[bucket] = {
                    "open": o,
                    "high": h,
                    "low": l_,
                    "close": c,
                    "volume": volume,
                }
            else:
                b = self.buckets[bucket]
                b["high"] = max(b["high"], h)
                b["low"] = min(b["low"], l_)
                b["close"] = c
                b["volume"] = b["volume"] + volume

    def drain(self) -> list[dict]:
        """Return all buckets and clear them, except the latest (still forming)."""
        with self.lock:
            if not self.buckets:
                return []
            keys = sorted(self.buckets.keys())
            # Always return all buckets (including current forming one) for upsert
            result = []
            for k in keys:
                b = self.buckets[k]
                result.append(
                    {
                        "time": k,
                        "open": b["open"],
                        "high": b["high"],
                        "low": b["low"],
                        "close": b["close"],
                        "volume": b["volume"],
                    }
                )
            # Keep only the latest bucket (still forming)
            if len(keys) > 1:
                latest_key = keys[-1]
                latest = self.buckets[latest_key]
                self.buckets = {latest_key: latest}
            return result


# ─── DB flush ───────────────────────────────────────────────────────────────

def hash_row(event_time: datetime, close: float) -> str:
    return sha256(f"MES-15M|{event_time.isoformat()}|{close}".encode()).hexdigest()


def flush_candles(engine, candles: list[dict]) -> int:
    """Upsert 15m candles into mkt_futures_mes_15m. Returns row count."""
    if not candles:
        return 0

    from sqlalchemy import text

    upserted = 0
    with engine.begin() as conn:
        for candle in candles:
            event_time = datetime.fromtimestamp(candle["time"], tz=timezone.utc)
            row_hash = hash_row(event_time, candle["close"])
            conn.execute(
                text(
                    """
                INSERT INTO mkt_futures_mes_15m
                    ("eventTime", open, high, low, close, volume,
                     source, "sourceDataset", "sourceSchema", "rowHash",
                     "ingestedAt", "knowledgeTime")
                VALUES
                    (:eventTime, :open, :high, :low, :close, :volume,
                     'DATABENTO', 'GLBX.MDP3', 'live-ohlcv-1m->15m', :rowHash,
                     NOW(), NOW())
                ON CONFLICT ("eventTime")
                DO UPDATE SET
                    open = EXCLUDED.open,
                    high = EXCLUDED.high,
                    low = EXCLUDED.low,
                    close = EXCLUDED.close,
                    volume = EXCLUDED.volume,
                    "rowHash" = EXCLUDED."rowHash",
                    "ingestedAt" = NOW(),
                    "knowledgeTime" = NOW()
            """
                ),
                {
                    "eventTime": event_time,
                    "open": candle["open"],
                    "high": candle["high"],
                    "low": candle["low"],
                    "close": candle["close"],
                    "volume": candle["volume"],
                    "rowHash": row_hash,
                },
            )
            upserted += 1

    return upserted


# ─── Historical backfill via Databento Live replay ──────────────────────────

def backfill_recent(engine, client_class, symbol: str, minutes: int = 60) -> int:
    """
    Use Databento historical API to backfill recent 15m candles so the chart
    isn't empty when the live worker starts. Returns row count.
    """
    import databento as db

    api_key = os.environ.get("DATABENTO_API_KEY", "")
    hist = db.Historical(api_key)

    end = datetime.now(timezone.utc)
    start = datetime.fromtimestamp(end.timestamp() - minutes * 60, tz=timezone.utc)

    print(f"[backfill] Fetching ohlcv-1m from {start.isoformat()} to {end.isoformat()}")

    try:
        data = hist.timeseries.get_range(
            dataset=DATASET,
            symbols=symbol,
            schema="ohlcv-1m",
            stype_in="continuous",
            start=start.isoformat(),
            end=end.isoformat(),
        )
    except Exception as e:
        print(f"[backfill] Historical fetch failed: {e}")
        return 0

    agg = CandleAggregator()
    count = 0
    for record in data:
        agg.ingest(
            record.ts_event,
            record.open,
            record.high,
            record.low,
            record.close,
            record.volume,
        )
        count += 1

    candles = agg.drain()
    rows = flush_candles(engine, candles)
    print(f"[backfill] Processed {count} 1m records → {len(candles)} 15m candles, {rows} upserted")
    return rows


# ─── Main live loop ─────────────────────────────────────────────────────────

def main():
    import databento as db

    api_key = os.environ.get("DATABENTO_API_KEY")
    if not api_key:
        print("ERROR: DATABENTO_API_KEY is required", file=sys.stderr)
        sys.exit(1)

    engine = get_engine()
    symbol = _registry_symbol()
    print(f"[mes-live-databento] symbol={symbol} dataset={DATASET}")

    # Parse CLI args
    backfill_minutes = 60
    for arg in sys.argv[1:]:
        if arg.startswith("--backfill-minutes="):
            backfill_minutes = int(arg.split("=")[1])

    # Create ingestion run
    run_id = 0
    try:
        with engine.begin() as conn:
            run_id = create_ingestion_run(
                conn,
                {
                    "symbol": symbol,
                    "dataset": DATASET,
                    "mode": "live",
                    "flush_interval_sec": FLUSH_INTERVAL_SEC,
                },
            )
    except Exception as e:
        print(f"[mes-live-databento] WARNING: Could not create IngestionRun: {e}")

    # Set up live client
    aggregator = CandleAggregator()
    total_records = 0
    total_upserted = 0
    running = True
    error_msg = None
    client = None

    # Backfill recent data first
    if backfill_minutes > 0:
        try:
            total_upserted += backfill_recent(engine, db.Live, symbol, backfill_minutes)
        except Exception as e:
            print(f"[mes-live-databento] Backfill failed (non-fatal): {e}")

    def on_signal(signum, frame):
        nonlocal running
        print(f"\n[mes-live-databento] Received signal {signum}, shutting down...")
        running = False

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    def record_callback(record):
        nonlocal total_records
        # OHLCVMsg has open, high, low, close, volume, ts_event
        if hasattr(record, "open") and hasattr(record, "close") and hasattr(record, "volume"):
            aggregator.ingest(
                record.ts_event,
                record.open,
                record.high,
                record.low,
                record.close,
                record.volume,
            )
            total_records += 1

    # Periodic flush thread
    def flush_loop():
        nonlocal total_upserted
        while running:
            time.sleep(FLUSH_INTERVAL_SEC)
            if not running:
                break
            candles = aggregator.drain()
            if candles:
                try:
                    n = flush_candles(engine, candles)
                    total_upserted += n
                    print(
                        f"[mes-live-databento] flushed {len(candles)} candles, "
                        f"total_records={total_records} total_upserted={total_upserted}"
                    )
                except Exception as e:
                    print(f"[mes-live-databento] flush error: {e}")

    try:
        flush_thread = threading.Thread(target=flush_loop, daemon=True)
        flush_thread.start()

        # Connect and subscribe
        print(f"[mes-live-databento] Connecting to Databento Live gateway...")
        client = db.Live(key=api_key)
        client.subscribe(
            dataset=DATASET,
            schema="ohlcv-1m",
            symbols=symbol,
            stype_in="continuous",
        )
        client.add_callback(record_callback)

        print(f"[mes-live-databento] Starting live stream (flush every {FLUSH_INTERVAL_SEC}s)...")
        client.start()

        # Block until signal
        while running:
            time.sleep(1)
    except KeyboardInterrupt:
        running = False
    except Exception as e:
        error_msg = str(e)
        running = False
        print(f"[mes-live-databento] ERROR: {error_msg}", file=sys.stderr)

    # Shutdown and finalize
    print("[mes-live-databento] Stopping live client...")
    if client is not None:
        try:
            client.stop()
            client.block_for_close(timeout=5)
        except Exception:
            try:
                client.terminate()
            except Exception:
                pass

    # Final flush
    candles = aggregator.drain()
    if candles:
        try:
            n = flush_candles(engine, candles)
            total_upserted += n
        except Exception as e:
            if error_msg is None:
                error_msg = f"final flush failed: {e}"
            print(f"[mes-live-databento] WARNING: {error_msg}")

    # Finalize ingestion run
    if run_id:
        try:
            with engine.begin() as conn:
                status = "FAILED" if error_msg else "COMPLETED"
                finalize_ingestion_run(conn, run_id, status, total_upserted, error_msg)
        except Exception as e:
            print(f"[mes-live-databento] WARNING: Could not finalize IngestionRun: {e}")

    print(
        f"[mes-live-databento] Stopped. total_records={total_records} total_upserted={total_upserted}"
    )
    if error_msg:
        sys.exit(1)


if __name__ == "__main__":
    main()
