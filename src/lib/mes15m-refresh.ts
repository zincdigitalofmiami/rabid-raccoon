import { createHash } from 'node:crypto'
import { getDirectPool } from './direct-pool'
import { fetchOhlcv, toCandles } from './databento'
import type { CandleData } from './types'

const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const SOURCE_SCHEMA_1M = 'ohlcv-1m'

const DERIVED_SOURCE_SCHEMAS = {
  '15m': 'mkt_futures_mes_1m->15m',
  '1h': 'mkt_futures_mes_1m->1h',
  '4h': 'mkt_futures_mes_1m->4h',
  '1d': 'mkt_futures_mes_1m->1d',
} as const

const BUCKET_SECONDS = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
} as const

const DEFAULT_LOOKBACK_MINUTES = {
  '1m': 18 * 60,
  '15m': 24 * 60,
  '1h': 72 * 60,
  '4h': 14 * 24 * 60,
  '1d': 45 * 24 * 60,
} as const

const DEFAULT_MIN_REFRESH_INTERVAL_MS = 5 * 60 * 1000
const MAX_1M_CANDLES_TO_UPSERT = 1200
const MAX_DERIVED_CANDLES_TO_UPSERT = {
  '15m': 500,
  '1h': 500,
  '4h': 500,
  '1d': 400,
} as const

const BATCH_SIZE = 40

type MesRefreshTimeframe = '1m' | '15m' | '1h' | '4h' | '1d'
type MesDerivedTimeframe = Exclude<MesRefreshTimeframe, '1m'>

const REFRESH_LOCK_KEYS: Record<MesRefreshTimeframe, number> = {
  '1m': 15_001_501,
  '15m': 15_001_515,
  '1h': 15_001_601,
  '4h': 15_001_604,
  '1d': 15_001_624,
}

const lastRefreshAttemptAtMs: Record<MesRefreshTimeframe, number> = {
  '1m': 0,
  '15m': 0,
  '1h': 0,
  '4h': 0,
  '1d': 0,
}

const inFlightRefresh: Record<MesRefreshTimeframe, Promise<RefreshResult> | null> = {
  '1m': null,
  '15m': null,
  '1h': null,
  '4h': null,
  '1d': null,
}

export interface RefreshResult {
  attempted: boolean
  refreshed: boolean
  rowsUpserted: number
  latestEventTime: Date | null
  reason?: string
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function asUtcDateFromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1000)
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function hashRow(prefix: string, event: Date, close: number): string {
  return createHash('sha256')
    .update(`${prefix}|${event.toISOString()}|${close}`)
    .digest('hex')
}

function dedupeAndSort(candles: CandleData[]): CandleData[] {
  const byTime = new Map<number, CandleData>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

function aggregateByBucketSeconds(candles: CandleData[], bucketSeconds: number): CandleData[] {
  if (candles.length === 0) return []

  const out: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const candle of candles) {
    const aligned = Math.floor(candle.time / bucketSeconds) * bucketSeconds
    if (!bucket || aligned !== bucketStart) {
      if (bucket) out.push(bucket)
      bucket = {
        time: aligned,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      }
      bucketStart = aligned
      continue
    }

    bucket.high = Math.max(bucket.high, candle.high)
    bucket.low = Math.min(bucket.low, candle.low)
    bucket.close = candle.close
    bucket.volume = (bucket.volume || 0) + (candle.volume || 0)
  }

  if (bucket) out.push(bucket)
  return out
}

async function currentLatestEventTime(timeframe: MesRefreshTimeframe): Promise<Date | null> {
  const pool = getDirectPool()

  if (timeframe === '1d') {
    const result = await pool.query(
      'SELECT "eventDate" AS "eventTime" FROM "mkt_futures_mes_1d" ORDER BY "eventDate" DESC LIMIT 1',
    )
    return result.rows[0]?.eventTime ?? null
  }

  const table =
    timeframe === '1m'
      ? '"mkt_futures_mes_1m"'
      : timeframe === '15m'
        ? '"mkt_futures_mes_15m"'
        : timeframe === '1h'
          ? '"mkt_futures_mes_1h"'
          : '"mkt_futures_mes_4h"'

  const result = await pool.query(
    `SELECT "eventTime" FROM ${table} ORDER BY "eventTime" DESC LIMIT 1`,
  )
  return result.rows[0]?.eventTime ?? null
}

