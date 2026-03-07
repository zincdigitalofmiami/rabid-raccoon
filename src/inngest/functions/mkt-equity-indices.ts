import { inngest } from '../client'
import { runDailyMarketIngestByRole } from './daily-market-role-ingest'

/**
 * Equity index futures — one step per symbol for isolated retry.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Runs daily at 07:05 UTC (staggered 5min after MES for Databento budget).
 */
export const ingestMktEquityIndices = inngest.createFunction(
  { id: 'ingest-mkt-equity-indices', retries: 2 },
  { cron: '0 1 * * *' },
  async ({ step }) => runDailyMarketIngestByRole(step, 'INNGEST_EQUITY_INDICES')
)
