import { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { fetchOhlcv, toCandles } from '../src/lib/databento'
import { INGESTION_SYMBOLS } from '../src/lib/ingestion-symbols'
import {
  aggregateCandles,
  asUtcDateFromUnixSeconds,
  formatUtcIso,
  loadDotEnvFiles,
  parseArg,
  splitIntoDayChunks,
} from './ingest-utils'

const INGEST_CONFIG = {
  MES_TIMEFRAME: '1h' as const,
  NON_MES_TIMEFRAME: '1d' as const,
  HISTORY_DAYS: 730,
  MES_RAW_SCHEMA: 'ohlcv-1h',
  MES_15M_RAW_SCHEMA: 'ohlcv-1m',
  NON_MES_RAW_SCHEMA: 'ohlcv-1d',
  CHUNK_DAYS: 14,
  INSERT_BATCH_SIZE: 1000,
  NON_MES_CONCURRENCY: 6,
}

interface PriceIngestSummary {
  timeframe: string
  sourceSchema: string
  daysBack: number
  symbolsRequested: string[]
  symbolsProcessed: string[]
  symbolsFailed: Record<string, string>
  chunkDays: number
  rowsInserted: number
  rowsProcessed: number
  dryRun: boolean
  mes15mInserted: number
}

interface SymbolIngestResult {
  symbolCode: string
  processed: number
  inserted: number
  failedMessage: string | null
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
}

function sanitizeCandles(candles: ReturnType<typeof toCandles>): ReturnType<typeof toCandles> {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const candle of candles) byTime.set(candle.time, candle)
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

function hasInvalidRealData(candles: ReturnType<typeof toCandles>): boolean {
  return candles.some(
    (row) =>
      !Number.isFinite(row.open) ||
      !Number.isFinite(row.high) ||
      !Number.isFinite(row.low) ||
      !Number.isFinite(row.close) ||
      row.open <= 0 ||
      row.high <= 0 ||
      row.low <= 0 ||
      row.close <= 0
  )
}

function hashPriceRow(symbolCode: string, eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`${symbolCode}|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

async function upsertDataSourceRegistry(): Promise<void> {
  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'market-prices-databento' },
    create: {
      sourceId: 'market-prices-databento',
      sourceName: 'Databento Futures OHLCV',
      description: 'Databento GLBX futures ingestion: MES (1h + 15m), non-MES (1d).',
      targetTable: 'mes_prices_1h,mes_prices_15m,futures_ex_mes_1d',
      apiProvider: 'databento',
      updateFrequency: 'mixed',
      authEnvVar: 'DATABENTO_API_KEY',
      ingestionScript: 'scripts/ingest-market-prices.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Databento Futures OHLCV',
      description: 'Databento GLBX futures ingestion: MES (1h + 15m), non-MES (1d).',
      targetTable: 'mes_prices_1h,mes_prices_15m,futures_ex_mes_1d',
      isActive: true,
    },
  })
}

async function upsertSymbolCatalog(symbolCodes: string[]): Promise<void> {
  await prisma.symbol.updateMany({
    where: { code: { notIn: symbolCodes } },
    data: { isActive: false },
  })

  for (const cfg of INGESTION_SYMBOLS) {
    if (!symbolCodes.includes(cfg.code)) continue
    await prisma.symbol.upsert({
      where: { code: cfg.code },
      create: {
        code: cfg.code,
        displayName: cfg.displayName,
        shortName: cfg.shortName,
        description: cfg.description,
        tickSize: cfg.tickSize,
        dataSource: 'DATABENTO',
        dataset: cfg.dataset,
        databentoSymbol: cfg.databentoSymbol,
      },
      update: {
        displayName: cfg.displayName,
        shortName: cfg.shortName,
        description: cfg.description,
        tickSize: cfg.tickSize,
        dataSource: 'DATABENTO',
        dataset: cfg.dataset,
        databentoSymbol: cfg.databentoSymbol,
        isActive: true,
      },
    })

    await prisma.symbolMapping.upsert({
      where: {
        sourceTable_sourceSymbol: {
          sourceTable: 'databento.continuous',
          sourceSymbol: cfg.databentoSymbol,
        },
      },
      create: {
        symbolCode: cfg.code,
        source: 'DATABENTO',
        sourceTable: 'databento.continuous',
        sourceSymbol: cfg.databentoSymbol,
        isPrimary: true,
        confidenceScore: 1,
      },
      update: {
        symbolCode: cfg.code,
        source: 'DATABENTO',
        isPrimary: true,
        confidenceScore: 1,
      },
    })
  }
}

async function insertMes1hCandles(
  dataset: string,
  sourceSchema: string,
  candles: ReturnType<typeof aggregateCandles>,
): Promise<{ processed: number; inserted: number }> {
  let inserted = 0
  const rows: Prisma.MesPrice1hCreateManyInput[] = candles.map((candle) => {
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
      rowHash: hashPriceRow('MES', eventTime, candle.close),
    }
  })

  for (let i = 0; i < rows.length; i += INGEST_CONFIG.INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INGEST_CONFIG.INSERT_BATCH_SIZE)
    const result = await prisma.mesPrice1h.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return { processed: rows.length, inserted }
}

async function insertMes15mCandles(
  dataset: string,
  candles: ReturnType<typeof aggregateCandles>,
): Promise<{ processed: number; inserted: number }> {
  let inserted = 0
  const rows: Prisma.MesPrice15mCreateManyInput[] = candles
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
        sourceDataset: dataset,
        sourceSchema: `${INGEST_CONFIG.MES_15M_RAW_SCHEMA}->15m`,
        rowHash: hashPriceRow('MES-15M', eventTime, candle.close),
      }
    })

  for (let i = 0; i < rows.length; i += INGEST_CONFIG.INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INGEST_CONFIG.INSERT_BATCH_SIZE)
    const result = await prisma.mesPrice15m.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return { processed: rows.length, inserted }
}

async function insertNonMesCandles(
  symbolCode: string,
  dataset: string,
  sourceSchema: string,
  candles: ReturnType<typeof aggregateCandles>,
): Promise<{ processed: number; inserted: number }> {
  let inserted = 0
  const rows: Prisma.FuturesExMes1dCreateManyInput[] = candles.map((candle) => {
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
    }
  })

  for (let i = 0; i < rows.length; i += INGEST_CONFIG.INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INGEST_CONFIG.INSERT_BATCH_SIZE)
    const result = await prisma.futuresExMes1d.createMany({ data: batch, skipDuplicates: true })
    inserted += result.count
  }
  return { processed: rows.length, inserted }
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results: R[] = new Array(items.length)
  let cursor = 0

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}

async function ingestSingleSymbol(params: {
  symbol: (typeof INGESTION_SYMBOLS)[number]
  start: Date
  end: Date
  chunks: Array<{ start: Date; end: Date }>
  dryRun: boolean
}): Promise<SymbolIngestResult> {
  const { symbol, start, end, chunks, dryRun } = params

  try {
    const isMes = symbol.code === 'MES'
    const sourceSchema = isMes ? INGEST_CONFIG.MES_RAW_SCHEMA : INGEST_CONFIG.NON_MES_RAW_SCHEMA
    const symbolChunks = isMes && sourceSchema === 'ohlcv-1h' ? [{ start, end }] : [{ start, end }]

    console.log(`\n[market-prices] ${symbol.code} ingest start (${symbolChunks.length} chunks)`)
    const rawCandlesAll: ReturnType<typeof toCandles> = []

    for (let chunkIndex = 0; chunkIndex < symbolChunks.length; chunkIndex++) {
      const chunk = symbolChunks[chunkIndex]
      if (chunkIndex === 0 || chunkIndex === symbolChunks.length - 1) {
        console.log(`[market-prices] ${symbol.code} chunk ${chunkIndex + 1}/${symbolChunks.length}`)
      }

      const records = await fetchOhlcv({
        dataset: symbol.dataset,
        symbol: symbol.databentoSymbol,
        stypeIn: 'continuous',
        start: formatUtcIso(chunk.start),
        end: formatUtcIso(chunk.end),
        schema: sourceSchema,
        timeoutMs: isMes ? 120_000 : 45_000,
        maxAttempts: isMes ? 3 : 2,
      })

      if (records.length === 0) continue
      const chunkCandles = toCandles(records)

      if (hasInvalidRealData(chunkCandles)) {
        console.warn(`[market-prices] ${symbol.code}: invalid OHLCV data detected, skipping`)
        return {
          symbolCode: symbol.code,
          processed: 0,
          inserted: 0,
          failedMessage: `Invalid OHLCV data in raw candles for ${symbol.code}`,
        }
      }

      rawCandlesAll.push(...chunkCandles)
    }

    if (rawCandlesAll.length === 0) {
      return {
        symbolCode: symbol.code,
        processed: 0,
        inserted: 0,
        failedMessage: `${symbol.code}: zero rows returned for ${sourceSchema}`,
      }
    }

    const uniqueCandles = sanitizeCandles(rawCandlesAll)
    const aggregated =
      sourceSchema === 'ohlcv-1h' || sourceSchema === 'ohlcv-1d'
        ? uniqueCandles
        : aggregateCandles(uniqueCandles, isMes ? 60 : 1440)

    if (dryRun) {
      console.log(`[market-prices] DRY RUN: ${symbol.code} would insert ${aggregated.length} rows`)
      return { symbolCode: symbol.code, processed: aggregated.length, inserted: 0, failedMessage: null }
    }

    const result = isMes
      ? await insertMes1hCandles(symbol.dataset, sourceSchema, aggregated)
      : await insertNonMesCandles(symbol.code, symbol.dataset, sourceSchema, aggregated)

    console.log(`[market-prices] ${symbol.code}: ${result.inserted} rows inserted (${result.processed} processed)`)
    return {
      symbolCode: symbol.code,
      processed: result.processed,
      inserted: result.inserted,
      failedMessage: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      symbolCode: symbol.code,
      processed: 0,
      inserted: 0,
      failedMessage: message.slice(0, 400),
    }
  }
}

async function ingestMes15m(params: {
  start: Date
  end: Date
  chunks: Array<{ start: Date; end: Date }>
  dryRun: boolean
}): Promise<{ processed: number; inserted: number }> {
  const { chunks, dryRun } = params
  const mesSymbol = INGESTION_SYMBOLS.find((s) => s.code === 'MES')
  if (!mesSymbol) {
    console.warn('[market-prices] MES not in catalog, skipping 15m backfill')
    return { processed: 0, inserted: 0 }
  }

  console.log(`\n[market-prices] MES 15m backfill: ${chunks.length} chunks (ohlcv-1m → 15m)`)
  let totalProcessed = 0
  let totalInserted = 0

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    if (i === 0 || (i + 1) % 10 === 0 || i === chunks.length - 1) {
      console.log(`[market-prices] MES 15m chunk ${i + 1}/${chunks.length}`)
    }

    try {
      const records = await fetchOhlcv({
        dataset: mesSymbol.dataset,
        symbol: mesSymbol.databentoSymbol,
        stypeIn: 'continuous',
        start: formatUtcIso(chunk.start),
        end: formatUtcIso(chunk.end),
        schema: INGEST_CONFIG.MES_15M_RAW_SCHEMA,
        timeoutMs: 120_000,
        maxAttempts: 3,
      })

      if (records.length === 0) continue
      const candles1m = sanitizeCandles(toCandles(records))
      const candles15m = aggregateCandles(candles1m, 15)

      if (dryRun) {
        totalProcessed += candles15m.length
        continue
      }

      const result = await insertMes15mCandles(mesSymbol.dataset, candles15m)
      totalProcessed += result.processed
      totalInserted += result.inserted
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[market-prices] MES 15m chunk ${i + 1} failed: ${message}`)
    }
  }

  console.log(`[market-prices] MES 15m done: ${totalInserted} inserted (${totalProcessed} processed)`)
  return { processed: totalProcessed, inserted: totalInserted }
}

