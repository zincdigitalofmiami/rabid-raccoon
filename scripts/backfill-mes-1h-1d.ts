/**
 * backfill-mes-1h-1d.ts
 *
 * Pulls MES.c.0 ohlcv-1h and ohlcv-1d from Databento for the full date range,
 * chunks by month, and batch-inserts into mkt_futures_mes_1h and mkt_futures_mes_1d.
 * Then derives and upserts mkt_futures_mes_4h and mkt_futures_mes_1w.
 * Uses skipDuplicates so it's fully idempotent — run it as many times as you want.
 *
 * Flags:
 *   --start=ISO                 Override start boundary (default: 2019-12-01T00:00:00Z)
 *   --end=ISO                   Override end boundary (default: now UTC)
 *   --strict                    Exit non-zero if any month/schema fetch failed
 *   --manifest-out=PATH         Write manifest JSON to custom path
 *   --retry-manifest=PATH       Retry only failed month chunks from prior manifest
 */
import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { logResolvedDbTarget, resolvePrismaRuntimeUrl } from '../src/lib/db-url'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles } from './ingest-utils'

loadDotEnvFiles()

const DATABENTO_BASE = 'https://hist.databento.com/v0'
const FIXED_PRICE_SCALE = 1_000_000_000
const MES_DATASET = 'GLBX.MDP3'
const MES_SYMBOL = 'MES.c.0'
const BATCH_SIZE = 100  // Prisma Accelerate safe
const REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_START = '2019-12-01T00:00:00Z'
const SCRIPT_NAME = 'scripts/backfill-mes-1h-1d.ts'
const SCHEMA_KEYS = ['ohlcv-1h', 'ohlcv-1d'] as const

interface RawRecord {
  hd: { ts_event: string; publisher_id: number; instrument_id: number }
  open: number; high: number; low: number; close: number; volume: number
}

type ChunkRange = { start: string; end: string }
type SchemaKey = (typeof SCHEMA_KEYS)[number]
type SchemaChunkStatus = 'ok' | 'failed'
type ChunkStatus = 'ok' | 'partial' | 'failed'

interface SchemaChunkResult {
  status: SchemaChunkStatus
  fetched: number
  inserted: number
  error: string | null
}

interface ChunkResult {
  month: string
  start: string
  end: string
  status: ChunkStatus
  schemas: Record<SchemaKey, SchemaChunkResult>
}

interface BackfillManifest {
  generatedAt: string
  script: string
  options: {
    start: string
    end: string
    strict: boolean
    retryManifest: string | null
    manifestOut: string
  }
  summary: {
    totalChunks: number
    okChunks: number
    partialChunks: number
    failedChunks: number
    failedSchemas: Record<SchemaKey, number>
    inserted: {
      mes1h: number
      mes1d: number
      mes4h: number
      mes1w: number
    }
  }
  failedMonths: string[]
  retryCommand: string | null
  chunks: ChunkResult[]
}

interface CliOptions {
  start: string
  end: string
  strict: boolean
  retryManifest: string | null
  manifestOut: string
}

