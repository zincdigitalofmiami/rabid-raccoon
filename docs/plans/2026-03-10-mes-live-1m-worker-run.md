# 2026-03-10 MES Live 1m Worker Run Notes

Worker entrypoint:

```bash
.venv-finance/bin/python scripts/ingest-mes-live-1m.py
```

## Guardrails

- This worker writes only `mkt_futures_mes_1m`.
- It does not write `mkt_futures_mes_15m`.
- It does not own chart rendering or trigger logic.
- Do not run two active authoritative MES 1m writers at the same time.
- Until cutover approval, existing Inngest `mkt-mes-1m` remains the active production owner.

## Required Environment

- `DATABENTO_API_KEY`
- `DIRECT_URL` (preferred) or `LOCAL_DATABASE_URL`

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

## Operational Behavior

- idempotent upsert into `mkt_futures_mes_1m` by `eventTime`
- duplicate `eventTime` entries inside one flush are deduped before write
- transient DB flush failure preserves pending buffer for retry (no silent drop)
- bounded catch-up runs at startup and reconnect (`--catchup-max-minutes`, default `30`)

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
.venv-finance/bin/python scripts/ingest-mes-live-1m.py --check-config
```

Compile check:

```bash
.venv-finance/bin/python -m py_compile scripts/ingest-mes-live-1m.py
```

## Current Gap

Pending proof is still operational:

- end-to-end deployed-runtime confirmation that minute cadence is sustained in `mkt_futures_mes_1m`
