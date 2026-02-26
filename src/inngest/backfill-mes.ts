/**
 * backfill-mes-all-timeframes — Inngest function
 *
 * Pulls ohlcv-1m from Databento for MES.c.0 (continuous front-month),
 * resamples into 15m / 1h / 1d candles, and batch-inserts into:
 *   - mkt_futures_mes_15m
 *   - mkt_futures_mes_1h
 *   - mkt_futures_mes_1d
 *
 * Designed to fill the ~5-year gap from 2019-01-01 → today.
 * Each 7-day chunk is an Inngest step so the job is resumable.
 *
 * Trigger via Inngest dev UI or:
 *   curl -X POST http://localhost:3000/api/inngest \
 *     -H 'Content-Type: application/json' \
 *     -d '{"name":"backfill/mes.all-timeframes","data":{}}'
 */

import { inngest } from './client'
import { prisma } from '../lib/prisma'
import { fetchOhlcv, toCandles } from '../lib/databento'
import { aggregateCandles, splitIntoDayChunks, asUtcDateFromUnixSeconds } from '../../scripts/ingest-utils'
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'

const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const SOURCE_SCHEMA = 'ohlcv-1m'
const CHUNK_DAYS = 7
const INSERT_BATCH = 100 // Prisma Accelerate safe batch size

// ─── Backfill date range (inclusive start, exclusive end) ────────────
// MES micro launched May 2019, but our gap starts June 2021.
// Pull everything from 2019-01-01 to capture full history.
const BACKFILL_START = '2019-01-01T00:00:00Z'

