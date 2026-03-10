#!/usr/bin/env python3
"""
Dedicated MES live 1m writer (external worker path).

Owns:
  - Writes only mkt_futures_mes_1m

Does not own:
  - mkt_futures_mes_15m or any higher timeframe table
  - trigger computation
  - chart rendering

Source contract (approved):
  - dataset: GLBX.MDP3
  - schema: OHLCV_1M
  - symbol: MES.c.0
  - stype_in: continuous
  - snapshot: false

Operational note:
  Keep this worker isolated. Do not run it concurrently with another
  authoritative MES upstream pull owner in production.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import signal
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any

import databento as db
import databento_dbn as dbn
import psycopg2
from psycopg2.extras import Json, execute_values


SOURCE = "DATABENTO"
APPROVED_DATASET = "GLBX.MDP3"
APPROVED_SCHEMA = "OHLCV_1M"
APPROVED_SYMBOL = "MES.c.0"
APPROVED_STYPE_IN = "continuous"
APPROVED_SNAPSHOT = False
JOB_NAME = "mes-live-1m-worker"
PRICE_QUANT = Decimal("0.000001")
ISO_TS_PATTERN = r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})"
AVAILABLE_END_PATTERNS = (
    re.compile(rf"available_end[\"']?\s*[=:]\s*[\"']?(?P<ts>{ISO_TS_PATTERN})[\"']?", re.IGNORECASE),
    re.compile(rf"available\s+end\D+(?P<ts>{ISO_TS_PATTERN})", re.IGNORECASE),
)

UPSERT_SQL = """
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
        "source" = EXCLUDED."source",
        "sourceDataset" = EXCLUDED."sourceDataset",
        "sourceSchema" = EXCLUDED."sourceSchema",
        "ingestedAt" = NOW(),
        "knowledgeTime" = NOW()
