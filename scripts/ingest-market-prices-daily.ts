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
const NON_MES_RAW_SCHEMA = NON_MES_DAILY_SCHEMA

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

async function insertCandlesByPolicy(
  symbolCode: string,
  dataset: string,
  sourceSchema: string,
  candles: ReturnType<typeof aggregateCandles>,
  dryRun: boolean,
  ctx: InsertContext
): Promise<{ processed: number; inserted: number }> {
  const processed = candles.length
  let inserted = 0
  if (dryRun || processed === 0) return { processed, inserted }

  // Secondary guard: enforce high >= low and all-positive before insert
  const valid = candles.filter(
    (c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 && c.high >= c.low
  )

  if (symbolCode === 'MES') {
    const rows: Prisma.MktFuturesMes1hCreateManyInput[] = valid.map((candle) => {
      const eventTime = asUtcDateFromUnixSeconds(candle.time)
      return {
        eventTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
        source: 'DATABENTO',
        sourceDataset: dataset,
        sourceSchema,
        rowHash: hashPriceRow(symbolCode, eventTime, candle.close),
        metadata: toJson({
          symbolCode,
          databentoSymbol: ctx.databentoSymbol,
          dataset,
          sourceSchema,
          aggregationMinutes: ctx.aggregationMinutes,
          lookbackHours: ctx.lookbackHours,
          fetchedAt: ctx.fetchedAt,
          rawRecordCount: ctx.rawRecordCount,
          validatedCount: ctx.validatedCount,
        }),
      }
    })

    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE)
      const result = await prisma.mktFuturesMes1h.createMany({ data: batch, skipDuplicates: true })
      inserted += result.count
    }
    return { processed, inserted }
  }

  // Non-MES: route to correct table based on source schema
  if (sourceSchema === NON_MES_HOURLY_SCHEMA) {
    // Hourly candles → mkt_futures_1h
    const rows: Prisma.MktFutures1hCreateManyInput[] = valid.map((candle) => {
      const eventTime = asUtcDateFromUnixSeconds(candle.time)
      return {
        symbolCode,
        eventTime,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
        source: 'DATABENTO',
        sourceDataset: dataset,
        sourceSchema,
        rowHash: hashPriceRow(symbolCode, eventTime, candle.close),
        metadata: toJson({
          symbolCode,
          databentoSymbol: ctx.databentoSymbol,
          dataset,
          sourceSchema,
          aggregationMinutes: ctx.aggregationMinutes,
          lookbackHours: ctx.lookbackHours,
          fetchedAt: ctx.fetchedAt,
          rawRecordCount: ctx.rawRecordCount,
          validatedCount: ctx.validatedCount,
        }),
      }
    })

    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INSERT_BATCH_SIZE)
      const result = await prisma.mktFutures1h.createMany({ data: batch, skipDuplicates: true })
      inserted += result.count
    }
    return { processed, inserted }
  }

  // Daily candles → mkt_futures_1d
  const rows: Prisma.MktFutures1dCreateManyInput[] = valid.map((candle) => {
    const eventTime = asUtcDateFromUnixSeconds(candle.time)
    const eventDate = startOfUtcDay(eventTime)
    return {
      symbolCode,
      eventDate,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
      source: 'DATABENTO',
      sourceDataset: dataset,
      sourceSchema,
      rowHash: hashPriceRow(symbolCode, eventTime, candle.close),
      metadata: toJson({
        symbolCode,
        databentoSymbol: ctx.databentoSymbol,
        dataset,
        sourceSchema,
        aggregationMinutes: ctx.aggregationMinutes,
        lookbackHours: ctx.lookbackHours,
        fetchedAt: ctx.fetchedAt,
        rawRecordCount: ctx.rawRecordCount,
        validatedCount: ctx.validatedCount,
      }),
    }
  })

  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE)
    const result = await prisma.mktFutures1d.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }

  return { processed, inserted }
}

