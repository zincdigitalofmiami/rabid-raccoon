import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'INDEXES'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED equity index series — SP500, NASDAQCOM, DJIA.
 * Target table: econ_indexes_1d
 * One step per series for isolated retry.
 * Runs daily at 14:00 UTC.
 */
export const ingestEconIndexes = inngest.createFunction(
  { id: 'ingest-econ-indexes', retries: 2 },
  { cron: '0 14 * * *' },
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
