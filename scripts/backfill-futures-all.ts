/**
 * backfill-futures-all.ts
 *
 * Databento backfill for non-MES active symbols (20 total on GLBX.MDP3).
 * Pulls ohlcv-1d and ohlcv-1h, inserts into mkt_futures_1d and mkt_futures_1h.
 * Chunks by 3-month windows to avoid Databento timeout. Fully idempotent (skipDuplicates).
 *
 * Usage:
 *   npx tsx scripts/backfill-futures-all.ts                           # all active non-MES
 *   npx tsx scripts/backfill-futures-all.ts --symbols=ZN,CL,GC       # specific symbols
 *   npx tsx scripts/backfill-futures-all.ts --schema=ohlcv-1d         # daily only
 *   npx tsx scripts/backfill-futures-all.ts --start=2023-01-01        # custom start
 */
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

const DATABENTO_BASE = 'https://hist.databento.com/v0'
const FIXED_PRICE_SCALE = 1_000_000_000
const GLBX = 'GLBX.MDP3'
const BATCH_SIZE = 100
const REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_START = '2020-01-01'

const NON_MES_ACTIVE = [
  'ES', 'NQ', 'YM', 'RTY', 'SOX',       // equity indices
  'ZN', 'ZB', 'ZF', 'ZT',                // treasuries
  'CL', 'GC', 'SI', 'NG',                // commodities
  '6E', '6J', 'SR3', 'SR1', 'ZQ',        // fx & rates
  'MNQ', 'MYM',                           // micro indices
]

interface RawRecord {
  hd: { ts_event: string; publisher_id: number; instrument_id: number }
  open: number; high: number; low: number; close: number; volume: number
}

function parseArgs() {
  const args = process.argv.slice(2)
  const symbolsArg = args.find(a => a.startsWith('--symbols='))?.split('=')[1]
  const schemaArg = args.find(a => a.startsWith('--schema='))?.split('=')[1]
  const startArg = args.find(a => a.startsWith('--start='))?.split('=')[1]
  return {
    symbols: symbolsArg ? symbolsArg.split(',').map(s => s.trim().toUpperCase()) : NON_MES_ACTIVE,
    schemas: schemaArg ? [schemaArg] : ['ohlcv-1d', 'ohlcv-1h'],
    start: startArg || DEFAULT_START,
  }
}

async function fetchDatabento(symbol: string, schema: string, start: string, end: string): Promise<RawRecord[]> {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY not set')
  const basicAuth = Buffer.from(`${apiKey}:`).toString('base64')

  let queryEnd = end
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = new URLSearchParams({
      dataset: GLBX,
      symbols: `${symbol}.c.0`,
      schema,
      stype_in: 'continuous',
      start,
      end: queryEnd,
      encoding: 'json',
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(`${DATABENTO_BASE}/timeseries.get_range`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basicAuth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      if (err instanceof Error && err.message.includes('aborted') && attempt < 3) continue
      throw err
    }
    clearTimeout(timeout)

    if (response.ok) {
      const text = await response.text()
      if (!text.trim()) return []
      return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RawRecord)
    }

    if (response.status === 422) {
      const errText = await response.text().catch(() => '{}')
      try {
        const detail = JSON.parse(errText)
        const availEnd = detail?.detail?.payload?.available_end
        if (availEnd && availEnd !== queryEnd) { queryEnd = availEnd; continue }
      } catch { /* fall through */ }
    }

    const errText = await response.text().catch(() => '')
    throw new Error(`Databento ${response.status}: ${errText.slice(0, 300)}`)
  }
  return []
}

function tsEventToDate(tsEvent: string): Date {
  const ns = BigInt(tsEvent)
  return new Date(Number(ns / 1_000_000n))
}

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

function hashRow(sym: string, ts: Date, close: number): string {
  return createHash('sha256').update(`${sym}|${ts.toISOString()}|${close}`).digest('hex')
}

function toPrice(raw: number): number {
  return raw / FIXED_PRICE_SCALE
}