async function tryAcquireRefreshLock(lockKey: number): Promise<{
  acquired: boolean
  release: () => Promise<void>
}> {
  const pool = getDirectPool()
  const client = await pool.connect()

  try {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockKey],
    )
    const acquired = result.rows[0]?.locked === true

    if (!acquired) {
      client.release()
      return {
        acquired: false,
        release: async () => {},
      }
    }

    return {
      acquired: true,
      release: async () => {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [lockKey])
        } finally {
          client.release()
        }
      },
    }
  } catch (error) {
    client.release()
    throw error
  }
}

async function readMes1mFromDb(windowStart: Date): Promise<CandleData[]> {
  const pool = getDirectPool()
  const rows = await pool.query<{
    eventTime: Date | string
    open: number | string
    high: number | string
    low: number | string
    close: number | string
    volume: number | string | bigint | null
  }>(
    `
      SELECT
        "eventTime",
        "open"::double precision AS "open",
        "high"::double precision AS "high",
        "low"::double precision AS "low",
        "close"::double precision AS "close",
        COALESCE("volume", 0)::double precision AS "volume"
      FROM "mkt_futures_mes_1m"
      WHERE "eventTime" >= $1
      ORDER BY "eventTime" ASC
    `,
    [windowStart],
  )

  return dedupeAndSort(
    rows.rows.map((row) => ({
      time: Math.floor(new Date(String(row.eventTime)).getTime() / 1000),
      open: asNumber(row.open),
      high: asNumber(row.high),
      low: asNumber(row.low),
      close: asNumber(row.close),
      volume: Math.max(0, Math.trunc(asNumber(row.volume))),
    })),
  )
}

