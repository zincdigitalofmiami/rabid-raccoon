import { inngest } from '../client'
import { runIngestMarketPricesDaily } from '../../../scripts/ingest-market-prices-daily'

const SYMBOLS = ['ES', 'NQ', 'YM', 'RTY', 'SOX'] as const

/**
 * Equity index futures — one step per symbol for isolated retries.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Cron: 07:05 UTC daily (5 min after MES to stagger Databento load)
 */
export const ingestMktEquityIndices = inngest.createFunction(
  { id: 'ingest-mkt-equity-indices', retries: 2 },
  { cron: '5 7 * * *' },
  async ({ step }) => {
    const results: Array<{ symbol: string; result: Awaited<ReturnType<typeof runIngestMarketPricesDaily>> }> = []

    for (const symbol of SYMBOLS) {
      const result = await step.run(`prices-${symbol.toLowerCase()}`, async () =>
        runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols: [symbol] })
      )
      results.push({ symbol, result })
    }

    return { ranAt: new Date().toISOString(), symbols: SYMBOLS, results }
  }
)
