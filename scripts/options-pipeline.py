#!/usr/bin/env python3
"""
options-pipeline.py — Unified Options Data Pipeline

Downloads completed Databento batch jobs, converts to parquet,
ingests into local Postgres, replicates to production, and validates
every step.

One command. Full automation. Built-in checks before, during, and after.

Usage:
  cd "/Volumes/Satechi Hub/rabid-raccoon"
  set -a && source .env.local && source .env.production.local && set +a
  .venv-finance/bin/python scripts/options-pipeline.py

Flags:
  --skip-download     Skip Databento download (use existing raw files)
  --skip-convert      Skip raw → parquet conversion (use existing parquets)
  --with-stats        Enable options statistics download/convert/ingest/validation
  --local-only        Don't push to production
  --dry-run           Preview everything, write nothing
  --parent ES_OPT     Process only one parent symbol
"""
import sys
import os
import re
import time
import json
from pathlib import Path
from hashlib import sha256
from datetime import datetime, timezone
from typing import Any, Iterable

import pandas as pd

# ─── Paths ────────────────────────────────────────────────────────────────────

ROOT = Path(__file__).resolve().parent.parent
DATASETS = ROOT / "datasets"
OHLCV_RAW = DATASETS / "options-ohlcv-raw"
STATS_RAW = DATASETS / "options-statistics-raw"
DEFN_RAW = DATASETS / "options-definition-raw"
OHLCV_DIR = DATASETS / "options-ohlcv"
STATS_DIR = DATASETS / "options-statistics"

BATCH_SIZE = 500
STAT_SETTLEMENT, STAT_VOLUME, STAT_OI, STAT_IV = 3, 6, 9, 14
STAT_TYPES_TO_KEEP = {STAT_SETTLEMENT, STAT_VOLUME, STAT_OI, STAT_IV}

# ─── Logging ──────────────────────────────────────────────────────────────────

class Log:
    """Structured logger with step tracking."""
    def __init__(self):
        self.step = 0
        self.errors = []
        self.warnings = []

    def header(self, msg: str):
        self.step += 1
        print(f"\n{'='*70}")
        print(f"  STEP {self.step}: {msg}")
        print(f"{'='*70}")

    def ok(self, msg: str):
        print(f"  [OK] {msg}")

    def warn(self, msg: str):
        print(f"  [WARN] {msg}")
        self.warnings.append(msg)

    def fail(self, msg: str):
        print(f"  [FAIL] {msg}")
        self.errors.append(msg)

    def info(self, msg: str):
        print(f"  {msg}")

    def check(self, condition: bool, ok_msg: str, fail_msg: str) -> bool:
        if condition:
            self.ok(ok_msg)
        else:
            self.fail(fail_msg)
        return condition

log = Log()


# ─── Environment ──────────────────────────────────────────────────────────────

def load_env() -> dict[str, str]:
    """Load env vars from .env.local and .env.production.local."""
    env = dict(os.environ)
    for envfile in [".env.local", ".env.production.local", ".env"]:
        p = ROOT / envfile
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip().strip('"')
            if key not in env:
                env[key] = val
    return env


def get_engine(url: str):
    """Create SQLAlchemy engine from a Postgres URL."""
    from sqlalchemy import create_engine
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    return create_engine(url)


# ─── Symbol Helpers ──────────────────────────────────────────────────────────

def load_parent_map() -> dict[str, str] | None:
    """Load symbol registry and build root → parent map (e.g. ES → ES.OPT).

    Returns None if registry not found (logs failure).
    """
    registry_path = ROOT / "src" / "lib" / "symbol-registry" / "snapshot.json"
    if not registry_path.exists():
        log.fail(f"Symbol registry not found at {registry_path}")
        return None

    with open(registry_path) as f:
        registry = json.load(f)

    parent_map = {}
    for sym in registry.get("symbols", []):
        code = sym.get("code", "")
        if code.endswith(".OPT"):
            root = code.replace(".OPT", "")
            parent_map[root] = code

    log.info(f"Symbol registry: {len(parent_map)} option parents loaded")
    return parent_map


def map_symbol(sym_str: str, sorted_roots: list[str], parent_map: dict[str, str]) -> str | None:
    """Map contract symbol to parent by longest-prefix match."""
    sym_str = str(sym_str).strip()
    for root in sorted_roots:
        if sym_str.startswith(root):
            return parent_map[root]
    return None


