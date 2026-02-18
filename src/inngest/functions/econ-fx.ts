import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, type FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'FX'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED FX — DXY, EUR/USD, JPY/USD, CNY/USD, MXN/USD
 * Target table: econ_fx_1d
 * Cron: 07:29 UTC daily
 */
export const ingestEconFx = inngest.createFunction(
  { id: 'ingest-econ-fx', retries: 2 },
  { cron: '29 7 * * *' },
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
