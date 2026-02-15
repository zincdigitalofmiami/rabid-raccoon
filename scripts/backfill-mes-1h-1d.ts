/**
 * backfill-mes-1h-1d.ts
 * 
 * Pulls MES.c.0 ohlcv-1h and ohlcv-1d from Databento for the full date range,
 * chunks by month, and batch-inserts into mkt_futures_mes_1h and mkt_futures_mes_1d.
 * Uses skipDuplicates so it's fully idempotent — run it as many times as you want.
 */
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

const DATABENTO_BASE = 'https://hist.databento.com/v0'
const FIXED_PRICE_SCALE = 1_000_000_000
const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const BATCH_SIZE = 100  // Prisma Accelerate safe
const REQUEST_TIMEOUT_MS = 120_000

interface RawRecord {
  hd: { ts_event: string; publisher_id: number; instrument_id: number }
  open: number; high: number; low: number; close: number; volume: number
}

// ── Databento fetch (raw HTTP, no SDK needed) ─────────────────────────────────

async function fetchDatabento(schema: string, start: string, end: string): Promise<RawRecord[]> {
  const apiKey = process.env.DATABENTO_API_KEY
  if (!apiKey) throw new Error('DATABENTO_API_KEY not set')
  const basicAuth = Buffer.from(`${apiKey}:`).toString('base64')

  let queryEnd = end
  for (let attempt = 0; attempt < 4; attempt++) {
    const body = new URLSearchParams({
      dataset: MES_DATASET,
      symbols: MES_SYMBOL,
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
      if (err instanceof Error && err.message.includes('aborted')) { continue }
      throw err
    }
    clearTimeout(timeout)

    if (response.ok) {
      const text = await response.text()
      if (!text.trim()) return []
      return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as RawRecord)
    }

    if (response.status !== 422) {
      const errText = await response.text().catch(() => '')
      throw new Error(`Databento ${response.status}: ${errText.slice(0, 300)}`)
    }

    // 422 — try to recover with tighter end
    const errText = await response.text().catch(() => '{}')
    try {
      const detail = JSON.parse(errText)
      const availEnd = detail?.detail?.payload?.available_end
      if (availEnd && availEnd !== queryEnd) { queryEnd = availEnd; continue }
    } catch { /* fall through */ }
    break
  }
  return []
}

// ── Month chunker ─────────────────────────────────────────────────────────────

function monthChunks(startIso: string, endIso: string): Array<{ start: string; end: string }> {
  const chunks: Array<{ start: string; end: string }> = []
  let cursor = new Date(startIso)
  const endDate = new Date(endIso)
  while (cursor < endDate) {
    const next = new Date(cursor)
    next.setUTCMonth(next.getUTCMonth() + 1)
    chunks.push({
      start: cursor.toISOString(),
      end: (next < endDate ? next : endDate).toISOString(),
    })
    cursor = next
  }
  return chunks
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

function hash1h(eventTime: Date, close: number): string {
  return createHash('sha256').update(`MES-1H|${eventTime.toISOString()}|${close}`).digest('hex')
}
function hash1d(eventDate: string, close: number): string {
  return createHash('sha256').update(`MES-1D|${eventDate}|${close}`).digest('hex')
}

// ── Insert 1h rows ────────────────────────────────────────────────────────────

async function insert1h(records: RawRecord[]): Promise<number> {
  const rows: Prisma.MktFuturesMes1hCreateManyInput[] = records
    .filter(r => Number(r.open) > 0 && Number(r.close) > 0)
    .map(r => {
      const tsNano = BigInt(r.hd.ts_event)
      const eventTime = new Date(Number(tsNano / 1_000_000n))
      const open = Number(r.open) / FIXED_PRICE_SCALE
      const high = Number(r.high) / FIXED_PRICE_SCALE
      const low = Number(r.low) / FIXED_PRICE_SCALE
      const close = Number(r.close) / FIXED_PRICE_SCALE
      return {
        eventTime,
        open, high, low, close,
        volume: BigInt(Math.max(0, Math.trunc(Number(r.volume)))),
        source: 'DATABENTO' as const,
        sourceDataset: MES_DATASET,
        sourceSchema: 'ohlcv-1h',
        rowHash: hash1h(eventTime, close),
      }
    })

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const result = await prisma.mktFuturesMes1h.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

// ── Insert 1d rows ────────────────────────────────────────────────────────────

async function insert1d(records: RawRecord[]): Promise<number> {
  const rows: Prisma.MktFuturesMes1dCreateManyInput[] = records
    .filter(r => Number(r.open) > 0 && Number(r.close) > 0)
    .map(r => {
      const tsNano = BigInt(r.hd.ts_event)
      const eventTime = new Date(Number(tsNano / 1_000_000n))
      const dateStr = eventTime.toISOString().slice(0, 10)
      const open = Number(r.open) / FIXED_PRICE_SCALE
      const high = Number(r.high) / FIXED_PRICE_SCALE
      const low = Number(r.low) / FIXED_PRICE_SCALE
      const close = Number(r.close) / FIXED_PRICE_SCALE
      return {
        eventDate: new Date(dateStr),
        open, high, low, close,
        volume: BigInt(Math.max(0, Math.trunc(Number(r.volume)))),
        source: 'DATABENTO' as const,
        sourceDataset: MES_DATASET,
        sourceSchema: 'ohlcv-1d',
        rowHash: hash1d(dateStr, close),
      }
    })

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const result = await prisma.mktFuturesMes1d.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required')
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY required')

  const START = '2019-12-01T00:00:00Z'  // a bit before 2020-01 for safety
  const END = new Date().toISOString()
  const chunks = monthChunks(START, END)

  console.log(`[backfill] ${chunks.length} month chunks from ${START} to ${END}`)

  let total1h = 0
  let total1d = 0

  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i]
    const label = start.slice(0, 7)
    
    // ── 1h ──
    try {
      const records1h = await fetchDatabento('ohlcv-1h', start, end)
      const ins1h = await insert1h(records1h)
      total1h += ins1h
      console.log(`[1h] ${label}  fetched=${records1h.length}  inserted=${ins1h}  total=${total1h}`)
    } catch (err) {
      console.error(`[1h] ${label} FAILED: ${err instanceof Error ? err.message : err}`)
    }

    // ── 1d ──
    try {
      const records1d = await fetchDatabento('ohlcv-1d', start, end)
      const ins1d = await insert1d(records1d)
      total1d += ins1d
      console.log(`[1d] ${label}  fetched=${records1d.length}  inserted=${ins1d}  total=${total1d}`)
    } catch (err) {
      console.error(`[1d] ${label} FAILED: ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`\n[DONE] 1h inserted: ${total1h}  |  1d inserted: ${total1d}`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error('[FATAL]', err)
  process.exit(1)
})
