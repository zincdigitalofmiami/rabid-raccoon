import { Prisma, EconCategory } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../src/lib/prisma'
import {
  fetchDollarCandles,
  fetchFedFundsCandles,
  fetchTenYearYieldCandles,
  fetchVixCandles,
} from '../src/lib/fred'
import { CandleData } from '../src/lib/types'
import { asUtcDateFromUnixSeconds, loadDotEnvFiles, parseArg } from './ingest-utils'

interface MacroIngestSummary {
  daysBack: number
  rowsInserted: number
  rowsProcessed: number
  indicatorsProcessed: string[]
  indicatorsFailed: Record<string, string>
  dryRun: boolean
}

interface MacroIngestOptions {
  daysBack?: number
  dryRun?: boolean
}

type MacroSource = 'FRED' | 'YAHOO'
type SeriesCategory = 'RATES' | 'VOLATILITY' | 'FX' | 'EQUITY' | 'OTHER'
type MacroDomain = 'RATES' | 'YIELDS' | 'FX' | 'VOL_INDICES' | 'INDEXES'

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
}

interface YahooChartResult {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          close?: Array<number | null>
        }>
      }
    }>
    error?: { description?: string }
  }
}

function toUtcDateOnlyFromUnixSeconds(unixSeconds: number): Date {
  const dt = asUtcDateFromUnixSeconds(unixSeconds)
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()))
}

function hashEconomicRow(seriesId: string, eventDate: Date, value: number, source: MacroSource): string {
  return createHash('sha256')
    .update(`${seriesId}|${eventDate.toISOString().slice(0, 10)}|${value}|${source}`)
    .digest('hex')
}

interface EconValueRow {
  seriesId: string
  eventDate: Date
  value: number
  source: MacroSource
  rowHash: string
}

function candlesToValueRows(
  seriesId: string,
  candles: CandleData[],
  source: MacroSource
): EconValueRow[] {
  return candles.filter((c) => Number.isFinite(c.close)).map((c) => {
    const eventDate = toUtcDateOnlyFromUnixSeconds(c.time)
    return {
      seriesId,
      eventDate,
      value: c.close,
      source,
      rowHash: hashEconomicRow(seriesId, eventDate, c.close, source),
    }
  })
}

async function upsertDataSourceRegistry(): Promise<void> {
  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'econ-fred-indicators' },
    create: {
      sourceId: 'econ-fred-indicators',
      sourceName: 'FRED Economic Indicators',
      description: 'Daily economic indicators sourced from FRED.',
      targetTable: 'econ_rates_1d,econ_yields_1d,econ_fx_1d,econ_vol_indices_1d',
      apiProvider: 'fred',
      updateFrequency: 'daily',
      authEnvVar: 'FRED_API_KEY',
      ingestionScript: 'scripts/ingest-macro-indicators.ts',
      isActive: true,
    },
    update: {
      sourceName: 'FRED Economic Indicators',
      description: 'Daily economic indicators sourced from FRED.',
      targetTable: 'econ_rates_1d,econ_yields_1d,econ_fx_1d,econ_vol_indices_1d',
      apiProvider: 'fred',
      updateFrequency: 'daily',
      authEnvVar: 'FRED_API_KEY',
      ingestionScript: 'scripts/ingest-macro-indicators.ts',
      isActive: true,
    },
  })

  await prisma.dataSourceRegistry.upsert({
    where: { sourceId: 'econ-yahoo-indicators' },
    create: {
      sourceId: 'econ-yahoo-indicators',
      sourceName: 'Yahoo Macro Proxy Indicators',
      description: 'Daily macro proxy closes sourced from Yahoo Finance.',
      targetTable: 'mkt_indexes_1d',
      apiProvider: 'yahoo',
      updateFrequency: 'daily',
      ingestionScript: 'scripts/ingest-macro-indicators.ts',
      isActive: true,
    },
    update: {
      sourceName: 'Yahoo Macro Proxy Indicators',
      description: 'Daily macro proxy closes sourced from Yahoo Finance.',
      targetTable: 'mkt_indexes_1d',
      apiProvider: 'yahoo',
      updateFrequency: 'daily',
      ingestionScript: 'scripts/ingest-macro-indicators.ts',
      isActive: true,
    },
  })
}

function seriesCategoryForDomain(domain: MacroDomain): SeriesCategory {
  switch (domain) {
    case 'RATES':
    case 'YIELDS':
      return 'RATES'
    case 'FX':
      return 'FX'
    case 'VOL_INDICES':
      return 'VOLATILITY'
    case 'INDEXES':
      return 'EQUITY'
    default:
      return 'OTHER'
  }
}

