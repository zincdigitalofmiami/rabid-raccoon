import { inngest } from '../client'
import { runDailyMarketIngestByRole } from './daily-market-role-ingest'

/**
 * Treasury futures — one step per symbol for isolated retry.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Runs daily at 07:10 UTC.
 */
export const ingestMktTreasuries = inngest.createFunction(
  { id: 'ingest-mkt-treasuries', retries: 2 },
  /* PAUSED: { cron: '0 2 * * *' } */ { event: "manual/paused" },
  async ({ step }) => runDailyMarketIngestByRole(step, 'INNGEST_TREASURIES')
)
