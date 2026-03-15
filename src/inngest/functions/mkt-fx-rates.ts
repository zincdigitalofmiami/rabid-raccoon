import { inngest } from '../client'
import { runDailyMarketIngestByRole } from './daily-market-role-ingest'

/**
 * FX & rates futures — one step per symbol for isolated retry.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Runs daily at 07:20 UTC.
 */
export const ingestMktFxRates = inngest.createFunction(
  { id: 'ingest-mkt-fx-rates', retries: 2 },
  /* PAUSED: { cron: '0 4 * * *' } */ { event: "manual/paused" },
  async ({ step }) => runDailyMarketIngestByRole(step, 'INNGEST_FX_RATES')
)
