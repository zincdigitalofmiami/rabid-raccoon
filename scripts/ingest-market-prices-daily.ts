import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { fetchOhlcv, toCandles } from '../src/lib/databento'
import { INGESTION_SYMBOLS } from '../src/lib/ingestion-symbols'
import {
  aggregateCandles,
  asUtcDateFromUnixSeconds,
  loadDotEnvFiles,
  parseArg,
} from './ingest-utils'

const DAILY_LOOKBACK_HOURS_DEFAULT = 72
const INSERT_BATCH_SIZE = 1000
const MES_HOURLY_SCHEMA = 'ohlcv-1h'
const NON_MES_DAILY_SCHEMA = 'ohlcv-1d'
const NON_MES_HOURLY_SCHEMA = 'ohlcv-1h'
/** @deprecated kept for log/audit compatibility */
const _NON_MES_RAW_SCHEMA = NON_MES_DAILY_SCHEMA

interface DailyIngestOptions {
  dryRun?: boolean
  lookbackHours?: number
  symbols?: string[]
}

interface DailyIngestSummary {
  lookbackHours: number
  rowsInserted: number
  rowsProcessed: number
  symbolsRequested: string[]
  symbolsProcessed: string[]
  symbolsFailed: Record<string, string>
  dryRun: boolean
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function hashPriceRow(symbolCode: string, eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`${symbolCode}|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null
  try {
    return (await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms)
      }),
    ])) as T
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function parseBoolean(raw: string): boolean {
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

function resolveOptions(options?: DailyIngestOptions): Required<DailyIngestOptions> {
  const cliDryRun = parseBoolean(parseArg('dry-run', 'false'))
  const cliLookback = Number(parseArg('lookback-hours', String(DAILY_LOOKBACK_HOURS_DEFAULT)))
  const cliSymbolsRaw = parseArg('symbols', '')
  const cliSymbols = cliSymbolsRaw
    ? cliSymbolsRaw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    : []

  const lookbackHours = Number.isFinite(options?.lookbackHours)
    ? Number(options?.lookbackHours)
    : Number.isFinite(cliLookback)
      ? cliLookback
      : DAILY_LOOKBACK_HOURS_DEFAULT

  return {
    dryRun: options?.dryRun ?? cliDryRun,
    lookbackHours,
    symbols: options?.symbols?.length ? options.symbols : cliSymbols,
  }
}

function pickSymbols(requested: string[]): typeof INGESTION_SYMBOLS {
  if (requested.length === 0) return INGESTION_SYMBOLS
  const set = new Set(requested)
  return INGESTION_SYMBOLS.filter((s) => set.has(s.code))
}

async function latestSymbolTime(symbolCode: string): Promise<Date | null> {
  if (symbolCode === 'MES') {
    const row = await prisma.mktFuturesMes1h.findFirst({
      orderBy: { eventTime: 'desc' },
      select: { eventTime: true },
    })
    return row?.eventTime ?? null
  }

  const row = await prisma.mktFutures1d.findFirst({
    where: { symbolCode },
    orderBy: { eventDate: 'desc' },
    select: { eventDate: true },
  })
  return row?.eventDate ?? null
}

async function latestSymbolHourlyTime(symbolCode: string): Promise<Date | null> {
  const row = await prisma.mktFutures1h.findFirst({
    where: { symbolCode },
    orderBy: { eventTime: 'desc' },
    select: { eventTime: true },
  })
  return row?.eventTime ?? null
}

function dedupeAndSort(candles: ReturnType<typeof toCandles>): ReturnType<typeof toCandles> {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

interface InsertContext {
  lookbackHours: number
  fetchedAt: string
  rawRecordCount: number
  validatedCount: number
  aggregationMinutes: number
  databentoSymbol: string
}

function buildCandleMetadata(symbolCode: string, dataset: string, sourceSchema: string, ctx: InsertContext) {
  return toJson({
    symbolCode, databentoSymbol: ctx.databentoSymbol, dataset, sourceSchema,
    aggregationMinutes: ctx.aggregationMinutes, lookbackHours: ctx.lookbackHours,
    fetchedAt: ctx.fetchedAt, rawRecordCount: ctx.rawRecordCount, validatedCount: ctx.validatedCount,
  })
}

function buildCandleBase(symbolCode: string, candle: ReturnType<typeof aggregateCandles>[number], dataset: string, sourceSchema: string, ctx: InsertContext) {
  const eventTime = asUtcDateFromUnixSeconds(candle.time)
  return {
    open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
    source: 'DATABENTO' as const,
    sourceDataset: dataset, sourceSchema,
    rowHash: hashPriceRow(symbolCode, eventTime, candle.close),
    metadata: buildCandleMetadata(symbolCode, dataset, sourceSchema, ctx),
    eventTime,
  }
}

async function batchInsert<T>(rows: T[], writer: (batch: T[]) => Promise<{ count: number }>): Promise<number> {
  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const result = await writer(rows.slice(i, i + INSERT_BATCH_SIZE))
    inserted += result.count
  }
  return inserted
}

async function insertCandlesByPolicy(
  symbolCode: string,
  dataset: string,
  sourceSchema: string,
  candles: ReturnType<typeof aggregateCandles>,
  dryRun: boolean,
  ctx: InsertContext
): Promise<{ processed: number; inserted: number }> {
  const processed = candles.length
  if (dryRun || processed === 0) return { processed, inserted: 0 }

  const valid = candles.filter(
    (c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= c.low
  )

  if (symbolCode === 'MES') {
    const rows = valid.map((candle) => {
      const base = buildCandleBase(symbolCode, candle, dataset, sourceSchema, ctx)
      return { eventTime: base.eventTime, open: base.open, high: base.high, low: base.low, close: base.close, volume: base.volume, source: base.source, sourceDataset: base.sourceDataset, sourceSchema: base.sourceSchema, rowHash: base.rowHash, metadata: base.metadata }
    })
    const inserted = await batchInsert(rows, (batch) => prisma.mktFuturesMes1h.createMany({ data: batch, skipDuplicates: true }))
    return { processed, inserted }
  }

  if (sourceSchema === NON_MES_HOURLY_SCHEMA) {
    const rows = valid.map((candle) => {
      const base = buildCandleBase(symbolCode, candle, dataset, sourceSchema, ctx)
      return { symbolCode, eventTime: base.eventTime, open: base.open, high: base.high, low: base.low, close: base.close, volume: base.volume, source: base.source, sourceDataset: base.sourceDataset, sourceSchema: base.sourceSchema, rowHash: base.rowHash, metadata: base.metadata }
    })
    const inserted = await batchInsert(rows, (batch) => prisma.mktFutures1h.createMany({ data: batch, skipDuplicates: true }))
    return { processed, inserted }
  }

  const rows = valid.map((candle) => {
    const base = buildCandleBase(symbolCode, candle, dataset, sourceSchema, ctx)
    return { symbolCode, eventDate: startOfUtcDay(base.eventTime), open: base.open, high: base.high, low: base.low, close: base.close, volume: base.volume, source: base.source, sourceDataset: base.sourceDataset, sourceSchema: base.sourceSchema, rowHash: base.rowHash, metadata: base.metadata }
  })
  const inserted = await batchInsert(rows, (batch) => prisma.mktFutures1d.createMany({ data: batch, skipDuplicates: true }))
  return { processed, inserted }
}

interface FetchInsertParams {
  symbol: typeof INGESTION_SYMBOLS[number]
  schema: string
  latestTime: Date | null
  overlapMs: number
  fallbackStart: Date
  now: Date
  timeoutMs: number
  aggregationMinutes: number
  lookbackHours: number
  dryRun: boolean
}

async function fetchDedupeInsert(params: FetchInsertParams): Promise<{ processed: number; inserted: number }> {
  const { symbol, schema, latestTime, overlapMs, fallbackStart, now, timeoutMs, aggregationMinutes, lookbackHours, dryRun } = params
  const start = latestTime ? new Date(latestTime.getTime() - overlapMs) : fallbackStart
  const fetchedAt = new Date().toISOString()

  const records = await withTimeout(
    fetchOhlcv({
      dataset: symbol.dataset,
      symbol: symbol.databentoSymbol,
      stypeIn: 'continuous',
      start: start.toISOString(),
      end: now.toISOString(),
      schema,
    }),
    timeoutMs,
    `Databento ${symbol.code} ${schema}`
  )

  if (records.length === 0) return { processed: 0, inserted: 0 }

  const rawCandles = toCandles(records)
  const unique = dedupeAndSort(rawCandles)
  const candles = aggregationMinutes === 1440 ? aggregateCandles(unique, 1440) : unique
  const filtered = latestTime
    ? candles.filter((c) => asUtcDateFromUnixSeconds(c.time) >= start)
    : candles

  return insertCandlesByPolicy(symbol.code, symbol.dataset, schema, filtered, dryRun, {
    lookbackHours, fetchedAt, rawRecordCount: records.length,
    validatedCount: rawCandles.length, aggregationMinutes, databentoSymbol: symbol.databentoSymbol,
  })
}

async function processMesSymbol(symbol: typeof INGESTION_SYMBOLS[number], resolved: Required<DailyIngestOptions>, now: Date): Promise<{ processed: number; inserted: number }> {
  const latestTime = await latestSymbolTime(symbol.code)
  return fetchDedupeInsert({
    symbol, schema: MES_HOURLY_SCHEMA, latestTime,
    overlapMs: 2 * 60 * 60 * 1000,
    fallbackStart: new Date(now.getTime() - resolved.lookbackHours * 60 * 60 * 1000),
    now, timeoutMs: 120_000, aggregationMinutes: 60,
    lookbackHours: resolved.lookbackHours, dryRun: resolved.dryRun,
  })
}

async function processNonMesSymbol(symbol: typeof INGESTION_SYMBOLS[number], resolved: Required<DailyIngestOptions>, now: Date): Promise<{ processed: number; inserted: number }> {
  const fallbackStart = new Date(now.getTime() - resolved.lookbackHours * 60 * 60 * 1000)
  let totalProcessed = 0
  let totalInserted = 0

  const hourlyResult = await fetchDedupeInsert({
    symbol, schema: NON_MES_HOURLY_SCHEMA,
    latestTime: await latestSymbolHourlyTime(symbol.code),
    overlapMs: 2 * 60 * 60 * 1000, fallbackStart, now, timeoutMs: 90_000,
    aggregationMinutes: 60, lookbackHours: resolved.lookbackHours, dryRun: resolved.dryRun,
  })
  totalProcessed += hourlyResult.processed
  totalInserted += hourlyResult.inserted

  const dailyResult = await fetchDedupeInsert({
    symbol, schema: NON_MES_DAILY_SCHEMA,
    latestTime: await latestSymbolTime(symbol.code),
    overlapMs: 2 * 24 * 60 * 60 * 1000, fallbackStart, now, timeoutMs: 60_000,
    aggregationMinutes: 1440, lookbackHours: resolved.lookbackHours, dryRun: resolved.dryRun,
  })
  totalProcessed += dailyResult.processed
  totalInserted += dailyResult.inserted

  return { processed: totalProcessed, inserted: totalInserted }
}

export async function runIngestMarketPricesDaily(options?: DailyIngestOptions): Promise<DailyIngestSummary> {
  loadDotEnvFiles()

  const resolved = resolveOptions(options)
  const symbols = pickSymbols(resolved.symbols)
  if (symbols.length === 0) throw new Error('No valid symbols selected for daily market price ingestion')
  if (!process.env.LOCAL_DATABASE_URL && !process.env.DATABASE_URL) {
    throw new Error('LOCAL_DATABASE_URL or DATABASE_URL is required')
  }
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required')
  if (!Number.isFinite(resolved.lookbackHours) || resolved.lookbackHours <= 0) {
    throw new Error(`Invalid lookback-hours '${resolved.lookbackHours}'`)
  }

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'market-prices-futures-daily',
      status: 'RUNNING',
      details: toJson({
        lookbackHours: resolved.lookbackHours,
        symbolsRequested: symbols.map((s) => s.code),
        targetMesTable: 'mkt_futures_mes_1h',
        targetNonMesHourlyTable: 'mkt_futures_1h',
        targetNonMesDailyTable: 'mkt_futures_1d',
        sourceSchemaMes: MES_HOURLY_SCHEMA,
        sourceSchemaHourly: NON_MES_HOURLY_SCHEMA,
        sourceSchemaDaily: NON_MES_DAILY_SCHEMA,
      }),
    },
  })

  let rowsInserted = 0
  let rowsProcessed = 0
  const symbolsProcessed: string[] = []
  const symbolsFailed: Record<string, string> = {}

  try {
    const now = new Date()

    for (const symbol of symbols) {
      try {
        const result = symbol.code === 'MES'
          ? await processMesSymbol(symbol, resolved, now)
          : await processNonMesSymbol(symbol, resolved, now)

        rowsProcessed += result.processed
        rowsInserted += result.inserted
        symbolsProcessed.push(symbol.code)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        symbolsFailed[symbol.code] = message.slice(0, 400)
      }
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'COMPLETED' : 'FAILED'
    const summary: DailyIngestSummary = {
      lookbackHours: resolved.lookbackHours, rowsInserted, rowsProcessed,
      symbolsRequested: symbols.map((s) => s.code), symbolsProcessed, symbolsFailed,
      dryRun: resolved.dryRun,
    }

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status, finishedAt: new Date(), rowsProcessed, rowsInserted,
        rowsFailed: Object.keys(symbolsFailed).length, details: toJson(summary),
      },
    })

    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED', finishedAt: new Date(), rowsProcessed, rowsInserted,
        rowsFailed: Object.keys(symbolsFailed).length + 1,
        details: toJson({ error: message, symbolsFailed }),
      },
    })
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestMarketPricesDaily()
    .then((summary) => {
      console.log('\n[market-prices-daily] done')
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[market-prices-daily] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
