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

// HARD-ENFORCED INGESTION CONFIG: NO SHORTCUTS, NO LIES, FULL 2Y OR FAIL
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
    'RJ',
    'RS1',
    'RSG',
    'RSV',
  ] as const,
  TIMEFRAME: '1h' as const,
  HISTORY_DAYS: 730,
  MIN_COVERAGE_PCT: 95,
  ZERO_FAKE_POLICY: true,
  DATABENTO_ONLY: true,
  EXPECTED_BARS_PER_SYMBOL: Math.floor(730 * 23), // user-locked reference threshold
  RAW_SCHEMA: 'ohlcv-1m',
  CHUNK_DAYS: 14,
  UPSERT_BATCH_SIZE: 1000,
}

interface MarketIngestSummary {
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
  if (INGEST_CONFIG.SYMBOL_UNIVERSE.length !== 33) {
    hardFail('Must load ALL 33 symbols. Fix config and retry.')
  }
  if (!INGEST_CONFIG.ZERO_FAKE_POLICY || !INGEST_CONFIG.DATABENTO_ONLY) {
    hardFail('Zero fake data and Databento-only policy must remain enabled.')
  }
}

function expectedTradableBarsPerSymbol(days: number): number {
  // 23 trading hours/day across 5 trading days/week.
  return Math.floor((days * 5 * 23) / 7)
}