function hashRow(prefix: string, eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`${prefix}|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

function dedupeAndSort(candles: ReturnType<typeof toCandles>): ReturnType<typeof toCandles> {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

type CandleRow = ReturnType<typeof toCandles>[number]

// ─── Batch inserters (chunked to 100 rows for Prisma Accelerate) ─────

async function insert15m(candles: CandleRow[]): Promise<number> {
  let inserted = 0
  const rows: Prisma.MktFuturesMes15mCreateManyInput[] = candles
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .map((c) => {
      const eventTime = asUtcDateFromUnixSeconds(c.time)
      return {
        eventTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: BigInt(Math.max(0, Math.trunc(c.volume || 0))),
        source: 'DATABENTO' as const,
        sourceDataset: MES_DATASET,
        sourceSchema: `${SOURCE_SCHEMA}->15m`,
        rowHash: hashRow('MES-15M', eventTime, c.close),
      }
    })
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH)
    const result = await prisma.mktFuturesMes15m.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

async function insert1h(candles: CandleRow[]): Promise<number> {
  let inserted = 0
  const rows: Prisma.MktFuturesMes1hCreateManyInput[] = candles
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .map((c) => {
      const eventTime = asUtcDateFromUnixSeconds(c.time)
      return {
        eventTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: BigInt(Math.max(0, Math.trunc(c.volume || 0))),
        source: 'DATABENTO' as const,
        sourceDataset: MES_DATASET,
        sourceSchema: `${SOURCE_SCHEMA}->1h`,
        rowHash: hashRow('MES-1H', eventTime, c.close),
      }
    })
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH)
    const result = await prisma.mktFuturesMes1h.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

async function insert1d(candles: CandleRow[]): Promise<number> {
  let inserted = 0
  const rows: Prisma.MktFuturesMes1dCreateManyInput[] = candles
    .filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)
    .map((c) => {
      // For daily, use the date portion only
      const eventDate = asUtcDateFromUnixSeconds(c.time)
      return {
        eventDate,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: BigInt(Math.max(0, Math.trunc(c.volume || 0))),
        source: 'DATABENTO' as const,
        sourceDataset: MES_DATASET,
        sourceSchema: `${SOURCE_SCHEMA}->1d`,
        rowHash: hashRow('MES-1D', eventDate, c.close),
      }
    })
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const batch = rows.slice(i, i + INSERT_BATCH)
    const result = await prisma.mktFuturesMes1d.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

// ─── Main Inngest Function ───────────────────────────────────────────

export const backfillMesAllTimeframes = inngest.createFunction(
  {
    id: 'backfill-mes-all-timeframes',
    retries: 2,
    concurrency: [{ limit: 1 }], // only one backfill at a time
  },
  { event: 'backfill/mes.all-timeframes' },
  async ({ step, event }) => {
    // Allow override of date range via event data
    const startStr = (event.data?.start as string) || BACKFILL_START
    const endStr = (event.data?.end as string) || new Date(Date.now() - 30 * 60 * 1000).toISOString()

    const startDate = new Date(startStr)
    const endDate = new Date(endStr)

    const chunks = splitIntoDayChunks(startDate, endDate, CHUNK_DAYS)
    console.log(`[backfill-mes] ${chunks.length} chunks of ${CHUNK_DAYS} days from ${startStr} to ${endStr}`)

    const totals = { m15: 0, h1: 0, d1: 0, chunks: 0, errors: 0 }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]
      const label = `chunk-${i}-${chunk.start.toISOString().slice(0, 10)}`

      const result = await step.run(label, async () => {
        const chunkStart = chunk.start.toISOString()
        const chunkEnd = chunk.end.toISOString()
        console.log(`[backfill-mes] ${label}: ${chunkStart} → ${chunkEnd}`)

        try {
          // Fetch 1m bars from Databento
          const records = await fetchOhlcv({
            dataset: MES_DATASET,
            symbol: MES_SYMBOL,
            stypeIn: 'continuous',
            start: chunkStart,
            end: chunkEnd,
            schema: SOURCE_SCHEMA,
            timeoutMs: 120_000, // 2 min for large chunks
            maxAttempts: 3,
          })

          if (records.length === 0) {
            console.log(`[backfill-mes] ${label}: no records`)
            return { m15: 0, h1: 0, d1: 0, raw1m: 0 }
          }

          const candles1m = dedupeAndSort(toCandles(records))
          console.log(`[backfill-mes] ${label}: ${candles1m.length} 1m candles`)

          // Resample to all three timeframes
          const candles15m = aggregateCandles(candles1m, 15)
          const candles1h = aggregateCandles(candles1m, 60)
          const candles1d = aggregateCandles(candles1m, 1440)

          // Insert all three tables
          const [ins15m, ins1h, ins1d] = await Promise.all([
            insert15m(candles15m),
            insert1h(candles1h),
            insert1d(candles1d),
          ])

          console.log(`[backfill-mes] ${label}: inserted 15m=${ins15m} 1h=${ins1h} 1d=${ins1d}`)
          return { m15: ins15m, h1: ins1h, d1: ins1d, raw1m: candles1m.length }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[backfill-mes] ${label} FAILED: ${msg}`)
          // Return zeros so the job continues — don't blow up the whole backfill
          return { m15: 0, h1: 0, d1: 0, raw1m: 0, error: msg }
        }
      })

      totals.m15 += result.m15
      totals.h1 += result.h1
      totals.d1 += result.d1
      totals.chunks += 1
      if ('error' in result) totals.errors += 1
    }

    // Log final ingestion run
    await step.run('log-ingestion-run', async () => {
      const allChunksFailed = totals.errors > 0 && totals.errors === chunks.length
      await prisma.ingestionRun.create({
        data: {
          job: 'backfill-mes-all-timeframes',
          status: allChunksFailed ? 'FAILED' : 'COMPLETED',
          finishedAt: new Date(),
          rowsProcessed: totals.m15 + totals.h1 + totals.d1,
          rowsInserted: totals.m15 + totals.h1 + totals.d1,
          details: {
            start: startStr,
            end: endStr,
            chunkDays: CHUNK_DAYS,
            totalChunks: chunks.length,
            completedChunks: totals.chunks,
            errorChunks: totals.errors,
            inserted15m: totals.m15,
            inserted1h: totals.h1,
            inserted1d: totals.d1,
            ...(totals.errors > 0 && totals.errors < chunks.length ? { partialFailure: true } : {}),
          },
        },
      })
    })

    return totals
  }
)
