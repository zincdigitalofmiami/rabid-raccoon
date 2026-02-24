import { inngest } from '../client'
import { refreshMes15mFromDatabento } from '../../lib/mes15m-refresh'

/**
 * MES 15m candle backfill — fetches ohlcv-1m from Databento, aggregates to 15m.
 * Target table: mkt_futures_mes_15m.
 * Runs every hour to ensure no gaps in 15m data.
 */
export const ingestMktMes15m = inngest.createFunction(
  { id: 'ingest-mkt-mes-15m', retries: 2 },
  { cron: '5 * * * *' }, // :05 past every hour (offset from 1h job at :00)
  async ({ step }) => {
    const result = await step.run('refresh-mes-15m', async () =>
      refreshMes15mFromDatabento({
        force: true,
        lookbackMinutes: 24 * 60, // 24h lookback to fill any gaps
      })
    )
    return { ranAt: new Date().toISOString(), result }
  }
)
