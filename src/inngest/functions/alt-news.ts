import { inngest } from '../client'
import { runIngestAltNewsFeeds } from '../../../scripts/ingest-alt-news-feeds'

/**
 * Alt news RSS feeds — Fed, SEC, BEA, ECB press releases.
 * Target tables: econ_news_1d, policy_news_1d, macro_reports_1d
 * Runs daily at 07:45 UTC.
 */
export const ingestAltNews = inngest.createFunction(
  { id: 'ingest-alt-news', retries: 2 },
  { cron: '45 7 * * *' },
  async ({ step }) => {
    const result = await step.run('alt-news-rss-daily', async () =>
      runIngestAltNewsFeeds()
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
