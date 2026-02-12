import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { fetchOhlcv, toCandles } from '../src/lib/databento'
import { asUtcDateFromUnixSeconds, loadDotEnvFiles, parseArg } from './ingest-utils'

const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const SOURCE_SCHEMA = 'ohlcv-1m'
const INSERT_BATCH_SIZE = 1000

interface LiveIngestSummary {
  rowsInserted: number
  rowsProcessed: number
  lookbackMinutes: number
  pollSeconds: number
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function hashPriceRow(eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`MES|${eventTime.toISOString()}|${close}`)
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

async function upsertMes1m(candles: ReturnType<typeof toCandles>): Promise<{ processed: number; inserted: number }> {
  const rows: Prisma.MesPrice1mCreateManyInput[] = candles
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
        sourceSchema: SOURCE_SCHEMA,
        rowHash: hashPriceRow(eventTime, candle.close),
      }
    })

  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE)
    const result = await prisma.mesPrice1m.createMany({
      data: batch,
      skipDuplicates: true,
    })
    inserted += result.count
  }

  return { processed: rows.length, inserted }
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

  const candles = dedupeAndSort(toCandles(records))
  const upserted = await upsertMes1m(candles)

  return {
    rowsInserted: upserted.inserted,
    rowsProcessed: upserted.processed,
    lookbackMinutes,
    pollSeconds: 0,
  }
}

export async function runMesLiveIngestion(): Promise<void> {
  loadDotEnvFiles()

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required')

  const once = parseBoolean(parseArg('once', 'false'))
  const lookbackMinutes = Number(parseArg('lookback-minutes', '180'))
  const pollSeconds = Number(parseArg('poll-seconds', '20'))

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
      job: 'mes-live-1m',
      status: 'RUNNING',
      details: toJson({ lookbackMinutes, pollSeconds, mode: 'stream' }),
    },
  })

  let totalInserted = 0
  let totalProcessed = 0

  const onExit = async () => {
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        rowsProcessed: totalProcessed,
        rowsInserted: totalInserted,
        details: toJson({ lookbackMinutes, pollSeconds, mode: 'stream', stoppedBy: 'signal' }),
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
      totalProcessed += result.rowsProcessed
      console.log(
        `[mes-live-1m] processed=${result.rowsProcessed} inserted=${result.rowsInserted} totalInserted=${totalInserted}`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[mes-live-1m] cycle failed: ${message}`)
    }

    await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMesLiveIngestion()
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[mes-live-1m] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
