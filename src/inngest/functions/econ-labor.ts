import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, type FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'LABOR'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED Labor — ICSA, CCSA, PAYEMS, UNRATE
 * Target table: econ_labor_1d
 * Cron: 07:30 UTC daily
 */
export const ingestEconLabor = inngest.createFunction(
  { id: 'ingest-econ-labor', retries: 2 },
  { cron: '30 7 * * *' },
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
