/**
 * Inngest function registry — barrel export for route.ts serve() call.
 *
 * 22 functions total:
 *   6 market data (Databento — 15m hourly, 1h–fx daily)
 *   10 FRED econ domains (05:00–14:00 UTC, 1hr apart)
 *   4 events/news (15:00–17:15 UTC)
 *   1 signals (18:00 UTC)
 *   1 backfill (event-triggered)
 */

// Market data — Databento futures
export { ingestMktMes15m } from './functions/mkt-mes-15m'
export { ingestMktMes1h } from './functions/mkt-mes-1h'
export { ingestMktEquityIndices } from './functions/mkt-equity-indices'
export { ingestMktTreasuries } from './functions/mkt-treasuries'
export { ingestMktCommodities } from './functions/mkt-commodities'
export { ingestMktFxRates } from './functions/mkt-fx-rates'

// FRED economic data — one function per domain table
export { ingestEconRates } from './functions/econ-rates'
export { ingestEconYields } from './functions/econ-yields'
export { ingestEconVolIndices } from './functions/econ-vol-indices'
export { ingestEconInflation } from './functions/econ-inflation'
export { ingestEconFx } from './functions/econ-fx'
export { ingestEconLabor } from './functions/econ-labor'
export { ingestEconActivity } from './functions/econ-activity'
export { ingestEconCommodities } from './functions/econ-commodities'
export { ingestEconMoney } from './functions/econ-money'
export { ingestEconIndexes } from './functions/econ-indexes'

// Events, news & calendar
export { ingestEconCalendar } from './functions/econ-calendar'
export { ingestNewsSignals } from './functions/news-signals'
export { ingestAltNews } from './functions/alt-news'
export { ingestFredNews } from './functions/fred-news'

// Signals
export { ingestMeasuredMoves } from './functions/measured-moves'

// Backfill (event-triggered, not cron)
export { backfillMesAllTimeframes } from './backfill-mes'