"""

UPSERT_TEMPLATE = (
    "(%(eventTime)s, %(open)s, %(high)s, %(low)s, %(close)s, %(volume)s, "
    "%(source)s::\"DataSource\", %(sourceDataset)s, %(sourceSchema)s, %(rowHash)s, NOW(), NOW())"
)


def load_env_files() -> None:
    """Best-effort dotenv loading for local/dev parity."""
    try:
        from dotenv import load_dotenv
    except Exception:
        return

    for path in (".env.production.local", ".env.local", ".env"):
        load_dotenv(path, override=False)


def resolve_db_url(explicit: str | None) -> str:
    if explicit:
        return explicit
    db_url = os.environ.get("DIRECT_URL") or os.environ.get("LOCAL_DATABASE_URL")
    if not db_url:
        raise RuntimeError("DIRECT_URL or LOCAL_DATABASE_URL is required")
    return db_url


def ns_to_utc(ts_ns: int) -> datetime:
    sec, ns_rem = divmod(int(ts_ns), 1_000_000_000)
    return datetime.fromtimestamp(sec, tz=timezone.utc).replace(
        microsecond=ns_rem // 1_000
    )


def quantize_price(raw: Any) -> Decimal:
    return Decimal(str(raw)).quantize(PRICE_QUANT, rounding=ROUND_HALF_UP)


def row_hash(event_time: datetime, close_price: Decimal) -> str:
    raw = f"MES-1M|{event_time.isoformat()}|{close_price}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def ensure_utc_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        dt = value
    elif hasattr(value, "to_pydatetime"):
        dt = value.to_pydatetime()
    elif isinstance(value, (int, float)):
        dt = ns_to_utc(int(value))
    else:
        dt = datetime.fromisoformat(str(value))

    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def dedupe_rows_by_event_time(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    deduped: dict[datetime, dict[str, Any]] = {}
    for row in rows:
        deduped[row["eventTime"]] = row
    return [deduped[key] for key in sorted(deduped.keys())]


def upsert_rows(
    conn: psycopg2.extensions.connection,
    rows: list[dict[str, Any]],
    batch_size: int,
) -> int:
    if not rows:
        return 0
    deduped_rows = dedupe_rows_by_event_time(rows)
    with conn.cursor() as cur:
        execute_values(
            cur,
            UPSERT_SQL,
            deduped_rows,
            template=UPSERT_TEMPLATE,
            page_size=max(1, batch_size),
        )
    conn.commit()
    return len(deduped_rows)


def enforce_subscription_contract(args: argparse.Namespace) -> None:
    mismatches: list[str] = []
    if args.dataset != APPROVED_DATASET:
        mismatches.append(f"dataset={args.dataset} (expected {APPROVED_DATASET})")
    if args.schema != APPROVED_SCHEMA:
        mismatches.append(f"schema={args.schema} (expected {APPROVED_SCHEMA})")
    if args.symbol != APPROVED_SYMBOL:
        mismatches.append(f"symbol={args.symbol} (expected {APPROVED_SYMBOL})")
    if args.stype_in != APPROVED_STYPE_IN:
        mismatches.append(f"stype_in={args.stype_in} (expected {APPROVED_STYPE_IN})")
    if args.snapshot != APPROVED_SNAPSHOT:
        mismatches.append(f"snapshot={args.snapshot} (expected {APPROVED_SNAPSHOT})")

    if mismatches and not args.allow_contract_override:
        joined = "; ".join(mismatches)
        raise RuntimeError(
            f"Subscription contract violation: {joined}. "
            "Use --allow-contract-override only for controlled testing."
        )


def latest_event_time_1m(conn: psycopg2.extensions.connection) -> datetime | None:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT "eventTime"
            FROM "mkt_futures_mes_1m"
            ORDER BY "eventTime" DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
    if not row or row[0] is None:
        return None
    return ensure_utc_datetime(row[0])


def is_historical_end_lag_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "data_end_after_available_end" in text
        or ("data_end" in text and "available_end" in text)
        or "end is after available historical end" in text
    )


def is_historical_start_lag_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return (
        "data_start_after_available_end" in text
        or ("data_start" in text and "available_end" in text)
        or "start is after available historical end" in text
    )


def extract_available_end(value: str) -> datetime | None:
    for pattern in AVAILABLE_END_PATTERNS:
        match = pattern.search(value)
        if not match:
            continue
        raw = match.group("ts").strip()
        if raw.endswith("Z"):
            raw = f"{raw[:-1]}+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    return None


@dataclass
class WorkerStats:
    received_rows: int = 0
    upserted_rows: int = 0
    flush_count: int = 0
    flush_errors: int = 0
    dropped_rows: int = 0
    last_event_time: datetime | None = None
    last_flush_at: datetime | None = None


class IngestionRunTracker:
    def __init__(self, conn: psycopg2.extensions.connection, enabled: bool, details: dict[str, Any]):
        self.conn = conn
        self.enabled = enabled
        self.details = details
        self.run_id: int | None = None

    def start(self) -> None:
        if not self.enabled:
            return
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO "ingestion_runs" ("job", "status", "details")
                VALUES (%s, 'RUNNING'::"IngestionStatus", %s)
                RETURNING "id"
                """,
                (JOB_NAME, Json(self.details)),
            )
            self.run_id = int(cur.fetchone()[0])
        self.conn.commit()

    def heartbeat(self, stats: WorkerStats) -> None:
        if not self.enabled or self.run_id is None:
            return
        details = dict(self.details)
        details.update(
            {
                "receivedRows": stats.received_rows,
                "upsertedRows": stats.upserted_rows,
                "flushCount": stats.flush_count,
                "lastEventTime": stats.last_event_time.isoformat() if stats.last_event_time else None,
                "lastFlushAt": stats.last_flush_at.isoformat() if stats.last_flush_at else None,
            }
        )
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "ingestion_runs"
                SET "rowsProcessed" = %s,
                    "rowsInserted" = %s,
                    "rowsFailed" = %s,
                    "details" = %s
                WHERE "id" = %s
                """,
                (
                    stats.received_rows,
                    stats.upserted_rows,
                    stats.flush_errors,
                    Json(details),
                    self.run_id,
                ),
            )
        self.conn.commit()

    def finish(self, status: str, stats: WorkerStats, error: str | None = None) -> None:
        if not self.enabled or self.run_id is None:
            return
        details = dict(self.details)
        details.update(
            {
                "receivedRows": stats.received_rows,
                "upsertedRows": stats.upserted_rows,
                "flushCount": stats.flush_count,
                "flushErrors": stats.flush_errors,
                "droppedRows": stats.dropped_rows,
                "lastEventTime": stats.last_event_time.isoformat() if stats.last_event_time else None,
                "lastFlushAt": stats.last_flush_at.isoformat() if stats.last_flush_at else None,
                "error": error,
            }
        )
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE "ingestion_runs"
                SET "status" = %s::"IngestionStatus",
                    "finishedAt" = NOW(),
                    "rowsProcessed" = %s,
                    "rowsInserted" = %s,
                    "rowsFailed" = %s,
                    "details" = %s
                WHERE "id" = %s
                """,
                (
                    status,
                    stats.received_rows,
                    stats.upserted_rows,
                    stats.flush_errors,
                    Json(details),
                    self.run_id,
                ),
            )
        self.conn.commit()


