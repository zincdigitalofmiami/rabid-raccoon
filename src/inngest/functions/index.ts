/**
 * Inngest function registry — cloud-facing runtime jobs only.
 *
 * 4 functions total:
 *   1. mkt-mes-15m     — MES 15m data refresh, every hour at :05
 *   2. econ-calendar   — Economic calendar + Treasury rates, daily at 15:00 UTC
 *   3. compute-signal  — Fib retracement + Warbird AI pipeline, every 15 min
 *   4. backfill-mes    — Historical backfill, event-triggered
 *
 * Heavy batch jobs (FRED ingestion, daily market data, news, GPR, Trump)
 * run as LOCAL scripts via `scripts/run-batch-ingest.sh`.
 * They do not belong in Inngest — no cloud orchestration needed, no retries,
 * no failure noise in the dashboard.
 */

// ── Cloud-facing runtime jobs ────────────────────────────────────────
export { ingestMktMes15m } from './mkt-mes-15m'
export { ingestEconCalendar } from './econ-calendar'
export { computeSignal } from './compute-signal'

// ── Backfill (event-triggered, not cron) ────────────────────────────
export { backfillMesAllTimeframes } from '../backfill-mes'
