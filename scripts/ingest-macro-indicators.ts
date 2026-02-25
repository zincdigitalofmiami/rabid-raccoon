import { Prisma } from '@prisma/client'
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

type MacroSource = 'FRED'
type SeriesCategory = 'RATES' | 'VOLATILITY' | 'FX' | 'EQUITY' | 'OTHER'
type MacroDomain = 'RATES' | 'YIELDS' | 'FX' | 'VOL_INDICES'

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue
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
      const inserted = await splitFn()
      return inserted.count
    } catch (err) {
      console.warn(`[macro] split table write failed for ${domain}: ${err instanceof Error ? err.message : err}`)
    }
  }
  return 0
}

interface IndicatorJob {
  seriesId: string
  displayName: string
  domain: MacroDomain
  source: MacroSource
  sourceSymbol: string
  frequency: string
  units: string
  fetcher: () => Promise<CandleData[]>
}

interface IndicatorResult {
  processed: number
  inserted: number
}

async function processIndicator(job: IndicatorJob, dryRun: boolean): Promise<IndicatorResult> {
  console.log(`[macro] ingesting ${job.seriesId}`)
  const candles = await job.fetcher()
  const rows = candlesToValueRows(job.seriesId, candles, job.source)

  if (dryRun) return { processed: rows.length, inserted: 0 }

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

  const inserted = await insertDomainRows(job.domain, job.sourceSymbol, rows)
  return { processed: rows.length, inserted }
}

interface ResolvedMacroOptions {
  daysBack: number
  dryRun: boolean
}

function resolveMacroOptions(options?: MacroIngestOptions): ResolvedMacroOptions {
  const daysBack = Number.isFinite(options?.daysBack)
    ? Number(options?.daysBack)
    : Number(parseArg('days-back', '730'))
  const dryRun = options?.dryRun ?? parseArg('dry-run', 'false').toLowerCase() === 'true'
  return { daysBack, dryRun }
}

function buildIndicatorJobs(startDate: string, endDate: string): IndicatorJob[] {
  return [
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
  ]
}

export async function runIngestMacroIndicators(options?: MacroIngestOptions): Promise<MacroIngestSummary> {
  loadDotEnvFiles()

  const { daysBack, dryRun } = resolveMacroOptions(options)
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
  const jobs = buildIndicatorJobs(startDate, endDate)

  try {
    if (!dryRun) {
      await upsertDataSourceRegistry()
    }

    for (const job of jobs) {
      try {
        const result = await processIndicator(job, dryRun)
        rowsProcessed += result.processed
        rowsInserted += result.inserted
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
