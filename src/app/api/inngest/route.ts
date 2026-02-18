import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import {
  // Market data (5)
  ingestMktMes,
  ingestMktEquityIndices,
  ingestMktTreasuries,
  ingestMktCommodities,
  ingestMktFxRates,
  // FRED econ domains (9)
  ingestEconRates,
  ingestEconYields,
  ingestEconVolIndices,
  ingestEconInflation,
  ingestEconFx,
  ingestEconLabor,
  ingestEconActivity,
  ingestEconCommodities,
  ingestEconMoney,
  // Events/news (3)
  ingestEconCalendar,
  ingestNewsSignals,
  ingestAltNews,
  // Signals (1)
  ingestMeasuredMoves,
  // Backfill (1)
  backfillMesAllTimeframes,
} from '@/inngest/index'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    // Market data — staggered 5min apart for Databento
    ingestMktMes,
    ingestMktEquityIndices,
    ingestMktTreasuries,
    ingestMktCommodities,
    ingestMktFxRates,
    // FRED econ — one per domain table, staggered 1min apart
    ingestEconRates,
    ingestEconYields,
    ingestEconVolIndices,
    ingestEconInflation,
    ingestEconFx,
    ingestEconLabor,
    ingestEconActivity,
    ingestEconCommodities,
    ingestEconMoney,
    // Events/news/calendar
    ingestEconCalendar,
    ingestNewsSignals,
    ingestAltNews,
    // Signals
    ingestMeasuredMoves,
    // Backfill (event-triggered)
    backfillMesAllTimeframes,
  ],
})
