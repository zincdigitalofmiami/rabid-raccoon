import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { fetchOhlcv, toCandles } from '../src/lib/databento'
import {
  aggregateCandles,
  asUtcDateFromUnixSeconds,
  loadDotEnvFiles,
  parseArg,
} from './ingest-utils'

const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const SOURCE_SCHEMA = 'ohlcv-1m'
const INSERT_BATCH_SIZE = 1000
const ENTRY_TIMEFRAME_MINUTES = 15
// Match the chart backfill window so stale partial bars are repaired quickly.
const RECENT_REFRESH_CANDLES = 96

interface LiveIngestSummary {
  rowsInserted: number
  rowsRefreshed: number
  rowsProcessed: number
  lookbackMinutes: number
  pollSeconds: number
  timeframe: '15m'
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function hashPriceRow(eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`MES-15M|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

function parseBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function dedupeAndSort(candles: ReturnType<typeof toCandles>): ReturnType<typeof toCandles> {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

async function upsertMes15m(
  candles: ReturnType<typeof aggregateCandles>
): Promise<{ processed: number; inserted: number; rowsRefreshed: number }> {
  const rows: Prisma.MktFuturesMes15mCreateManyInput[] = candles
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .map((candle) => {
      const eventTime = asUtcDateFromUnixSeconds(candle.time)
      return {
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
    })

  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE)
    const result = await prisma.mktFuturesMes15m.createMany({
      data: batch,
      skipDuplicates: true,
    })
    inserted += result.count
  }

  // Refresh recent candles so the active bar (same eventTime) does not go stale.
  // We intentionally avoid refreshing the full lookback window every cycle.
  const refreshTail = rows.slice(-Math.min(RECENT_REFRESH_CANDLES, rows.length))
  for (const row of refreshTail) {
    await prisma.mktFuturesMes15m.upsert({
      where: { eventTime: row.eventTime },
      create: row,
      update: {
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume ?? null,
        source: row.source,
        sourceDataset: row.sourceDataset ?? null,
        sourceSchema: row.sourceSchema ?? null,
        rowHash: row.rowHash ?? null,
        metadata: row.metadata ?? undefined,
        ingestedAt: new Date(),
        knowledgeTime: new Date(),
      },
    })
  }

  return { processed: rows.length, inserted, rowsRefreshed: refreshTail.length }
}

async function ingestOnce(lookbackMinutes: number): Promise<LiveIngestSummary> {
  const end = new Date()
  const start = new Date(end.getTime() - lookbackMinutes * 60 * 1000)

  const records = await fetchOhlcv({
    dataset: MES_DATASET,
    symbol: MES_SYMBOL,
    stypeIn: 'continuous',
    start: start.toISOString(),
    end: end.toISOString(),
    schema: SOURCE_SCHEMA,
  })

  const candles1m = dedupeAndSort(toCandles(records))
  const candles15m = aggregateCandles(candles1m, ENTRY_TIMEFRAME_MINUTES)
  const upserted = await upsertMes15m(candles15m)

  return {
    rowsInserted: upserted.inserted,
    rowsRefreshed: upserted.rowsRefreshed,
    rowsProcessed: upserted.processed,
    lookbackMinutes,
    pollSeconds: 0,
    timeframe: '15m',
  }
}

export async function runMesLiveIngestion15m(): Promise<void> {
  loadDotEnvFiles()

  if (!process.env.LOCAL_DATABASE_URL && !process.env.DIRECT_URL) {
    throw new Error('LOCAL_DATABASE_URL is required (or set PRISMA_DIRECT=1 with DIRECT_URL for explicit direct runs)')
  }
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required')

  const once = parseBoolean(parseArg('once', 'false'))
  const lookbackMinutes = Number(parseArg('lookback-minutes', '720'))
  const pollSeconds = Number(parseArg('poll-seconds', '45'))

  if (!Number.isFinite(lookbackMinutes) || lookbackMinutes <= 0) {
    throw new Error(`Invalid --lookback-minutes '${lookbackMinutes}'`)
  }
  if (!Number.isFinite(pollSeconds) || pollSeconds <= 0) {
    throw new Error(`Invalid --poll-seconds '${pollSeconds}'`)
  }

  if (once) {
    const result = await ingestOnce(lookbackMinutes)
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'mes-live-15m',
      status: 'RUNNING',
      details: toJson({ lookbackMinutes, pollSeconds, mode: 'stream', timeframe: '15m' }),
    },
  })

  let totalInserted = 0
  let totalRefreshed = 0
  let totalProcessed = 0

  const onExit = async () => {
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'COMPLETED',
        finishedAt: new Date(),
        rowsProcessed: totalProcessed,
        rowsInserted: totalInserted,
        details: toJson({
          lookbackMinutes,
          pollSeconds,
          mode: 'stream',
          timeframe: '15m',
          rowsRefreshed: totalRefreshed,
          stoppedBy: 'signal',
        }),
      },
    })
    await prisma.$disconnect()
    process.exit(0)
  }

  process.on('SIGINT', onExit)
  process.on('SIGTERM', onExit)

  while (true) {
    try {
      const result = await ingestOnce(lookbackMinutes)
      totalInserted += result.rowsInserted
      totalRefreshed += result.rowsRefreshed
      totalProcessed += result.rowsProcessed
      console.log(
        `[mes-live-15m] processed=${result.rowsProcessed} inserted=${result.rowsInserted} refreshed=${result.rowsRefreshed} totalInserted=${totalInserted}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[mes-live-15m] cycle failed: ${message}`)
    }

    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMesLiveIngestion15m()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[mes-live-15m] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
