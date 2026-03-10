/**
 * Inngest function registry — barrel export for route.ts serve() call.
 *
 * 28 functions total:
 *   7 market data (Databento — 1m minute cadence, 15m hourly, 1h–fx daily)
 *   10 FRED econ domains (05:00–14:00 UTC, 1hr apart)
 *   4 events/news (15:00–17:15 UTC)
 *   1 signals (18:00 UTC)
 *   1 15m compute cycle + econ event trigger
 *   1 outcome checker (every 15m weekdays)
 *   2 geopolitical/policy ingest jobs (19:00, 19:30 UTC)
 *   1 coverage audit (weekly Sun 06:00 UTC)
 *   1 backfill (event-triggered)
 */

// Market data — Databento futures
export { ingestMktMes1m } from "./functions/mkt-mes-1m";
export { ingestMktMes15m } from "./functions/mkt-mes-15m";
export { ingestMktMes1h } from "./functions/mkt-mes-1h";
export { ingestMktEquityIndices } from "./functions/mkt-equity-indices";
export { ingestMktTreasuries } from "./functions/mkt-treasuries";
export { ingestMktCommodities } from "./functions/mkt-commodities";
export { ingestMktFxRates } from "./functions/mkt-fx-rates";

// FRED economic data — one function per domain table
export { ingestEconRates } from "./functions/econ-rates";
export { ingestEconYields } from "./functions/econ-yields";
export { ingestEconVolIndices } from "./functions/econ-vol-indices";
export { ingestEconInflation } from "./functions/econ-inflation";
export { ingestEconFx } from "./functions/econ-fx";
export { ingestEconLabor } from "./functions/econ-labor";
export { ingestEconActivity } from "./functions/econ-activity";
export { ingestEconCommodities } from "./functions/econ-commodities";
export { ingestEconMoney } from "./functions/econ-money";
export { ingestEconIndexes } from "./functions/econ-indexes";

// Events, news & calendar
export { ingestEconCalendar } from "./functions/econ-calendar";
export { ingestNewsSignals } from "./functions/news-signals";
export { ingestAltNews } from "./functions/alt-news";
export { ingestFredNews } from "./functions/fred-news";

// Signals
export { ingestMeasuredMoves } from "./functions/measured-moves";
export { computeSignal } from "./functions/compute-signal";
export { checkOutcomes } from "./functions/check-trade-outcomes";

// Geopolitical / policy
export { ingestGprIndex } from "./functions/ingest-gpr-index";
export { ingestTrumpEffect } from "./functions/ingest-trump-effect";

// Coverage audit (weekly)
export { checkSymbolCoverage } from "./functions/check-symbol-coverage";

// Backfill (event-triggered, not cron)
export { backfillMesAllTimeframes } from "./backfill-mes";
