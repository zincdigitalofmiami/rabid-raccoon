import { inngest } from '../client'
import { runIngestEconCalendar } from '../../lib/ingest/econ-calendar'

const RELEASE_BATCHES: Array<{ id: string; releaseIds: number[] }> = [
  { id: 'tier1-fomc-nfp-cpi-pce', releaseIds: [101, 50, 10, 53] },
  { id: 'tier2-ppi-retail-gdp-claims-jolts', releaseIds: [46, 9, 21, 180, 192] },
  { id: 'tier3-sentiment-durables-housing', releaseIds: [54, 95, 27, 97] },
  { id: 'tier3-adp-indprod-trade-construction', releaseIds: [194, 13, 51, 229] },
]

const DAILY_RATES_WINDOWS: Array<{ id: string; startDateStr: string; endDateStr?: string }> = [
  { id: 'daily-rates-2020-2021', startDateStr: '2020-01-01', endDateStr: '2021-12-31' },
  { id: 'daily-rates-2022-2023', startDateStr: '2022-01-01', endDateStr: '2023-12-31' },
  { id: 'daily-rates-2024-now', startDateStr: '2024-01-01' },
]

/**
 * Economic calendar — release dates, actuals, surprises.
 * Target tables: econ_calendar, macro_reports_1d
 * One step per release tier + daily rates windows + earnings.
 * Cron: 07:35 UTC daily
 */
export const ingestEconCalendar = inngest.createFunction(
  { id: 'ingest-econ-calendar', retries: 1 },
  { cron: '35 7 * * *' },
  async ({ step }) => {
    // Release tiers
    const releaseResults = []
    for (const batch of RELEASE_BATCHES) {
      const result = await step.run(`releases-${batch.id}`, async () =>
        runIngestEconCalendar({
          startDateStr: '2020-01-01',
          releaseIds: batch.releaseIds,
          includeEarnings: false,
          continueOnError: true,
        })
      )
      releaseResults.push({ batchId: batch.id, result })
    }

    // Daily Treasury rates
    const ratesResults = []
    for (const window of DAILY_RATES_WINDOWS) {
      const result = await step.run(`rates-${window.id}`, async () =>
        runIngestEconCalendar({
          startDateStr: window.startDateStr,
          endDateStr: window.endDateStr,
          releaseIds: [18],
          includeEarnings: false,
          continueOnError: true,
        })
      )
      ratesResults.push({ windowId: window.id, result })
    }

    // Earnings
    const earnings = await step.run('earnings', async () =>
      runIngestEconCalendar({
        startDateStr: '2020-01-01',
        releaseIds: [],
        includeEarnings: true,
        continueOnError: true,
      })
    )

    return { ranAt: new Date().toISOString(), releaseResults, ratesResults, earnings }
  }
)