# ─── DataFrame Helpers ───────────────────────────────────────────────────────

def resolve_symbol_column(df: pd.DataFrame) -> tuple[pd.DataFrame, str | None]:
    """Find or create the 'symbol' column. Returns (df, col_name) or (df, None)."""
    if "symbol" in df.columns:
        return df, "symbol"
    if df.index.name == "symbol":
        return df.reset_index(), "symbol"
    return df, None


def resolve_month_column(df: pd.DataFrame, dbn_file: Path) -> pd.DataFrame | None:
    """Add '_month' column from timestamp or filename. Returns None on failure."""
    ts_col = "ts_event" if "ts_event" in df.columns else (
        "ts_ref" if "ts_ref" in df.columns else None
    )
    if ts_col:
        df["_month"] = pd.to_datetime(df[ts_col]).dt.to_period("M")
        return df

    match = re.search(r"(\d{4})(\d{2})\d{2}-\d{8}", dbn_file.name)
    if not match:
        return None
    df["_month"] = pd.Period(f"{match.group(1)}-{match.group(2)}", freq="M")
    return df


def detect_count_column(df: pd.DataFrame) -> str | None:
    """Return the best column for counting unique contracts."""
    if "instrument_id" in df.columns:
        return "instrument_id"
    if "symbol" in df.columns:
        return "symbol"
    return None


def safe_stat_agg(
    day_df: pd.DataFrame,
    stat_type: int,
    col: str,
    agg_fn: str,
    cast_fn=float,
) -> float | int | None:
    """Filter day_df by stat_type, aggregate col with agg_fn, return cast result or None."""
    rows = day_df[day_df["stat_type"] == stat_type]
    if rows.empty or col not in rows.columns:
        return None
    return cast_fn(getattr(rows[col], agg_fn)())


# ─── Step 0: Preflight Checks ────────────────────────────────────────────────

def preflight(env: dict, with_stats: bool) -> tuple:
    """Validate environment, connections, and disk state before doing anything."""
    from sqlalchemy import text

    log.header("PREFLIGHT CHECKS")

    # Check env vars
    local_url = env.get("LOCAL_DATABASE_URL")
    direct_url = env.get("DIRECT_URL")
    databento_key = env.get("DATABENTO_API_KEY")

    log.check(bool(local_url), "LOCAL_DATABASE_URL present", "LOCAL_DATABASE_URL missing!")
    if direct_url:
        log.ok("DIRECT_URL present")
    else:
        log.warn("DIRECT_URL missing — local ingest can run, production replication will be skipped")
    log.check(bool(databento_key), f"DATABENTO_API_KEY present", "DATABENTO_API_KEY missing — downloads will fail")

    # Check local Postgres
    local_engine = None
    if local_url:
        try:
            local_engine = get_engine(local_url)
            with local_engine.connect() as c:
                c.execute(text("SELECT 1"))
            log.ok("Local Postgres connected")
        except Exception as e:
            log.fail(f"Local Postgres connection failed: {e}")
            local_engine = None

    # Check production Postgres
    prod_engine = None
    if direct_url:
        try:
            prod_engine = get_engine(direct_url)
            with prod_engine.connect() as c:
                c.execute(text("SELECT 1"))
            log.ok("Production Postgres connected")
        except Exception as e:
            log.fail(f"Production Postgres connection failed: {e}")
            prod_engine = None

    # Check existing data counts
    for label, engine in [("LOCAL", local_engine), ("PROD", prod_engine)]:
        if not engine:
            continue
        try:
            with engine.connect() as c:
                ohlcv_count = c.execute(text('SELECT count(*) FROM mkt_options_ohlcv_1d')).scalar()
                log.info(f"{label} mkt_options_ohlcv_1d: {ohlcv_count:,} rows")
                if with_stats:
                    agg_count = c.execute(text('SELECT count(*) FROM mkt_options_statistics_1d')).scalar()
                    log.info(f"{label} mkt_options_statistics_1d:   {agg_count:,} rows")
                else:
                    log.info(f"{label} mkt_options_statistics_1d:   skipped (stats disabled)")
        except Exception as e:
            log.warn(f"Could not read {label} row counts: {e}")

    # Check disk
    log.info(f"OHLCV raw dirs: {len(list(OHLCV_RAW.glob('GLBX-*'))) if OHLCV_RAW.exists() else 0}")
    log.info(f"OHLCV parquets: {len(list(OHLCV_DIR.rglob('*.parquet'))) if OHLCV_DIR.exists() else 0}")
    log.info(f"Stats raw dirs: {len(list(STATS_RAW.glob('GLBX-*'))) if STATS_RAW.exists() else 0}")
    log.info(f"Stats parquets: {len(list(STATS_DIR.rglob('*.parquet'))) if STATS_DIR.exists() else 0}")

    return local_engine, prod_engine, databento_key