function getArgValue(name: string): string | null {
  const prefix = `--${name}=`
  const arg = process.argv.find((entry) => entry.startsWith(prefix))
  return arg ? arg.slice(prefix.length).trim() : null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function asIsoOrThrow(value: string, label: string): string {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid --${label} value "${value}" (must be ISO timestamp or parseable date)`)
  }
  return parsed.toISOString()
}

function makeManifestPath(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return resolve(`reports/backfill/mes-1h-1d-manifest-${stamp}.json`)
}

function parseCliOptions(): CliOptions {
  const retryManifest = getArgValue('retry-manifest')
  if (retryManifest && (getArgValue('start') || getArgValue('end'))) {
    throw new Error('Do not combine --retry-manifest with --start/--end. Choose one mode.')
  }

  const strictValue = getArgValue('strict')
  const strict = hasFlag('strict') || strictValue === '1' || strictValue === 'true'
  const start = asIsoOrThrow(getArgValue('start') || DEFAULT_START, 'start')
  const end = asIsoOrThrow(getArgValue('end') || new Date().toISOString(), 'end')
  if (new Date(start) >= new Date(end)) {
    throw new Error(`Invalid range: --start ${start} must be before --end ${end}`)
  }

  const manifestOut = resolve(getArgValue('manifest-out') || makeManifestPath())
  return {
    start,
    end,
    strict,
    retryManifest: retryManifest ? resolve(retryManifest) : null,
    manifestOut,
  }
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

function normalizeChunkRange(start: unknown, end: unknown): ChunkRange {
  if (typeof start !== 'string' || typeof end !== 'string') {
    throw new Error('Manifest chunk is missing start/end ISO strings')
  }
  return {
    start: asIsoOrThrow(start, 'retry-manifest.start'),
    end: asIsoOrThrow(end, 'retry-manifest.end'),
  }
}

function chunksFromRetryManifest(filePath: string): ChunkRange[] {
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { chunks?: unknown[] }
  if (!Array.isArray(raw?.chunks)) {
    throw new Error(`Retry manifest at ${filePath} has no "chunks" array`)
  }

  const failed = raw.chunks
    .map((entry) => entry as { status?: string; start?: unknown; end?: unknown })
    .filter((entry) => entry.status === 'failed' || entry.status === 'partial')
    .map((entry) => normalizeChunkRange(entry.start, entry.end))

  const deduped = new Map<string, ChunkRange>()
  for (const chunk of failed) {
    deduped.set(`${chunk.start}|${chunk.end}`, chunk)
  }

  const ranges = [...deduped.values()].sort((a, b) => a.start.localeCompare(b.start))
  if (ranges.length === 0) {
    throw new Error(`Retry manifest ${filePath} has no failed/partial chunks to retry`)
  }
  return ranges
}

function emptySchemaResult(): Record<SchemaKey, SchemaChunkResult> {
  return {
    'ohlcv-1h': { status: 'ok', fetched: 0, inserted: 0, error: null },
    'ohlcv-1d': { status: 'ok', fetched: 0, inserted: 0, error: null },
  }
}

function deriveChunkStatus(result: ChunkResult): ChunkStatus {
  const failures = SCHEMA_KEYS.filter((schema) => result.schemas[schema].status === 'failed').length
  if (failures === 0) return 'ok'
  if (failures === SCHEMA_KEYS.length) return 'failed'
  return 'partial'
}

function buildManifest(options: CliOptions, chunks: ChunkResult[], inserted: BackfillManifest['summary']['inserted']): BackfillManifest {
  const okChunks = chunks.filter((chunk) => chunk.status === 'ok').length
  const partialChunks = chunks.filter((chunk) => chunk.status === 'partial').length
  const failedChunks = chunks.filter((chunk) => chunk.status === 'failed').length
  const failedSchemas: Record<SchemaKey, number> = {
    'ohlcv-1h': chunks.filter((chunk) => chunk.schemas['ohlcv-1h'].status === 'failed').length,
    'ohlcv-1d': chunks.filter((chunk) => chunk.schemas['ohlcv-1d'].status === 'failed').length,
  }
  const failedMonths = chunks.filter((chunk) => chunk.status !== 'ok').map((chunk) => chunk.month)

  const retryCommand = failedMonths.length > 0
    ? `npx tsx ${SCRIPT_NAME} --retry-manifest=${options.manifestOut}${options.strict ? ' --strict' : ''}`
    : null

  return {
    generatedAt: new Date().toISOString(),
    script: SCRIPT_NAME,
    options: {
      start: options.start,
      end: options.end,
      strict: options.strict,
      retryManifest: options.retryManifest,
      manifestOut: options.manifestOut,
    },
    summary: {
      totalChunks: chunks.length,
      okChunks,
      partialChunks,
      failedChunks,
      failedSchemas,
      inserted,
    },
    failedMonths,
    retryCommand,
    chunks,
  }
}

function writeManifest(filePath: string, manifest: BackfillManifest): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

function hash1h(eventTime: Date, close: number): string {
  return createHash('sha256').update(`MES-1H|${eventTime.toISOString()}|${close}`).digest('hex')
}
function hash1d(eventDate: string, close: number): string {
  return createHash('sha256').update(`MES-1D|${eventDate}|${close}`).digest('hex')
}
function hash4h(eventTime: Date, close: number): string {
  return createHash('sha256').update(`MES-4H|${eventTime.toISOString()}|${close}`).digest('hex')
}
function hash1w(eventDate: string, close: number): string {
  return createHash('sha256').update(`MES-1W|${eventDate}|${close}`).digest('hex')
}

interface CandlePoint {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function rawToCandle(record: RawRecord): CandlePoint | null {
  if (!(Number(record.open) > 0 && Number(record.close) > 0)) return null
  const tsNano = BigInt(record.hd.ts_event)
  return {
    time: Number(tsNano / 1_000_000_000n),
    open: Number(record.open) / FIXED_PRICE_SCALE,
    high: Number(record.high) / FIXED_PRICE_SCALE,
    low: Number(record.low) / FIXED_PRICE_SCALE,
    close: Number(record.close) / FIXED_PRICE_SCALE,
    volume: Math.max(0, Math.trunc(Number(record.volume))),
  }
}

function aggregateToPeriod(candles: CandlePoint[], periodSeconds: number): CandlePoint[] {
  if (candles.length === 0) return []
  const sorted = [...candles].sort((a, b) => a.time - b.time)
  const out: CandlePoint[] = []
  let bucket: CandlePoint | null = null
  let bucketStart = 0

  for (const candle of sorted) {
    const aligned = Math.floor(candle.time / periodSeconds) * periodSeconds
    if (!bucket || aligned !== bucketStart) {
      if (bucket) out.push(bucket)
      bucket = { ...candle, time: aligned }
      bucketStart = aligned
      continue
    }
    bucket.high = Math.max(bucket.high, candle.high)
    bucket.low = Math.min(bucket.low, candle.low)
    bucket.close = candle.close
    bucket.volume += candle.volume
  }
  if (bucket) out.push(bucket)
  return out
}

function startOfUtcWeekFromDate(date: Date): Date {
  const day = date.getUTCDay()
  const shiftToMonday = (day + 6) % 7
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - shiftToMonday))
}

function aggregateToWeeksFromDaily(candles: CandlePoint[]): CandlePoint[] {
  if (candles.length === 0) return []
  const sorted = [...candles].sort((a, b) => a.time - b.time)
  const byWeek = new Map<number, CandlePoint>()

  for (const candle of sorted) {
    const weekStart = startOfUtcWeekFromDate(new Date(candle.time * 1000))
    const key = Math.floor(weekStart.getTime() / 1000)
    const current = byWeek.get(key)
    if (!current) {
      byWeek.set(key, { ...candle, time: key })
      continue
    }
    current.high = Math.max(current.high, candle.high)
    current.low = Math.min(current.low, candle.low)
    current.close = candle.close
    current.volume += candle.volume
  }

  return [...byWeek.values()].sort((a, b) => a.time - b.time)
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

async function insert4hFromRaw1h(records: RawRecord[]): Promise<number> {
  const candles = records.map(rawToCandle).filter((r): r is CandlePoint => r !== null)
  const aggregated = aggregateToPeriod(candles, 4 * 60 * 60)
  const rows: Prisma.MktFuturesMes4hCreateManyInput[] = aggregated.map((candle) => {
    const eventTime = new Date(candle.time * 1000)
    return {
      eventTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: BigInt(candle.volume),
      source: 'DATABENTO',
      sourceDataset: MES_DATASET,
      sourceSchema: 'derived-4h',
      rowHash: hash4h(eventTime, candle.close),
    }
  })

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const result = await prisma.mktFuturesMes4h.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

async function insert1wFromRaw1d(records: RawRecord[]): Promise<number> {
  const candles = records.map(rawToCandle).filter((r): r is CandlePoint => r !== null)
  const aggregated = aggregateToWeeksFromDaily(candles)
  const rows: Prisma.MktFuturesMes1wCreateManyInput[] = aggregated.map((candle) => {
    const weekStart = new Date(candle.time * 1000)
    const eventDateIso = weekStart.toISOString().slice(0, 10)
    return {
      eventDate: new Date(eventDateIso),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: BigInt(candle.volume),
      source: 'DATABENTO',
      sourceDataset: MES_DATASET,
      sourceSchema: 'derived-1w',
      rowHash: hash1w(eventDateIso, candle.close),
    }
  })

  let inserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const result = await prisma.mktFuturesMes1w.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return inserted
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const target = resolvePrismaRuntimeUrl()
  logResolvedDbTarget('backfill-mes-1h-1d', target)
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY required')

  const options = parseCliOptions()
  const chunks = options.retryManifest
    ? chunksFromRetryManifest(options.retryManifest)
    : monthChunks(options.start, options.end)

  console.log(
    options.retryManifest
      ? `[backfill] retry mode from manifest ${options.retryManifest} (${chunks.length} failed/partial month chunks)`
      : `[backfill] ${chunks.length} month chunks from ${options.start} to ${options.end}`
  )

  let total1h = 0
  let total1d = 0
  const all1hRecords: RawRecord[] = []
  const all1dRecords: RawRecord[] = []
  const chunkResults: ChunkResult[] = []

  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i]
    const label = start.slice(0, 7)
    const chunkResult: ChunkResult = {
      month: label,
      start,
      end,
      status: 'ok',
      schemas: emptySchemaResult(),
    }

    // ── 1h ──
    try {
      const records1h = await fetchDatabento('ohlcv-1h', start, end)
      const ins1h = await insert1h(records1h)
      all1hRecords.push(...records1h)
      total1h += ins1h
      chunkResult.schemas['ohlcv-1h'] = {
        status: 'ok',
        fetched: records1h.length,
        inserted: ins1h,
        error: null,
      }
      console.log(`[1h] ${label}  fetched=${records1h.length}  inserted=${ins1h}  total=${total1h}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      chunkResult.schemas['ohlcv-1h'] = {
        status: 'failed',
        fetched: 0,
        inserted: 0,
        error: message,
      }
      console.error(`[1h] ${label} FAILED: ${message}`)
    }

    // ── 1d ──
    try {
      const records1d = await fetchDatabento('ohlcv-1d', start, end)
      const ins1d = await insert1d(records1d)
      all1dRecords.push(...records1d)
      total1d += ins1d
      chunkResult.schemas['ohlcv-1d'] = {
        status: 'ok',
        fetched: records1d.length,
        inserted: ins1d,
        error: null,
      }
      console.log(`[1d] ${label}  fetched=${records1d.length}  inserted=${ins1d}  total=${total1d}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      chunkResult.schemas['ohlcv-1d'] = {
        status: 'failed',
        fetched: 0,
        inserted: 0,
        error: message,
      }
      console.error(`[1d] ${label} FAILED: ${message}`)
    }

    chunkResult.status = deriveChunkStatus(chunkResult)
    chunkResults.push(chunkResult)
  }

  const total4h = await insert4hFromRaw1h(all1hRecords)
  const total1w = await insert1wFromRaw1d(all1dRecords)

  const manifest = buildManifest(options, chunkResults, {
    mes1h: total1h,
    mes1d: total1d,
    mes4h: total4h,
    mes1w: total1w,
  })
  writeManifest(options.manifestOut, manifest)

  console.log(`\n[DONE] 1h inserted: ${total1h}  |  1d inserted: ${total1d}  |  4h inserted: ${total4h}  |  1w inserted: ${total1w}`)
  console.log(`[manifest] ${options.manifestOut}`)

  if (manifest.summary.failedChunks > 0 || manifest.summary.partialChunks > 0) {
    console.warn(
      `[warn] chunk failures detected: failed=${manifest.summary.failedChunks}, partial=${manifest.summary.partialChunks}, ` +
      `schema failures 1h=${manifest.summary.failedSchemas['ohlcv-1h']}, 1d=${manifest.summary.failedSchemas['ohlcv-1d']}`
    )
    if (manifest.retryCommand) {
      console.warn(`[action] retry only failed chunks:\n  ${manifest.retryCommand}`)
    }
  }

  if (options.strict && (manifest.summary.failedChunks > 0 || manifest.summary.partialChunks > 0)) {
    throw new Error(
      `Strict mode failed: ${manifest.summary.failedChunks} failed chunks and ${manifest.summary.partialChunks} partial chunks. ` +
      `See manifest at ${options.manifestOut}`
    )
  }
}

main().catch(err => {
  console.error('[FATAL]', err)
  process.exitCode = 1
}).finally(async () => {
  await prisma.$disconnect()
})
