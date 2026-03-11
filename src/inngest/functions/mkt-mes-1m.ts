import { inngest } from '../client'
import { refreshMes1mFromDatabento } from '../../lib/mes15m-refresh'
import { isMesMarketOpen } from './mes-market-hours'
import { getMes1mOwner, shouldSkipMes1mInngest } from './mes-owner'

/**
 * Authoritative MES 1m writer for live chart + trigger consumers.
 *
 * Contract:
 * - Upstream write target is mkt_futures_mes_1m only.
 * - Runs every minute while MES market is open (conservative UTC gate).
 * - Does not rewrite mkt_futures_mes_15m; higher timeframes are derived downstream.
 */
export const ingestMktMes1m = inngest.createFunction(
  { id: 'ingest-mkt-mes-1m', retries: 2 },
  { cron: '* * * * 0-5' },
  async ({ step }) => {
    const now = new Date()
    const owner = getMes1mOwner()
    if (shouldSkipMes1mInngest()) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'owner-worker',
        owner,
        authoritative: false,
        timeframe: '1m',
      }
    }

    if (!isMesMarketOpen(now)) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'market-closed',
        owner,
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
      owner,
      authoritative: true,
      timeframe: '1m',
    }
  },
)