function generateMonthChunks(start: string, end: string, monthsPerChunk: number): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = []
  let current = new Date(`${start}T00:00:00Z`)
  const endDate = new Date(`${end}T00:00:00Z`)
  while (current < endDate) {
    const chunkEnd = new Date(current)
    chunkEnd.setUTCMonth(chunkEnd.getUTCMonth() + monthsPerChunk)
    if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime())
    chunks.push({
      start: current.toISOString().slice(0, 10),
      end: chunkEnd.toISOString().slice(0, 10),
    })
    current = chunkEnd
  }
  return chunks
}

async function backfillSymbolDaily(symbol: string, records: RawRecord[]): Promise<number> {
  if (records.length === 0) return 0
  let inserted = 0
  const rows: Prisma.MktFutures1dCreateManyInput[] = records.map(r => {
    const eventTime = tsEventToDate(r.hd.ts_event)
    const eventDate = startOfUtcDay(eventTime)
    return {
      symbolCode: symbol,
      eventDate,
      open: toPrice(r.open),
      high: toPrice(r.high),
      low: toPrice(r.low),
      close: toPrice(r.close),
      volume: BigInt(Math.max(0, Math.trunc(r.volume || 0))),
      source: 'DATABENTO',
      sourceDataset: GLBX,
      sourceSchema: 'ohlcv-1d',
      rowHash: hashRow(symbol, eventDate, toPrice(r.close)),
    }
  })
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const result = await prisma.mktFutures1d.createMany({ data: rows.slice(i, i + BATCH_SIZE), skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

async function backfillSymbolHourly(symbol: string, records: RawRecord[]): Promise<number> {
  if (records.length === 0) return 0
  let inserted = 0
  const rows: Prisma.MktFutures1hCreateManyInput[] = records.map(r => {
    const eventTime = tsEventToDate(r.hd.ts_event)
    return {
      symbolCode: symbol,
      eventTime,
      open: toPrice(r.open),
      high: toPrice(r.high),
      low: toPrice(r.low),
      close: toPrice(r.close),
      volume: BigInt(Math.max(0, Math.trunc(r.volume || 0))),
      source: 'DATABENTO',
      sourceDataset: GLBX,
      sourceSchema: 'ohlcv-1h',
      rowHash: hashRow(symbol, eventTime, toPrice(r.close)),
    }
  })
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const result = await prisma.mktFutures1h.createMany({ data: rows.slice(i, i + BATCH_SIZE), skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

async function main() {
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY required')
  if (!process.env.LOCAL_DATABASE_URL && !process.env.DATABASE_URL && !process.env.DIRECT_URL) {
    throw new Error('LOCAL_DATABASE_URL, DATABASE_URL, or DIRECT_URL is required')
  }

  const { symbols, schemas, start } = parseArgs()
  const endDate = new Date().toISOString().slice(0, 10)

  console.log(`[backfill] symbols: ${symbols.join(', ')}`)
  console.log(`[backfill] schemas: ${schemas.join(', ')}`)
  console.log(`[backfill] range: ${start} → ${endDate}`)

  const chunks = generateMonthChunks(start, endDate, 3)
  console.log(`[backfill] ${chunks.length} chunks (3-month windows)\n`)

  for (const symbol of symbols) {
    for (const schema of schemas) {
      let totalRecords = 0
      let totalInserted = 0

      for (const chunk of chunks) {
        try {
          const records = await fetchDatabento(symbol, schema, chunk.start, chunk.end)
          totalRecords += records.length

          if (records.length > 0) {
            const inserted = schema === 'ohlcv-1d'
              ? await backfillSymbolDaily(symbol, records)
              : await backfillSymbolHourly(symbol, records)
            totalInserted += inserted
          }

          process.stdout.write(`.`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          console.error(`\n[backfill] ${symbol} ${schema} chunk ${chunk.start}→${chunk.end} FAILED: ${msg.slice(0, 200)}`)
        }
      }

      console.log(`\n[backfill] ${symbol} ${schema}: ${totalRecords} records, ${totalInserted} new rows`)
    }
  }

  console.log('\n[backfill] done.')
}

main()
  .catch(err => { console.error(err); process.exit(1) })
  .finally(() => prisma.$disconnect())
