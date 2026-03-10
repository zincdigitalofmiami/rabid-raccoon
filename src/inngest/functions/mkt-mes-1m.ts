import { inngest } from '../client'
import { refreshMes1mFromDatabento } from '../../lib/mes15m-refresh'

/**
 * Authoritative MES 1m writer for live chart + trigger consumers.
 *
 * Contract:
 * - Upstream write target is mkt_futures_mes_1m only.
 * - Runs every minute while MES market is open (conservative UTC gate).
 * - Does not rewrite mkt_futures_mes_15m; higher timeframes are derived downstream.
 */
function isMesMarketOpen(now: Date): boolean {
  const day = now.getUTCDay() // 0=Sun, 6=Sat
  const hour = now.getUTCHours()

  if (day === 6) return false
  if (day === 0) return hour >= 22
  if (day === 5) return hour < 22
  return true
}

export const ingestMktMes1m = inngest.createFunction(
  { id: 'ingest-mkt-mes-1m', retries: 2 },
  { cron: '* * * * 0-5' },
  async ({ step }) => {
    const now = new Date()
    if (!isMesMarketOpen(now)) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'market-closed',
        authoritative: true,
        timeframe: '1m',
      }
    }

    const result = await step.run('refresh-mes-1m-authoritative', async () =>
      refreshMes1mFromDatabento({
        force: true,
        lookbackMinutes: 180,
        minRefreshIntervalMs: 55_000,
      }),
    )

    if (result.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 1m authoritative refresh returned 0 rows (reason: ${result.reason ?? 'unknown'}, attempted: ${result.attempted})`,
      )
    }

    return {
      ranAt: now.toISOString(),
      result,
      authoritative: true,
      timeframe: '1m',
    }
  },
)
