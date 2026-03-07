import { inngest } from '../client'
import { refreshMes15mFromDatabento } from '../../lib/mes15m-refresh'

/**
 * MES 15m candle backfill — fetches ohlcv-1m from Databento, aggregates to 15m.
 * Target table: mkt_futures_mes_15m.
 * Runs every 15 minutes so live routes can stay read-only.
 */
export const ingestMktMes15m = inngest.createFunction(
  { id: 'ingest-mkt-mes-15m', retries: 2 },
  { cron: '5,20,35,50 * * * 1-5' },
  async ({ step }) => {
    const result = await step.run('refresh-mes-15m', async () =>
      refreshMes15mFromDatabento({
        force: true,
        lookbackMinutes: 24 * 60, // 24h lookback to fill any gaps
      })
    )

    if (result.rowsUpserted === 0) {
      console.warn(`[WARN] MES 15m refresh returned 0 rows (reason: ${result.reason ?? 'unknown'}, attempted: ${result.attempted})`)
    }

    return { ranAt: new Date().toISOString(), result, zeroRows: result.rowsUpserted === 0 }
  }
)
