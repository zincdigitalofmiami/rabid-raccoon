import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { fetchOhlcv, toCandles } from './databento'
import type { CandleData } from './types'

const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const SOURCE_SCHEMA = 'ohlcv-1m'
const FIFTEEN_MIN_SECONDS = 15 * 60
const DEFAULT_LOOKBACK_MINUTES = 18 * 60
const DEFAULT_MIN_REFRESH_INTERVAL_MS = 30_000
const MAX_CANDLES_TO_UPSERT = 500

let lastRefreshAttemptAtMs = 0

interface RefreshResult {
  attempted: boolean
  refreshed: boolean
  rowsUpserted: number
  latestEventTime: Date | null
  reason?: string
}

function asUtcDateFromUnixSeconds(seconds: number): Date {
  return new Date(seconds * 1000)
}

function hashPriceRow(eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`MES-15M|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

function dedupeAndSort(candles: CandleData[]): CandleData[] {
  const byTime = new Map<number, CandleData>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

function aggregateTo15m(candles: CandleData[]): CandleData[] {
  if (candles.length === 0) return []

  const out: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const candle of candles) {
    const aligned = Math.floor(candle.time / FIFTEEN_MIN_SECONDS) * FIFTEEN_MIN_SECONDS
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

async function currentLatestEventTime(): Promise<Date | null> {
  const row = await prisma.mktFuturesMes15m.findFirst({
    orderBy: { eventTime: 'desc' },
    select: { eventTime: true },
  })
  return row?.eventTime ?? null
}

export async function refreshMes15mFromDatabento(options?: {
  force?: boolean
  lookbackMinutes?: number
  minRefreshIntervalMs?: number
}): Promise<RefreshResult> {
  const force = options?.force === true
  const minRefreshIntervalMs = Math.max(
    5_000,
    options?.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_INTERVAL_MS
  )

  if (!force && Date.now() - lastRefreshAttemptAtMs < minRefreshIntervalMs) {
    return {
      attempted: false,
      refreshed: false,
      rowsUpserted: 0,
      latestEventTime: await currentLatestEventTime(),
      reason: 'refresh-throttled',
    }
  }

  if (!process.env.DATABENTO_API_KEY) {
    return {
      attempted: false,
      refreshed: false,
      rowsUpserted: 0,
      latestEventTime: await currentLatestEventTime(),
      reason: 'missing-databento-api-key',
    }
  }

  lastRefreshAttemptAtMs = Date.now()

  try {
    const lookbackMinutes = Math.max(120, options?.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES)
    const end = new Date()
    const start = new Date(end.getTime() - lookbackMinutes * 60 * 1000)

    const records = await fetchOhlcv({
      dataset: MES_DATASET,
      symbol: MES_SYMBOL,
      stypeIn: 'continuous',
      start: start.toISOString(),
      end: end.toISOString(),
      schema: SOURCE_SCHEMA,
      timeoutMs: 20_000,
      maxAttempts: 2,
    })

    const candles15m = aggregateTo15m(dedupeAndSort(toCandles(records))).slice(-MAX_CANDLES_TO_UPSERT)
    if (candles15m.length === 0) {
      return {
        attempted: true,
        refreshed: false,
        rowsUpserted: 0,
        latestEventTime: await currentLatestEventTime(),
        reason: 'no-candles-returned',
      }
    }

    let rowsUpserted = 0
    for (const candle of candles15m) {
      const eventTime = asUtcDateFromUnixSeconds(candle.time)
      const payload: Prisma.MktFuturesMes15mCreateInput = {
        eventTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
        source: 'DATABENTO',
        sourceDataset: MES_DATASET,
        sourceSchema: `${SOURCE_SCHEMA}->15m`,
        rowHash: hashPriceRow(eventTime, candle.close),
      }

      await prisma.mktFuturesMes15m.upsert({
        where: { eventTime },
        create: payload,
        update: {
          open: payload.open,
          high: payload.high,
          low: payload.low,
          close: payload.close,
          volume: payload.volume,
          source: payload.source,
          sourceDataset: payload.sourceDataset,
          sourceSchema: payload.sourceSchema,
          rowHash: payload.rowHash,
          ingestedAt: new Date(),
          knowledgeTime: new Date(),
        },
      })

      rowsUpserted += 1
    }

    return {
      attempted: true,
      refreshed: true,
      rowsUpserted,
      latestEventTime: asUtcDateFromUnixSeconds(candles15m[candles15m.length - 1].time),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      attempted: true,
      refreshed: false,
      rowsUpserted: 0,
      latestEventTime: await currentLatestEventTime(),
      reason: message,
    }
  }
}
