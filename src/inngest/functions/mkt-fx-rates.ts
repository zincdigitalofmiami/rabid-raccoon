import { inngest } from '../client'
import { runIngestMarketPricesDaily } from '../../../scripts/ingest-market-prices-daily'

const SYMBOLS = ['6E', '6J', 'SR3'] as const

/**
 * FX & rates futures — one step per symbol for isolated retry.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Runs daily at 07:20 UTC.
 */
export const ingestMktFxRates = inngest.createFunction(
  { id: 'ingest-mkt-fx-rates', retries: 2 },
  { cron: '0 4 * * *' },
  async ({ step }) => {
    const results: Array<{ symbol: string; result: Awaited<ReturnType<typeof runIngestMarketPricesDaily>> }> = []

    for (const symbol of SYMBOLS) {
      const result = await step.run(`market-prices-${symbol.toLowerCase()}`, async () =>
        runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols: [symbol] })
      )
      results.push({ symbol, result })
    }

    return { ranAt: new Date().toISOString(), symbols: SYMBOLS, results }
  }
)
