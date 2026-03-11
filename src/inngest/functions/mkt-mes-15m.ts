import { inngest } from '../client'
import { refreshMes15mFromDb1m } from '../../lib/mes15m-refresh'
import { isMesMarketOpen } from './mes-market-hours'
import { getMesHigherTfOwner, shouldSkipMesHigherTfInngest } from './mes-owner'

/**
 * MES 15m shared-table refresh (compatibility path).
 * Reads mkt_futures_mes_1m from DB, aggregates to 15m.
 *
 * Ownership note:
 * - Authoritative minute-cadence MES ingestion is ingest-mkt-mes-1m (1m table only).
 * - This function writes only mkt_futures_mes_15m for compatibility readers.
 * Target table: mkt_futures_mes_15m.
 * Runs every 15 minutes so live routes can stay read-only.
 */
export const ingestMktMes15m = inngest.createFunction(
  { id: 'ingest-mkt-mes-15m', retries: 2 },
  { cron: '5,20,35,50 * * * 1-5' },
  async ({ step }) => {
    const now = new Date()
    const owner = getMesHigherTfOwner()
    if (shouldSkipMesHigherTfInngest()) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'owner-worker',
        owner,
        timeframe: '15m',
      }
    }

    if (!isMesMarketOpen(now)) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'market-closed',
        owner,
        timeframe: '15m',
      }
    }

    const result = await step.run('derive-mes-15m-from-db-1m', async () =>
      refreshMes15mFromDb1m({
        force: true,
        lookbackMinutes: 24 * 60, // 24h lookback to fill any gaps
      })
    )

    if (result.rowsUpserted === 0) {
      console.warn(`[WARN] MES 15m refresh returned 0 rows (reason: ${result.reason ?? 'unknown'}, attempted: ${result.attempted})`)
    }

    return {
      ranAt: now.toISOString(),
      result,
      owner,
      timeframe: '15m',
      zeroRows: result.rowsUpserted === 0,
    }
  }
)