async function insertDomainRows(
  domain: MacroDomain,
  sourceSymbol: string,
  rows: EconValueRow[]
): Promise<number> {
  if (rows.length === 0) return 0

  const categoryMap: Record<MacroDomain, EconCategory | null> = {
    RATES: EconCategory.RATES,
    YIELDS: EconCategory.YIELDS,
    FX: EconCategory.FX,
    VOL_INDICES: EconCategory.VOLATILITY,
    INDEXES: null,
  }

  const category = categoryMap[domain]
  if (category !== null) {
    // Consolidated econ observation
    const inserted = await prisma.econObservation1d.createMany({
      data: rows.map((row) => ({
        category,
        seriesId: row.seriesId,
        eventDate: row.eventDate,
        value: row.value,
        source: row.source,
        rowHash: row.rowHash,
        metadata: toJson({ sourceSymbol }),
      })),
      skipDuplicates: true,
    })

    // Dual-write to domain-specific split table for training pipelines
    const splitData = rows.map((row) => ({
      seriesId: row.seriesId,
      eventDate: row.eventDate,
      value: row.value,
      source: row.source,
      rowHash: row.rowHash,
      metadata: toJson({ sourceSymbol }),
    }))

    const splitInsertMap: Record<string, (() => Promise<{ count: number }>) | undefined> = {
      RATES: () => prisma.econRates1d.createMany({ data: splitData, skipDuplicates: true }),
      YIELDS: () => prisma.econYields1d.createMany({ data: splitData, skipDuplicates: true }),
      FX: () => prisma.econFx1d.createMany({ data: splitData, skipDuplicates: true }),
      VOL_INDICES: () => prisma.econVolIndices1d.createMany({ data: splitData, skipDuplicates: true }),
    }

    const splitFn = splitInsertMap[domain]
    if (splitFn) {
      try {
        await splitFn()
      } catch (err) {
        console.warn(`[macro] split table write failed for ${domain}: ${err instanceof Error ? err.message : err}`)
      }
    }

    return inserted.count
  } else if (domain === 'INDEXES') {
    // Market index
    const inserted = await prisma.mktIndexes1d.createMany({
      data: rows.map((row) => ({
        symbolCode: sourceSymbol,
        eventDate: row.eventDate,
        open: row.value,
        high: row.value,
        low: row.value,
        close: row.value,
        volume: BigInt(0),
        source: row.source,
        sourceSymbol,
        rowHash: row.rowHash,
        metadata: toJson({ seriesId: row.seriesId }),
      })),
      skipDuplicates: true,
    })
    return inserted.count
  }
  return 0
}

async function fetchYahooDailyClose(symbol: string, daysBack: number): Promise<CandleData[]> {
  const endSec = Math.floor(Date.now() / 1000)
  const startSec = endSec - daysBack * 24 * 60 * 60
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`)
  url.searchParams.set('interval', '1d')
  url.searchParams.set('period1', String(startSec))
  url.searchParams.set('period2', String(endSec))
  url.searchParams.set('events', 'history')
  url.searchParams.set('includePrePost', 'false')

  const response = await fetch(url.toString(), {
    headers: {
      'User-Agent': 'RabidRaccoon/1.0',
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Yahoo API error ${response.status}: ${body.slice(0, 300)}`)
  }

  const data = (await response.json()) as YahooChartResult
  const result = data.chart?.result?.[0]
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]?.close) {
    const detail = data.chart?.error?.description || 'missing chart data'
    throw new Error(`Yahoo chart parse failed: ${detail}`)
  }

  const closes = result.indicators.quote[0].close || []
  const out: CandleData[] = []
  for (let i = 0; i < result.timestamp.length; i++) {
    const ts = result.timestamp[i]
    const close = closes[i]
    if (!Number.isFinite(ts) || !Number.isFinite(close || NaN)) continue
    const c = Number(close)
    out.push({ time: ts, open: c, high: c, low: c, close: c, volume: 0 })
  }
  return out
}

