/**
 * Inngest function registry — barrel export for route.ts serve() call.
 *
 * 19 functions total:
 *   5 market data (Databento, staggered 5min apart)
 *   9 FRED econ domains (staggered 1min apart)
 *   3 events/news
 *   1 signals
 *   1 backfill (event-triggered)
 */

// Market data — Databento futures
export { ingestMktMes } from './functions/mkt-mes'
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

// Events, news & calendar
export { ingestEconCalendar } from './functions/econ-calendar'
export { ingestNewsSignals } from './functions/news-signals'
export { ingestAltNews } from './functions/alt-news'

// Signals
export { ingestMeasuredMoves } from './functions/measured-moves'

// Backfill (event-triggered, not cron)
export { backfillMesAllTimeframes } from './backfill-mes'