# ─── Step 1: Download from Databento ─────────────────────────────────────────

def should_skip_job(
    job: dict,
    schema_to_dir: dict[str, Path],
    seen_schemas: dict[str, tuple[str, int]],
) -> str | None:
    """Check if a job should be skipped. Returns skip reason string, or None to proceed."""
    state = job["state"]
    schema = job["schema"]
    jid = job["id"]

    if state != "done":
        return f"{state} ({job.get('progress', '?')}%)"

    out_dir = schema_to_dir.get(schema, DATASETS / f"options-{schema}-raw")
    existing = out_dir / jid
    if existing.exists() and any(existing.iterdir()):
        return f"already on disk at {existing.name}/"

    rec_count = job.get("record_count", 0)
    if schema in seen_schemas:
        prev_id, prev_count = seen_schemas[schema]
        if rec_count == prev_count:
            return f"duplicate of {prev_id} ({rec_count:,} records)"

    return None


def download_jobs(databento_key: str, dry_run: bool, with_stats: bool) -> dict:
    """Download all completed Databento batch jobs. Returns summary."""
    import databento as db

    log.header("DOWNLOAD COMPLETED DATABENTO JOBS")

    client = db.Historical(databento_key)
    jobs = client.batch.list_jobs()
    log.info(f"Total batch jobs: {len(jobs)}")

    downloaded = {"ohlcv": 0, "statistics": 0, "definition": 0}
    schema_to_dir = {
        "ohlcv-1d": OHLCV_RAW,
        "statistics": STATS_RAW,
        "definition": DEFN_RAW,
    }

    seen_schemas = {}
    for j in jobs:
        jid, schema = j["id"], j["schema"]
        if schema == "statistics" and not with_stats:
            log.info(f"  {jid} ({schema}): stats disabled — skipping")
            continue
        skip_reason = should_skip_job(j, schema_to_dir, seen_schemas)
        if skip_reason:
            level = "ok" if "already on disk" in skip_reason else "info"
            getattr(log, level)(f"  {jid} ({schema}): {skip_reason} — skipping")
            continue

        seen_schemas[schema] = (jid, j.get("record_count", 0))
        out_dir = schema_to_dir.get(schema, DATASETS / f"options-{schema}-raw")
        rec_count = j.get("record_count", 0)
        expires = j.get("ts_expiration", "unknown")
        size_gb = j.get("package_size", 0) / 1e9
        log.info(f"  {jid} ({schema}): {rec_count:,} records, {size_gb:.1f} GB, expires {expires}")

        if dry_run:
            log.info(f"    → would download to {out_dir.name}/{jid}/")
            continue

        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            files = client.batch.download(jid, output_dir=str(out_dir))
            log.ok(f"    → downloaded {len(files)} files to {out_dir.name}/{jid}/")
            key = schema.replace("-1d", "")
            downloaded[key] = downloaded.get(key, 0) + len(files)
        except Exception as e:
            log.fail(f"    → download failed: {e}")

    return downloaded


# ─── Step 2: Convert Raw → Parquet ───────────────────────────────────────────

