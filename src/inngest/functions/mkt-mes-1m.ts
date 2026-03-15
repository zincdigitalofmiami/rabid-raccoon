import { inngest } from '../client'
import {
  refreshMes1mFromDatabento,
  refreshMes15mFromDb1m,
  refreshMes1hFromDb1m,
  refreshMes4hFromDb1m,
  refreshMes1dFromDb1m,
} from '../../lib/mes-refresh'
import { getDirectPool } from '../../lib/direct-pool'
import { MES_1M_OWNER_PATH } from '../../lib/mes-live-queries'
import { isMesMarketOpen } from './mes-market-hours'
import { getMes1mOwner, shouldSkipMes1mInngest } from './mes-owner'

/**
 * Authoritative MES 1m writer for live chart + trigger consumers.
 *
 * Contract:
 * - Upstream external pull target is mkt_futures_mes_1m only.
 * - Runs every minute while MES market is open (conservative UTC gate).
 * - Derives/upserts mkt_futures_mes_15m, mkt_futures_mes_1h, mkt_futures_mes_4h, mkt_futures_mes_1d from stored 1m.
 */
export const ingestMktMes1m = inngest.createFunction(
  { id: 'ingest-mkt-mes-1m', retries: 2 },
  // PAUSED: { cron: '* * * * 0-5' }
  { event: "manual/paused" },
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
        minRefreshIntervalMs: 55_000,
      }),
    )

    if (result.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 1m authoritative refresh returned 0 rows (reason: ${result.reason ?? 'unknown'}, attempted: ${result.attempted})`,
      )
    }

    const derived15m = await step.run('derive-mes-15m-from-db-1m', async () =>
      refreshMes15mFromDb1m({
        force: true,
        lookbackMinutes: 24 * 60,
      }),
    )

    if (derived15m.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 15m derive from 1m returned 0 rows (reason: ${derived15m.reason ?? 'unknown'}, attempted: ${derived15m.attempted})`,
      )
    }

    const markers = await step.run('read-mes-derived-latest-markers', async () => {
      const pool = getDirectPool()
      const [latest1mResult, latest1hResult, latest4hResult, latest1dResult] = await Promise.all([
        pool.query<{ eventTime: Date | string }>(
          'SELECT "eventTime" FROM "mkt_futures_mes_1m" ORDER BY "eventTime" DESC LIMIT 1',
        ),
        pool.query<{ eventTime: Date | string }>(
          'SELECT "eventTime" FROM "mkt_futures_mes_1h" ORDER BY "eventTime" DESC LIMIT 1',
        ),
        pool.query<{ eventTime: Date | string }>(
          'SELECT "eventTime" FROM "mkt_futures_mes_4h" ORDER BY "eventTime" DESC LIMIT 1',
        ),
        pool.query<{ eventDate: Date | string }>(
          'SELECT "eventDate" FROM "mkt_futures_mes_1d" ORDER BY "eventDate" DESC LIMIT 1',
        ),
      ])

      const asIso = (value: Date | string | null | undefined): string | null => {
        if (!value) return null
        const date = value instanceof Date ? value : new Date(String(value))
        return Number.isNaN(date.getTime()) ? null : date.toISOString()
      }

      return {
        latest1mIso: asIso(latest1mResult.rows[0]?.eventTime),
        latest1hIso: asIso(latest1hResult.rows[0]?.eventTime),
        latest4hIso: asIso(latest4hResult.rows[0]?.eventTime),
        latest1dIso: asIso(latest1dResult.rows[0]?.eventDate),
      }
    })

    const latest1m = markers.latest1mIso ? new Date(markers.latest1mIso) : null
    const latest1h = markers.latest1hIso ? new Date(markers.latest1hIso) : null
    const latest4h = markers.latest4hIso ? new Date(markers.latest4hIso) : null
    const latest1d = markers.latest1dIso ? new Date(markers.latest1dIso) : null

    const nowUtc = new Date()
    const current1hBucketStart = new Date(Math.floor(nowUtc.getTime() / 3_600_000) * 3_600_000)
    const current4hBucketStart = new Date(Math.floor(nowUtc.getTime() / 14_400_000) * 14_400_000)
    const current1dBucketStart = new Date(
      Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()),
    )

    const run1h =
      latest1h == null ||
      latest1h.getTime() < current1hBucketStart.getTime()
    const run4h =
      latest4h == null ||
      latest4h.getTime() < current4hBucketStart.getTime()
    const run1d =
      latest1d == null ||
      latest1d.getTime() < current1dBucketStart.getTime()

    const derived1h = run1h
      ? await step.run('derive-mes-1h-from-db-1m', async () =>
          refreshMes1hFromDb1m({
            force: true,
            lookbackMinutes: 72 * 60,
          }),
        )
      : {
          attempted: false,
          refreshed: false,
          rowsUpserted: 0,
          latestEventTime: null,
          reason: 'bucket-current',
        }

    if (run1h && derived1h.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 1h derive from 1m returned 0 rows (reason: ${derived1h.reason ?? 'unknown'}, attempted: ${derived1h.attempted})`,
      )
    }

    const derived4h = run4h
      ? await step.run('derive-mes-4h-from-db-1m', async () =>
          refreshMes4hFromDb1m({
            force: true,
            lookbackMinutes: 14 * 24 * 60,
          }),
        )
      : {
          attempted: false,
          refreshed: false,
          rowsUpserted: 0,
          latestEventTime: null,
          reason: 'bucket-current',
        }

    if (run4h && derived4h.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 4h derive from 1m returned 0 rows (reason: ${derived4h.reason ?? 'unknown'}, attempted: ${derived4h.attempted})`,
      )
    }

    const derived1d = run1d
      ? await step.run('derive-mes-1d-from-db-1m', async () =>
          refreshMes1dFromDb1m({
            force: true,
            lookbackMinutes: 45 * 24 * 60,
          }),
        )
      : {
          attempted: false,
          refreshed: false,
          rowsUpserted: 0,
          latestEventTime: null,
          reason: 'bucket-current',
        }

    if (run1d && derived1d.rowsUpserted === 0) {
      console.warn(
        `[WARN] MES 1d derive from 1m returned 0 rows (reason: ${derived1d.reason ?? 'unknown'}, attempted: ${derived1d.attempted})`,
      )
    }

    const ownerFreshness = {
      writerFunctionId: MES_1M_OWNER_PATH.writerFunctionId,
      writerFunctionFile: MES_1M_OWNER_PATH.writerFunctionFile,
      sourceTable: MES_1M_OWNER_PATH.sourceTable,
      upstreamProvider: MES_1M_OWNER_PATH.upstreamProvider,
      expectedCadenceSeconds: MES_1M_OWNER_PATH.expectedCadenceSeconds,
      lagAlertSeconds: MES_1M_OWNER_PATH.lagAlertSeconds,
      latest1mRowTime: markers.latest1mIso,
      latest1mAgeSeconds: latest1m
        ? Math.max(0, Math.floor((Date.now() - latest1m.getTime()) / 1000))
        : null,
    }

    return {
      ranAt: now.toISOString(),
      result,
      derived15m,
      derived1h,
      derived4h,
      derived1d,
      ownerFreshness,
      owner,
      authoritative: true,
      timeframe: '1m',
    }
  },
)
