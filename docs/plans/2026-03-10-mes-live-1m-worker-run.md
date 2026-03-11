# 2026-03-10 MES Live 1m Worker Run Notes

Worker runtime manifest:

```bash
requirements-mes-live-1m-worker.txt
```

Canonical worker entrypoint:

```bash
bash scripts/run-mes-live-1m-worker.sh
```

## Guardrails

- This worker is the only MES upstream pull owner (`1m` only).
- It writes `mkt_futures_mes_1m` and derives `mkt_futures_mes_15m`, `mkt_futures_mes_1h`, `mkt_futures_mes_4h`, and `mkt_futures_mes_1d` from stored 1m.
- It does not own chart rendering or trigger logic.
- Do not run two active authoritative MES 1m writers at the same time.
- Run this as exactly one external worker instance (no autoscaling, no standby duplicate).
- Until cutover approval, existing Inngest `mkt-mes-1m` remains the active production owner.

## Required Environment

- `DATABENTO_API_KEY`
- `DIRECT_URL` (preferred) or `LOCAL_DATABASE_URL`
- `MES_HIGHER_TF_OWNER` (`inngest` default; switch to `worker` for higher-TF ownership cutover)
- `MES_1M_OWNER` (optional; when unset, 1m Inngest owner uses `MES_HIGHER_TF_OWNER` as fallback)

## Host-Native Dependency Install

```bash
pip install -r requirements-mes-live-1m-worker.txt
```

## Fixed Subscription Contract

Approved runtime contract:

- `dataset=GLBX.MDP3`
- `schema=OHLCV_1M`
- `symbol=MES.c.0`
- `stype_in=continuous`
- `snapshot=false`

The worker enforces this contract unless test-only override flags are explicitly set.

## Metadata Truth Contract

Rows written by live subscription:

- `source=DATABENTO`
- `sourceDataset=GLBX.MDP3`
- `sourceSchema=LIVE_OHLCV_1M_CONTINUOUS`

Rows written by bounded catch-up:

- `source=DATABENTO`
- `sourceDataset=GLBX.MDP3`
- `sourceSchema=HIST_OHLCV_1M_CONTINUOUS_CATCHUP`

Rows written by DB-derived higher timeframes:

- `mkt_futures_mes_15m`: `sourceSchema=mkt_futures_mes_1m->15m`
- `mkt_futures_mes_1h`: `sourceSchema=mkt_futures_mes_1m->1h`
- `mkt_futures_mes_4h`: `sourceSchema=mkt_futures_mes_1m->4h`
- `mkt_futures_mes_1d`: `sourceSchema=mkt_futures_mes_1m->1d`

## Operational Behavior

- idempotent upsert into `mkt_futures_mes_1m` by `eventTime`
- duplicate `eventTime` entries inside one flush are deduped before write
- transient DB flush failure preserves pending buffer for retry (no silent drop)
- bounded catch-up runs at startup and reconnect (`--catchup-max-minutes`, default `30`)
- on a throttled cadence, worker runs bounded DB-only derivation/upsert for `15m`, `1h`, `4h`, `1d` (default lookback `2880` minutes / 48h)
  - default minimum intervals by timeframe:
    - `15m`: `900s`
    - `1h`: `3600s`
    - `4h`: `3600s`
    - `1d`: `3600s`
- derivation can be disabled only for controlled debugging with `--disable-derived-upserts`
- write-path duplicate guard: derivation batches are deduped by `eventTime`/`eventDate` before upsert

## Historical Lag Fail-Open Behavior

Known Databento historical lag is non-fatal for both:

- `data_end_after_available_end`
- `data_start_after_available_end`

Behavior:

- if `available_end` is parseable and usable in end-lag, catch-up clamps end and retries once
- otherwise catch-up degrades/skips and returns structured result
- worker continues into live ingestion path instead of aborting

Catch-up structured results include:

- `attempted`
- `degraded`
- `reason`
- `errorCode` (for lag skip path)
- `start`
- `requestedEnd`
- `effectiveEnd`
- `availableEnd`
- `rowsUpserted`

## Useful Local Checks

Dry config check:

```bash
bash scripts/run-mes-live-1m-worker.sh --check-config
```

Compile check:

```bash
.venv-finance/bin/python -m py_compile scripts/ingest-mes-live-1m.py
```

Cloud to local MES sync (training/research copy):

```bash
bash scripts/run-mes-cloud-to-local-sync.sh
```

Default sync direction is cloud -> local only.
Required env vars for sync:

- `MES_SYNC_CLOUD_DATABASE_URL` (cloud source, read)
- `LOCAL_DATABASE_URL` (local target, write)

Daily low-cost cadence recommendation (example cron):

```bash
15 2 * * * cd /Volumes/Satechi\ Hub/rabid-raccoon && bash scripts/run-mes-cloud-to-local-sync.sh
```

DB-only repair/backfill utility (from stored MES 1m):

```bash
.venv-finance/bin/python scripts/repair-mes-derived-from-1m.py --start 2026-01-01 --end 2026-03-11 --timeframes 15m,1h,4h,1d
```

Dry-run preview:

```bash
.venv-finance/bin/python scripts/repair-mes-derived-from-1m.py --start 2026-01-01 --end 2026-03-11 --timeframes 15m,4h --dry-run
```

This repair path is DB-only and does not call Databento.

## Cutover Launch Truth

For real ownership cutover launch (not ad-hoc local probe), start with:

```bash
bash scripts/run-mes-live-1m-worker.sh
```

The launcher already enforces the approved production contract and `--log-ingestion-runs`.
Do not pass `--snapshot` or `--allow-contract-override` for cutover mode.

## Current Gap

Pending proof is still operational:

- end-to-end deployed-runtime confirmation that minute cadence is sustained in `mkt_futures_mes_1m`
