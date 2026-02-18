import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import {
  // Market Data (Databento) — 5 functions
  ingestMktMes1h,
  ingestMktEquityIndices,
  ingestMktTreasuries,
  ingestMktCommodities,
  ingestMktFxRates,
  // FRED Economic Series — 10 functions
  ingestEconRates,
  ingestEconYields,
  ingestEconVolIndices,
  ingestEconInflation,
  ingestEconFx,
  ingestEconLabor,
  ingestEconActivity,
  ingestEconCommodities,
  ingestEconMoney,
  ingestEconIndexes,
  // Events / News — 3 functions
  ingestEconCalendar,
  ingestNewsSignals,
  ingestAltNews,
  // Signals — 1 function
  ingestMeasuredMoves,
  // Backfill — 1 function (event-triggered)
  backfillMesAllTimeframes,
} from '@/inngest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    // Market Data (Databento, 00:00–04:00 UTC)
    ingestMktMes1h,
    ingestMktEquityIndices,
    ingestMktTreasuries,
    ingestMktCommodities,
    ingestMktFxRates,
    // FRED Econ (05:00–14:00 UTC, 1hr apart)
    ingestEconRates,
    ingestEconYields,
    ingestEconVolIndices,
    ingestEconInflation,
    ingestEconFx,
    ingestEconLabor,
    ingestEconActivity,
    ingestEconCommodities,
    ingestEconMoney,
    ingestEconIndexes,
    // Events / News (15:00–17:00 UTC)
    ingestEconCalendar,
    ingestNewsSignals,
    ingestAltNews,
    // Signals (18:00 UTC)
    ingestMeasuredMoves,
    // Backfill (event-triggered)
    backfillMesAllTimeframes,
  ],
})
