import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, type FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'MONEY'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED Money — WALCL (Fed Assets), RRP, M2
 * Target table: econ_money_1d
 * Cron: 07:33 UTC daily
 */
export const ingestEconMoney = inngest.createFunction(
  { id: 'ingest-econ-money', retries: 2 },
  { cron: '33 7 * * *' },
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
