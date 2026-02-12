import { Prisma } from '@prisma/client'
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

type MacroSource = Prisma.MacroIndicatorCreateManyInput['source']

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

function candlesToRows(
  indicator: string,
  candles: CandleData[],
  source: MacroSource,
  sourceSymbol: string
): Prisma.MacroIndicatorCreateManyInput[] {
  return candles
    .filter((c) => Number.isFinite(c.close))
    .map((c) => ({
      indicator,
      timestamp: asUtcDateFromUnixSeconds(c.time),
      value: c.close,
      source,
      sourceSymbol,
    }))
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

export async function runIngestMacroIndicators(): Promise<MacroIngestSummary> {
  loadDotEnvFiles()

  const daysBack = Number(parseArg('days-back', '730'))
  const dryRun = parseArg('dry-run', 'false').toLowerCase() === 'true'
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
    indicator: string
    source: MacroSource
    sourceSymbol: string
    fetcher: () => Promise<CandleData[]>
  }> = [
    {
      indicator: 'VIXCLS',
      source: 'FRED',
      sourceSymbol: 'VIXCLS',
      fetcher: () => fetchVixCandles(startDate, endDate),
    },
    {
      indicator: 'FEDFUNDS',
      source: 'FRED',
      sourceSymbol: 'FEDFUNDS',
      fetcher: () => fetchFedFundsCandles(startDate, endDate),
    },
    {
      indicator: 'DTWEXBGS',
      source: 'FRED',
      sourceSymbol: 'DTWEXBGS',
      fetcher: () => fetchDollarCandles(startDate, endDate),
    },
    {
      indicator: 'DGS10',
      source: 'FRED',
      sourceSymbol: 'DGS10',
      fetcher: () => fetchTenYearYieldCandles(startDate, endDate),
    },
    {
      indicator: 'FXI_CLOSE',
      source: 'YAHOO',
      sourceSymbol: 'FXI',
      fetcher: () => fetchYahooDailyClose('FXI', daysBack),
    },
  ]

  try {
    for (const job of jobs) {
      try {
        console.log(`[macro] ingesting ${job.indicator}`)
        const candles = await job.fetcher()
        const rows = candlesToRows(job.indicator, candles, job.source, job.sourceSymbol)
        rowsProcessed += rows.length
        if (!dryRun && rows.length > 0) {
          const inserted = await prisma.macroIndicator.createMany({
            data: rows,
            skipDuplicates: true,
          })
          rowsInserted += inserted.count
        }
        indicatorsProcessed.push(job.indicator)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        indicatorsFailed[job.indicator] = message.slice(0, 400)
        console.error(`[macro] failed ${job.indicator}: ${indicatorsFailed[job.indicator]}`)
      }
    }

    const status = Object.keys(indicatorsFailed).length === 0 ? 'SUCCEEDED' : 'PARTIAL'
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
