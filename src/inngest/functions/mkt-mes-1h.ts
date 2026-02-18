import { inngest } from '../client'
import { runIngestMarketPricesDaily } from '../../../scripts/ingest-market-prices-daily'

/**
 * MES 1h candle ingestion — fetches ohlcv-1h from Databento.
 * Target table: mkt_futures_mes_1h (single table, isolated job).
 * Runs daily at 00:00 UTC (7 PM EST).
 */
export const ingestMktMes1h = inngest.createFunction(
  { id: 'ingest-mkt-mes-1h', retries: 2 },
  { cron: '0 0 * * *' },
  async ({ step }) => {
    const result = await step.run('fetch-mes-1h', async () =>
      runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols: ['MES'] })
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
