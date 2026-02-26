import { inngest } from '../client'
import { prisma } from '../../lib/prisma'
import { runNewsScrape, NewsScrapeResult } from '../../lib/news-scrape'

const NEWS_LAYERS = ['trump_policy', 'volatility', 'banking', 'econ_report'] as const

/**
 * News signal scrape — one step per layer for isolated retry.
 * Target table: news_signals
 * Runs daily at 07:40 UTC.
 */
export const ingestNewsSignals = inngest.createFunction(
  { id: 'ingest-news-signals', retries: 2 },
  { cron: '0 16 * * *' },
  async ({ step }) => {
    const run = await step.run('create-ingestion-run', async () => {
      const record = await prisma.ingestionRun.create({
        data: {
          job: 'ingest-news-signals',
          status: 'RUNNING',
          details: { layers: [...NEWS_LAYERS], layerCount: NEWS_LAYERS.length },
        },
      })
      return { id: Number(record.id) }
    })

    try {
      const results: Array<{ layer: string; result: NewsScrapeResult }> = []

      for (const layer of NEWS_LAYERS) {
        const result = await step.run(`news-scrape-${layer.replace(/_/g, '-')}`, async () =>
          runNewsScrape({ layer, continueOnError: true, queryDelayMs: 500 })
        )
        results.push({ layer, result })
      }

      await step.run('update-ingestion-run', async () => {
        await prisma.ingestionRun.update({
          where: { id: BigInt(run.id) },
          data: {
            status: 'COMPLETED',
            finishedAt: new Date(),
            details: JSON.parse(JSON.stringify({ layers: [...NEWS_LAYERS], results })),
          },
        })
      })

      return { ranAt: new Date().toISOString(), layers: NEWS_LAYERS, results }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await prisma.ingestionRun.update({
          where: { id: BigInt(run.id) },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            details: { error: message },
          },
        })
      } catch { /* IngestionRun update failed — original error takes priority */ }
      throw error
    }
  }
)
