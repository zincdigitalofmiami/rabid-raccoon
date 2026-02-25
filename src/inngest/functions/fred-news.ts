import { inngest } from '../client'
import { runIngestFredNews } from '../../../scripts/ingest-fred-news'

/**
 * FRED News RSS feeds — Announcements + Blog.
 * Target table: econ_news_1d
 * Runs daily at 17:15 UTC (after alt-news at 17:00).
 */
export const ingestFredNews = inngest.createFunction(
  { id: 'ingest-fred-news', retries: 2 },
  { cron: '15 17 * * *' },
  async ({ step }) => {
    const result = await step.run('fred-news-rss-daily', async () =>
      runIngestFredNews()
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