def run_bounded_catchup(
    *,
    conn: psycopg2.extensions.connection,
    api_key: str,
    dataset: str,
    schema: str,
    symbol: str,
    stype_in: str,
    source_schema: str,
    max_minutes: int,
    batch_size: int,
    logger: logging.Logger,
    reason: str,
) -> dict[str, Any]:
    if max_minutes <= 0:
        return {
            "attempted": False,
            "reason": "catchup-disabled",
            "rowsUpserted": 0,
        }

    now_utc = datetime.now(timezone.utc)
    latest = latest_event_time_1m(conn)
    window_start = now_utc - timedelta(minutes=max_minutes)
    if latest is None:
        start_utc = window_start
    else:
        start_utc = max(window_start, latest + timedelta(minutes=1))

    if start_utc >= now_utc:
        return {
            "attempted": False,
            "degraded": False,
            "reason": "already-fresh",
            "rowsUpserted": 0,
            "start": start_utc.isoformat(),
            "requestedEnd": now_utc.isoformat(),
            "effectiveEnd": now_utc.isoformat(),
            "latestBefore": latest.isoformat() if latest else None,
        }

    logger.info(
        "[catchup:%s] start=%s end=%s max_minutes=%d",
        reason,
        start_utc.isoformat(),
        now_utc.isoformat(),
        max_minutes,
    )

    historical = db.Historical(api_key)
    requested_end_utc = now_utc
    effective_end_utc = requested_end_utc
    degraded = False
    available_end_utc: datetime | None = None

    def get_df(end_utc: datetime):
        store = historical.timeseries.get_range(
            dataset=dataset,
            schema=schema,
            symbols=symbol,
            stype_in=stype_in,
            start=start_utc.isoformat(),
            end=end_utc.isoformat(),
        )
        return store.to_df()

    try:
        df = get_df(effective_end_utc)
    except Exception as exc:
        if is_historical_start_lag_error(exc):
            degraded = True
            error_text = str(exc)
            available_end_utc = extract_available_end(error_text)
            logger.warning(
                "[catchup:%s] historical start lag detected; start=%s requested_end=%s available_end=%s; skipping catch-up and continuing live",
                reason,
                start_utc.isoformat(),
                requested_end_utc.isoformat(),
                available_end_utc.isoformat() if available_end_utc else "unknown",
            )
            return {
                "attempted": True,
                "degraded": True,
                "reason": "historical-start-lag-skip",
                "errorCode": "data_start_after_available_end",
                "rowsUpserted": 0,
                "start": start_utc.isoformat(),
                "requestedEnd": requested_end_utc.isoformat(),
                "effectiveEnd": (
                    min(available_end_utc, requested_end_utc).isoformat()
                    if available_end_utc
                    else requested_end_utc.isoformat()
                ),
                "availableEnd": available_end_utc.isoformat() if available_end_utc else None,
                "latestBefore": latest.isoformat() if latest else None,
            }

        if not is_historical_end_lag_error(exc):
            raise

        degraded = True
        error_text = str(exc)
        available_end_utc = extract_available_end(error_text)

        if available_end_utc and available_end_utc > start_utc:
            effective_end_utc = min(available_end_utc, requested_end_utc)
            logger.warning(
                "[catchup:%s] historical lag detected; requested_end=%s available_end=%s clamped_end=%s",
                reason,
                requested_end_utc.isoformat(),
                available_end_utc.isoformat(),
                effective_end_utc.isoformat(),
            )
            try:
                df = get_df(effective_end_utc)
            except Exception as retry_exc:
                if is_historical_start_lag_error(retry_exc):
                    retry_error_text = str(retry_exc)
                    retry_available_end_utc = extract_available_end(retry_error_text)
                    logger.warning(
                        "[catchup:%s] historical start lag after clamp; start=%s clamped_end=%s available_end=%s; skipping catch-up and continuing live",
                        reason,
                        start_utc.isoformat(),
                        effective_end_utc.isoformat(),
                        retry_available_end_utc.isoformat() if retry_available_end_utc else "unknown",
                    )
                    return {
                        "attempted": True,
                        "degraded": True,
                        "reason": "historical-start-lag-skip",
                        "errorCode": "data_start_after_available_end",
                        "rowsUpserted": 0,
                        "start": start_utc.isoformat(),
                        "requestedEnd": requested_end_utc.isoformat(),
                        "effectiveEnd": effective_end_utc.isoformat(),
                        "availableEnd": (
                            retry_available_end_utc.isoformat()
                            if retry_available_end_utc
                            else available_end_utc.isoformat() if available_end_utc else None
                        ),
                        "latestBefore": latest.isoformat() if latest else None,
                    }
                if not is_historical_end_lag_error(retry_exc):
                    raise
                logger.warning(
                    "[catchup:%s] historical lag persists after clamp; skipping catch-up and continuing live",
                    reason,
                )
                return {
                    "attempted": True,
                    "degraded": True,
                    "reason": "historical-lag-skip",
                    "errorCode": "data_end_after_available_end",
                    "rowsUpserted": 0,
                    "start": start_utc.isoformat(),
                    "requestedEnd": requested_end_utc.isoformat(),
                    "effectiveEnd": effective_end_utc.isoformat(),
                    "availableEnd": available_end_utc.isoformat(),
                    "latestBefore": latest.isoformat() if latest else None,
                }
        else:
            logger.warning(
                "[catchup:%s] historical lag detected without usable available_end; skipping catch-up and continuing live",
                reason,
            )
            return {
                "attempted": True,
                "degraded": True,
                "reason": "historical-lag-skip",
                "errorCode": "data_end_after_available_end",
                "rowsUpserted": 0,
                "start": start_utc.isoformat(),
                "requestedEnd": requested_end_utc.isoformat(),
                "effectiveEnd": requested_end_utc.isoformat(),
                "availableEnd": available_end_utc.isoformat() if available_end_utc else None,
                "latestBefore": latest.isoformat() if latest else None,
            }

    if df.empty:
        return {
            "attempted": True,
            "degraded": degraded,
            "reason": "no-rows-returned",
            "rowsUpserted": 0,
            "start": start_utc.isoformat(),
            "requestedEnd": requested_end_utc.isoformat(),
            "effectiveEnd": effective_end_utc.isoformat(),
            "availableEnd": available_end_utc.isoformat() if available_end_utc else None,
            "latestBefore": latest.isoformat() if latest else None,
        }

    rows: list[dict[str, Any]] = []
    for idx, row in df.iterrows():
        event_time = ensure_utc_datetime(idx if "ts_event" not in row else row["ts_event"])
        open_px = quantize_price(row.get("open", row.get("pretty_open")))
        high_px = quantize_price(row.get("high", row.get("pretty_high")))
        low_px = quantize_price(row.get("low", row.get("pretty_low")))
        close_px = quantize_price(row.get("close", row.get("pretty_close")))
        volume = max(0, int(row.get("volume", 0)))
        rows.append(
            {
                "eventTime": event_time,
                "open": open_px,
                "high": high_px,
                "low": low_px,
                "close": close_px,
                "volume": volume,
                "source": SOURCE,
                "sourceDataset": dataset,
                "sourceSchema": source_schema,
                "rowHash": row_hash(event_time, close_px),
            }
        )

    rows_upserted = upsert_rows(conn, rows, batch_size)
    latest_written = rows[-1]["eventTime"].isoformat() if rows else None
    logger.info(
        "[catchup:%s] upserted_rows=%d latest_event=%s",
        reason,
        rows_upserted,
        latest_written,
    )
    return {
        "attempted": True,
        "degraded": degraded,
        "reason": "ok" if not degraded else "ok-clamped-end",
        "rowsUpserted": rows_upserted,
        "start": start_utc.isoformat(),
        "requestedEnd": requested_end_utc.isoformat(),
        "effectiveEnd": effective_end_utc.isoformat(),
        "availableEnd": available_end_utc.isoformat() if available_end_utc else None,
        "latestBefore": latest.isoformat() if latest else None,
        "latestWritten": latest_written,
    }


