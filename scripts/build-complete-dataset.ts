import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles, parseArg } from './ingest-utils'
import fs from 'node:fs'
import path from 'node:path'

/**
 * COMPLETE DATASET BUILDER
 * Pulls EVERY available data source from the database for AutoGluon training
 */

interface SeriesAggregate {
    eventDate: Date
    avgValue: number | null
    minValue: number | null
    maxValue: number | null
    count: number
}

interface OutputRow {
    item_id: string
    timestamp: string
    target: number
    // Time features
    hour_utc: number
    day_of_week_utc: number
    is_month_start: number
    is_month_end: number
    // Market data
    vix_level: number | null
    // Rates & Yields (aggregated)
    rates_avg: number | null
    rates_count: number
    yields_avg: number | null
    yields_count: number
    // FX
    fx_avg: number | null
    fx_count: number
    // Inflation
    inflation_avg: number | null
    inflation_count: number
    // Labor
    labor_avg: number | null
    labor_count: number
    // Activity
    activity_avg: number | null
    activity_count: number
    // Money Supply
    money_avg: number | null
    money_count: number
    // Commodities
    commodities_avg: number | null
    commodities_count: number
    // Market Indexes
    mkt_indexes_avg: number | null
    mkt_indexes_count: number
    // Spot Prices
    spot_prices_avg: number | null
    spot_prices_count: number
    // News & Policy
    news_count_7d: number
    news_fed_count_7d: number
    news_sec_count_7d: number
    news_ecb_count_7d: number
    policy_count_7d: number
    policy_avg_sentiment: number | null
    policy_avg_impact: number | null
    // Macro Reports
    macro_surprise_avg_7d: number | null
    macro_report_count_7d: number
}

function toDateKeyUtc(date: Date): string {
    return date.toISOString().slice(0, 10)
}

function asofAggregate(points: SeriesAggregate[], ts: Date): SeriesAggregate | null {
    const targetKey = toDateKeyUtc(ts)
    let best: SeriesAggregate | null = null
    for (const point of points) {
        if (toDateKeyUtc(point.eventDate) <= targetKey) {
            best = point
        } else {
            break
        }
    }
    return best
}

function countLast7d<T extends { eventDate: Date }>(points: T[], ts: Date): number {
    const ts7dAgo = new Date(ts.getTime() - 7 * 24 * 60 * 60 * 1000)
    const targetKey = toDateKeyUtc(ts)
    return points.filter((p) => {
        const pKey = toDateKeyUtc(p.eventDate)
        return pKey >= toDateKeyUtc(ts7dAgo) && pKey <= targetKey
    }).length
}

function avgLast7d(
    points: Array<{ eventDate: Date; value: number | null }>,
    ts: Date
): number | null {
    const ts7dAgo = new Date(ts.getTime() - 7 * 24 * 60 * 60 * 1000)
    const targetKey = toDateKeyUtc(ts)
    const relevant = points.filter((p) => {
        const pKey = toDateKeyUtc(p.eventDate)
        return pKey >= toDateKeyUtc(ts7dAgo) && pKey <= targetKey && p.value != null
    })
    if (relevant.length === 0) return null
    const sum = relevant.reduce((acc, p) => acc + (p.value ?? 0), 0)
    return sum / relevant.length
}

