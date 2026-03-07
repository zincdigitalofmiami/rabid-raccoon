/**
 * ingest-live-news — Minute-by-minute news ingestion during market hours.
 *
 * Schedule: every minute, 06:00-15:59 ET (10:00-19:59 UTC), weekdays.
 * Rotates through source layers each minute to avoid hammering any single source.
 *
 * Source rotation (4-minute cycle):
 *   Minute 0: trump_policy layer (Google News RSS)
 *   Minute 1: volatility layer (Google News RSS)
 *   Minute 2: econ_report layer (Google News RSS)
 *   Minute 3: banking layer (Google News RSS)
 *
 * Each invocation runs ONE layer's Google News scrape (fast, <5s).
 * Dedup is handled by the existing rowHash SHA256 pattern in news_signals.
 */

import { inngest } from '../client'
import { runNewsScrape, type NewsScrapeResult } from '../../lib/news-scrape'

const LAYERS = ['trump_policy', 'volatility', 'econ_report', 'banking'] as const

export const ingestLiveNews = inngest.createFunction(
  { id: 'ingest-live-news', retries: 1 },
  { cron: '* 10-19 * * 1-5' }, // Every minute, 10:00-19:59 UTC (06:00-15:59 ET), Mon-Fri
  async ({ step }) => {
    // Determine which layer to scrape based on current minute
    const now = new Date()
    const minuteOfHour = now.getUTCMinutes()
    const layerIndex = minuteOfHour % LAYERS.length
    const layer = LAYERS[layerIndex]

    const result: NewsScrapeResult = await step.run(`live-news-${layer}`, async () =>
      runNewsScrape({ layer, continueOnError: true, queryDelayMs: 200 }),
    )

    return {
      ranAt: now.toISOString(),
      layer,
      minuteOfHour,
      queriesRun: result.queriesRun,
      articlesSeen: result.articlesSeen,
      inserted: result.inserted,
    }
  },
)