export async function runIngestMarketPrices(): Promise<PriceIngestSummary> {
  loadDotEnvFiles()

  const dryRunRaw = parseArg('dry-run', 'false').toLowerCase()
  const dryRun = dryRunRaw === 'true' || dryRunRaw === '1'

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!process.env.DATABENTO_API_KEY) throw new Error('DATABENTO_API_KEY is required')

  const symbolCodes = INGESTION_SYMBOLS.map((s) => s.code)
  const start = new Date(Date.now() - INGEST_CONFIG.HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const end = new Date()
  const chunks = splitIntoDayChunks(start, end, INGEST_CONFIG.CHUNK_DAYS)

  console.log(`[market-prices] ${symbolCodes.length} symbols from catalog`)
  console.log(`[market-prices] range: ${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)}`)
  console.log(`[market-prices] MES: 1h (${INGEST_CONFIG.MES_RAW_SCHEMA}) + 15m (${INGEST_CONFIG.MES_15M_RAW_SCHEMA}→15m)`)
  console.log(`[market-prices] Non-MES: 1d (${INGEST_CONFIG.NON_MES_RAW_SCHEMA})`)

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'market-prices',
      status: 'RUNNING',
      details: toJson({
        daysBack: INGEST_CONFIG.HISTORY_DAYS,
        symbols: symbolCodes,
        chunkDays: INGEST_CONFIG.CHUNK_DAYS,
      }),
    },
  })

  let rowsInserted = 0
  let rowsProcessed = 0
  const symbolsProcessed: string[] = []
  const symbolsFailed: Record<string, string> = {}
  let mes15mInserted = 0

  try {
    await upsertDataSourceRegistry()
    await upsertSymbolCatalog(symbolCodes)

    const applyResult = (result: SymbolIngestResult): void => {
      rowsProcessed += result.processed
      rowsInserted += result.inserted

      if (result.failedMessage) {
        symbolsFailed[result.symbolCode] = result.failedMessage
        console.warn(`[market-prices] ${result.symbolCode} failed: ${result.failedMessage}`)
      } else {
        symbolsProcessed.push(result.symbolCode)
      }
    }

    // MES 1h first
    const mesSymbol = INGESTION_SYMBOLS.find((s) => s.code === 'MES')
    if (mesSymbol) {
      const mesResult = await ingestSingleSymbol({ symbol: mesSymbol, start, end, chunks, dryRun })
      applyResult(mesResult)
    }

    // MES 15m backfill
    const mes15mResult = await ingestMes15m({ start, end, chunks, dryRun })
    mes15mInserted = mes15mResult.inserted
    rowsInserted += mes15mResult.inserted
    rowsProcessed += mes15mResult.processed

    // Non-MES symbols in parallel
    const nonMesSymbols = INGESTION_SYMBOLS.filter((s) => s.code !== 'MES')
    const nonMesResults = await runWithConcurrency(
      nonMesSymbols,
      INGEST_CONFIG.NON_MES_CONCURRENCY,
      async (symbol) => ingestSingleSymbol({ symbol, start, end, chunks, dryRun })
    )
    for (const result of nonMesResults) {
      applyResult(result)
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'SUCCEEDED' : 'PARTIAL'
    const summary: PriceIngestSummary = {
      timeframe: `MES=1h+15m; NON_MES=1d`,
      sourceSchema: `MES=${INGEST_CONFIG.MES_RAW_SCHEMA}+${INGEST_CONFIG.MES_15M_RAW_SCHEMA}; NON_MES=${INGEST_CONFIG.NON_MES_RAW_SCHEMA}`,
      daysBack: INGEST_CONFIG.HISTORY_DAYS,
      symbolsRequested: symbolCodes,
      symbolsProcessed,
      symbolsFailed,
      chunkDays: INGEST_CONFIG.CHUNK_DAYS,
      rowsInserted,
      rowsProcessed,
      dryRun,
      mes15mInserted,
    }

    console.log(`\n[market-prices] done: ${symbolsProcessed.length} succeeded, ${Object.keys(symbolsFailed).length} failed`)
    if (Object.keys(symbolsFailed).length > 0) {
      console.warn('[market-prices] Failed symbols:', Object.keys(symbolsFailed).join(', '))
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
  runIngestMarketPrices()
    .then((summary) => {
      console.log('\n[market-prices] complete')
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[market-prices] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