class MesLive1mSink:
    def __init__(
        self,
        conn: psycopg2.extensions.connection,
        batch_size: int,
        flush_interval_s: float,
        source_dataset: str,
        source_schema: str,
        tracker: IngestionRunTracker,
        logger: logging.Logger,
    ) -> None:
        self.conn = conn
        self.batch_size = max(1, batch_size)
        self.flush_interval_s = max(0.1, flush_interval_s)
        self.source_dataset = source_dataset
        self.source_schema = source_schema
        self.tracker = tracker
        self.logger = logger
        self.stats = WorkerStats()
        self._pending_by_event_time: dict[datetime, dict[str, Any]] = {}
        self._last_flush_monotonic = time.monotonic()
        self._lock = threading.Lock()

    def append_ohlcv(self, rec: dbn.OHLCVMsg) -> None:
        event_time = ns_to_utc(int(rec.ts_event))
        open_px = quantize_price(getattr(rec, "pretty_open", rec.open))
        high_px = quantize_price(getattr(rec, "pretty_high", rec.high))
        low_px = quantize_price(getattr(rec, "pretty_low", rec.low))
        close_px = quantize_price(getattr(rec, "pretty_close", rec.close))
        volume = max(0, int(rec.volume))

        row = {
            "eventTime": event_time,
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "volume": volume,
            "source": SOURCE,
            "sourceDataset": self.source_dataset,
            "sourceSchema": self.source_schema,
            "rowHash": row_hash(event_time, close_px),
        }

        with self._lock:
            self._pending_by_event_time[event_time] = row
            self.stats.received_rows += 1
            self.stats.last_event_time = event_time
            should_flush = len(self._pending_by_event_time) >= self.batch_size or (
                time.monotonic() - self._last_flush_monotonic
            ) >= self.flush_interval_s
            if should_flush:
                self._flush_locked()

    def flush_if_due(self) -> None:
        with self._lock:
            if not self._pending_by_event_time:
                return
            if (time.monotonic() - self._last_flush_monotonic) >= self.flush_interval_s:
                self._flush_locked()

    def flush_all(self) -> None:
        with self._lock:
            if self._pending_by_event_time:
                self._flush_locked()

    def _flush_locked(self) -> None:
        if not self._pending_by_event_time:
            return
        rows = [self._pending_by_event_time[k] for k in sorted(self._pending_by_event_time.keys())]
        try:
            upserted = upsert_rows(self.conn, rows, self.batch_size)
            self._pending_by_event_time.clear()
            self.stats.upserted_rows += upserted
            self.stats.flush_count += 1
            self.stats.last_flush_at = datetime.now(timezone.utc)
            latest = rows[-1]["eventTime"].isoformat()
            self.logger.info(
                "[flush] rows=%d total_upserted=%d latest_event=%s",
                upserted,
                self.stats.upserted_rows,
                latest,
            )
            self.tracker.heartbeat(self.stats)
        except Exception:
            self.conn.rollback()
            self.stats.flush_errors += 1
            self.logger.exception(
                "[flush] failed pending_rows=%d (will retry)",
                len(self._pending_by_event_time),
            )
            self.tracker.heartbeat(self.stats)
        finally:
            self._last_flush_monotonic = time.monotonic()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Dedicated MES live 1m writer using Databento Live OHLCV_1M",
    )
    parser.add_argument("--db-url", default=None, help="Override DIRECT_URL/LOCAL_DATABASE_URL")
    parser.add_argument("--dataset", default=APPROVED_DATASET)
    parser.add_argument("--schema", default=APPROVED_SCHEMA)
    parser.add_argument("--symbol", default=APPROVED_SYMBOL)
    parser.add_argument("--stype-in", default=APPROVED_STYPE_IN)
    parser.add_argument("--snapshot", action="store_true", help="Enable live snapshot (default: false)")
    parser.add_argument(
        "--allow-contract-override",
        action="store_true",
        help="Allow non-approved subscription args (testing only)",
    )
    parser.add_argument("--batch-size", type=int, default=20)
    parser.add_argument("--flush-interval-seconds", type=float, default=2.0)
    parser.add_argument(
        "--catchup-max-minutes",
        type=int,
        default=30,
        help="Bounded startup/reconnect historical catch-up window",
    )
    parser.add_argument("--max-runtime-seconds", type=int, default=0)
    parser.add_argument("--log-ingestion-runs", action="store_true")
    parser.add_argument("--check-config", action="store_true")
    return parser


