import { Prisma, Timeframe } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import { fetchOhlcv, toCandles } from '../src/lib/databento'
import { INGESTION_SYMBOLS, type IngestionSymbol } from '../src/lib/ingestion-symbols'
import {
  aggregateCandles,
  asUtcDateFromUnixSeconds,
  formatUtcIso,
  loadDotEnvFiles,
  parseArg,
  splitIntoDayChunks,
  timeframeToPrisma,
} from './ingest-utils'

const INGEST_CONFIG = {
  MES_TIMEFRAME: '1h' as const,
  NON_MES_TIMEFRAME: '1d' as const,
  HISTORY_DAYS: 730,
  MIN_COVERAGE_PCT: 95,
  ZERO_FAKE_POLICY: true,
  DATABENTO_ONLY: true,
  EXPECTED_H1_CANDLES_PER_SYMBOL: Math.floor(730 * 23),
  EXPECTED_D1_CANDLES_PER_SYMBOL: Math.floor((730 * 5) / 7),
  MES_RAW_SCHEMA: 'ohlcv-1h',
  NON_MES_RAW_SCHEMA: 'ohlcv-1d',
  CHUNK_DAYS: 14,
  INSERT_BATCH_SIZE: 1000,
  NON_MES_CONCURRENCY: 6,
}

const CANONICAL_SYMBOL_COUNT = 12

interface PriceIngestSummary {
  timeframe: string
  sourceSchema: string
  daysBack: number
  symbolsRequested: string[]
  symbolsProcessed: string[]
  symbolsFailed: Record<string, string>
  symbolsCoveragePct: Record<string, number>
  chunkDays: number
  rowsInserted: number
  rowsProcessed: number
  dryRun: boolean
  postLoadVerified: boolean
}

interface SymbolIngestResult {
  symbolCode: string
  processed: number
  inserted: number
  coveragePct: number | null
  failedMessage: string | null
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function hardFail(message: string): never {
  throw new Error(`FULL_2Y_REQUIRED_VIOLATION: ${message}`)
}

const VALID_DRY_RUN_VALUES = ['true', 'false', '1', '0']

function validateDryRunValue(raw: string): void {
  if (!VALID_DRY_RUN_VALUES.includes(raw.toLowerCase())) {
    hardFail(`Invalid --dry-run value (${raw}). Use true/false.`)
  }
}

function assertNoForbiddenOverrides(): boolean {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        validateDryRunValue(next)
        i += 1
      }
      continue
    }
    if (arg.startsWith('--dry-run=')) {
      validateDryRunValue(arg.slice('--dry-run='.length))
      continue
    }
    hardFail(`No overrides allowed (${arg}). No shortcuts allowed, reloading aborted.`)
  }
  const dryRunRaw = parseArg('dry-run', 'false').toLowerCase()
  return dryRunRaw === 'true' || dryRunRaw === '1'
}

function assertHardConfigIntegrity(): void {
  if (INGESTION_SYMBOLS.length !== CANONICAL_SYMBOL_COUNT) {
    hardFail(`Must keep canonical ${CANONICAL_SYMBOL_COUNT}-symbol list in ingestion-symbols.ts`)
  }
  const uniqueCodes = new Set(INGESTION_SYMBOLS.map((s) => s.code))
  if (uniqueCodes.size !== INGESTION_SYMBOLS.length) {
    hardFail('Canonical ingestion symbol list contains duplicates.')
  }
  if (!INGEST_CONFIG.ZERO_FAKE_POLICY || !INGEST_CONFIG.DATABENTO_ONLY) {
    hardFail('Zero fake data and Databento-only policy must remain enabled.')
  }
}

async function loadActiveDatabentoSymbols(): Promise<IngestionSymbol[]> {
  const canonicalByCode = new Map(INGESTION_SYMBOLS.map((symbol) => [symbol.code, symbol]))
  const activeRows = await prisma.symbol.findMany({
    where: {
      dataSource: 'DATABENTO',
      isActive: true,
    },
    select: { code: true },
    orderBy: { code: 'asc' },
  })

  if (activeRows.length !== INGESTION_SYMBOLS.length) {
    hardFail(
      `Expected ${INGESTION_SYMBOLS.length} active Databento symbols, found ${activeRows.length}. ` +
        'Reconcile symbols.isActive before ingestion.'
    )
  }

  const activeCodes = new Set(activeRows.map((row) => row.code))
  const missingCanonical = INGESTION_SYMBOLS.filter((symbol) => !activeCodes.has(symbol.code)).map(
    (symbol) => symbol.code
  )
  if (missingCanonical.length > 0) {
    hardFail(`Active symbol catalog missing canonical codes: ${missingCanonical.join(', ')}`)
  }

  const nonCanonicalActive = activeRows
    .filter((row) => !canonicalByCode.has(row.code))
    .map((row) => row.code)
  if (nonCanonicalActive.length > 0) {
    hardFail(`Found non-canonical active symbols: ${nonCanonicalActive.join(', ')}`)
  }

  return activeRows.map((row) => canonicalByCode.get(row.code)!).filter(Boolean)
}

