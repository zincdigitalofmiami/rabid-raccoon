import { inngest } from '../client'
import { prisma } from '../../lib/prisma'
import { FRED_SERIES, runIngestOneFredSeries, FredSeriesResult } from '../../../scripts/ingest-fred-complete'

const DOMAIN = 'MONEY'
const LOOKBACK_DAYS = 45
const SERIES = FRED_SERIES.filter((s) => s.domain === DOMAIN)

/**
 * FRED money/liquidity series — WALCL (Fed balance sheet), RRP, M2.
 * Target table: econ_money_1d
 * Runs daily at 07:33 UTC.
 */
export const ingestEconMoney = inngest.createFunction(
  { id: 'ingest-econ-money', retries: 2 },
  { cron: '0 13 * * *' },
  async ({ step }) => {
    const jobId = `ingest-econ-${DOMAIN.toLowerCase().replace(/_/g, '-')}`
    const run = await step.run('create-ingestion-run', async () => {
      const record = await prisma.ingestionRun.create({
        data: {
          job: jobId,
          status: 'RUNNING',
          details: { domain: DOMAIN, seriesCount: SERIES.length, seriesIds: SERIES.map(s => s.seriesId) },
        },
      })
      return { id: Number(record.id) }
    })

    try {
      const results: FredSeriesResult[] = []

      for (const spec of SERIES) {
        const result = await step.run(`fred-${spec.seriesId.toLowerCase()}`, async () =>
          runIngestOneFredSeries(spec, LOOKBACK_DAYS)
        )
        results.push(result)
      }

      const totalFetched = results.reduce((s, r) => s + r.fetched, 0)
      const totalInserted = results.reduce((s, r) => s + r.inserted, 0)
      const errors = results.filter(r => r.error)
      console.log(`[fred] ${DOMAIN} complete — ${SERIES.length} series, ${totalFetched} fetched, ${totalInserted} inserted, ${errors.length} errors`)
      if (errors.length > 0) console.error(`[fred] ${DOMAIN} errors:`, JSON.stringify(errors))

      await step.run('update-ingestion-run', async () => {
        await prisma.ingestionRun.update({
          where: { id: BigInt(run.id) },
          data: {
            status: errors.length === SERIES.length ? 'FAILED' : 'COMPLETED',
            finishedAt: new Date(),
            rowsProcessed: totalFetched,
            rowsInserted: totalInserted,
            rowsFailed: errors.length,
            details: JSON.parse(JSON.stringify({ domain: DOMAIN, seriesCount: SERIES.length, results })),
          },
        })
      })

      return { ranAt: new Date().toISOString(), domain: DOMAIN, seriesCount: SERIES.length, results }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      try {
        await prisma.ingestionRun.update({
          where: { id: BigInt(run.id) },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            details: { domain: DOMAIN, error: message },
          },
        })
      } catch { /* IngestionRun update failed — original error takes priority */ }
      throw error
    }
  }
)
