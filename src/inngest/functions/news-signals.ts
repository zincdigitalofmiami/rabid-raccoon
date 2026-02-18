import { inngest } from '../client'
import { runNewsScrape, NewsScrapeResult } from '../../lib/news-scrape'

const NEWS_LAYERS = ['trump_policy', 'volatility', 'banking', 'econ_report'] as const

/**
 * News signal scrape — one step per layer for isolated retry.
 * Target table: news_signals
 * Runs daily at 07:40 UTC.
 */
export const ingestNewsSignals = inngest.createFunction(
  { id: 'ingest-news-signals', retries: 2 },
  { cron: '40 7 * * *' },
  async ({ step }) => {
    const results: Array<{ layer: string; result: NewsScrapeResult }> = []

    for (const layer of NEWS_LAYERS) {
      const result = await step.run(`news-scrape-${layer.replace(/_/g, '-')}`, async () =>
        runNewsScrape({ layer, continueOnError: true, queryDelayMs: 500 })
      )
      results.push({ layer, result })
    }

    return { ranAt: new Date().toISOString(), layers: NEWS_LAYERS, results }
  }
)
