/**
 * Backfill MES 15m candles from Databento.
 *
 * Fetches ohlcv-1m data in monthly chunks, aggregates to 15m,
 * and inserts into mkt_futures_mes_15m with small batches + delay
 * to avoid Prisma Accelerate EPIPE errors.
 *
 * Usage:
 *   npx tsx scripts/backfill-mes-15m.ts --start=2024-01-01 --end=2026-02-10
 */

import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { fetchOhlcv, toCandles } from '../src/lib/databento'
import {
  aggregateCandles,
  asUtcDateFromUnixSeconds,
  loadDotEnvFiles,
  parseArg,
  splitIntoDayChunks,
} from './ingest-utils'

const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const SOURCE_SCHEMA = 'ohlcv-1m'

// Small batches + delay for Prisma Accelerate
const INSERT_BATCH_SIZE = 150
const BATCH_DELAY_MS = 400
const CHUNK_DAYS = 30

function hashPriceRow(eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`MES-15M|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function dedupeAndSort(candles: ReturnType<typeof toCandles>): ReturnType<typeof toCandles> {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

async function insertBatch(
  candles: ReturnType<typeof aggregateCandles>
): Promise<{ processed: number; inserted: number }> {
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

    if (i + INSERT_BATCH_SIZE < rows.length) {
      await sleep(BATCH_DELAY_MS)
    }
  }

  return { processed: rows.length, inserted }
}

async function main() {
  loadDotEnvFiles()

  if (!process.env.LOCAL_DATABASE_URL && !process.env.DIRECT_URL) {
    throw new Error('LOCAL_DATABASE_URL is required (or set PRISMA_DIRECT=1 with DIRECT_URL for explicit direct runs)')
  }
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required')

  const startStr = parseArg('start', '2024-01-01')
  const endStr = parseArg('end', '2026-02-10')
  const startDate = new Date(`${startStr}T00:00:00Z`)
  const endDate = new Date(`${endStr}T00:00:00Z`)

  console.log(`[backfill-mes-15m] range: ${startStr} → ${endStr}`)

  const chunks = splitIntoDayChunks(startDate, endDate, CHUNK_DAYS)
  console.log(`[backfill-mes-15m] ${chunks.length} chunks of ${CHUNK_DAYS} days each`)

  let totalInserted = 0
  let totalProcessed = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    const label = `chunk ${i + 1}/${chunks.length}`
    const chunkStart = chunk.start.toISOString()
    const chunkEnd = chunk.end.toISOString()

    console.log(`[${label}] fetching ${chunkStart.slice(0, 10)} → ${chunkEnd.slice(0, 10)} ...`)

    try {
      const records = await fetchOhlcv({
        dataset: MES_DATASET,
        symbol: MES_SYMBOL,
        stypeIn: 'continuous',
        start: chunkStart,
        end: chunkEnd,
        schema: SOURCE_SCHEMA,
        timeoutMs: 120_000,
      })

      if (records.length === 0) {
        console.log(`[${label}] no records, skipping`)
        continue
      }

      const candles1m = dedupeAndSort(toCandles(records))
      const candles15m = aggregateCandles(candles1m, 15)

      console.log(`[${label}] ${records.length} raw → ${candles1m.length} 1m → ${candles15m.length} 15m candles`)

      const result = await insertBatch(candles15m)
      totalProcessed += result.processed
      totalInserted += result.inserted

      console.log(`[${label}] inserted=${result.inserted} (skipped=${result.processed - result.inserted} dupes)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[${label}] FAILED: ${message}`)
      // Continue to next chunk instead of aborting
    }

    // Pause between Databento requests
    if (i < chunks.length - 1) {
      await sleep(2000)
    }
  }

  console.log(`\n[backfill-mes-15m] DONE — processed=${totalProcessed} inserted=${totalInserted}`)
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[backfill-mes-15m] fatal: ${message}`)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
