import { inngest } from '../client'
import { runDailyMarketIngestByRole } from './daily-market-role-ingest'

/**
 * Commodity futures — one step per symbol for isolated retry.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Runs daily at 07:15 UTC.
 */
export const ingestMktCommodities = inngest.createFunction(
  { id: 'ingest-mkt-commodities', retries: 2 },
  // PAUSED: { cron: '0 3 * * *' }
  { event: "manual/paused" },
  async ({ step }) => runDailyMarketIngestByRole(step, 'INNGEST_COMMODITIES')
)
