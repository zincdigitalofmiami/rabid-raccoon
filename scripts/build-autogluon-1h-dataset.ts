// NOTE: macro_surprise_avg_7d was removed in stabilization pass #2.
// The macro_reports_1d table has no actual surprise values (all null from RSS feeds).
// Re-add this feature when an economic calendar surprise source is integrated
// (e.g., Trading Economics API or Investing.com calendar).
// See: scripts/ingest-alt-news-feeds.ts lines 449-455.
import fs from 'node:fs'
import path from 'node:path'
import { Timeframe } from '@prisma/client'
import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles, parseArg } from './ingest-utils'

type DailyPoint = { eventDate: Date; value: number | null }
type SignalPoint = { timestamp: Date; target100: number; target1236: number; direction: 'BULLISH' | 'BEARISH' }
type NewsPoint = { eventDate: Date; count: number }
type PolicyPoint = { eventDate: Date; sentiment: number | null; impact: number | null }

interface OutputRow {
  item_id: string
  timestamp: string
  target: number
  hour_utc: number
  day_of_week_utc: number
  is_month_start: number
  is_month_end: number
  vix_level: number | null
  us10y_yield: number | null
  fed_funds: number | null
  usd_index: number | null
  mm_target100_delta: number | null
  mm_target1236_delta: number | null
  mm_direction_is_bullish: number | null
  news_count_7d: number
  news_fed_count_7d: number
  news_sec_count_7d: number
  news_ecb_count_7d: number
  policy_count_7d: number
  policy_avg_sentiment: number | null
  policy_avg_impact: number | null
}

function toDateKeyUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function asofValue(points: DailyPoint[], date: Date): number | null {
  const targetKey = toDateKeyUtc(date)
  let best: number | null = null
  for (const point of points) {
    if (toDateKeyUtc(point.eventDate) <= targetKey) {
      best = point.value ?? null
    } else {
      break
    }
  }
  return best
}

function asofSignal(points: SignalPoint[], ts: Date): SignalPoint | null {
  let best: SignalPoint | null = null
  for (const point of points) {
    if (point.timestamp < ts) {
      best = point
    } else {
      break
    }
  }
  return best
}

function countNewsLast7d(points: NewsPoint[], ts: Date): number {
  const ts7dAgo = new Date(ts.getTime() - 7 * 24 * 60 * 60 * 1000)
  const targetKey = toDateKeyUtc(ts)
  return points.filter((p) => {
    const pKey = toDateKeyUtc(p.eventDate)
    return pKey >= toDateKeyUtc(ts7dAgo) && pKey < targetKey
  }).reduce((sum, p) => sum + p.count, 0)
}

function avgPolicyLast7d(points: PolicyPoint[], ts: Date, field: 'sentiment' | 'impact'): number | null {
  const ts7dAgo = new Date(ts.getTime() - 7 * 24 * 60 * 60 * 1000)
  const targetKey = toDateKeyUtc(ts)
  const relevant = points.filter((p) => {
    const pKey = toDateKeyUtc(p.eventDate)
    return pKey >= toDateKeyUtc(ts7dAgo) && pKey < targetKey && p[field] != null
  })
  if (relevant.length === 0) return null
  const sum = relevant.reduce((acc, p) => acc + (p[field] ?? 0), 0)
  return sum / relevant.length
}

