import { inngest } from '../client'
import { runIngestMeasuredMoveSignals } from '../../../scripts/ingest-mm-signals'

/**
 * Measured move signals — Halsey methodology on MES 1h bars.
 * Target table: measured_move_signals
 * Cron: 07:50 UTC daily
 */
export const ingestMeasuredMoves = inngest.createFunction(
  { id: 'ingest-measured-moves', retries: 2 },
  { cron: '50 7 * * *' },
  async ({ step }) => {
    const result = await step.run('mm-signals-mes', async () =>
      runIngestMeasuredMoveSignals({ timeframe: '1h', daysBack: 120, symbols: ['MES'], dryRun: false })
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
