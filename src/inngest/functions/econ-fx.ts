import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'FX'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED FX series — DXY (DTWEXBGS), EUR/USD, JPY/USD, CNY/USD, MXN/USD.
 * Target table: econ_fx_1d
 * Runs daily at 07:29 UTC.
 */
export const ingestEconFx = inngest.createFunction(
  { id: 'ingest-econ-fx', retries: 2 },
  { cron: '0 9 * * *' },
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
