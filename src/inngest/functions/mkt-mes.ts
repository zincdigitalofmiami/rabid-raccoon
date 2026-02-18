import { inngest } from '../client'
import { runIngestMarketPricesDaily } from '../../../scripts/ingest-market-prices-daily'

/**
 * MES market data — fetches 1m bars from Databento, resamples to 1h.
 * Target tables: mkt_futures_mes_1h, mkt_futures_mes_15m, mkt_futures_mes_1d
 * Cron: 07:00 UTC daily
 */
export const ingestMktMes = inngest.createFunction(
  { id: 'ingest-mkt-mes', retries: 2 },
  { cron: '0 7 * * *' },
  async ({ step }) => {
    const result = await step.run('mes-prices', async () =>
      runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols: ['MES'] })
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