def process_dbn_file(
    dbn_file: Path,
    schema_label: str,
    sorted_roots: list[str],
    parent_map: dict[str, str],
    out_dir: Path,
    target_parent: str | None,
    dry_run: bool,
) -> int:
    """Process one .dbn.zst file: read, map symbols, write parquets. Returns row count."""
    import databento as db

    try:
        store = db.DBNStore.from_file(str(dbn_file))
        df = store.to_df()
    except Exception as e:
        log.warn(f"    {dbn_file.name}: failed to read — {e}")
        return 0

    if df.empty:
        return 0

    # Filter statistics to useful stat types
    if schema_label == "statistics" and "stat_type" in df.columns:
        df = df[df["stat_type"].isin(STAT_TYPES_TO_KEEP)]

    # Map symbols to parents
    df, sym_col = resolve_symbol_column(df)
    if not sym_col:
        log.warn(f"    {dbn_file.name}: no symbol column")
        return 0

    df["_parent"] = df[sym_col].apply(lambda s: map_symbol(s, sorted_roots, parent_map))
    unmapped = df["_parent"].isna().sum()
    if unmapped > 0:
        df = df.dropna(subset=["_parent"])

    if df.empty:
        return 0

    # Resolve month column
    df = resolve_month_column(df, dbn_file)
    if df is None:
        log.warn(f"    {dbn_file.name}: could not determine month — skipping")
        return 0

    # Write per-parent, per-month parquets
    total_rows = 0
    for (parent, month), group_df in df.groupby(["_parent", "_month"]):
        safe_parent = parent.replace(".", "_")
        if target_parent and safe_parent != target_parent:
            continue

        if dry_run:
            total_rows += len(group_df)
            continue

        parent_out = out_dir / safe_parent
        parent_out.mkdir(parents=True, exist_ok=True)
        save_df = group_df.drop(columns=["_parent", "_month"], errors="ignore")
        save_df.to_parquet(parent_out / f"{month}.parquet", index=False)
        total_rows += len(save_df)

    return total_rows


def convert_raw_to_parquet(dry_run: bool, target_parent: str | None = None, with_stats: bool = False):
    """Convert .dbn.zst files to per-symbol monthly parquets."""
    log.header("CONVERT RAW → PARQUET")

    parent_map = load_parent_map()
    if parent_map is None:
        return

    sorted_roots = sorted(parent_map.keys(), key=len, reverse=True)

    schemas = [("ohlcv-1d", OHLCV_RAW, OHLCV_DIR)]
    if with_stats:
        schemas.append(("statistics", STATS_RAW, STATS_DIR))

    for schema_label, raw_dir, out_dir in schemas:
        if not raw_dir.exists():
            log.info(f"  {schema_label}: no raw directory — skipping")
            continue

        job_dirs = sorted(d for d in raw_dir.iterdir() if d.is_dir() and d.name.startswith("GLBX-"))
        if not job_dirs:
            log.info(f"  {schema_label}: no job directories found — skipping")
            continue

        total_files = 0
        total_rows = 0

        for job_dir in job_dirs:
            dbn_files = sorted(job_dir.glob("*.dbn.zst"))
            if not dbn_files:
                continue
            log.info(f"  {schema_label}/{job_dir.name}: {len(dbn_files)} .dbn.zst files")
            for dbn_file in dbn_files:
                total_rows += process_dbn_file(
                    dbn_file, schema_label, sorted_roots, parent_map,
                    out_dir, target_parent, dry_run,
                )
                total_files += 1

        action = "would convert" if dry_run else "converted"
        log.ok(f"  {schema_label}: {action} {total_files} files → {total_rows:,} rows")


# ─── Step 3: Ingest Parquets → Local Postgres ────────────────────────────────

def iter_batches(rows: list[dict[str, Any]], batch_size: int = BATCH_SIZE) -> Iterable[list[dict[str, Any]]]:
    """Yield rows in fixed-size batches for efficient executemany upserts."""
    for i in range(0, len(rows), batch_size):
        yield rows[i:i + batch_size]


def get_parent_dirs(base_dir: Path, target_parent: str | None) -> list[Path]:
    """Return sorted parent directories, optionally filtered by one parent."""
    if not base_dir.exists():
        return []
    parent_dirs = sorted(d for d in base_dir.iterdir() if d.is_dir())
    if target_parent:
        return [d for d in parent_dirs if d.name == target_parent]
    return parent_dirs


def load_parent_dataframe(parent_dir: Path) -> pd.DataFrame | None:
    """Load and concatenate all parquet files for a parent directory."""
    files = sorted(parent_dir.glob("*.parquet"))
    if not files:
        return None

    dfs = []
    for parquet_file in files:
        try:
            dfs.append(pd.read_parquet(parquet_file))
        except Exception as exc:
            log.warn(f"  {parent_dir.name}/{parquet_file.name}: {exc}")

    if not dfs:
        return None
    return pd.concat(dfs, ignore_index=True)


def upsert_rows(engine, upsert_sql, rows: list[dict[str, Any]]):
    """Batch upserts to reduce per-row round trips."""
    if not rows:
        return
    with engine.begin() as conn:
        for batch in iter_batches(rows):
            conn.execute(upsert_sql, batch)


