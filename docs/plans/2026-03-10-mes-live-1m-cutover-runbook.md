# 2026-03-10 MES 1m Ownership Cutover Runbook

**Status:** Planning/runbook only (no runtime behavior change in this pass)  
**Scope:** Move authoritative MES 1m ownership from Inngest to dedicated Python live worker

---

## 1. Current State

### Active owner today

- [src/inngest/functions/mkt-mes-1m.ts](../../src/inngest/functions/mkt-mes-1m.ts)
- Calls `refreshMes1mFromDatabento()` (historical pull path via `src/lib/mes15m-refresh.ts`)
- Current write metadata from this path uses `sourceSchema=ohlcv-1m`

### Candidate replacement

- [scripts/ingest-mes-live-1m.py](../../scripts/ingest-mes-live-1m.py)
- Runtime manifest: [requirements-mes-live-1m-worker.txt](../../requirements-mes-live-1m-worker.txt)
- Canonical launcher: [scripts/run-mes-live-1m-worker.sh](../../scripts/run-mes-live-1m-worker.sh)
- Dedicated live `databento.Live` worker
- Pulls only MES `1m` from Databento and writes `mkt_futures_mes_1m`
- Derives/upserts `mkt_futures_mes_15m`, `mkt_futures_mes_1h`, `mkt_futures_mes_4h`, `mkt_futures_mes_1d` from stored cloud `1m`
- Fixed contract: `GLBX.MDP3 / OHLCV_1M / MES.c.0 / continuous / snapshot=false`

### What is already proven

- Bounded local proof with real Databento + direct DB credentials showed:
  - live subscription ack on `OHLCV_1M`
  - minute-cadence writes into `mkt_futures_mes_1m`
  - truthful live metadata (`sourceSchema=LIVE_OHLCV_1M_CONTINUOUS`, `sourceDataset=GLBX.MDP3`)
- Default mode with catch-up enabled now survives startup historical lag (`data_start_after_available_end`) and continues into live mode.

### What is not yet proven long-term

- Multi-hour/session stability on target host
- Reconnect behavior under real network interruptions over longer runtime
- Full production cutover observation while Inngest owner is demoted
- Ongoing higher-TF derivation freshness (`15m/1h/4h/1d`) under sustained runtime

---

## 2. Host Recommendation (Near-Term)

### Recommended host: Render Background Worker

Reason this fits the MES-only 1m worker:

- Always-on process model matches persistent live socket workload
- Simple env/secret management and restart policy
- Built-in logs are sufficient for this narrow ingestion service
- Fast path to deploy without designing a larger infra platform

### Minimal host safety settings (Render)

- Run exactly `1` worker instance (fixed single instance).
- Enable restart-on-failure for the worker process.
- Disable autoscaling for this service.
- Do not run a parallel duplicate deployment/standby worker during cutover.

Render Background Worker commands (host-native, no Docker):

- build command: `pip install -r requirements-mes-live-1m-worker.txt`
- start command: `bash scripts/run-mes-live-1m-worker.sh`

### Non-goals for this cutover

- No Kubernetes rollout
- No multi-region worker orchestration
- No broader ingestion platform rebuild

---

## 3. Pre-Cutover Checklist

### Runtime prerequisites

- Python environment can install and run:
  - `requirements-mes-live-1m-worker.txt`
  - `scripts/run-mes-live-1m-worker.sh`
- Required env vars present:
  - `DATABENTO_API_KEY`
  - `DIRECT_URL` (preferred) or `LOCAL_DATABASE_URL`

### Quick readiness checks

```bash
bash scripts/run-mes-live-1m-worker.sh --check-config
.venv-finance/bin/python -m py_compile scripts/ingest-mes-live-1m.py
```

### DB connectivity check

```sql
SELECT now() AT TIME ZONE 'utc' AS db_utc_now;
SELECT max("eventTime") AS latest_event_time FROM "mkt_futures_mes_1m";
```

### Baseline capture before switch

Capture these before changing ownership:

```sql
SELECT "eventTime","ingestedAt","sourceDataset","sourceSchema"
FROM "mkt_futures_mes_1m"
ORDER BY "eventTime" DESC
LIMIT 20;

SELECT "sourceSchema", count(*) AS rows_15m
FROM "mkt_futures_mes_1m"
WHERE "ingestedAt" >= (now() AT TIME ZONE 'utc') - interval '15 minutes'
GROUP BY "sourceSchema"
ORDER BY rows_15m DESC;

SELECT
  EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'utc') - max("eventTime"))) AS event_lag_seconds
FROM "mkt_futures_mes_1m";
```

### Single-writer guard

- Confirm operator and exact timestamp for ownership switch.
- Confirm Inngest owner will be demoted in control plane during cutover window.
- Confirm external worker service is configured for exactly one running instance.
- Confirm no standby/duplicate MES live worker is active.
- Do not run both writers as authoritative at the same time.

---

## 4. Exact Cutover Sequence