function quoteCsv(value: string | number | null): string {
  if (value == null) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (!/[",\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function writeCsv(filePath: string, rows: OutputRow[]): void {
  const header = [
    'item_id',
    'timestamp',
    'target',
    'hour_utc',
    'day_of_week_utc',
    'is_month_start',
    'is_month_end',
    'vix_level',
    'us10y_yield',
    'fed_funds',
    'usd_index',
    'mm_target100_delta',
    'mm_target1236_delta',
    'mm_direction_is_bullish',
    'news_count_7d',
    'news_fed_count_7d',
    'news_sec_count_7d',
    'news_ecb_count_7d',
    'policy_count_7d',
    'policy_avg_sentiment',
    'policy_avg_impact',
  ]

  const lines: string[] = [header.join(',')]
  for (const row of rows) {
    lines.push(
      [
        row.item_id,
        row.timestamp,
        row.target,
        row.hour_utc,
        row.day_of_week_utc,
        row.is_month_start,
        row.is_month_end,
        row.vix_level,
        row.us10y_yield,
        row.fed_funds,
        row.usd_index,
        row.mm_target100_delta,
        row.mm_target1236_delta,
        row.mm_direction_is_bullish,
        row.news_count_7d,
        row.news_fed_count_7d,
        row.news_sec_count_7d,
        row.news_ecb_count_7d,
        row.policy_count_7d,
        row.policy_avg_sentiment,
        row.policy_avg_impact,
      ]
        .map(quoteCsv)
        .join(',')
    )
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8')
}

async function run(): Promise<void> {
  loadDotEnvFiles()

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required')
  }

  const daysBack = Number(parseArg('days-back', '730'))
  const outFile = parseArg('out', 'datasets/autogluon/mes_1h.csv')
  if (!Number.isFinite(daysBack) || daysBack <= 0) {
    throw new Error(`Invalid --days-back '${daysBack}'`)
  }

  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  const [mesRows, vixRows, y10Rows, dffRows, dxyRows, mmRows, newsRows, policyRows] = await Promise.all([
    prisma.mesPrice1h.findMany({
      where: { eventTime: { gte: start } },
      orderBy: { eventTime: 'asc' },
      select: {
        eventTime: true,
        close: true,
      },
    }),
    prisma.econVolIndices1d.findMany({
      where: { seriesId: 'VIXCLS' },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, value: true },
    }),
    prisma.econYields1d.findMany({
      where: { seriesId: 'DGS10' },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, value: true },
    }),
    prisma.econRates1d.findMany({
      where: { seriesId: 'DFF' },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, value: true },
    }),
    prisma.econFx1d.findMany({
      where: { seriesId: 'DTWEXBGS' },
      orderBy: { eventDate: 'asc' },
      select: { eventDate: true, value: true },
    }),
    prisma.measuredMoveSignal.findMany({
      where: {
        symbolCode: 'MES',
        timeframe: Timeframe.H1,
        timestamp: { gte: new Date(start.getTime() - 60 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true, target100: true, target1236: true, direction: true },
    }),
    // Econ news with source-specific counts
    prisma.$queryRaw<{ eventDate: Date; total_count: number; fed_count: number; sec_count: number; ecb_count: number }[]>`
      SELECT
        "eventDate"::date as "eventDate",
        COUNT(*)::int as total_count,
        COUNT(*) FILTER (WHERE "source" ILIKE '%fed%' OR "headline" ILIKE '%federal reserve%')::int as fed_count,
        COUNT(*) FILTER (WHERE "source" ILIKE '%sec%' OR "headline" ILIKE '%securities and exchange%')::int as sec_count,
        COUNT(*) FILTER (WHERE "source" ILIKE '%ecb%' OR "headline" ILIKE '%european central bank%')::int as ecb_count
      FROM "econ_news_1d"
      GROUP BY "eventDate"
      ORDER BY "eventDate" ASC
    `,
    // Policy news aggregated by day
    prisma.$queryRaw<{ eventDate: Date; count: number; avgSentiment: number | null; avgImpact: number | null }[]>`
      SELECT
        "eventDate"::date as "eventDate",
        COUNT(*)::int as count,
        AVG("sentimentScore") as "avgSentiment",
        AVG("impactScore") as "avgImpact"
      FROM "policy_news_1d"
      GROUP BY "eventDate"
      ORDER BY "eventDate" ASC
    `,
  ])

  if (mesRows.length < 200) {
    throw new Error(`Insufficient MES 1h history (${mesRows.length} rows). Ingest prices first.`)
  }

  console.log(`[dataset] Loaded ${newsRows.length} econ news days, ${policyRows.length} policy news days`)

  const newsPoints: NewsPoint[] = newsRows.map((r) => ({ eventDate: r.eventDate, count: r.total_count }))
  const newsFedPoints: NewsPoint[] = newsRows.map((r) => ({ eventDate: r.eventDate, count: r.fed_count }))
  const newsSecPoints: NewsPoint[] = newsRows.map((r) => ({ eventDate: r.eventDate, count: r.sec_count }))
  const newsEcbPoints: NewsPoint[] = newsRows.map((r) => ({ eventDate: r.eventDate, count: r.ecb_count }))
  const policyPoints: PolicyPoint[] = policyRows.map((r) => ({
    eventDate: r.eventDate,
    sentiment: r.avgSentiment,
    impact: r.avgImpact,
  }))
  const output: OutputRow[] = mesRows.map((row) => {
    const ts = row.eventTime
    const mm = asofSignal(mmRows, ts)

    const vix = asofValue(vixRows, ts)
    const y10 = asofValue(y10Rows, ts)
    const dff = asofValue(dffRows, ts)
    const dxy = asofValue(dxyRows, ts)

    const target100Delta = mm ? mm.target100 - row.close : null
    const target1236Delta = mm ? mm.target1236 - row.close : null

    const newsCount7d = countNewsLast7d(newsPoints, ts)
    const newsFedCount7d = countNewsLast7d(newsFedPoints, ts)
    const newsSecCount7d = countNewsLast7d(newsSecPoints, ts)
    const newsEcbCount7d = countNewsLast7d(newsEcbPoints, ts)
    const policyCount7d = countNewsLast7d(policyPoints.map((p) => ({ eventDate: p.eventDate, count: 1 })), ts)
    const policyAvgSentiment = avgPolicyLast7d(policyPoints, ts, 'sentiment')
    const policyAvgImpact = avgPolicyLast7d(policyPoints, ts, 'impact')

    const utcDay = ts.getUTCDate()
    const utcMonth = ts.getUTCMonth()
    const utcYear = ts.getUTCFullYear()
    const monthEnd = new Date(Date.UTC(utcYear, utcMonth + 1, 0)).getUTCDate()

    return {
      item_id: 'MES_1H',
      timestamp: ts.toISOString(),
      target: row.close,
      hour_utc: ts.getUTCHours(),
      day_of_week_utc: ts.getUTCDay(),
      is_month_start: utcDay === 1 ? 1 : 0,
      is_month_end: utcDay === monthEnd ? 1 : 0,
      vix_level: vix,
      us10y_yield: y10,
      fed_funds: dff,
      usd_index: dxy,
      mm_target100_delta: target100Delta,
      mm_target1236_delta: target1236Delta,
      mm_direction_is_bullish: mm ? (mm.direction === 'BULLISH' ? 1 : 0) : null,
      news_count_7d: newsCount7d,
      news_fed_count_7d: newsFedCount7d,
      news_sec_count_7d: newsSecCount7d,
      news_ecb_count_7d: newsEcbCount7d,
      policy_count_7d: policyCount7d,
      policy_avg_sentiment: policyAvgSentiment,
      policy_avg_impact: policyAvgImpact,
    }
  })

  for (let i = 1; i < output.length; i++) {
    if (output[i].timestamp <= output[i - 1].timestamp) {
      throw new Error(`Timestamp order violation at row ${i}`)
    }
  }

  if (output.some((row) => !Number.isFinite(row.target) || row.target <= 0)) {
    throw new Error('Target validation failed: non-positive or invalid target values detected.')
  }

  writeCsv(path.resolve(process.cwd(), outFile), output)

  const schema = {
    dataset: 'MES_1H',
    format: 'autogluon-timeseries-csv',
    columns: {
      item_id: 'string',
      timestamp: 'datetime-iso8601',
      target: 'float64',
      hour_utc: 'int32',
      day_of_week_utc: 'int32',
      is_month_start: 'int8',
      is_month_end: 'int8',
      vix_level: 'float64|null',
      us10y_yield: 'float64|null',
      fed_funds: 'float64|null',
      usd_index: 'float64|null',
      mm_target100_delta: 'float64|null',
      mm_target1236_delta: 'float64|null',
      mm_direction_is_bullish: 'int8|null',
      news_count_7d: 'int32',
      news_fed_count_7d: 'int32',
      news_sec_count_7d: 'int32',
      news_ecb_count_7d: 'int32',
      policy_count_7d: 'int32',
      policy_avg_sentiment: 'float64|null',
      policy_avg_impact: 'float64|null',
    },
    predictor: {
      target: 'target',
      known_covariates_names: ['hour_utc', 'day_of_week_utc', 'is_month_start', 'is_month_end'],
      past_covariates_names: [
        'vix_level',
        'us10y_yield',
        'fed_funds',
        'usd_index',
        'mm_target100_delta',
        'mm_target1236_delta',
        'mm_direction_is_bullish',
        'news_count_7d',
        'news_fed_count_7d',
        'news_sec_count_7d',
        'news_ecb_count_7d',
        'policy_count_7d',
        'policy_avg_sentiment',
        'policy_avg_impact',
      ],
      item_id_column: 'item_id',
      timestamp_column: 'timestamp',
      frequency: '1H',
    },
    rows: output.length,
    dateRange: {
      start: output[0]?.timestamp || null,
      end: output[output.length - 1]?.timestamp || null,
    },
  }

  const schemaFile = path.resolve(process.cwd(), outFile.replace(/\.csv$/i, '.schema.json'))
  fs.writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, 'utf8')

  console.log('[dataset:autogluon:1h] done')
  console.log(JSON.stringify({ outFile, schemaFile, rows: output.length }, null, 2))
}

run()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[dataset:autogluon:1h] failed: ${message}`)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
