import { inngest } from './client'
import { runIngestMarketPricesDaily } from '../../scripts/ingest-market-prices-daily'
import { runIngestAltNewsFeeds } from '../../scripts/ingest-alt-news-feeds'
import { runIngestMeasuredMoveSignals } from '../../scripts/ingest-mm-signals'
import { runIngestEconCalendar } from '../lib/ingest/econ-calendar'
import { runNewsScrape } from '../lib/news-scrape'
import { FRED_SERIES, runIngestOneFredSeries } from '../../scripts/ingest-fred-complete'
import { INGESTION_SYMBOL_CODES } from '../lib/ingestion-symbols'

export { backfillMesAllTimeframes } from './backfill-mes'

// One step per symbol — isolated failures, isolated retries, no cross-contamination
// Derived from ingestion-symbols.ts so new symbols are picked up automatically
const MARKET_SYMBOLS = INGESTION_SYMBOL_CODES

const ECON_RELEASE_BATCHES: Array<{ id: string; releaseIds: number[] }> = [
  { id: 'tier1-fomc-nfp-cpi-pce', releaseIds: [101, 50, 10, 53] },
  { id: 'tier2-ppi-retail-gdp-claims-jolts', releaseIds: [46, 9, 21, 180, 192] },
  { id: 'tier3-sentiment-durables-housing', releaseIds: [54, 95, 27, 97] },
  { id: 'tier3-adp-indprod-trade-construction', releaseIds: [194, 13, 51, 229] },
]

const ECON_DAILY_RATES_WINDOWS: Array<{ id: string; startDateStr: string; endDateStr?: string }> = [
  { id: 'daily-rates-2020-2021', startDateStr: '2020-01-01', endDateStr: '2021-12-31' },
  { id: 'daily-rates-2022-2023', startDateStr: '2022-01-01', endDateStr: '2023-12-31' },
  { id: 'daily-rates-2024-now', startDateStr: '2024-01-01' },
]

const NEWS_LAYERS = ['trump_policy', 'volatility', 'banking', 'econ_report'] as const

const FRED_LOOKBACK_DAYS = 45

export const dailyIngestionJob = inngest.createFunction(
  { id: 'daily-ingestion-job', retries: 1 },
  { cron: '0 7 * * *' },
  async ({ step }) => {

    // ── 1. Databento market prices — one isolated step per symbol ─────────
    // Each symbol has its own API budget. One rate-limit or timeout does NOT
    // kill the others, and Inngest only retries the failed symbol's step.
    const marketResults: Array<{
      symbol: string
      result: Awaited<ReturnType<typeof runIngestMarketPricesDaily>>
    }> = []

    for (const symbol of MARKET_SYMBOLS) {
      const result = await step.run(`market-prices-${symbol.toLowerCase()}`, async () =>
        runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false, symbols: [symbol] })
      )
      marketResults.push({ symbol, result })
    }

    // ── 2. FRED economic series — one isolated step per series (47 total) ─
    // FRED rate-limits at 120 req/min. Each step is one series.
    // A FRED outage on one series does not block the other 46.
    const fredResults: Array<Awaited<ReturnType<typeof runIngestOneFredSeries>>> = []

    for (const spec of FRED_SERIES) {
      const result = await step.run(`fred-series-${spec.seriesId.toLowerCase()}`, async () =>
        runIngestOneFredSeries(spec, FRED_LOOKBACK_DAYS)
      )
      fredResults.push(result)
    }

    // ── 3. Alt news RSS feeds ─────────────────────────────────────────────
    const altNews = await step.run('alt-news-rss-daily', async () => runIngestAltNewsFeeds())

    // ── 4. Measured move signals (MES 1h, 120-day lookback) ───────────────
    const mm = await step.run('measured-move-signals', async () =>
      runIngestMeasuredMoveSignals({ timeframe: '1h', daysBack: 120, symbols: ['MES'], dryRun: false })
    )

    // ── 5. Economic calendar releases — one step per tier ─────────────────
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
      econCalendarReleases.push({ batchId: batch.id, releaseIds: batch.releaseIds, result })
    }

    // ── 6. Daily Treasury rates — one step per time window ────────────────
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

    // ── 7. Earnings ───────────────────────────────────────────────────────
    const econCalendarEarnings = await step.run('econ-calendar-earnings', async () =>
      runIngestEconCalendar({
        startDateStr: '2020-01-01',
        releaseIds: [],
        includeEarnings: true,
        continueOnError: true,
      })
    )

    // ── 8. News scrape — one step per layer ───────────────────────────────
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
      marketResults,
      fredResults,
      altNews,
      mm,
      econCalendarReleases,
      econCalendarDailyRates,
      econCalendarEarnings,
      newsScrape,
    }
  }
)
