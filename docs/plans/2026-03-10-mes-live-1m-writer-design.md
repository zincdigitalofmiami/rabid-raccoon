# 2026-03-10 Dedicated MES Live 1m Writer Design

**Date:** 2026-03-10  
**Status:** Implemented locally with bounded live proof; pending deployed-host cutover observation  
**Scope:** Dedicated MES-only live 1m writer outside Vercel serverless

---

## Purpose

Freeze the approved first-deployment contract for MES live 1m ingestion and record exactly what now exists in local implementation.

This document is intentionally narrow:

- writer ownership and boundaries
- subscription/write contract
- operational behavior
- cutover constraints
- current proof gap

---

## Current Local Implementation

Dedicated worker exists at:

- [scripts/ingest-mes-live-1m.py](../../scripts/ingest-mes-live-1m.py)

This worker is isolated from chart rendering and trigger logic, and is designed to run as an external process (not Vercel serverless request handling).

---

## Fixed First-Deployment Subscription Contract

The worker enforces this contract by default:

- `dataset = GLBX.MDP3`
- `schema = OHLCV_1M`
- `symbol = MES.c.0`
- `stype_in = continuous`
- `snapshot = false`

Non-contract overrides are blocked unless explicitly passed with test-only override flags.

---

## Ownership And Boundaries

### Owns

- authoritative writes to `mkt_futures_mes_1m` (when cutover is approved)

### Does not own

- `mkt_futures_mes_15m`
- trigger computation/decision logic
- chart rendering behavior
- 1s ingestion/aggregation

---

## Write Contract

The worker writes only to `mkt_futures_mes_1m` via idempotent upsert on `eventTime`.

Metadata is required to remain truthful:

- `source = DATABENTO`
- `sourceDataset = GLBX.MDP3` (from active runtime config)
- `sourceSchema = LIVE_OHLCV_1M_CONTINUOUS` for live subscription rows
- `sourceSchema = HIST_OHLCV_1M_CONTINUOUS_CATCHUP` for bounded catch-up rows
- `ingestedAt`, `knowledgeTime` set on insert/update
- deterministic `rowHash`

Duplicate `eventTime` records in the same flush window are deduped before upsert so valid rows are not dropped by same-statement conflict issues.

Transient DB flush errors keep buffered rows pending for retry (lossless pending behavior in-memory).

---

## Operational Behavior

### Live path

- persistent `databento.Live` subscription at `OHLCV_1M`
- reconnect callback enabled
- periodic flush + batch upsert to `mkt_futures_mes_1m`

### Bounded catch-up

- runs on startup and reconnect
- reads historical 1m only for bounded window (`--catchup-max-minutes`, default `30`)
- writes catch-up rows only to `mkt_futures_mes_1m`

### Historical lag fail-open

Known Databento historical lag conditions are handled explicitly:

- `data_end_after_available_end`
- `data_start_after_available_end`

Behavior:

- if a usable `available_end` is present on end-lag, catch-up clamps `end` and retries once
- if lag persists (or available bound is not usable), catch-up returns structured degraded/skip result and live ingestion continues
- these lag conditions must not kill startup or reconnect flow

---

## Cutover Rule

There must never be two active authoritative MES 1m writers.

Current approved state for now:

- Inngest `src/inngest/functions/mkt-mes-1m.ts` remains the active production owner until explicit cutover approval.
- The dedicated Python writer exists locally and is not yet the deployed active owner.

Cutover happens only after live runtime proof confirms expected cadence/freshness.

---

## Current Proof Gap

Still pending:

- end-to-end deployed-runtime proof that live minute cadence is sustained into `mkt_futures_mes_1m`
- observed freshness proof that this cadence satisfies the chart contract in production conditions

This is an operational validation gap, not a code contract ambiguity.

---

## Adjacent Training Context (Record Only)

These are recorded project decisions, not implementation scope for this doc:

- active Warbird horizons: `1h`, `4h`, `1d`
- `1w` is cut for now
- `1m` is approved as a feature source, not a prediction horizon
- do not use 5 years of 1m-derived context
- start 1m-derived feature work with a recent `90-180` day window
