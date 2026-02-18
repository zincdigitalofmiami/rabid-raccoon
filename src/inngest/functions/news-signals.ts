import { inngest } from '../client'
import { runNewsScrape } from '../../lib/news-scrape'

const NEWS_LAYERS = ['trump_policy', 'volatility', 'banking', 'econ_report'] as const

/**
 * Google News scrape by layer — one step per layer for isolated retries.
 * Target table: news_signals
 * Cron: 07:40 UTC daily
 */
export const ingestNewsSignals = inngest.createFunction(
  { id: 'ingest-news-signals', retries: 1 },
  { cron: '40 7 * * *' },
  async ({ step }) => {
    const results: Array<{
      layer: (typeof NEWS_LAYERS)[number]
      result: Awaited<ReturnType<typeof runNewsScrape>>
    }> = []

    for (const layer of NEWS_LAYERS) {
      const result = await step.run(`scrape-${layer.replace('_', '-')}`, async () =>
        runNewsScrape({ layer, continueOnError: true, queryDelayMs: 500 })
      )
      results.push({ layer, result })
    }

    return { ranAt: new Date().toISOString(), results }
  }
)
