import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import {
  // Market Data (Databento) — 5 functions
  ingestMktMes,
  ingestMktEquityIndices,
  ingestMktTreasuries,
  ingestMktCommodities,
  ingestMktFxRates,
  // FRED Economic Series — 9 functions
  ingestEconRates,
  ingestEconYields,
  ingestEconVolIndices,
  ingestEconInflation,
  ingestEconFx,
  ingestEconLabor,
  ingestEconActivity,
  ingestEconCommodities,
  ingestEconMoney,
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
    // Market Data (staggered 07:00–07:20 UTC)
    ingestMktMes,
    ingestMktEquityIndices,
    ingestMktTreasuries,
    ingestMktCommodities,
    ingestMktFxRates,
    // FRED Econ (staggered 07:25–07:33 UTC)
    ingestEconRates,
    ingestEconYields,
    ingestEconVolIndices,
    ingestEconInflation,
    ingestEconFx,
    ingestEconLabor,
    ingestEconActivity,
    ingestEconCommodities,
    ingestEconMoney,
    // Events / News (07:35–07:45 UTC)
    ingestEconCalendar,
    ingestNewsSignals,
    ingestAltNews,
    // Signals (07:50 UTC)
    ingestMeasuredMoves,
    // Backfill (event-triggered)
    backfillMesAllTimeframes,
  ],
})