def main() -> int:
    load_env_files()
    args = build_parser().parse_args()
    enforce_subscription_contract(args)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    logger = logging.getLogger("mes-live-1m")

    api_key = os.environ.get("DATABENTO_API_KEY")
    db_url = resolve_db_url(args.db_url)
    source_schema_live = f"LIVE_{args.schema.upper()}_{args.stype_in.upper()}"
    source_schema_catchup = f"HIST_{args.schema.upper()}_{args.stype_in.upper()}_CATCHUP"

    config_summary = {
        "dataset": args.dataset,
        "schema": args.schema,
        "symbol": args.symbol,
        "stypeIn": args.stype_in,
        "snapshot": args.snapshot,
        "sourceSchemaLive": source_schema_live,
        "sourceSchemaCatchup": source_schema_catchup,
        "catchupMaxMinutes": args.catchup_max_minutes,
        "allowContractOverride": args.allow_contract_override,
        "logIngestionRuns": args.log_ingestion_runs,
    }

    if args.check_config:
        print(json.dumps({"ok": True, "config": config_summary}, indent=2))
        return 0

    if not api_key:
        raise RuntimeError("DATABENTO_API_KEY is required")

    stop_requested = threading.Event()
    catchup_requested = threading.Event()
    live_client: db.Live | None = None
    conn: psycopg2.extensions.connection | None = None
    tracker: IngestionRunTracker | None = None
    sink: MesLive1mSink | None = None

    def request_stop(signum: int, _frame: Any) -> None:
        logger.warning("shutdown signal received: %s", signum)
        stop_requested.set()
        if live_client is not None:
            try:
                live_client.stop()
            except Exception:
                logger.exception("failed to stop live client")

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)

    def record_callback(record: dbn.DBNRecord) -> None:
        if sink is None:
            logger.error("[callback] sink not initialized; dropping record")
            return
        if isinstance(record, dbn.OHLCVMsg):
            sink.append_ohlcv(record)
        elif isinstance(record, dbn.SymbolMappingMsg):
            logger.info(
                "[mapping] instrument_id=%s raw_symbol=%s",
                getattr(record, "instrument_id", None),
                getattr(record, "stype_out_symbol", None),
            )
        elif isinstance(record, dbn.SystemMsg):
            logger.info("[system] %s", record)

    def callback_error(exc: Exception) -> None:
        logger.exception("[callback] exception: %s", exc)

    def reconnect_callback(*args: Any) -> None:
        logger.warning("[live] reconnect event: %s", args)
        catchup_requested.set()

    start_time = time.monotonic()
    status = "COMPLETED"
    error_text: str | None = None

    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = False
        tracker = IngestionRunTracker(conn, args.log_ingestion_runs, config_summary)
        tracker.start()

        sink = MesLive1mSink(
            conn=conn,
            batch_size=args.batch_size,
            flush_interval_s=args.flush_interval_seconds,
            source_dataset=args.dataset,
            source_schema=source_schema_live,
            tracker=tracker,
            logger=logger,
        )

        startup_catchup = run_bounded_catchup(
            conn=conn,
            api_key=api_key,
            dataset=args.dataset,
            schema=args.schema,
            symbol=args.symbol,
            stype_in=args.stype_in,
            source_schema=source_schema_catchup,
            max_minutes=args.catchup_max_minutes,
            batch_size=args.batch_size,
            logger=logger,
            reason="startup",
        )
        logger.info("[catchup:startup] result=%s", startup_catchup)

        live_client = db.Live(
            key=api_key,
            reconnect_policy=db.ReconnectPolicy.RECONNECT,
        )
        live_client.add_callback(record_callback, callback_error)
        live_client.add_reconnect_callback(reconnect_callback, callback_error)

        logger.info(
            "[connect] subscribing dataset=%s schema=%s symbol=%s stype_in=%s snapshot=%s",
            args.dataset,
            args.schema,
            args.symbol,
            args.stype_in,
            args.snapshot,
        )
        live_client.subscribe(
            dataset=args.dataset,
            schema=args.schema,
            symbols=args.symbol,
            stype_in=args.stype_in,
            snapshot=args.snapshot,
        )
        live_client.start()
        logger.info("[connect] live client started")

        while not stop_requested.is_set():
            if args.max_runtime_seconds > 0:
                elapsed = time.monotonic() - start_time
                if elapsed >= args.max_runtime_seconds:
                    logger.info("max runtime reached (%ss), stopping", args.max_runtime_seconds)
                    break
            if catchup_requested.is_set():
                catchup_requested.clear()
                sink.flush_all()
                reconnect_catchup = run_bounded_catchup(
                    conn=conn,
                    api_key=api_key,
                    dataset=args.dataset,
                    schema=args.schema,
                    symbol=args.symbol,
                    stype_in=args.stype_in,
                    source_schema=source_schema_catchup,
                    max_minutes=args.catchup_max_minutes,
                    batch_size=args.batch_size,
                    logger=logger,
                    reason="reconnect",
                )
                logger.info("[catchup:reconnect] result=%s", reconnect_catchup)
            sink.flush_if_due()
            time.sleep(1.0)

    except Exception as exc:
        status = "FAILED"
        error_text = str(exc)
        logger.exception("worker failed")
    finally:
        stop_requested.set()
        if live_client is not None:
            try:
                live_client.stop()
            except Exception:
                logger.exception("failed to stop live client")
            try:
                live_client.terminate()
            except Exception:
                logger.exception("failed to terminate live client")
        if sink is not None:
            sink.flush_all()
        if tracker is not None and sink is not None:
            tracker.finish(status=status, stats=sink.stats, error=error_text)
        if conn is not None:
            conn.close()

    return 0 if status == "COMPLETED" else 1


if __name__ == "__main__":
    raise SystemExit(main())
