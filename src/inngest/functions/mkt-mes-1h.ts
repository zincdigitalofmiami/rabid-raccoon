import { inngest } from '../client'
import { refreshMes1hFromDb1m } from '../../lib/mes-refresh'
import { isMesMarketOpen } from './mes-market-hours'
import { getMesHigherTfOwner, shouldSkipMesHigherTfInngest } from './mes-owner'

/**
 * MES 1h shared-table refresh (compatibility path).
 * Reads mkt_futures_mes_1m from DB, aggregates to 1h.
 *
 * Ownership note:
 * - Authoritative minute-cadence MES ingestion is ingest-mkt-mes-1m (1m table only).
 * - This function writes only mkt_futures_mes_1h for compatibility readers.
 * Target table: mkt_futures_mes_1h.
 * Runs hourly while market is open.
 */
export const ingestMktMes1h = inngest.createFunction(
  { id: 'ingest-mkt-mes-1h', retries: 2 },
  /* PAUSED: { cron: '10 * * * 0-5' } */ { event: "manual/paused" },
  async ({ step }) => {
    const now = new Date()
    const owner = getMesHigherTfOwner()
    if (shouldSkipMesHigherTfInngest()) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'owner-worker',
        owner,
        timeframe: '1h',
      }
    }

    if (!isMesMarketOpen(now)) {
      return {
        ranAt: now.toISOString(),
        skipped: true,
        reason: 'market-closed',
        owner,
        timeframe: '1h',
      }
    }

    const result = await step.run('derive-mes-1h-from-db-1m', async () =>
      refreshMes1hFromDb1m({
        force: true,
      }),
    )

    if (result.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 1h refresh returned 0 rows (reason: ${result.reason ?? 'unknown'}, attempted: ${result.attempted})`,
      )
    }

    return {
      ranAt: now.toISOString(),
      result,
      owner,
      timeframe: '1h',
      zeroRows: result.rowsUpserted === 0,
    }
  }
)
