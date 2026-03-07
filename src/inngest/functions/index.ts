/**
 * Inngest function registry — barrel export for route.ts serve() call.
 *
 * 24 functions total:
 *   6 market data (Databento) — 15m hourly, 1h–fx daily
 *   10 FRED econ (by domain table) — 05:00–14:00 UTC, 1hr apart
 *   4 events/news — 15:00–17:15 UTC
 *   1 signals (measured moves) — 18:00 UTC
 *   1 15m compute cycle (compute-signal) — :13/:28/:43/:58 weekdays + econ event trigger
 *   1 outcome checker (check-trade-outcomes) — every 15m weekdays
 *   1 backfill (event-triggered)
 *
 * Each function is independently visible, retriable, and monitorable in Inngest dashboard.
 */

// ── Market Data (Databento) ─────────────────────────────────────────
export { ingestMktMes15m } from './mkt-mes-15m'
export { ingestMktMes1h } from './mkt-mes-1h'
export { ingestMktEquityIndices } from './mkt-equity-indices'
export { ingestMktTreasuries } from './mkt-treasuries'
export { ingestMktCommodities } from './mkt-commodities'
export { ingestMktFxRates } from './mkt-fx-rates'

// ── FRED Economic Series (by domain table) ──────────────────────────
export { ingestEconRates } from './econ-rates'
export { ingestEconYields } from './econ-yields'
export { ingestEconVolIndices } from './econ-vol-indices'
export { ingestEconInflation } from './econ-inflation'
export { ingestEconFx } from './econ-fx'
export { ingestEconLabor } from './econ-labor'
export { ingestEconActivity } from './econ-activity'
export { ingestEconCommodities } from './econ-commodities'
export { ingestEconMoney } from './econ-money'
export { ingestEconIndexes } from './econ-indexes'

// ── Events / News ───────────────────────────────────────────────────
export { ingestEconCalendar } from './econ-calendar'
export { ingestNewsSignals } from './news-signals'
export { ingestAltNews } from './alt-news'
export { ingestFredNews } from './fred-news'

// ── Signals ─────────────────────────────────────────────────────────
export { ingestMeasuredMoves } from './measured-moves'
export { computeSignal } from './compute-signal'
export { checkOutcomes } from './check-trade-outcomes'

// ── Backfill (event-triggered, not cron) ────────────────────────────
export { backfillMesAllTimeframes } from '../backfill-mes'
