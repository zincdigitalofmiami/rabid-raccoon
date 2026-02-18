import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'INFLATION'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED inflation series — T10YIE, T5YIFR, DFII10, DFII5, T5YIE, CPI, Core CPI, Core PCE, PPI.
 * Target table: econ_inflation_1d
 * Runs daily at 07:28 UTC.
 */
export const ingestEconInflation = inngest.createFunction(
  { id: 'ingest-econ-inflation', retries: 2 },
  { cron: '28 7 * * *' },
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