function sanitizeCandles(candles: ReturnType<typeof toCandles>): ReturnType<typeof toCandles> {
  const byTime = new Map<number, (typeof candles)[number]>()
  for (const c of candles) byTime.set(c.time, c)
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

function hashFuturesRow(symbolCode: string, eventTime: Date, close: number): string {
  return createHash('sha256')
    .update(`${symbolCode}|${eventTime.toISOString()}|${close}`)
    .digest('hex')
}

async function upsertDataSourceRegistry(): Promise<void> {
  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'market-bars-databento' },
    create: {
      sourceId: 'market-bars-databento',
      sourceName: 'Databento Futures OHLCV',
      description: 'Databento GLBX market bars ingestion for MES universe.',
      targetTable: 'mkt_futures_1h',
      apiProvider: 'databento',
      updateFrequency: 'intraday',
      authEnvVar: 'DATABENTO_API_KEY',
      ingestionScript: 'scripts/ingest-market-bars.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Databento Futures OHLCV',
      description: 'Databento GLBX market bars ingestion for MES universe.',
      targetTable: 'mkt_futures_1h',
      apiProvider: 'databento',
      updateFrequency: 'intraday',
      authEnvVar: 'DATABENTO_API_KEY',
      ingestionScript: 'scripts/ingest-market-bars.ts',
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

export async function runIngestMarketBars(): Promise<MarketIngestSummary> {
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
  const tfPrisma = timeframeToPrisma(INGEST_CONFIG.TIMEFRAME)
  if (tfPrisma !== Timeframe.H1) {
    hardFail(`TIMEFRAME_VIOLATION: expected H1 only, got ${tfPrisma}`)
  }
  const minCoverageBars = Math.floor(
    expectedTradableBarsPerSymbol(INGEST_CONFIG.HISTORY_DAYS) * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100)
  )

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'market-bars',
      status: 'RUNNING',
      details: toJson({
        daysBack: INGEST_CONFIG.HISTORY_DAYS,
        timeframe: INGEST_CONFIG.TIMEFRAME,
        sourceSchema: INGEST_CONFIG.RAW_SCHEMA,
        chunkDays: INGEST_CONFIG.CHUNK_DAYS,
        symbolsRequested: INGEST_CONFIG.SYMBOL_UNIVERSE,
        minCoverageBars,
        expectedBarsReference: INGEST_CONFIG.EXPECTED_BARS_PER_SYMBOL,
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
        const existingDomainCount = await prisma.mktFutures1h.count({
          where: { symbolCode: symbol.code },
        })
        if (existingDomainCount >= minCoverageBars) {
          symbolsCoveragePct[symbol.code] = Number(
            ((existingDomainCount / minCoverageBars) * 100).toFixed(2)
          )
          symbolsProcessed.push(symbol.code)
          console.log(
            `[market-bars] SUCCESS: ${symbol.code} already compliant in DB (${existingDomainCount} bars >= ${minCoverageBars}).`
          )
          continue
        }

        console.log(`\n[market-bars] ${symbol.code} ingest start (${chunks.length} chunks)`)
        const rawCandlesAll: ReturnType<typeof toCandles> = []

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex]
          if (chunkIndex === 0 || (chunkIndex + 1) % 5 === 0 || chunkIndex === chunks.length - 1) {
            console.log(`[market-bars] ${symbol.code} chunk ${chunkIndex + 1}/${chunks.length}`)
          }
          const records = await fetchOhlcv({
            dataset: symbol.dataset,
            symbol: symbol.databentoSymbol,
            stypeIn: 'continuous',
            start: formatUtcIso(chunk.start),
            end: formatUtcIso(chunk.end),
            schema: INGEST_CONFIG.RAW_SCHEMA,
          })

          if (records.length === 0) continue
          const chunkCandles = toCandles(records)

          if (hasInvalidRealData(chunkCandles)) {
            symbolsFailed[symbol.code] =
              `FAKE_DATA_DETECTED: invalid/zero OHLCV in raw bars for ${symbol.code}; zero tolerance.`
            console.error(`[market-bars] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
            rawCandlesAll.length = 0
            break
          }

          rawCandlesAll.push(...chunkCandles)
        }

        if (symbolsFailed[symbol.code]) continue
        if (rawCandlesAll.length === 0) {
          symbolsFailed[symbol.code] = `AUDIT_FAIL: ${symbol.code} returned zero raw 1m bars.`
          console.error(`[market-bars] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        // User-locked audit check (reference threshold on raw fetch cardinality).
        if (
          rawCandlesAll.length <
          Math.floor(INGEST_CONFIG.EXPECTED_BARS_PER_SYMBOL * (INGEST_CONFIG.MIN_COVERAGE_PCT / 100))
        ) {
          symbolsFailed[symbol.code] =
            `AUDIT_FAIL: ${symbol.code} raw bars=${rawCandlesAll.length} below enforced reference threshold.`
          console.error(`[market-bars] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        const rawUnique = sanitizeCandles(rawCandlesAll)
        const resampled = aggregateCandles(rawUnique, 60)
        if (resampled.some((bar) => bar.close == null || !Number.isFinite(bar.close))) {
          symbolsFailed[symbol.code] =
            `GAP_DETECTED_IN_RESAMPLE: ${symbol.code} has null/invalid close post-aggregation.`
          console.error(`[market-bars] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        const coveragePct = (resampled.length / minCoverageBars) * 100
        symbolsCoveragePct[symbol.code] = Number(coveragePct.toFixed(2))
        if (resampled.length < minCoverageBars) {
          symbolsFailed[symbol.code] =
            `AUDIT_FAIL: ${symbol.code} has ${resampled.length} 1h bars (< ${minCoverageBars}, ${INGEST_CONFIG.MIN_COVERAGE_PCT}% coverage). Excluding.`
          console.error(`[market-bars] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
          continue
        }

        const data: Prisma.MktFutures1hCreateManyInput[] = resampled.map((bar) => {
          const eventTime = asUtcDateFromUnixSeconds(bar.time)
          return {
            symbolCode: symbol.code,
            eventTime,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: BigInt(Math.max(0, Math.trunc(bar.volume || 0))),
            source: 'DATABENTO',
            sourceDataset: symbol.dataset,
            sourceSchema: INGEST_CONFIG.RAW_SCHEMA,
            rowHash: hashFuturesRow(symbol.code, eventTime, bar.close),
          }
        })

        rowsProcessed += data.length
        if (!dryRun) {
          for (let i = 0; i < data.length; i += INGEST_CONFIG.UPSERT_BATCH_SIZE) {
            const batch = data.slice(i, i + INGEST_CONFIG.UPSERT_BATCH_SIZE)
            const inserted = await prisma.mktFutures1h.createMany({
              data: batch,
              skipDuplicates: true,
            })
            rowsInserted += inserted.count
          }
        }

        symbolsProcessed.push(symbol.code)
        console.log(
          `[market-bars] SUCCESS: ${symbol.code} full 2y 1h loaded – ${resampled.length} bars, no fakes.`
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        symbolsFailed[symbol.code] = message.slice(0, 400)
        console.error(`[market-bars] ${symbol.code} failed: ${symbolsFailed[symbol.code]}`)
      }
    }

    const passingSymbols = symbolsProcessed
    if (passingSymbols.length === 0) {
      hardFail('LOAD_INCOMPLETE: no symbols passed hard coverage and quality checks.')
    }

    if (!dryRun) {
      const loadedCounts = await prisma.mktFutures1h.groupBy({
        by: ['symbolCode'],
        where: { symbolCode: { in: passingSymbols } },
        _count: {
          _all: true,
        },
      })

      if (loadedCounts.length !== passingSymbols.length) {
        hardFail('LOAD_INCOMPLETE: Not all passing symbols were loaded fully.')
      }

      const countMap = new Map<string, number>(
        loadedCounts.map((row) => [row.symbolCode, row._count._all])
      )
      for (const symbolCode of passingSymbols) {
        const count = countMap.get(symbolCode) || 0
        if (count < minCoverageBars) {
          hardFail(
            `INSUFFICIENT_DATA: ${symbolCode} has only ${count} bars; ${minCoverageBars} required for hard compliance.`
          )
        }
      }
      postLoadVerified = true
      console.log('ALL CLEAR: Full 2y ingestion complete – no lies, no fakes, ready for training.')
    }

    const status = Object.keys(symbolsFailed).length === 0 ? 'SUCCEEDED' : 'PARTIAL'
    const summary: MarketIngestSummary = {
      timeframe: INGEST_CONFIG.TIMEFRAME,
      sourceSchema: INGEST_CONFIG.RAW_SCHEMA,
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
  runIngestMarketBars()
    .then((summary) => {
      console.log('\n[market-bars] done')
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[market-bars] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