def create_ingestion_run(engine, label: str, target_parent: str | None, dry_run: bool) -> int | None:
    """Create an ingestion_runs record and return its id."""
    from sqlalchemy import text

    if dry_run:
        return None

    try:
        with engine.begin() as conn:
            row = conn.execute(text("""
                INSERT INTO "ingestion_runs" (job, status, details, "startedAt")
                VALUES (:job, 'RUNNING', :details::jsonb, NOW())
                RETURNING id
            """), {
                "job": f"options-pipeline-{label.lower()}",
                "details": json.dumps({"target": label, "parent": target_parent}),
            }).fetchone()
        run_id = row[0] if row else None
        log.ok(f"IngestionRun #{run_id} created")
        return run_id
    except Exception as exc:
        log.warn(f"Could not create IngestionRun: {exc}")
        return None


def finalize_ingestion_run(engine, run_id: int | None, result: dict[str, int], dry_run: bool):
    """Finalize ingestion_runs with completion status and inserted row counts."""
    from sqlalchemy import text

    if not run_id or dry_run:
        return

    total = result["ohlcv_rows"] + result["stats_rows"]
    status = "COMPLETED" if not log.errors else "FAILED"
    try:
        with engine.begin() as conn:
            conn.execute(text("""
                UPDATE "ingestion_runs"
                SET status = :status,
                    "finishedAt" = NOW(),
                    "rowsInserted" = :rows,
                    details = COALESCE(details, '{}'::jsonb) || :d::jsonb
                WHERE id = :id
            """), {
                "id": run_id,
                "status": status,
                "rows": total,
                "d": json.dumps(result),
            })
        log.ok(f"IngestionRun #{run_id} → {status} ({total:,} rows)")
    except Exception as exc:
        log.warn(f"Could not finalize IngestionRun: {exc}")


def build_ohlcv_rows(parent_symbol: str, df: pd.DataFrame) -> list[dict[str, Any]]:
    """Aggregate contract-level OHLCV rows into one row per eventDate."""
    if "ts_event" not in df.columns:
        return []

    df = df.copy()
    df["eventDate"] = pd.to_datetime(df["ts_event"]).dt.date
    count_col = detect_count_column(df)

    rows = []
    for date, day_df in df.groupby("eventDate"):
        volume = int(day_df["volume"].sum()) if "volume" in day_df.columns else None
        contract_count = int(day_df[count_col].nunique()) if count_col else None
        avg_close = float(day_df["close"].mean()) if "close" in day_df.columns else None
        max_high = float(day_df["high"].max()) if "high" in day_df.columns else None
        low_s = day_df[day_df["low"] > 0]["low"] if "low" in day_df.columns else pd.Series(dtype=float)
        min_low = float(low_s.min()) if not low_s.empty else None
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


def build_stats_rows(parent_symbol: str, df: pd.DataFrame) -> list[dict[str, Any]]:
    """Aggregate statistics rows into one row per eventDate."""
    date_col = "ts_event" if "ts_event" in df.columns else ("ts_ref" if "ts_ref" in df.columns else None)
    if not date_col or "stat_type" not in df.columns:
        return []

    df = df.copy()
    df["eventDate"] = pd.to_datetime(df[date_col]).dt.date
    count_col = detect_count_column(df)

    rows = []
    for date, day_df in df.groupby("eventDate"):
        total_volume = safe_stat_agg(day_df, STAT_VOLUME, "quantity", "sum", int)
        total_oi = safe_stat_agg(day_df, STAT_OI, "quantity", "sum", int)
        settlement = safe_stat_agg(day_df, STAT_SETTLEMENT, "price", "median")
        avg_iv = safe_stat_agg(day_df, STAT_IV, "price", "mean")
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


def ingest_ohlcv(engine, target_parent: str | None, dry_run: bool) -> int:
    """Ingest OHLCV parent parquets into mkt_options_ohlcv_1d."""
    from sqlalchemy import text

    parent_dirs = get_parent_dirs(OHLCV_DIR, target_parent)
    if not parent_dirs:
        log.info("  OHLCV: no parent directories found")
        return 0

    log.info(f"  OHLCV: {len(parent_dirs)} parents → mkt_options_ohlcv_1d")
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

    total_rows = 0
    for parent_dir in parent_dirs:
        parent_symbol = parent_dir.name.replace("_", ".")
        df = load_parent_dataframe(parent_dir)
        if df is None:
            continue

        rows = build_ohlcv_rows(parent_symbol, df)
        if not rows:
            log.warn(f"  {parent_dir.name}: no ts_event column — skipping")
            continue

        if dry_run:
            log.info(f"    {parent_dir.name}: {len(rows)} daily rows (dry run)")
        else:
            upsert_rows(engine, upsert_sql, rows)
            log.ok(f"    {parent_dir.name}: {len(rows)} daily rows upserted")
        total_rows += len(rows)

    return total_rows


