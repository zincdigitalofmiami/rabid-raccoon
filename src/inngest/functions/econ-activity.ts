import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'ACTIVITY'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED activity series — GDP, Retail Sales, UMich Sentiment, IndPro, Trade Balance, China Imports.
 * Target table: econ_activity_1d
 * Runs daily at 07:31 UTC.
 */
export const ingestEconActivity = inngest.createFunction(
  { id: 'ingest-econ-activity', retries: 2 },
  { cron: '0 11 * * *' },
  async ({ step }) => {
    const results: FredSeriesResult[] = []

    for (const spec of SERIES) {
      const result = await step.run(`fred-${spec.seriesId.toLowerCase()}`, async () =>
        runIngestOneFredSeries(spec, LOOKBACK_DAYS)
      )
      results.push(result)
    }

    return { ranAt: new Date().toISOString(), domain: DOMAIN, seriesCount: SERIES.length, results }
  }
)