export async function runIngestMarketPricesDaily(options?: DailyIngestOptions): Promise<DailyIngestSummary> {
  loadDotEnvFiles()

  const resolved = resolveOptions(options)
  const symbols = pickSymbols(resolved.symbols)
  if (symbols.length === 0) {
    throw new Error('No valid symbols selected for daily market price ingestion')
  }

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
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
        if (symbol.code === 'MES') {
          // ── MES: fetch 1h directly, write to mkt_futures_mes_1h ──
          const latestTime = await latestSymbolTime(symbol.code)
          const overlapMs = 2 * 60 * 60 * 1000
          const overlapStart = latestTime
            ? new Date(latestTime.getTime() - overlapMs)
            : new Date(now.getTime() - resolved.lookbackHours * 60 * 60 * 1000)

          const fetchedAt = new Date().toISOString()
          const records = await withTimeout(
            fetchOhlcv({
              dataset: symbol.dataset,
              symbol: symbol.databentoSymbol,
              stypeIn: 'continuous',
              start: overlapStart.toISOString(),
              end: now.toISOString(),
              schema: MES_HOURLY_SCHEMA,
            }),
            120_000,
            `Databento MES ${MES_HOURLY_SCHEMA}`
          )

          if (records.length > 0) {
            const rawCandles = toCandles(records)
            const uniqueCandles = dedupeAndSort(rawCandles)
            const filtered = latestTime
              ? uniqueCandles.filter((c) => asUtcDateFromUnixSeconds(c.time) >= overlapStart)
              : uniqueCandles

            const result = await insertCandlesByPolicy(
              symbol.code, symbol.dataset, MES_HOURLY_SCHEMA, filtered, resolved.dryRun,
              { lookbackHours: resolved.lookbackHours, fetchedAt, rawRecordCount: records.length, validatedCount: rawCandles.length, aggregationMinutes: 60, databentoSymbol: symbol.databentoSymbol }
            )
            rowsProcessed += result.processed
            rowsInserted += result.inserted
          }

          symbolsProcessed.push(symbol.code)
        } else {
          // ── Non-MES: fetch both ohlcv-1h and ohlcv-1d, write to mkt_futures_1h + mkt_futures_1d ──
          const overlapHourly = 2 * 60 * 60 * 1000
          const overlapDaily = 2 * 24 * 60 * 60 * 1000
          const fallbackStart = new Date(now.getTime() - resolved.lookbackHours * 60 * 60 * 1000)

          // ── 1h fetch ──
          const latestHourly = await latestSymbolHourlyTime(symbol.code)
          const hourlyStart = latestHourly
            ? new Date(latestHourly.getTime() - overlapHourly)
            : fallbackStart

          const fetchedAt = new Date().toISOString()
          const hourlyRecords = await withTimeout(
            fetchOhlcv({
              dataset: symbol.dataset,
              symbol: symbol.databentoSymbol,
              stypeIn: 'continuous',
              start: hourlyStart.toISOString(),
              end: now.toISOString(),
              schema: NON_MES_HOURLY_SCHEMA,
            }),
            90_000,
            `Databento ${symbol.code} ${NON_MES_HOURLY_SCHEMA}`
          )

          if (hourlyRecords.length > 0) {
            const rawHourly = toCandles(hourlyRecords)
            const uniqueHourly = dedupeAndSort(rawHourly)
            const filteredHourly = latestHourly
              ? uniqueHourly.filter((c) => asUtcDateFromUnixSeconds(c.time) >= hourlyStart)
              : uniqueHourly

            const hourlyResult = await insertCandlesByPolicy(
              symbol.code, symbol.dataset, NON_MES_HOURLY_SCHEMA, filteredHourly, resolved.dryRun,
              { lookbackHours: resolved.lookbackHours, fetchedAt, rawRecordCount: hourlyRecords.length, validatedCount: rawHourly.length, aggregationMinutes: 60, databentoSymbol: symbol.databentoSymbol }
            )
            rowsProcessed += hourlyResult.processed
            rowsInserted += hourlyResult.inserted
          }

          // ── 1d fetch ──
          const latestDaily = await latestSymbolTime(symbol.code)
          const dailyStart = latestDaily
            ? new Date(latestDaily.getTime() - overlapDaily)
            : fallbackStart

          const dailyRecords = await withTimeout(
            fetchOhlcv({
              dataset: symbol.dataset,
              symbol: symbol.databentoSymbol,
              stypeIn: 'continuous',
              start: dailyStart.toISOString(),
              end: now.toISOString(),
              schema: NON_MES_DAILY_SCHEMA,
            }),
            60_000,
            `Databento ${symbol.code} ${NON_MES_DAILY_SCHEMA}`
          )

          if (dailyRecords.length > 0) {
            const rawDaily = toCandles(dailyRecords)
            const uniqueDaily = dedupeAndSort(rawDaily)
            const aggregatedDaily = aggregateCandles(uniqueDaily, 1440)
            const filteredDaily = latestDaily
              ? aggregatedDaily.filter((c) => asUtcDateFromUnixSeconds(c.time) >= dailyStart)
              : aggregatedDaily

            const dailyResult = await insertCandlesByPolicy(
              symbol.code, symbol.dataset, NON_MES_DAILY_SCHEMA, filteredDaily, resolved.dryRun,
              { lookbackHours: resolved.lookbackHours, fetchedAt, rawRecordCount: dailyRecords.length, validatedCount: rawDaily.length, aggregationMinutes: 1440, databentoSymbol: symbol.databentoSymbol }
            )
            rowsProcessed += dailyResult.processed
            rowsInserted += dailyResult.inserted
          }

          symbolsProcessed.push(symbol.code)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        symbolsFailed[symbol.code] = message.slice(0, 400)
      }
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'COMPLETED' : 'FAILED'
    const summary: DailyIngestSummary = {
      lookbackHours: resolved.lookbackHours,
      rowsInserted,
      rowsProcessed,
      symbolsRequested: symbols.map((s) => s.code),
      symbolsProcessed,
      symbolsFailed,
      dryRun: resolved.dryRun,
    }

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        rowsProcessed,
        rowsInserted,
        rowsFailed: Object.keys(symbolsFailed).length,
        details: toJson(summary),
      },
    })

    return summary
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        rowsProcessed,
        rowsInserted,
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
