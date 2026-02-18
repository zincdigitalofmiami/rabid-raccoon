import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, type FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'RATES'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED Rates — DFF, DFEDTARL, DFEDTARU, T10Y2Y, SOFR
 * Target table: econ_rates_1d
 * Cron: 07:25 UTC daily
 */
export const ingestEconRates = inngest.createFunction(
  { id: 'ingest-econ-rates', retries: 2 },
  { cron: '25 7 * * *' },
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
