import { inngest } from '../client'
import { runIngestMeasuredMoveSignals } from '../../../scripts/ingest-mm-signals'

/**
 * Measured move signal detection — Halsey methodology on MES 1h.
 * Target table: measured_move_signals
 * Runs daily at 07:50 UTC.
 */
export const ingestMeasuredMoves = inngest.createFunction(
  { id: 'ingest-measured-moves', retries: 2 },
  { cron: '50 7 * * *' },
  async ({ step }) => {
    const result = await step.run('measured-move-signals', async () =>
      runIngestMeasuredMoveSignals({
        timeframe: '1h',
        daysBack: 120,
        symbols: ['MES'],
        dryRun: false,
      })
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
