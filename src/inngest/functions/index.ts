/**
 * Inngest function registry — barrel export for route.ts serve() call.
 *
 * 19 functions total:
 *   5 market data (Databento) — 00:00–04:00 UTC, 1hr apart
 *   9 FRED econ (by domain table) — 05:00–13:00 UTC, 1hr apart
 *   3 events/news
 *   1 signals (measured moves)
 *   1 backfill (event-triggered)
 *
 * Each function is independently visible, retriable, and monitorable in Inngest dashboard.
 */

// ── Market Data (Databento) ─────────────────────────────────────────
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

// ── Events / News ───────────────────────────────────────────────────
export { ingestEconCalendar } from './econ-calendar'
export { ingestNewsSignals } from './news-signals'
export { ingestAltNews } from './alt-news'

// ── Signals ─────────────────────────────────────────────────────────
export { ingestMeasuredMoves } from './measured-moves'

// ── Backfill (event-triggered, not cron) ────────────────────────────
export { backfillMesAllTimeframes } from '../backfill-mes'
