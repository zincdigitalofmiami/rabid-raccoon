import { serve } from 'inngest/next'
import { inngest } from '@/inngest/client'
import {
  // Market Data (Databento) — 6 functions
  ingestMktMes15m,
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
  // Events / News — 4 functions
  ingestEconCalendar,
  ingestNewsSignals,
  ingestAltNews,
  ingestFredNews,
  // Signals — 1 function
  ingestMeasuredMoves,
  // Backfill — 1 function (event-triggered)
  backfillMesAllTimeframes,
} from '@/inngest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const serveHost = process.env.INNGEST_SERVE_HOST || ''

export const { GET, POST, PUT } = serve({
  client: inngest,
  ...(serveHost && { serveHost }),
  functions: [
    // Market Data (Databento)
    ingestMktMes15m, // every hour at :05
    ingestMktMes1h,  // daily at 00:00 UTC
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
    // Events / News (15:00–17:15 UTC)
    ingestEconCalendar,
    ingestNewsSignals,
    ingestAltNews,
    ingestFredNews,    // daily at 17:15 UTC
    // Signals (18:00 UTC)
    ingestMeasuredMoves,
    // Backfill (event-triggered)
    backfillMesAllTimeframes,
  ],
})