1. Capture baseline DB state and current writer metadata (`ohlcv-1m` vs `LIVE_OHLCV_1M_CONTINUOUS`).
2. Confirm dedicated worker host is ready but not yet started.
3. Demote/pause `ingest-mkt-mes-1m` in Inngest control plane (do not code-edit cron for this step).
4. Wait ~2 minutes and confirm no new `sourceSchema=ohlcv-1m` writes are arriving.
5. Start the dedicated worker process with fixed contract + ingestion run logging:
   - `bash scripts/run-mes-live-1m-worker.sh`
   - Launcher defaults are the approved contract + `--log-ingestion-runs`.
   - Do not pass `--snapshot` or `--allow-contract-override` in cutover mode.
6. Verify worker logs:
   - subscription request succeeded
   - periodic flush with advancing `latest_event`
7. Verify DB writes now show live-owner truth:
   - `sourceSchema=LIVE_OHLCV_1M_CONTINUOUS`
   - `sourceDataset=GLBX.MDP3`
   - `eventTime` advancing at ~60s cadence
8. Verify DB-derived tables advance from 1m after worker flushes:
   - `mkt_futures_mes_15m` latest row advances with `sourceSchema=mkt_futures_mes_1m->15m`
   - `mkt_futures_mes_1h` latest row advances with `sourceSchema=mkt_futures_mes_1m->1h`
   - `mkt_futures_mes_4h` latest row advances with `sourceSchema=mkt_futures_mes_1m->4h`
   - `mkt_futures_mes_1d` latest row advances with `sourceSchema=mkt_futures_mes_1m->1d`
   - 1d path remains active so pivot readers stay current
9. Verify chart contract support (without chart code changes):
   - `mkt_futures_mes_1m` latest `eventTime` remains near wall clock (minute-fresh)
   - `/api/live/mes15m` continues receiving fresh underlying 1m, so active 15m bar can update minute-to-minute
10. Keep monitoring for at least 15 continuous minutes before declaring cutover stable.
11. Stability declaration guard:
    - Cutover operator captures DB query outputs + worker log excerpts for the full 15-minute window.
    - Reviewer/gatekeeper confirms all stability criteria before declaring cutover complete.

---

## 5. Rollback Sequence

### Rollback triggers

Rollback if any of the following persists during market-open window:

- no new `LIVE_OHLCV_1M_CONTINUOUS` rows for >2 minutes
- worker exits/restarts 2+ times within 10 minutes
- event lag grows beyond acceptable bound (example: >180s for 3 consecutive checks)
- new `sourceSchema=ohlcv-1m` rows appear after Inngest owner is paused (duplicate-writer signal)

### Rollback order

1. Stop the dedicated Python worker.
2. Re-enable `ingest-mkt-mes-1m` in Inngest control plane.
3. Verify Inngest path resumes writes (`sourceSchema=ohlcv-1m` expected from current path).
4. Verify `eventTime` advancement resumes in `mkt_futures_mes_1m`.
5. Capture rollback evidence (timestamps, logs, DB snapshots) before closing incident.

### Rollback confirmation checks

```sql
SELECT "eventTime","ingestedAt","sourceSchema"
FROM "mkt_futures_mes_1m"
WHERE "ingestedAt" >= (now() AT TIME ZONE 'utc') - interval '10 minutes'
ORDER BY "ingestedAt" DESC
LIMIT 50;
```

Success criteria: new rows are arriving again from the restored owner path and minute freshness is back.

---

## 6. Immediate Post-Cutover Monitoring

### First 15 minutes

Check every minute:

- worker logs: connection health, subscription ack, flush lines, errors
- DB: latest `eventTime`, `ingestedAt`, `sourceSchema`, lag seconds
- ensure no competing write pattern from old owner

Suggested query:

```sql
SELECT
  "eventTime",
  "ingestedAt",
  "sourceDataset",
  "sourceSchema",
  EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'utc') - "eventTime")) AS event_lag_seconds
FROM "mkt_futures_mes_1m"
ORDER BY "eventTime" DESC
LIMIT 15;
```

```sql
SELECT "sourceSchema", count(*) AS rows_5m
FROM "mkt_futures_mes_1m"
WHERE "ingestedAt" >= (now() AT TIME ZONE 'utc') - interval '5 minutes'
GROUP BY "sourceSchema"
ORDER BY rows_5m DESC;
```

### First session/day

- Watch for reconnect storms or repeated catch-up degraded states
- Confirm minute cadence continues through normal market phases
- Confirm shared downstream 15m derivation consumers stay fresh
- Keep periodic snapshots of sourceSchema mix to detect accidental dual-writer behavior

---

## 7. Proven vs Observation Boundary

### Already proven (local controlled evidence)

- Dedicated worker can subscribe and write 1m rows with truthful live metadata.
- Startup catch-up now fail-opens on both historical lag classes:
  - `data_end_after_available_end`
  - `data_start_after_available_end`

### Still needs observation during real cutover

- Long-duration host stability
- Reconnect quality under sustained runtime
- Operational correctness of single-writer ownership during production switch

---

## Assumptions

- Inngest owner demotion/re-enable is performed operationally in Inngest control plane, not by code changes in this runbook.
- `sourceSchema=ohlcv-1m` remains the marker for current Inngest 1m path (as implemented in `src/lib/mes15m-refresh.ts` at time of writing).
- Cloud is authoritative for MES runtime ingestion; local MES copies for training/research are synchronized one-way (cloud -> local) on a low-cost schedule (daily default).