function expectedTradableCandlesPerSymbol(days: number): number {
  return Math.floor((days * 5 * 23) / 7)
}

function expectedTradableDaysPerSymbol(days: number): number {
  return Math.floor((days * 5) / 7)
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
  return candles.some(isInvalidCandle)
}

function hashPriceRow(symbolCode: string, eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`${symbolCode}|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

function isInvalidCandle(row: ReturnType<typeof toCandles>[number]): boolean {
  if (!Number.isFinite(row.open) || !Number.isFinite(row.high) || !Number.isFinite(row.low) || !Number.isFinite(row.close)) return true
  if (row.open <= 0 || row.high <= 0 || row.low <= 0 || row.close <= 0) return true
  return !Number.isFinite(row.volume || NaN) || (row.volume || 0) <= 0
}

function buildMesPriceRow(candle: ReturnType<typeof toCandles>[number], dataset: string, sourceSchema: string): Prisma.MktFuturesMes1hCreateManyInput {
  const eventTime = asUtcDateFromUnixSeconds(candle.time)
  return {
    eventTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
    source: 'DATABENTO', sourceDataset: dataset, sourceSchema,
    rowHash: hashPriceRow('MES', eventTime, candle.close),
  }
}

function buildNonMesPriceRow(symbolCode: string, candle: ReturnType<typeof toCandles>[number], dataset: string, sourceSchema: string): Prisma.MktFutures1dCreateManyInput {
  const eventTime = asUtcDateFromUnixSeconds(candle.time)
  return {
    symbolCode, eventDate: startOfUtcDay(eventTime),
    open: candle.open, high: candle.high, low: candle.low, close: candle.close,
    volume: BigInt(Math.max(0, Math.trunc(candle.volume || 0))),
    source: 'DATABENTO', sourceDataset: dataset, sourceSchema,
    rowHash: hashPriceRow(symbolCode, eventTime, candle.close),
  }
}

async function batchInsertMany<T>(rows: T[], writer: (batch: T[]) => Promise<{ count: number }>): Promise<number> {
  let inserted = 0
  for (let i = 0; i < rows.length; i += INGEST_CONFIG.INSERT_BATCH_SIZE) {
    const result = await writer(rows.slice(i, i + INGEST_CONFIG.INSERT_BATCH_SIZE))
    inserted += result.count
  }
  return inserted
}

async function upsertDataSourceRegistry(): Promise<void> {
  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'market-prices-databento' },
    create: {
      sourceId: 'market-prices-databento',
      sourceName: 'Databento Futures OHLCV',
      description:
        'Databento GLBX futures ingestion with MES (native 1h) and non-MES (native 1d) in dedicated training tables.',
      targetTable: 'mkt_futures_mes_1h,mkt_futures_1d',
      apiProvider: 'databento',
      updateFrequency: 'mixed',
      authEnvVar: 'DATABENTO_API_KEY',
      ingestionScript: 'scripts/ingest-market-prices.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Databento Futures OHLCV',
      description:
        'Databento GLBX futures ingestion with MES (native 1h) and non-MES (native 1d) in dedicated training tables.',
      targetTable: 'mkt_futures_mes_1h,mkt_futures_1d',
      apiProvider: 'databento',
      updateFrequency: 'mixed',
      authEnvVar: 'DATABENTO_API_KEY',
      ingestionScript: 'scripts/ingest-market-prices.ts',
      isActive: true,
    },
  })
}

async function upsertSymbolCatalog(symbolCodes: string[]): Promise<void> {
  await prisma.symbol.updateMany({
    where: {
      code: {
        notIn: symbolCodes,
      },
    },
    data: {
      isActive: false,
    },
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

async function existingCountForSymbol(symbolCode: string): Promise<number> {
  if (symbolCode === 'MES') {
    return prisma.mktFuturesMes1h.count()
  }
  return prisma.mktFutures1d.count({ where: { symbolCode } })
}

async function insertCandlesForSymbol(
  symbolCode: string,
  dataset: string,
  sourceSchema: string,
  candles: ReturnType<typeof aggregateCandles>,
  dryRun: boolean
): Promise<{ processed: number; inserted: number }> {
  const processed = candles.length
  if (dryRun || processed === 0) return { processed, inserted: 0 }

  if (symbolCode === 'MES') {
    const rows = candles.map((c) => buildMesPriceRow(c, dataset, sourceSchema))
    const inserted = await batchInsertMany(rows, (batch) =>
      prisma.mktFuturesMes1h.createMany({ data: batch, skipDuplicates: true })
    )
    return { processed, inserted }
  }

  const rows = candles.map((c) => buildNonMesPriceRow(symbolCode, c, dataset, sourceSchema))
  const inserted = await batchInsertMany(rows, (batch) =>
    prisma.mktFutures1d.createMany({ data: batch, skipDuplicates: true })
  )
  return { processed, inserted }
}

async function verifyLoadedCoverage(
  symbolCodes: string[],
  minCoverageHourly: number,
  minCoverageDaily: number
): Promise<void> {
  const mesCount = await prisma.mktFuturesMes1h.count()
  if (symbolCodes.includes('MES') && mesCount < minCoverageHourly) {
    hardFail(`INSUFFICIENT_DATA: MES has only ${mesCount} rows; ${minCoverageHourly} required.`)
  }

  const nonMes = symbolCodes.filter((code) => code !== 'MES')
  if (nonMes.length === 0) return

  const grouped = await prisma.mktFutures1d.groupBy({
    by: ['symbolCode'],
    where: { symbolCode: { in: nonMes } },
    _count: { _all: true },
  })

  if (grouped.length !== nonMes.length) {
    hardFail('LOAD_INCOMPLETE: non-MES symbol set is missing one or more symbols.')
  }

  const countMap = new Map<string, number>(grouped.map((row) => [row.symbolCode, row._count._all]))
  for (const code of nonMes) {
    const count = countMap.get(code) || 0
    if (count < minCoverageDaily) {
      hardFail(`INSUFFICIENT_DATA: ${code} has only ${count} rows; ${minCoverageDaily} required.`)
    }
  }
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
  symbol: IngestionSymbol
  start: Date
  end: Date
  chunks: Array<{ start: Date; end: Date }>
  minCoverageHourly: number
  minCoverageDaily: number
  dryRun: boolean
}): Promise<SymbolIngestResult> {
  const { symbol, start, end, chunks, minCoverageHourly, minCoverageDaily, dryRun } = params

  try {
    const symbolMinCoverage = symbol.code === 'MES' ? minCoverageHourly : minCoverageDaily
    const symbolTimeframe = symbol.code === 'MES' ? INGEST_CONFIG.MES_TIMEFRAME : INGEST_CONFIG.NON_MES_TIMEFRAME
    const sourceSchema = symbol.code === 'MES' ? INGEST_CONFIG.MES_RAW_SCHEMA : INGEST_CONFIG.NON_MES_RAW_SCHEMA
    const rawMinCoverage =
      symbol.code === 'MES'
        ? sourceSchema === 'ohlcv-1h'
          ? minCoverageHourly
          : Math.floor(INGEST_CONFIG.EXPECTED_H1_CANDLES_PER_SYMBOL * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100))
        : Math.floor(INGEST_CONFIG.EXPECTED_D1_CANDLES_PER_SYMBOL * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100))

    const existingCount = await existingCountForSymbol(symbol.code)
    if (existingCount >= symbolMinCoverage) {
      const coveragePct = Number(((existingCount / symbolMinCoverage) * 100).toFixed(2))
      console.log(
        `[market-prices] SUCCESS: ${symbol.code} already compliant in DB (${existingCount} ${symbolTimeframe} rows >= ${symbolMinCoverage}).`
      )
      return {
        symbolCode: symbol.code,
        processed: 0,
        inserted: 0,
        coveragePct,
        failedMessage: null,
      }
    }

    const symbolChunks =
      symbol.code === 'MES'
        ? sourceSchema === 'ohlcv-1h'
          ? [{ start, end }]
          : chunks
        : [{ start, end }]
    console.log(`\n[market-prices] ${symbol.code} ingest start (${symbolChunks.length} chunks)`)
    const rawCandlesAll: ReturnType<typeof toCandles> = []

    for (let chunkIndex = 0; chunkIndex < symbolChunks.length; chunkIndex++) {
      const chunk = symbolChunks[chunkIndex]
      if (chunkIndex === 0 || (chunkIndex + 1) % 5 === 0 || chunkIndex === symbolChunks.length - 1) {
        console.log(`[market-prices] ${symbol.code} chunk ${chunkIndex + 1}/${symbolChunks.length}`)
      }

      const records = await fetchOhlcv({
        dataset: symbol.dataset,
        symbol: symbol.databentoSymbol,
        stypeIn: 'continuous',
        start: formatUtcIso(chunk.start),
        end: formatUtcIso(chunk.end),
        schema: sourceSchema,
        timeoutMs: symbol.code === 'MES' ? 120_000 : 45_000,
        maxAttempts: symbol.code === 'MES' ? 3 : 2,
      })

      if (records.length === 0) continue
      const chunkCandles = toCandles(records)

      if (hasInvalidRealData(chunkCandles)) {
        return {
          symbolCode: symbol.code,
          processed: 0,
          inserted: 0,
          coveragePct: null,
          failedMessage: `FAKE_DATA_DETECTED: invalid/zero OHLCV in raw candles for ${symbol.code}; zero tolerance.`,
        }
      }

      rawCandlesAll.push(...chunkCandles)
    }

    if (rawCandlesAll.length === 0) {
      return {
        symbolCode: symbol.code,
        processed: 0,
        inserted: 0,
        coveragePct: null,
        failedMessage: `AUDIT_FAIL: ${symbol.code} returned zero raw rows for ${sourceSchema}.`,
      }
    }

    if (rawCandlesAll.length < rawMinCoverage) {
      return {
        symbolCode: symbol.code,
        processed: 0,
        inserted: 0,
        coveragePct: null,
        failedMessage: `AUDIT_FAIL: ${symbol.code} raw count=${rawCandlesAll.length} below enforced ${sourceSchema} threshold ${rawMinCoverage}.`,
      }
    }

    const uniqueCandles = sanitizeCandles(rawCandlesAll)
    const aggregated =
      sourceSchema === 'ohlcv-1h' || sourceSchema === 'ohlcv-1d'
        ? uniqueCandles
        : aggregateCandles(uniqueCandles, symbol.code === 'MES' ? 60 : 1440)
    if (aggregated.some((candle) => candle.close == null || !Number.isFinite(candle.close))) {
      return {
        symbolCode: symbol.code,
        processed: 0,
        inserted: 0,
        coveragePct: null,
        failedMessage: `GAP_DETECTED_IN_RESAMPLE: ${symbol.code} has null/invalid close after aggregation.`,
      }
    }

    const coveragePct = Number(((aggregated.length / symbolMinCoverage) * 100).toFixed(2))
    if (aggregated.length < symbolMinCoverage) {
      return {
        symbolCode: symbol.code,
        processed: 0,
        inserted: 0,
        coveragePct,
        failedMessage: `AUDIT_FAIL: ${symbol.code} has ${aggregated.length} ${symbolTimeframe} rows (< ${symbolMinCoverage}, ${INGEST_CONFIG.MIN_COVERAGE_PCT}% coverage). Excluding.`,
      }
    }

    const result = await insertCandlesForSymbol(
      symbol.code,
      symbol.dataset,
      sourceSchema,
      aggregated,
      dryRun
    )

    console.log(
      `[market-prices] SUCCESS: ${symbol.code} full 2y ${symbolTimeframe} loaded – ${aggregated.length} rows, no fake data.`
    )
    return {
      symbolCode: symbol.code,
      processed: result.processed,
      inserted: result.inserted,
      coveragePct,
      failedMessage: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      symbolCode: symbol.code,
      processed: 0,
      inserted: 0,
      coveragePct: null,
      failedMessage: message.slice(0, 400),
    }
  }
}

export async function runIngestMarketPrices(): Promise<PriceIngestSummary> {
  loadDotEnvFiles()
  assertHardConfigIntegrity()
  const dryRun = assertNoForbiddenOverrides()

  if (!process.env.DATABASE_URL) {
    hardFail('DATABASE_URL is required')
  }
  if (!process.env.DATABENTO_API_KEY) {
    hardFail('DATABENTO_API_KEY is required')
  }

  const start = new Date(Date.now() - INGEST_CONFIG.HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const startDate = start.toISOString().slice(0, 10)
  const end = new Date()
  console.log(`ENFORCING FULL 2Y: Starting from ${startDate} – no shortcuts allowed.`)

  const selected = await loadActiveDatabentoSymbols()
  const selectedCodes = selected.map((symbol) => symbol.code)

  const chunks = splitIntoDayChunks(start, end, INGEST_CONFIG.CHUNK_DAYS)
  const tfPrisma = timeframeToPrisma(INGEST_CONFIG.MES_TIMEFRAME)
  if (tfPrisma !== Timeframe.H1) {
    hardFail(`TIMEFRAME_VIOLATION: expected MES H1, got ${tfPrisma}`)
  }

  const minCoverageHourly = Math.floor(
    expectedTradableCandlesPerSymbol(INGEST_CONFIG.HISTORY_DAYS) * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100)
  )
  const minCoverageDaily = Math.floor(
    expectedTradableDaysPerSymbol(INGEST_CONFIG.HISTORY_DAYS) * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100)
  )

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'market-prices-mes-1h-nonmes-1d',
      status: 'RUNNING',
      details: toJson({
        daysBack: INGEST_CONFIG.HISTORY_DAYS,
        timeframeMes: INGEST_CONFIG.MES_TIMEFRAME,
        timeframeNonMes: INGEST_CONFIG.NON_MES_TIMEFRAME,
        sourceSchemaMes: INGEST_CONFIG.MES_RAW_SCHEMA,
        sourceSchemaNonMes: INGEST_CONFIG.NON_MES_RAW_SCHEMA,
        chunkDays: INGEST_CONFIG.CHUNK_DAYS,
        symbolsRequested: selectedCodes,
        minCoverageHourly,
        minCoverageDaily,
        expectedH1Reference: INGEST_CONFIG.EXPECTED_H1_CANDLES_PER_SYMBOL,
        expectedD1Reference: INGEST_CONFIG.EXPECTED_D1_CANDLES_PER_SYMBOL,
      }),
    },
  })

  let rowsInserted = 0
  let rowsProcessed = 0
  const symbolsProcessed: string[] = []
  const symbolsFailed: Record<string, string> = {}
  const symbolsCoveragePct: Record<string, number> = {}
  let postLoadVerified = false

  try {
    await upsertDataSourceRegistry()
    await upsertSymbolCatalog(selectedCodes)

    const applyResult = (result: SymbolIngestResult): void => {
      if (result.coveragePct != null) {
        symbolsCoveragePct[result.symbolCode] = result.coveragePct
      }
      rowsProcessed += result.processed
      rowsInserted += result.inserted

      if (result.failedMessage) {
        symbolsFailed[result.symbolCode] = result.failedMessage
        console.error(`[market-prices] ${result.symbolCode} failed: ${result.failedMessage}`)
      } else {
        symbolsProcessed.push(result.symbolCode)
      }
    }

    const mesSymbol = selected.find((symbol) => symbol.code === 'MES')
    if (mesSymbol) {
      const mesResult = await ingestSingleSymbol({
        symbol: mesSymbol,
        start,
        end,
        chunks,
        minCoverageHourly,
        minCoverageDaily,
        dryRun,
      })
      applyResult(mesResult)
    }

    const nonMesSymbols = selected.filter((symbol) => symbol.code !== 'MES')
    const nonMesResults = await runWithConcurrency(
      nonMesSymbols,
      INGEST_CONFIG.NON_MES_CONCURRENCY,
      async (symbol) =>
        ingestSingleSymbol({
          symbol,
          start,
          end,
          chunks,
          minCoverageHourly,
          minCoverageDaily,
          dryRun,
        })
    )

    for (const result of nonMesResults) {
      applyResult(result)
    }

    const passingSymbols = symbolsProcessed
    if (passingSymbols.length === 0) {
      hardFail('LOAD_INCOMPLETE: no symbols passed hard coverage and quality checks.')
    }

    if (!dryRun) {
      await verifyLoadedCoverage(passingSymbols, minCoverageHourly, minCoverageDaily)
      postLoadVerified = true
      console.log('ALL CLEAR: Full 2y ingestion complete – no lies, no fakes, ready for training.')
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'COMPLETED' : 'FAILED'
    const summary: PriceIngestSummary = {
      timeframe: `MES=${INGEST_CONFIG.MES_TIMEFRAME};NON_MES=${INGEST_CONFIG.NON_MES_TIMEFRAME}`,
      sourceSchema: `MES=${INGEST_CONFIG.MES_RAW_SCHEMA};NON_MES=${INGEST_CONFIG.NON_MES_RAW_SCHEMA}`,
      daysBack: INGEST_CONFIG.HISTORY_DAYS,
      symbolsRequested: selectedCodes,
      symbolsProcessed,
      symbolsFailed,
      symbolsCoveragePct,
      chunkDays: INGEST_CONFIG.CHUNK_DAYS,
      rowsInserted,
      rowsProcessed,
      dryRun,
      postLoadVerified,
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
        details: toJson({
          error: message,
          symbolsFailed,
        }),
      },
    })
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestMarketPrices()
    .then((summary) => {
      console.log('\n[market-prices] done')
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
