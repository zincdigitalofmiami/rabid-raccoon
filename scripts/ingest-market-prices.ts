import { Prisma, Timeframe } from '@prisma/client'
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
  timeframeToPrisma,
} from './ingest-utils'

const INGEST_CONFIG = {
  SYMBOL_UNIVERSE: [
    'ES',
    'MES',
    'NQ',
    'MNQ',
    'YM',
    'MYM',
    'RTY',
    'M2K',
    'EMD',
    'NIY',
    'NKD',
    'XAE',
    'XAF',
    'XAV',
    'XAI',
    'XAB',
    'XAR',
    'XAK',
    'XAU',
    'XAY',
    'XAP',
    'XAZ',
    'SXB',
    'SXI',
    'SXT',
    'SXO',
    'SXR',
    'SOX',
    'BIO',
    'RS1',
    'RSG',
    'RSV',
  ] as const,
  MES_TIMEFRAME: '1h' as const,
  NON_MES_TIMEFRAME: '1d' as const,
  HISTORY_DAYS: 730,
  MIN_COVERAGE_PCT: 95,
  ZERO_FAKE_POLICY: true,
  DATABENTO_ONLY: true,
  EXPECTED_H1_CANDLES_PER_SYMBOL: Math.floor(730 * 23),
  EXPECTED_D1_CANDLES_PER_SYMBOL: Math.floor((730 * 5) / 7),
  MES_RAW_SCHEMA: 'ohlcv-1m',
  NON_MES_RAW_SCHEMA: 'ohlcv-1d',
  CHUNK_DAYS: 14,
  INSERT_BATCH_SIZE: 1000,
}

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

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

function hardFail(message: string): never {
  throw new Error(`FULL_2Y_REQUIRED_VIOLATION: ${message}`)
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

function assertNoForbiddenOverrides(): boolean {
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') {
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        const normalized = next.toLowerCase()
        if (!['true', 'false', '1', '0'].includes(normalized)) {
          hardFail(`Invalid --dry-run value (${next}). Use true/false.`)
        }
        i += 1
      }
      continue
    }
    if (arg.startsWith('--dry-run=')) {
      const value = arg.slice('--dry-run='.length).toLowerCase()
      if (!['true', 'false', '1', '0'].includes(value)) {
        hardFail(`Invalid --dry-run value (${value}). Use true/false.`)
      }
      continue
    }
    hardFail(`No overrides allowed (${arg}). No shortcuts allowed, reloading aborted.`)
  }
  const dryRunRaw = parseArg('dry-run', 'false').toLowerCase()
  return dryRunRaw === 'true' || dryRunRaw === '1'
}

function assertHardConfigIntegrity(): void {
  if (INGEST_CONFIG.SYMBOL_UNIVERSE.length !== 32) {
    hardFail('Must load ALL 32 symbols. Fix config and retry.')
  }
  if (!INGEST_CONFIG.ZERO_FAKE_POLICY || !INGEST_CONFIG.DATABENTO_ONLY) {
    hardFail('Zero fake data and Databento-only policy must remain enabled.')
  }
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
  return candles.some(
    (row) =>
      !Number.isFinite(row.open) ||
      !Number.isFinite(row.high) ||
      !Number.isFinite(row.low) ||
      !Number.isFinite(row.close) ||
      row.open <= 0 ||
      row.high <= 0 ||
      row.low <= 0 ||
      row.close <= 0 ||
      !Number.isFinite(row.volume || NaN) ||
      (row.volume || 0) <= 0
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
      description:
        'Databento GLBX futures ingestion with MES (1m->1h) and non-MES (native 1d) in dedicated daily training table.',
      targetTable: 'mes_prices_1h,futures_ex_mes_1d',
      apiProvider: 'databento',
      updateFrequency: 'mixed',
      authEnvVar: 'DATABENTO_API_KEY',
      ingestionScript: 'scripts/ingest-market-prices.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Databento Futures OHLCV',
      description:
        'Databento GLBX futures ingestion with MES (1m->1h) and non-MES (native 1d) in dedicated daily training table.',
      targetTable: 'mes_prices_1h,futures_ex_mes_1d',
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
    return prisma.mesPrice1h.count()
  }
  return prisma.futuresExMes1d.count({ where: { symbolCode } })
}

