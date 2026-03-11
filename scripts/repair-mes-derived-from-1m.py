#!/usr/bin/env python3
"""
DB-only MES derived timeframe repair/backfill utility.

Reads stored mkt_futures_mes_1m rows and upserts derived candles into:
  - mkt_futures_mes_15m
  - mkt_futures_mes_1h
  - mkt_futures_mes_4h
  - mkt_futures_mes_1d

This script never calls Databento.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import execute_values

PRICE_QUANT = Decimal("0.000001")
MES_DATASET = "GLBX.MDP3"

SOURCE_SCHEMAS = {
    "15m": "mkt_futures_mes_1m->15m",
    "1h": "mkt_futures_mes_1m->1h",
    "4h": "mkt_futures_mes_1m->4h",
    "1d": "mkt_futures_mes_1m->1d",
}

INTRADAY_TABLES = {
    "15m": "mkt_futures_mes_15m",
    "1h": "mkt_futures_mes_1h",
    "4h": "mkt_futures_mes_4h",
}

BUCKET_SECONDS = {
    "15m": 15 * 60,
    "1h": 60 * 60,
    "4h": 4 * 60 * 60,
}

INTRADAY_UPSERT_SQL = {
    "15m": """
        INSERT INTO "mkt_futures_mes_15m" (
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
            "source" = EXCLUDED."source",
            "sourceDataset" = EXCLUDED."sourceDataset",
            "sourceSchema" = EXCLUDED."sourceSchema",
            "rowHash" = EXCLUDED."rowHash",
            "ingestedAt" = NOW(),
            "knowledgeTime" = NOW()
    """,
    "1h": """
        INSERT INTO "mkt_futures_mes_1h" (
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
            "source" = EXCLUDED."source",
            "sourceDataset" = EXCLUDED."sourceDataset",
            "sourceSchema" = EXCLUDED."sourceSchema",
            "rowHash" = EXCLUDED."rowHash",
            "ingestedAt" = NOW(),
            "knowledgeTime" = NOW()
    """,
    "4h": """
        INSERT INTO "mkt_futures_mes_4h" (
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
            "source" = EXCLUDED."source",
            "sourceDataset" = EXCLUDED."sourceDataset",
            "sourceSchema" = EXCLUDED."sourceSchema",
            "rowHash" = EXCLUDED."rowHash",
            "ingestedAt" = NOW(),
            "knowledgeTime" = NOW()
    """,
}

INTRADAY_TEMPLATE = (
    "(%(eventTime)s, %(open)s, %(high)s, %(low)s, %(close)s, %(volume)s, "
    "%(source)s::\"DataSource\", %(sourceDataset)s, %(sourceSchema)s, %(rowHash)s, NOW(), NOW())"
)

DAILY_UPSERT_SQL = """
    INSERT INTO "mkt_futures_mes_1d" (
        "eventDate", "open", "high", "low", "close", "volume",
        "source", "sourceDataset", "sourceSchema", "rowHash",
        "ingestedAt", "knowledgeTime"
    )
    VALUES %s
    ON CONFLICT ("eventDate") DO UPDATE SET
        "open" = EXCLUDED."open",
        "high" = EXCLUDED."high",
        "low" = EXCLUDED."low",
        "close" = EXCLUDED."close",
        "volume" = EXCLUDED."volume",
        "source" = EXCLUDED."source",
        "sourceDataset" = EXCLUDED."sourceDataset",
        "sourceSchema" = EXCLUDED."sourceSchema",
        "rowHash" = EXCLUDED."rowHash",
        "ingestedAt" = NOW(),
        "knowledgeTime" = NOW()
"""

DAILY_TEMPLATE = (
    "(%(eventDate)s, %(open)s, %(high)s, %(low)s, %(close)s, %(volume)s, "
    "%(source)s::\"DataSource\", %(sourceDataset)s, %(sourceSchema)s, %(rowHash)s, NOW(), NOW())"
)


def load_env_files() -> None:
    for name in (".env.production.local", ".env.local", ".env"):
        path = Path(name)
        if not path.exists():
            continue
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"')
            if key and key not in os.environ:
                os.environ[key] = value


def resolve_db_url(explicit: str | None) -> str:
    if explicit:
        return explicit
    db_url = os.environ.get("DIRECT_URL") or os.environ.get("LOCAL_DATABASE_URL")
    if not db_url:
        raise RuntimeError("DIRECT_URL or LOCAL_DATABASE_URL is required")
    return db_url


def parse_iso(value: str) -> datetime:
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    if "T" not in normalized and " " not in normalized:
        normalized = f"{normalized}T00:00:00+00:00"
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def parse_timeframes(raw: str) -> list[str]:
    requested = [part.strip().lower() for part in raw.split(",") if part.strip()]
    allowed = {"15m", "1h", "4h", "1d"}
    if not requested:
        return ["15m", "1h", "4h", "1d"]
    invalid = [tf for tf in requested if tf not in allowed]
    if invalid:
        raise RuntimeError(f"Unsupported timeframe(s): {', '.join(invalid)}")
    ordered = [tf for tf in ("15m", "1h", "4h", "1d") if tf in requested]
    return ordered


def quantize_price(value: Any) -> Decimal:
    return Decimal(str(value)).quantize(PRICE_QUANT, rounding=ROUND_HALF_UP)


def hash_row(prefix: str, key: datetime | date, close_price: Decimal) -> str:
    if isinstance(key, datetime):
        raw_key = key.isoformat()
    else:
        raw_key = key.isoformat()
    raw = f"{prefix}|{raw_key}|{close_price}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def aggregate_intraday(
    conn: psycopg2.extensions.connection,
    *,
    bucket_seconds: int,
    start_utc: datetime,
    end_utc: datetime,
    source_schema: str,
    hash_prefix: str,
) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                to_timestamp(
                    floor(extract(epoch from "eventTime") / %s) * %s
                ) AS bucket_time,
                (array_agg("open" ORDER BY "eventTime" ASC))[1] AS open,
                max("high") AS high,
                min("low") AS low,
                (array_agg("close" ORDER BY "eventTime" DESC))[1] AS close,
                COALESCE(sum(COALESCE("volume", 0)), 0)::bigint AS volume
            FROM "mkt_futures_mes_1m"
            WHERE "eventTime" >= %s
              AND "eventTime" <= %s
            GROUP BY 1
            ORDER BY 1 ASC
            """,
            (bucket_seconds, bucket_seconds, start_utc, end_utc),
        )
        records = cur.fetchall()

    rows: list[dict[str, Any]] = []
    deduped: dict[datetime, dict[str, Any]] = {}
    for record in records:
        event_time = record[0].astimezone(timezone.utc)
        open_px = quantize_price(record[1])
        high_px = quantize_price(record[2])
        low_px = quantize_price(record[3])
        close_px = quantize_price(record[4])
        deduped[event_time] = {
            "eventTime": event_time,
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "volume": max(0, int(record[5] or 0)),
            "source": "DATABENTO",
            "sourceDataset": MES_DATASET,
            "sourceSchema": source_schema,
            "rowHash": hash_row(hash_prefix, event_time, close_px),
        }
    for key in sorted(deduped.keys()):
        rows.append(deduped[key])
    return rows


def aggregate_daily(
    conn: psycopg2.extensions.connection,
    *,
    start_utc: datetime,
    end_utc: datetime,
) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT
                date_trunc('day', "eventTime" AT TIME ZONE 'UTC')::date AS event_date,
                (array_agg("open" ORDER BY "eventTime" ASC))[1] AS open,
                max("high") AS high,
                min("low") AS low,
                (array_agg("close" ORDER BY "eventTime" DESC))[1] AS close,
                COALESCE(sum(COALESCE("volume", 0)), 0)::bigint AS volume
            FROM "mkt_futures_mes_1m"
            WHERE "eventTime" >= %s
              AND "eventTime" <= %s
            GROUP BY 1
            ORDER BY 1 ASC
            """,
            (start_utc, end_utc),
        )
        records = cur.fetchall()

    rows: list[dict[str, Any]] = []
    deduped: dict[date, dict[str, Any]] = {}
    for record in records:
        event_date: date = record[0]
        open_px = quantize_price(record[1])
        high_px = quantize_price(record[2])
        low_px = quantize_price(record[3])
        close_px = quantize_price(record[4])
        deduped[event_date] = {
            "eventDate": event_date,
            "open": open_px,
            "high": high_px,
            "low": low_px,
            "close": close_px,
            "volume": max(0, int(record[5] or 0)),
            "source": "DATABENTO",
            "sourceDataset": MES_DATASET,
            "sourceSchema": SOURCE_SCHEMAS["1d"],
            "rowHash": hash_row("MES-1D", event_date, close_px),
        }
    for key in sorted(deduped.keys()):
        rows.append(deduped[key])
    return rows


def upsert_intraday(
    conn: psycopg2.extensions.connection,
    timeframe: str,
    rows: list[dict[str, Any]],
    batch_size: int,
) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            INTRADAY_UPSERT_SQL[timeframe],
            rows,
            template=INTRADAY_TEMPLATE,
            page_size=max(1, batch_size),
        )
    conn.commit()
    return len(rows)


def upsert_daily(
    conn: psycopg2.extensions.connection,
    rows: list[dict[str, Any]],
    batch_size: int,
) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        execute_values(
            cur,
            DAILY_UPSERT_SQL,
            rows,
            template=DAILY_TEMPLATE,
            page_size=max(1, batch_size),
        )
    conn.commit()
    return len(rows)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Repair/backfill MES derived timeframes from stored 1m data only",
    )
    parser.add_argument("--db-url", default=None, help="Override DIRECT_URL/LOCAL_DATABASE_URL")
    parser.add_argument("--start", required=True, help="UTC range start (YYYY-MM-DD or ISO timestamp)")
    parser.add_argument("--end", default=None, help="UTC range end (YYYY-MM-DD or ISO timestamp); defaults to now")
    parser.add_argument(
        "--timeframes",
        default="15m,1h,4h,1d",
        help="Comma-separated subset of 15m,1h,4h,1d",
    )
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    load_env_files()
    args = build_parser().parse_args()

    start_utc = parse_iso(args.start)
    end_utc = parse_iso(args.end) if args.end else datetime.now(timezone.utc)
    if start_utc >= end_utc:
        raise RuntimeError("start must be before end")

    requested = parse_timeframes(args.timeframes)
    db_url = resolve_db_url(args.db_url)

    print(
        f"[repair] start={start_utc.isoformat()} end={end_utc.isoformat()} "
        f"timeframes={','.join(requested)} dryRun={args.dry_run}"
    )

    conn = psycopg2.connect(db_url)
    try:
        for timeframe in requested:
            if timeframe in {"15m", "1h", "4h"}:
                rows = aggregate_intraday(
                    conn,
                    bucket_seconds=BUCKET_SECONDS[timeframe],
                    start_utc=start_utc,
                    end_utc=end_utc,
                    source_schema=SOURCE_SCHEMAS[timeframe],
                    hash_prefix=f"MES-{timeframe.upper()}",
                )
                if args.dry_run:
                    print(f"[repair:{timeframe}] aggregated={len(rows)} upserted=0 dryRun=true")
                else:
                    upserted = upsert_intraday(conn, timeframe, rows, args.batch_size)
                    print(f"[repair:{timeframe}] aggregated={len(rows)} upserted={upserted}")
                continue

            rows = aggregate_daily(
                conn,
                start_utc=start_utc,
                end_utc=end_utc,
            )
            if args.dry_run:
                print(f"[repair:1d] aggregated={len(rows)} upserted=0 dryRun=true")
            else:
                upserted = upsert_daily(conn, rows, args.batch_size)
                print(f"[repair:1d] aggregated={len(rows)} upserted={upserted}")
    finally:
        conn.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