async function upsertMes1m(candles: CandleData[]): Promise<number> {
  if (candles.length === 0) return 0

  const UPSERT_SQL = `
    INSERT INTO "mkt_futures_mes_1m" (
      "eventTime", "open", "high", "low", "close", "volume",
      "source", "sourceDataset", "sourceSchema", "rowHash",
      "ingestedAt", "knowledgeTime"
    )
    VALUES ($1, $2, $3, $4, $5, $6, 'DATABENTO'::"DataSource", $7, $8, $9, NOW(), NOW())
    ON CONFLICT ("eventTime") DO UPDATE SET
      "open" = EXCLUDED."open",
      "high" = EXCLUDED."high",
      "low" = EXCLUDED."low",
      "close" = EXCLUDED."close",
      "volume" = EXCLUDED."volume",
      "rowHash" = EXCLUDED."rowHash",
      "source" = EXCLUDED."source",
      "sourceDataset" = EXCLUDED."sourceDataset",
      "sourceSchema" = EXCLUDED."sourceSchema",
      "ingestedAt" = NOW(),
      "knowledgeTime" = NOW()
  `

  let rowsUpserted = 0
  const pool = getDirectPool()
  const client = await pool.connect()
  try {
    for (let i = 0; i < candles.length; i += BATCH_SIZE) {
      const batch = candles.slice(i, i + BATCH_SIZE)
      await client.query('BEGIN')
      for (const candle of batch) {
        const eventTime = asUtcDateFromUnixSeconds(candle.time)
        await client.query(UPSERT_SQL, [
          eventTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          Math.max(0, Math.trunc(candle.volume || 0)),
          MES_DATASET,
          SOURCE_SCHEMA_1M,
          hashRow('MES-1M', eventTime, candle.close),
        ])
      }
      await client.query('COMMIT')
      rowsUpserted += batch.length
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  return rowsUpserted
}

async function upsertMesDerived(timeframe: MesDerivedTimeframe, candles: CandleData[]): Promise<number> {
  if (candles.length === 0) return 0

  const sourceSchema = DERIVED_SOURCE_SCHEMAS[timeframe]
  let rowsUpserted = 0
  const pool = getDirectPool()
  const client = await pool.connect()

  try {
    if (timeframe === '1d') {
      const UPSERT_DAILY_SQL = `
        INSERT INTO "mkt_futures_mes_1d" (
          "eventDate", "open", "high", "low", "close", "volume",
          "source", "sourceDataset", "sourceSchema", "rowHash",
          "ingestedAt", "knowledgeTime"
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'DATABENTO'::"DataSource", $7, $8, $9, NOW(), NOW())
        ON CONFLICT ("eventDate") DO UPDATE SET
          "open" = EXCLUDED."open",
          "high" = EXCLUDED."high",
          "low" = EXCLUDED."low",
          "close" = EXCLUDED."close",
          "volume" = EXCLUDED."volume",
          "source" = EXCLUDED."source",
          "sourceDataset" = EXCLUDED."sourceDataset",
          "sourceSchema" = EXCLUDED."sourceSchema",
          "rowHash" = EXCLUDED."rowHash",
          "ingestedAt" = NOW(),
          "knowledgeTime" = NOW()
      `

      for (let i = 0; i < candles.length; i += BATCH_SIZE) {
        const batch = candles.slice(i, i + BATCH_SIZE)
        await client.query('BEGIN')
        for (const candle of batch) {
          const eventDate = startOfUtcDay(asUtcDateFromUnixSeconds(candle.time))
          await client.query(UPSERT_DAILY_SQL, [
            eventDate,
            candle.open,
            candle.high,
            candle.low,
            candle.close,
            Math.max(0, Math.trunc(candle.volume || 0)),
            MES_DATASET,
            sourceSchema,
            hashRow('MES-1D', eventDate, candle.close),
          ])
        }
        await client.query('COMMIT')
        rowsUpserted += batch.length
      }

      return rowsUpserted
    }

    const tableName =
      timeframe === '15m'
        ? '"mkt_futures_mes_15m"'
        : timeframe === '1h'
          ? '"mkt_futures_mes_1h"'
          : '"mkt_futures_mes_4h"'

    const prefix = timeframe === '15m' ? 'MES-15M' : timeframe === '1h' ? 'MES-1H' : 'MES-4H'

    const UPSERT_INTRADAY_SQL = `
      INSERT INTO ${tableName} (
        "eventTime", "open", "high", "low", "close", "volume",
        "source", "sourceDataset", "sourceSchema", "rowHash",
        "ingestedAt", "knowledgeTime"
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'DATABENTO'::"DataSource", $7, $8, $9, NOW(), NOW())
      ON CONFLICT ("eventTime") DO UPDATE SET
        "open" = EXCLUDED."open",
        "high" = EXCLUDED."high",
        "low" = EXCLUDED."low",
        "close" = EXCLUDED."close",
        "volume" = EXCLUDED."volume",
        "source" = EXCLUDED."source",
        "sourceDataset" = EXCLUDED."sourceDataset",
        "sourceSchema" = EXCLUDED."sourceSchema",
        "rowHash" = EXCLUDED."rowHash",
        "ingestedAt" = NOW(),
        "knowledgeTime" = NOW()
    `

    for (let i = 0; i < candles.length; i += BATCH_SIZE) {
      const batch = candles.slice(i, i + BATCH_SIZE)
      await client.query('BEGIN')
      for (const candle of batch) {
        const eventTime = asUtcDateFromUnixSeconds(candle.time)
        await client.query(UPSERT_INTRADAY_SQL, [
          eventTime,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          Math.max(0, Math.trunc(candle.volume || 0)),
          MES_DATASET,
          sourceSchema,
          hashRow(prefix, eventTime, candle.close),
        ])
      }
      await client.query('COMMIT')
      rowsUpserted += batch.length
    }

    return rowsUpserted
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function refreshMes(
  timeframe: MesRefreshTimeframe,
  options?: {
    force?: boolean
    lookbackMinutes?: number
    minRefreshIntervalMs?: number
  },
): Promise<RefreshResult> {
  if (inFlightRefresh[timeframe]) {
    return inFlightRefresh[timeframe]!
  }

  inFlightRefresh[timeframe] = (async (): Promise<RefreshResult> => {
    const force = options?.force === true
    const minRefreshIntervalMs = Math.max(
      30_000,
      options?.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS,
    )

    if (!force && Date.now() - lastRefreshAttemptAtMs[timeframe] < minRefreshIntervalMs) {
      return {
        attempted: false,
        refreshed: false,
        rowsUpserted: 0,
        latestEventTime: await currentLatestEventTime(timeframe),
        reason: 'refresh-throttled',
      }
    }

    if (timeframe === '1m' && !process.env.DATABENTO_API_KEY) {
      return {
        attempted: false,
        refreshed: false,
        rowsUpserted: 0,
        latestEventTime: await currentLatestEventTime('1m'),
        reason: 'missing-databento-api-key',
      }
    }

    const refreshLock = await tryAcquireRefreshLock(REFRESH_LOCK_KEYS[timeframe])
    if (!refreshLock.acquired) {
      return {
        attempted: false,
        refreshed: false,
        rowsUpserted: 0,
        latestEventTime: await currentLatestEventTime(timeframe),
        reason: 'refresh-locked',
      }
    }

    try {
      lastRefreshAttemptAtMs[timeframe] = Date.now()
      const lookbackMinutes = Math.max(
        120,
        options?.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES[timeframe],
      )
      const now = Date.now()
      const windowStart = new Date(now - lookbackMinutes * 60 * 1000)

      if (timeframe === '1m') {
        const records = await fetchOhlcv({
          dataset: MES_DATASET,
          symbol: MES_SYMBOL,
          stypeIn: 'continuous',
          start: windowStart.toISOString(),
          end: new Date(now).toISOString(),
          schema: SOURCE_SCHEMA_1M,
          timeoutMs: 20_000,
          maxAttempts: 2,
        })

        const candles1m = dedupeAndSort(toCandles(records)).slice(-MAX_1M_CANDLES_TO_UPSERT)
        const rowsUpserted = await upsertMes1m(candles1m)

        return {
          attempted: true,
          refreshed: rowsUpserted > 0,
          rowsUpserted,
          latestEventTime:
            candles1m.length > 0
              ? asUtcDateFromUnixSeconds(candles1m[candles1m.length - 1].time)
              : await currentLatestEventTime('1m'),
          ...(candles1m.length === 0 ? { reason: 'no-candles-returned' } : {}),
        }
      }

      const sorted1m = await readMes1mFromDb(windowStart)
      const bucketSeconds = BUCKET_SECONDS[timeframe]
      const candlesDerived = aggregateByBucketSeconds(sorted1m, bucketSeconds).slice(
        -MAX_DERIVED_CANDLES_TO_UPSERT[timeframe],
      )

      if (candlesDerived.length === 0) {
        return {
          attempted: true,
          refreshed: false,
          rowsUpserted: 0,
          latestEventTime: await currentLatestEventTime(timeframe),
          reason: 'no-candles-returned',
        }
      }

      const rowsUpserted = await upsertMesDerived(timeframe, candlesDerived)
      return {
        attempted: true,
        refreshed: rowsUpserted > 0,
        rowsUpserted,
        latestEventTime: asUtcDateFromUnixSeconds(candlesDerived[candlesDerived.length - 1].time),
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        attempted: true,
        refreshed: false,
        rowsUpserted: 0,
        latestEventTime: await currentLatestEventTime(timeframe),
        reason: message,
      }
    } finally {
      await refreshLock.release()
    }
  })().finally(() => {
    inFlightRefresh[timeframe] = null
  })

  return inFlightRefresh[timeframe]!
}

export async function refreshMes1mFromDatabento(options?: {
  force?: boolean
  lookbackMinutes?: number
  minRefreshIntervalMs?: number
}): Promise<RefreshResult> {
  return refreshMes('1m', options)
}

export async function refreshMes15mFromDb1m(options?: {
  force?: boolean
  lookbackMinutes?: number
  minRefreshIntervalMs?: number
}): Promise<RefreshResult> {
  return refreshMes('15m', options)
}

export async function refreshMes1hFromDb1m(options?: {
  force?: boolean
  lookbackMinutes?: number
  minRefreshIntervalMs?: number
}): Promise<RefreshResult> {
  return refreshMes('1h', options)
}

export async function refreshMes4hFromDb1m(options?: {
  force?: boolean
  lookbackMinutes?: number
  minRefreshIntervalMs?: number
}): Promise<RefreshResult> {
  return refreshMes('4h', options)
}

export async function refreshMes1dFromDb1m(options?: {
  force?: boolean
  lookbackMinutes?: number
  minRefreshIntervalMs?: number
}): Promise<RefreshResult> {
  return refreshMes('1d', options)
}