async function insertCandlesForSymbol(
  symbolCode: string,
  dataset: string,
  sourceSchema: string,
  candles: ReturnType<typeof aggregateCandles>,
  dryRun: boolean
): Promise<{ processed: number; inserted: number }> {
  let inserted = 0
  const processed = candles.length
  if (dryRun || processed === 0) return { processed, inserted }

  if (symbolCode === 'MES') {
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
        rowHash: hashPriceRow(symbolCode, eventTime, candle.close),
      }
    })

    for (let i = 0; i < rows.length; i += INGEST_CONFIG.INSERT_BATCH_SIZE) {
      const batch = rows.slice(i, i + INGEST_CONFIG.INSERT_BATCH_SIZE)
      const result = await prisma.mesPrice1h.createMany({
        data: batch,
        skipDuplicates: true,
      })
      inserted += result.count
    }
    return { processed, inserted }
  }

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
    const result = await prisma.futuresExMes1d.createMany({
      data: batch,
      skipDuplicates: true,
    })
    inserted += result.count
  }

  return { processed, inserted }
}

async function verifyLoadedCoverage(
  symbolCodes: string[],
  minCoverageHourly: number,
  minCoverageDaily: number
): Promise<void> {
  const mesCount = await prisma.mesPrice1h.count()
  if (symbolCodes.includes('MES') && mesCount < minCoverageHourly) {
    hardFail(`INSUFFICIENT_DATA: MES has only ${mesCount} rows; ${minCoverageHourly} required.`)
  }

  const nonMes = symbolCodes.filter((code) => code !== 'MES')
  if (nonMes.length === 0) return

  const grouped = await prisma.futuresExMes1d.groupBy({
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

  const selected = INGESTION_SYMBOLS.filter((s) =>
    INGEST_CONFIG.SYMBOL_UNIVERSE.includes(s.code as (typeof INGEST_CONFIG.SYMBOL_UNIVERSE)[number])
  )
  if (selected.length !== INGEST_CONFIG.SYMBOL_UNIVERSE.length) {
    const missing = INGEST_CONFIG.SYMBOL_UNIVERSE.filter(
      (code) => !selected.find((s) => s.code === code)
    )
    hardFail(`Symbol catalog missing entries for: ${missing.join(', ')}`)
  }

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
        symbolsRequested: INGEST_CONFIG.SYMBOL_UNIVERSE,
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
    await upsertSymbolCatalog(INGEST_CONFIG.SYMBOL_UNIVERSE as unknown as string[])

    for (const symbol of selected) {
      try {
        const symbolMinCoverage = symbol.code === 'MES' ? minCoverageHourly : minCoverageDaily
        const symbolTimeframe = symbol.code === 'MES' ? INGEST_CONFIG.MES_TIMEFRAME : INGEST_CONFIG.NON_MES_TIMEFRAME
        const sourceSchema = symbol.code === 'MES' ? INGEST_CONFIG.MES_RAW_SCHEMA : INGEST_CONFIG.NON_MES_RAW_SCHEMA
        const rawMinCoverage =
          symbol.code === 'MES'
            ? Math.floor(INGEST_CONFIG.EXPECTED_H1_CANDLES_PER_SYMBOL * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100))
            : Math.floor(INGEST_CONFIG.EXPECTED_D1_CANDLES_PER_SYMBOL * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100))

        const existingCount = await existingCountForSymbol(symbol.code)
        if (existingCount >= symbolMinCoverage) {
          symbolsCoveragePct[symbol.code] = Number(((existingCount / symbolMinCoverage) * 100).toFixed(2))
          symbolsProcessed.push(symbol.code)
          console.log(
            `[market-prices] SUCCESS: ${symbol.code} already compliant in DB (${existingCount} ${symbolTimeframe} rows >= ${symbolMinCoverage}).`
          )
          continue
        }

        const symbolChunks = symbol.code === 'MES' ? chunks : [{ start, end }]
        console.log(`\n[market-prices] ${symbol.code} ingest start (${symbolChunks.length} chunks)`)
        const rawCandlesAll: ReturnType<typeof toCandles> = []

        for (let chunkIndex = 0; chunkIndex < symbolChunks.length; chunkIndex++) {
          const chunk = symbolChunks[chunkIndex]
          if (
            chunkIndex === 0 ||
            (chunkIndex + 1) % 5 === 0 ||
            chunkIndex === symbolChunks.length - 1
          ) {
            console.log(`[market-prices] ${symbol.code} chunk ${chunkIndex + 1}/${symbolChunks.length}`)
          }

          const records = await withTimeout(
            fetchOhlcv({
              dataset: symbol.dataset,
              symbol: symbol.databentoSymbol,
              stypeIn: 'continuous',
              start: formatUtcIso(chunk.start),
              end: formatUtcIso(chunk.end),
              schema: sourceSchema,
            }),
            symbol.code === 'MES' ? 120_000 : 60_000,
            `Databento ${symbol.code} ${sourceSchema}`
          )

          if (records.length === 0) continue
          const chunkCandles = toCandles(records)

          if (hasInvalidRealData(chunkCandles)) {
            symbolsFailed[symbol.code] =
              `FAKE_DATA_DETECTED: invalid/zero OHLCV in raw candles for ${symbol.code}; zero tolerance.`
            console.error(`[market-prices] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
            rawCandlesAll.length = 0
            break
          }

          rawCandlesAll.push(...chunkCandles)
        }

        if (symbolsFailed[symbol.code]) continue
        if (rawCandlesAll.length === 0) {
          symbolsFailed[symbol.code] = `AUDIT_FAIL: ${symbol.code} returned zero raw 1m rows.`
          console.error(`[market-prices] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        if (rawCandlesAll.length < rawMinCoverage) {
          symbolsFailed[symbol.code] =
            `AUDIT_FAIL: ${symbol.code} raw count=${rawCandlesAll.length} below enforced ${sourceSchema} threshold ${rawMinCoverage}.`
          console.error(`[market-prices] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        const uniqueCandles = sanitizeCandles(rawCandlesAll)
        const aggregated = aggregateCandles(uniqueCandles, symbol.code === 'MES' ? 60 : 1440)
        if (aggregated.some((candle) => candle.close == null || !Number.isFinite(candle.close))) {
          symbolsFailed[symbol.code] =
            `GAP_DETECTED_IN_RESAMPLE: ${symbol.code} has null/invalid close after aggregation.`
          console.error(`[market-prices] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        const coveragePct = (aggregated.length / symbolMinCoverage) * 100
        symbolsCoveragePct[symbol.code] = Number(coveragePct.toFixed(2))
        if (aggregated.length < symbolMinCoverage) {
          symbolsFailed[symbol.code] =
            `AUDIT_FAIL: ${symbol.code} has ${aggregated.length} ${symbolTimeframe} rows (< ${symbolMinCoverage}, ${INGEST_CONFIG.MIN_COVERAGE_PCT}% coverage). Excluding.`
          console.error(`[market-prices] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        const result = await insertCandlesForSymbol(
          symbol.code,
          symbol.dataset,
          sourceSchema,
          aggregated,
          dryRun
        )
        rowsProcessed += result.processed
        rowsInserted += result.inserted

        symbolsProcessed.push(symbol.code)
        console.log(
          `[market-prices] SUCCESS: ${symbol.code} full 2y ${symbolTimeframe} loaded – ${aggregated.length} rows, no fake data.`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        symbolsFailed[symbol.code] = message.slice(0, 400)
        console.error(`[market-prices] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
      }
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

    const status = Object.keys(symbolsFailed).length === 0 ? 'SUCCEEDED' : 'PARTIAL'
    const summary: PriceIngestSummary = {
      timeframe: `MES=${INGEST_CONFIG.MES_TIMEFRAME};NON_MES=${INGEST_CONFIG.NON_MES_TIMEFRAME}`,
      sourceSchema: `MES=${INGEST_CONFIG.MES_RAW_SCHEMA};NON_MES=${INGEST_CONFIG.NON_MES_RAW_SCHEMA}`,
      daysBack: INGEST_CONFIG.HISTORY_DAYS,
      symbolsRequested: [...INGEST_CONFIG.SYMBOL_UNIVERSE],
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
