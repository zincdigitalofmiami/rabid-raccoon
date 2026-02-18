import { inngest } from '../client'
import { runIngestMarketPricesDaily } from '../../../scripts/ingest-market-prices-daily'

const SYMBOLS = ['CL', 'GC', 'SI', 'NG'] as const

/**
 * Commodity futures — one step per symbol.
 * Target tables: mkt_futures_1h, mkt_futures_1d
 * Cron: 07:15 UTC daily
 */
export const ingestMktCommodities = inngest.createFunction(
  { id: 'ingest-mkt-commodities', retries: 2 },
  { cron: '15 7 * * *' },
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
