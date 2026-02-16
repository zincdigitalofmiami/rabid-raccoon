import { inngest } from './client'
import { runIngestMacroIndicators } from '../../scripts/ingest-macro-indicators'
import { runIngestMarketPricesDaily } from '../../scripts/ingest-market-prices-daily'
import { runIngestAltNewsFeeds } from '../../scripts/ingest-alt-news-feeds'
import { runIngestMeasuredMoveSignals } from '../../scripts/ingest-mm-signals'
import { runIngestEconCalendar } from '../lib/ingest/econ-calendar'
import { runNewsScrape } from '../lib/news-scrape'

export { backfillMesAllTimeframes } from './backfill-mes'

const MARKET_SYMBOL_BATCHES: string[][] = [
  ['MES', 'ES', 'NQ', 'MNQ', 'YM', 'MYM', 'RTY', 'M2K', 'EMD', 'NKD'],
  ['XAE', 'XAF', 'XAV', 'XAI', 'XAB', 'XAR', 'XAK', 'XAU', 'XAY', 'XAP', 'XAZ'],
  ['SXT', 'RS1', 'RSG', 'RSV'],
]

const ECON_RELEASE_BATCHES: Array<{ id: string; releaseIds: number[] }> = [
  { id: 'inflation-labor-fomc', releaseIds: [10, 46, 101] },
  { id: 'gdp-pce-ppi', releaseIds: [21, 53, 51] },
  { id: 'activity-claims', releaseIds: [83, 13, 54, 29, 202] },
]

const ECON_DAILY_RATES_WINDOWS: Array<{ id: string; startDateStr: string; endDateStr?: string }> = [
  { id: 'daily-rates-2020-2021', startDateStr: '2020-01-01', endDateStr: '2021-12-31' },
  { id: 'daily-rates-2022-2023', startDateStr: '2022-01-01', endDateStr: '2023-12-31' },
  { id: 'daily-rates-2024-now', startDateStr: '2024-01-01' },
]

const NEWS_LAYERS = ['trump_policy', 'volatility', 'banking', 'econ_report'] as const

export const dailyIngestionJob = inngest.createFunction(
  { id: 'daily-ingestion-job', retries: 1 },
  { cron: '0 7 * * *' },
  async ({ step }) => {
    const marketBatches: Array<{ batch: number; symbols: string[]; result: Awaited<ReturnType<typeof runIngestMarketPricesDaily>> }> = []

    for (let i = 0; i < MARKET_SYMBOL_BATCHES.length; i++) {
      const symbols = MARKET_SYMBOL_BATCHES[i]
      const result = await step.run(`market-prices-batch-${i + 1}`, async () =>
        runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols })
      )
      marketBatches.push({ batch: i + 1, symbols, result })
    }

    const macro = await step.run('macro-indicators-daily', async () =>
      runIngestMacroIndicators({ daysBack: 45, dryRun: false })
    )

    const altNews = await step.run('alt-news-rss-daily', async () => runIngestAltNewsFeeds())

    const mm = await step.run('measured-move-signals', async () =>
      runIngestMeasuredMoveSignals({ timeframe: '1h', daysBack: 120, symbols: ['MES'], dryRun: false })
    )

    const econCalendarReleases: Array<{
      batchId: string
      releaseIds: number[]
      result: Awaited<ReturnType<typeof runIngestEconCalendar>>
    }> = []

    for (const batch of ECON_RELEASE_BATCHES) {
      const result = await step.run(`econ-calendar-${batch.id}`, async () =>
        runIngestEconCalendar({
          startDateStr: '2020-01-01',
          releaseIds: batch.releaseIds,
          includeEarnings: false,
          continueOnError: true,
        })
      )

      econCalendarReleases.push({
        batchId: batch.id,
        releaseIds: batch.releaseIds,
        result,
      })
    }

    const econCalendarDailyRates: Array<{
      batchId: string
      startDateStr: string
      endDateStr?: string
      result: Awaited<ReturnType<typeof runIngestEconCalendar>>
    }> = []

    for (const window of ECON_DAILY_RATES_WINDOWS) {
      const result = await step.run(`econ-calendar-${window.id}`, async () =>
        runIngestEconCalendar({
          startDateStr: window.startDateStr,
          endDateStr: window.endDateStr,
          releaseIds: [18],
          includeEarnings: false,
          continueOnError: true,
        })
      )

      econCalendarDailyRates.push({
        batchId: window.id,
        startDateStr: window.startDateStr,
        endDateStr: window.endDateStr,
        result,
      })
    }

    const econCalendarEarnings = await step.run('econ-calendar-earnings', async () =>
      runIngestEconCalendar({
        startDateStr: '2020-01-01',
        releaseIds: [],
        includeEarnings: true,
        continueOnError: true,
      })
    )

    const newsScrape: Array<{
      layer: (typeof NEWS_LAYERS)[number]
      result: Awaited<ReturnType<typeof runNewsScrape>>
    }> = []

    for (const layer of NEWS_LAYERS) {
      const result = await step.run(`news-scrape-${layer.replace('_', '-')}`, async () =>
        runNewsScrape({ layer, continueOnError: true, queryDelayMs: 500 })
      )
      newsScrape.push({ layer, result })
    }

    return {
      ranAt: new Date().toISOString(),
      marketBatches,
      macro,
      altNews,
      mm,
      econCalendarReleases,
      econCalendarDailyRates,
      econCalendarEarnings,
      newsScrape,
    }
  }
)
