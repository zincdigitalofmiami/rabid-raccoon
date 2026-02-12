import { inngest } from './client'
import { runIngestMacroIndicators } from '../../scripts/ingest-macro-indicators'
import { runIngestMarketPricesDaily } from '../../scripts/ingest-market-prices-daily'
import { runIngestMeasuredMoveSignals } from '../../scripts/ingest-mm-signals'

export const dailyIngestionJob = inngest.createFunction(
  { id: 'daily-ingestion-job', retries: 1 },
  { cron: '0 7 * * *' },
  async ({ step }) => {
    const market = await step.run('market-prices-incremental', async () =>
      runIngestMarketPricesDaily({ lookbackHours: 48, dryRun: false })
    )

    const macro = await step.run('macro-indicators-daily', async () =>
      runIngestMacroIndicators({ daysBack: 45, dryRun: false })
    )

    const mm = await step.run('measured-move-signals', async () =>
      runIngestMeasuredMoveSignals({ timeframe: '1h', daysBack: 120, symbols: ['MES'], dryRun: false })
    )

    return {
      ranAt: new Date().toISOString(),
      market,
      macro,
      mm,
    }
  }
)
