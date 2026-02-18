import { inngest } from '../client'
import { FRED_SERIES, runIngestOneFredSeries, type FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'VOL_INDICES'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED Vol & Credit — VIX, VVIX, HY OAS, IG OAS, OVX, NFCI, EPU
 * Target table: econ_vol_indices_1d
 * Cron: 07:27 UTC daily
 */
export const ingestEconVolIndices = inngest.createFunction(
  { id: 'ingest-econ-vol-indices', retries: 2 },
  { cron: '27 7 * * *' },
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