async function run(): Promise<void> {
    loadDotEnvFiles()

    const daysBack = Number(parseArg('days-back', '730'))
    const outFile = parseArg('out', 'datasets/autogluon/mes_1h_complete.csv')
    const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

    console.log('[dataset:complete] Starting COMPLETE dataset build')
    console.log(`[dataset:complete] Days back: ${daysBack}, Start date: ${start.toISOString()}`)

    // FETCH ALL PRICE DATA
    const priceRows = await prisma.mesPrice1h.findMany({
        where: { eventTime: { gte: start } },
        orderBy: { eventTime: 'asc' },
        select: { eventTime: true, close: true },
    })

    if (priceRows.length < 200) {
        throw new Error(`Insufficient MES 1h price data (${priceRows.length} rows)`)
    }

    console.log(`[dataset:complete] Loaded ${priceRows.length} MES 1h price rows`)

    // FETCH ALL ECONOMIC DATA (aggregated by day)
    console.log('[dataset:complete] Fetching ALL economic data tables...')

    const [
        ratesData,
        yieldsData,
        fxData,
        volData,
        inflationData,
        laborData,
        activityData,
        moneyData,
        commoditiesData,
        indexesData,
        spotData,
    ] = await Promise.all([
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_rates_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_yields_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_fx_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<Array<{ eventDate: Date; value: number | null }>>`
      SELECT event_date::date as "eventDate", value
      FROM econ_vol_indices_1d
      WHERE series_id = 'VIXCLS'
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_inflation_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_labor_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_activity_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_money_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM econ_commodities_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM mkt_indexes_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<SeriesAggregate[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(value) as "avgValue",
        MIN(value) as "minValue",
        MAX(value) as "maxValue",
        COUNT(*)::int as count
      FROM mkt_spot_1d
      WHERE value IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
    ])

    console.log(`[dataset:complete] Rates: ${ratesData.length} days`)
    console.log(`[dataset:complete] Yields: ${yieldsData.length} days`)
    console.log(`[dataset:complete] FX: ${fxData.length} days`)
    console.log(`[dataset:complete] Vol: ${volData.length} days`)
    console.log(`[dataset:complete] Inflation: ${inflationData.length} days`)
    console.log(`[dataset:complete] Labor: ${laborData.length} days`)
    console.log(`[dataset:complete] Activity: ${activityData.length} days`)
    console.log(`[dataset:complete] Money: ${moneyData.length} days`)
    console.log(`[dataset:complete] Commodities: ${commoditiesData.length} days`)
    console.log(`[dataset:complete] Indexes: ${indexesData.length} days`)
    console.log(`[dataset:complete] Spot: ${spotData.length} days`)

    // FETCH NEWS & POLICY DATA
    console.log('[dataset:complete] Fetching news and policy data...')

    const [newsRows, policyRows, macroRows] = await Promise.all([
        prisma.$queryRaw<
            { eventDate: Date; total_count: number; fed_count: number; sec_count: number; ecb_count: number }[]
        >`
      SELECT
        event_date::date as "eventDate",
        COUNT(*)::int as total_count,
        COUNT(*) FILTER (WHERE source ILIKE '%fed%' OR headline ILIKE '%federal reserve%')::int as fed_count,
        COUNT(*) FILTER (WHERE source ILIKE '%sec%' OR headline ILIKE '%securities and exchange%')::int as sec_count,
        COUNT(*) FILTER (WHERE source ILIKE '%ecb%' OR headline ILIKE '%european central bank%')::int as ecb_count
      FROM econ_news_1d
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<{ eventDate: Date; count: number; avgSentiment: number | null; avgImpact: number | null }[]>`
      SELECT
        event_date::date as "eventDate",
        COUNT(*)::int as count,
        AVG(sentiment_score) as "avgSentiment",
        AVG(impact_score) as "avgImpact"
      FROM policy_news_1d
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
        prisma.$queryRaw<{ eventDate: Date; avgSurprise: number | null; count: number }[]>`
      SELECT
        event_date::date as "eventDate",
        AVG(surprise_pct) as "avgSurprise",
        COUNT(*)::int as count
      FROM macro_reports_1d
      WHERE surprise_pct IS NOT NULL
      GROUP BY event_date
      ORDER BY event_date ASC
    `,
    ])

    console.log(`[dataset:complete] News: ${newsRows.length} days`)
    console.log(`[dataset:complete] Policy: ${policyRows.length} days`)
    console.log(`[dataset:complete] Macro: ${macroRows.length} days`)

    // BUILD OUTPUT ROWS
    console.log('[dataset:complete] Building output rows...')

    const output: OutputRow[] = priceRows.map((row) => {
        const ts = row.eventTime

        // Time features
        const utcDay = ts.getUTCDate()
        const utcMonth = ts.getUTCMonth()
        const utcYear = ts.getUTCFullYear()
        const monthEnd = new Date(Date.UTC(utcYear, utcMonth + 1, 0)).getUTCDate()

        // Economic data (as-of date lookups)
        const rates = asofAggregate(ratesData, ts)
        const yields = asofAggregate(yieldsData, ts)
        const fx = asofAggregate(fxData, ts)
        const vix = volData.find((v) => toDateKeyUtc(v.eventDate) <= toDateKeyUtc(ts))
        const inflation = asofAggregate(inflationData, ts)
        const labor = asofAggregate(laborData, ts)
        const activity = asofAggregate(activityData, ts)
        const money = asofAggregate(moneyData, ts)
        const commodities = asofAggregate(commoditiesData, ts)
        const indexes = asofAggregate(indexesData, ts)
        const spot = asofAggregate(spotData, ts)

        // News & policy (7-day rolling)
        const newsCount7d = newsRows.filter((n) => {
            const diff = (ts.getTime() - n.eventDate.getTime()) / (1000 * 60 * 60 * 24)
            return diff >= 0 && diff <= 7
        })
        const newsTotalCount = newsCount7d.reduce((sum, n) => sum + n.total_count, 0)
        const newsFedCount = newsCount7d.reduce((sum, n) => sum + n.fed_count, 0)
        const newsSecCount = newsCount7d.reduce((sum, n) => sum + n.sec_count, 0)
        const newsEcbCount = newsCount7d.reduce((sum, n) => sum + n.ecb_count, 0)

        const policyCount7d = policyRows.filter((p) => {
            const diff = (ts.getTime() - p.eventDate.getTime()) / (1000 * 60 * 60 * 24)
            return diff >= 0 && diff <= 7
        })
        const policyTotal = policyCount7d.reduce((sum, p) => sum + p.count, 0)
        const policySentiments = policyCount7d.filter((p) => p.avgSentiment != null).map((p) => p.avgSentiment!)
        const policyImpacts = policyCount7d.filter((p) => p.avgImpact != null).map((p) => p.avgImpact!)

        const macroCount7d = macroRows.filter((m) => {
            const diff = (ts.getTime() - m.eventDate.getTime()) / (1000 * 60 * 60 * 24)
            return diff >= 0 && diff <= 7
        })
        const macroSurprises = macroCount7d.filter((m) => m.avgSurprise != null).map((m) => m.avgSurprise!)

        return {
            item_id: 'MES_1H',
            timestamp: ts.toISOString(),
            target: row.close,
            hour_utc: ts.getUTCHours(),
            day_of_week_utc: ts.getUTCDay(),
            is_month_start: utcDay === 1 ? 1 : 0,
            is_month_end: utcDay === monthEnd ? 1 : 0,
            vix_level: vix?.value ?? null,
            rates_avg: rates?.avgValue ?? null,
            rates_count: rates?.count ?? 0,
            yields_avg: yields?.avgValue ?? null,
            yields_count: yields?.count ?? 0,
            fx_avg: fx?.avgValue ?? null,
            fx_count: fx?.count ?? 0,
            inflation_avg: inflation?.avgValue ?? null,
            inflation_count: inflation?.count ?? 0,
            labor_avg: labor?.avgValue ?? null,
            labor_count: labor?.count ?? 0,
            activity_avg: activity?.avgValue ?? null,
            activity_count: activity?.count ?? 0,
            money_avg: money?.avgValue ?? null,
            money_count: money?.count ?? 0,
            commodities_avg: commodities?.avgValue ?? null,
            commodities_count: commodities?.count ?? 0,
            mkt_indexes_avg: indexes?.avgValue ?? null,
            mkt_indexes_count: indexes?.count ?? 0,
            spot_prices_avg: spot?.avgValue ?? null,
            spot_prices_count: spot?.count ?? 0,
            news_count_7d: newsTotalCount,
            news_fed_count_7d: newsFedCount,
            news_sec_count_7d: newsSecCount,
            news_ecb_count_7d: newsEcbCount,
            policy_count_7d: policyTotal,
            policy_avg_sentiment: policySentiments.length > 0 ? policySentiments.reduce((a, b) => a + b, 0) / policySentiments.length : null,
            policy_avg_impact: policyImpacts.length > 0 ? policyImpacts.reduce((a, b) => a + b, 0) / policyImpacts.length : null,
            macro_surprise_avg_7d: macroSurprises.length > 0 ? macroSurprises.reduce((a, b) => a + b, 0) / macroSurprises.length : null,
            macro_report_count_7d: macroCount7d.reduce((sum, m) => sum + m.count, 0),
        }
    })

    // Write CSV
    const header = Object.keys(output[0])
    const csvLines = [
        header.join(','),
        ...output.map((row) =>
            header.map((key) => {
                const val = row[key as keyof OutputRow]
                return val == null ? '' : String(val)
            }).join(',')
        ),
    ]

    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true })
    fs.writeFileSync(path.resolve(outFile), csvLines.join('\n') + '\n', 'utf8')

    console.log(`[dataset:complete] ✅ Written ${output.length} rows to ${outFile}`)
    console.log(`[dataset:complete] Features: ${header.length}`)
    console.log(`[dataset:complete] Date range: ${output[0].timestamp} to ${output[output.length - 1].timestamp}`)
}

run()
    .catch((error) => {
        console.error('[dataset:complete] ERROR:', error)
        process.exit(1)
    })
    .finally(() => prisma.$disconnect())