export async function runIngestMacroIndicators(options?: MacroIngestOptions): Promise<MacroIngestSummary> {
  loadDotEnvFiles()

  const daysBack = Number.isFinite(options?.daysBack)
    ? Number(options?.daysBack)
    : Number(parseArg('days-back', '730'))
  const dryRun = options?.dryRun ?? parseArg('dry-run', 'false').toLowerCase() === 'true'
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  if (!process.env.FRED_API_KEY) throw new Error('FRED_API_KEY is required')
  if (!Number.isFinite(daysBack) || daysBack <= 0) {
    throw new Error(`Invalid --days-back '${daysBack}'`)
  }

  const run = await prisma.ingestionRun.create({
    data: {
      job: 'macro-indicators',
      status: 'RUNNING',
      details: toJson({ daysBack }),
    },
  })

  let rowsInserted = 0
  let rowsProcessed = 0
  const indicatorsProcessed: string[] = []
  const indicatorsFailed: Record<string, string> = {}
  const now = new Date()
  const startDate = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
  const endDate = now.toISOString().slice(0, 10)

  const jobs: Array<{
    seriesId: string
    displayName: string
    domain: MacroDomain
    source: MacroSource
    sourceSymbol: string
    frequency: string
    units: string
    fetcher: () => Promise<CandleData[]>
  }> = [
    {
      seriesId: 'VIXCLS',
      displayName: 'CBOE Volatility Index',
      domain: 'VOL_INDICES',
      source: 'FRED',
      sourceSymbol: 'VIXCLS',
      frequency: 'daily',
      units: 'index',
      fetcher: () => fetchVixCandles(startDate, endDate),
    },
    {
      seriesId: 'DFF',
      displayName: 'Federal Funds Effective Rate',
      domain: 'RATES',
      source: 'FRED',
      sourceSymbol: 'DFF',
      frequency: 'daily',
      units: 'percent',
      fetcher: () => fetchFedFundsCandles(startDate, endDate),
    },
    {
      seriesId: 'DTWEXBGS',
      displayName: 'Trade Weighted U.S. Dollar Index: Broad',
      domain: 'FX',
      source: 'FRED',
      sourceSymbol: 'DTWEXBGS',
      frequency: 'daily',
      units: 'index',
      fetcher: () => fetchDollarCandles(startDate, endDate),
    },
    {
      seriesId: 'DGS10',
      displayName: '10-Year Treasury Constant Maturity Rate',
      domain: 'YIELDS',
      source: 'FRED',
      sourceSymbol: 'DGS10',
      frequency: 'daily',
      units: 'percent',
      fetcher: () => fetchTenYearYieldCandles(startDate, endDate),
    },
    {
      seriesId: 'FXI_CLOSE',
      displayName: 'iShares China Large-Cap ETF Close',
      domain: 'INDEXES',
      source: 'YAHOO',
      sourceSymbol: 'FXI',
      frequency: 'daily',
      units: 'price',
      fetcher: () => fetchYahooDailyClose('FXI', daysBack),
    },
  ]

  try {
    if (!dryRun) {
      await upsertDataSourceRegistry()
    }

    for (const job of jobs) {
      try {
        console.log(`[macro] ingesting ${job.seriesId}`)
        const candles = await job.fetcher()
        const rows = candlesToValueRows(job.seriesId, candles, job.source)
        rowsProcessed += rows.length
        if (!dryRun) {
          await prisma.economicSeries.upsert({
            where: { seriesId: job.seriesId },
            create: {
              seriesId: job.seriesId,
              displayName: job.displayName,
              category: seriesCategoryForDomain(job.domain),
              source: job.source,
              sourceSymbol: job.sourceSymbol,
              frequency: job.frequency,
              units: job.units,
              isActive: true,
              metadata: toJson({ providerSymbol: job.sourceSymbol, domainTable: job.domain }),
            },
            update: {
              displayName: job.displayName,
              category: seriesCategoryForDomain(job.domain),
              source: job.source,
              sourceSymbol: job.sourceSymbol,
              frequency: job.frequency,
              units: job.units,
              isActive: true,
              metadata: toJson({ providerSymbol: job.sourceSymbol, domainTable: job.domain }),
            },
          })

          rowsInserted += await insertDomainRows(job.domain, job.sourceSymbol, rows)
        }
        indicatorsProcessed.push(job.seriesId)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        indicatorsFailed[job.seriesId] = message.slice(0, 400)
        console.error(`[macro] failed ${job.seriesId}: ${indicatorsFailed[job.seriesId]}`)
      }
    }

    const status = Object.keys(indicatorsFailed).length === 0 ? 'COMPLETED' : 'FAILED'
    const summary: MacroIngestSummary = {
      daysBack,
      rowsInserted,
      rowsProcessed,
      indicatorsProcessed,
      indicatorsFailed,
      dryRun,
    }

    await prisma.ingestionRun.update({
      where: { id: run.id },
      data: {
        status,
        finishedAt: new Date(),
        rowsProcessed,
        rowsInserted,
        rowsFailed: Object.keys(indicatorsFailed).length,
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
        rowsFailed: Object.keys(indicatorsFailed).length + 1,
        details: toJson({
          error: message,
          indicatorsFailed,
        }),
      },
    })
    throw error
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runIngestMacroIndicators()
    .then((summary) => {
      console.log('\n[macro] done')
      console.log(JSON.stringify(summary, null, 2))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[macro] failed: ${message}`)
      process.exit(1)
    })
    .finally(async () => {
      await prisma.$disconnect()
    })
}