def ingest_stats(engine, target_parent: str | None, dry_run: bool) -> int:
    """Ingest statistics parent parquets into mkt_options_statistics_1d."""
    from sqlalchemy import text

    parent_dirs = get_parent_dirs(STATS_DIR, target_parent)
    if not parent_dirs:
        log.info("  Statistics: no parent directories found (Databento jobs still processing)")
        return 0

    log.info(f"  Statistics: {len(parent_dirs)} parents → mkt_options_statistics_1d")
    upsert_sql = text("""
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

    total_rows = 0
    for parent_dir in parent_dirs:
        parent_symbol = parent_dir.name.replace("_", ".")
        df = load_parent_dataframe(parent_dir)
        if df is None:
            continue

        rows = build_stats_rows(parent_symbol, df)
        if not rows:
            log.warn(f"  {parent_dir.name}: missing columns — skipping")
            continue

        if dry_run:
            log.info(f"    {parent_dir.name}: {len(rows)} daily rows (dry run)")
        else:
            upsert_rows(engine, upsert_sql, rows)
            log.ok(f"    {parent_dir.name}: {len(rows)} daily rows upserted")
        total_rows += len(rows)

    return total_rows

def ingest_to_db(
    engine,
    label: str,
    target_parent: str | None,
    dry_run: bool,
    with_stats: bool,
) -> dict:
    """Ingest OHLCV and statistics parquets into a Postgres database."""
    log.header(f"INGEST → {label} POSTGRES")

    run_id = create_ingestion_run(engine, label, target_parent, dry_run)
    ohlcv_rows = ingest_ohlcv(engine, target_parent, dry_run)
    stats_rows = 0
    if with_stats:
        stats_rows = ingest_stats(engine, target_parent, dry_run)
    else:
        log.info("  Statistics ingest skipped (stats disabled)")

    result = {
        "ohlcv_rows": ohlcv_rows,
        "stats_rows": stats_rows,
    }
    finalize_ingestion_run(engine, run_id, result, dry_run)
    return result


# ─── Step 4: Post-Ingestion Validation ───────────────────────────────────────

def query_table_stats(engine, label: str, table: str) -> tuple[int, str]:
    """Query row count and max eventDate for a table. Returns (count, max_date_str)."""
    from sqlalchemy import text

    if not engine:
        return 0, "N/A"
    try:
        with engine.connect() as c:
            count = c.execute(text(f'SELECT count(*) FROM {table}')).scalar()
            row = c.execute(text(f'SELECT max("eventDate")::text FROM {table}')).fetchone()
            max_date = row[0] if row and row[0] else "N/A"
        return count, max_date
    except Exception as e:
        log.warn(f"Could not query {label} {table}: {e}")
        return 0, "N/A"


def validate(local_engine, prod_engine, with_stats: bool):
    """Compare local and production row counts and freshness."""
    from sqlalchemy import text

    log.header("POST-INGESTION VALIDATION")

    tables = ["mkt_options_ohlcv_1d"]
    if with_stats:
        tables.append("mkt_options_statistics_1d")

    for table in tables:
        local_count, local_max = query_table_stats(local_engine, "local", table)
        prod_count, prod_max = query_table_stats(prod_engine, "prod", table)

        match = "MATCH" if local_count == prod_count else "DRIFT"
        log.info(f"  {table}:")
        log.info(f"    LOCAL: {local_count:>8,} rows | latest: {local_max}")
        log.info(f"    PROD:  {prod_count:>8,} rows | latest: {prod_max}")
        log.info(f"    Status: {match}")

        if local_count != prod_count and local_count > 0 and prod_count > 0:
            log.warn(f"  {table}: local ({local_count:,}) != prod ({prod_count:,})")

    # Check ingestion_runs
    for label, engine in [("LOCAL", local_engine), ("PROD", prod_engine)]:
        if not engine:
            continue
        try:
            with engine.connect() as c:
                row = c.execute(text("""
                    SELECT job, status, "rowsInserted", "startedAt"::text
                    FROM ingestion_runs
                    ORDER BY "startedAt" DESC LIMIT 1
                """)).fetchone()
                if row:
                    log.info(f"  {label} latest ingestion: {row[0]} → {row[1]} ({row[2]:,} rows) at {row[3]}")
        except Exception:
            pass


# ─── CLI & Reporting ─────────────────────────────────────────────────────────

def parse_flags() -> dict:
    """Parse CLI flags from sys.argv."""
    flags = {
        "skip_download": "--skip-download" in sys.argv,
        "skip_convert": "--skip-convert" in sys.argv,
        "with_stats": "--with-stats" in sys.argv,
        "local_only": "--local-only" in sys.argv,
        "dry_run": "--dry-run" in sys.argv,
        "target_parent": None,
    }
    for i, arg in enumerate(sys.argv):
        if arg == "--parent" and i + 1 < len(sys.argv):
            flags["target_parent"] = sys.argv[i + 1]
    return flags


def print_banner(flags: dict):
    """Print the pipeline startup banner."""
    print("\n" + "="*70)
    print("  OPTIONS DATA PIPELINE")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    if flags["dry_run"]:
        print("  MODE: DRY RUN")
    if flags["local_only"]:
        print("  MODE: LOCAL ONLY (no prod push)")
    if flags["target_parent"]:
        print(f"  TARGET: {flags['target_parent']}")
    if flags["with_stats"]:
        print("  STATS: ENABLED (--with-stats)")
    else:
        print("  STATS: DISABLED (OHLCV-only mode)")
    print("="*70)


def print_report(local_result: dict, prod_result: dict, flags: dict, elapsed: float):
    """Print the final pipeline summary report."""
    print(f"\n{'='*70}")
    print(f"  PIPELINE COMPLETE — {elapsed:.1f}s")
    print(f"{'='*70}")
    print(f"  LOCAL:  OHLCV {local_result['ohlcv_rows']:>7,} rows  |  Stats {local_result['stats_rows']:>7,} rows")
    if not flags["local_only"]:
        print(f"  PROD:   OHLCV {prod_result['ohlcv_rows']:>7,} rows  |  Stats {prod_result['stats_rows']:>7,} rows")
    if log.warnings:
        print(f"\n  WARNINGS ({len(log.warnings)}):")
        for w in log.warnings:
            print(f"    - {w}")
    if log.errors:
        print(f"\n  ERRORS ({len(log.errors)}):")
        for e in log.errors:
            print(f"    - {e}")
    else:
        print(f"\n  No errors.")
    print()


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    t0 = time.time()
    flags = parse_flags()
    print_banner(flags)

    os.chdir(str(ROOT))
    env = load_env()

    # Step 0: Preflight
    local_engine, prod_engine, databento_key = preflight(env, flags["with_stats"])
    if not local_engine:
        log.fail("ABORT: Cannot connect to local Postgres")
        sys.exit(1)

    dry_run = flags["dry_run"]
    target_parent = flags["target_parent"]

    # Step 1: Download
    if not flags["skip_download"] and databento_key:
        download_jobs(databento_key, dry_run, flags["with_stats"])
    elif flags["skip_download"]:
        log.header("DOWNLOAD — SKIPPED (--skip-download)")
    else:
        log.header("DOWNLOAD — SKIPPED (no DATABENTO_API_KEY)")

    # Step 2: Convert
    if not flags["skip_convert"]:
        convert_raw_to_parquet(dry_run, target_parent, flags["with_stats"])
    else:
        log.header("CONVERT — SKIPPED (--skip-convert)")

    # Step 3a: Ingest → Local
    local_result = ingest_to_db(local_engine, "LOCAL", target_parent, dry_run, flags["with_stats"])

    # Step 3b: Ingest → Production
    prod_result = {"ohlcv_rows": 0, "stats_rows": 0}
    if not flags["local_only"] and prod_engine:
        prod_result = ingest_to_db(prod_engine, "PROD", target_parent, dry_run, flags["with_stats"])
    elif flags["local_only"]:
        log.header("PROD PUSH — SKIPPED (--local-only)")
    else:
        log.header("PROD PUSH — SKIPPED (no production connection)")

    # Step 4: Validate
    validate(local_engine, prod_engine, flags["with_stats"])

    print_report(local_result, prod_result, flags, time.time() - t0)


if __name__ == "__main__":
    main()
