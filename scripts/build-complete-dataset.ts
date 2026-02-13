/**
 * build-complete-dataset.ts
 *
 * Builds a comprehensive MES intraday training dataset for AutoGluon.
 * Follows the zinc-fusion-v15 pattern: individual FRED series as separate
 * columns, technical indicators on price, forward return targets.
 *
 * Features (~80+ columns):
 *   - MES 1h OHLCV + technical indicators (returns, rolling stats, RSI, range)
 *   - Individual FRED series as-of columns (VIX, yields, FX, spreads, etc.)
 *   - Derived features (yield curve slope/curvature, real rates, vol spreads)
 *   - News/policy rolling aggregates
 *   - Forward return targets at 1h, 4h, 8h, 24h horizons
 *
 * Usage:
 *   npx tsx scripts/build-complete-dataset.ts
 *   npx tsx scripts/build-complete-dataset.ts --days-back=365
 *   npx tsx scripts/build-complete-dataset.ts --out=datasets/custom.csv
 */

import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles, parseArg } from './ingest-utils'
import fs from 'node:fs'
import path from 'node:path'

// ─── KEY FRED SERIES FOR MES TRADING ──────────────────────────────────────
// Individual series → individual columns (not aggregated)

interface FredSeriesConfig {
  seriesId: string
  column: string
  table: string
}

const FRED_FEATURES: FredSeriesConfig[] = [
  // Volatility & risk
  { seriesId: 'VIXCLS', column: 'fred_vix', table: 'econ_vol_indices_1d' },
  { seriesId: 'VXVCLS', column: 'fred_vvix', table: 'econ_vol_indices_1d' },
  { seriesId: 'OVXCLS', column: 'fred_ovx', table: 'econ_vol_indices_1d' },
  { seriesId: 'GVZCLS', column: 'fred_gvz', table: 'econ_vol_indices_1d' },
  { seriesId: 'BAMLC0A0CM', column: 'fred_ig_oas', table: 'econ_vol_indices_1d' },
  { seriesId: 'BAMLH0A0HYM2', column: 'fred_hy_oas', table: 'econ_vol_indices_1d' },
  { seriesId: 'NFCI', column: 'fred_nfci', table: 'econ_vol_indices_1d' },
  { seriesId: 'STLFSI4', column: 'fred_stlfsi', table: 'econ_vol_indices_1d' },
  { seriesId: 'USEPUINDXD', column: 'fred_epu', table: 'econ_vol_indices_1d' },
  { seriesId: 'SP500', column: 'fred_sp500', table: 'econ_vol_indices_1d' },
  { seriesId: 'NASDAQCOM', column: 'fred_nasdaq', table: 'econ_vol_indices_1d' },

  // Rates
  { seriesId: 'DFF', column: 'fred_dff', table: 'econ_rates_1d' },
  { seriesId: 'SOFR', column: 'fred_sofr', table: 'econ_rates_1d' },
  { seriesId: 'T10Y2Y', column: 'fred_t10y2y', table: 'econ_rates_1d' },
  { seriesId: 'T10Y3M', column: 'fred_t10y3m', table: 'econ_rates_1d' },
  { seriesId: 'MORTGAGE30US', column: 'fred_mort30', table: 'econ_rates_1d' },

  // Yield curve (full term structure)
  { seriesId: 'DGS1MO', column: 'fred_y1m', table: 'econ_yields_1d' },
  { seriesId: 'DGS3MO', column: 'fred_y3m', table: 'econ_yields_1d' },
  { seriesId: 'DGS2', column: 'fred_y2y', table: 'econ_yields_1d' },
  { seriesId: 'DGS5', column: 'fred_y5y', table: 'econ_yields_1d' },
  { seriesId: 'DGS10', column: 'fred_y10y', table: 'econ_yields_1d' },
  { seriesId: 'DGS30', column: 'fred_y30y', table: 'econ_yields_1d' },

  // FX
  { seriesId: 'DTWEXBGS', column: 'fred_dxy', table: 'econ_fx_1d' },
  { seriesId: 'DEXUSEU', column: 'fred_eurusd', table: 'econ_fx_1d' },
  { seriesId: 'DEXJPUS', column: 'fred_jpyusd', table: 'econ_fx_1d' },
  { seriesId: 'DEXCHUS', column: 'fred_cnyusd', table: 'econ_fx_1d' },

  // Inflation expectations & real yields
  { seriesId: 'T5YIE', column: 'fred_infl5y', table: 'econ_inflation_1d' },
  { seriesId: 'T10YIE', column: 'fred_infl10y', table: 'econ_inflation_1d' },
  { seriesId: 'T5YIFR', column: 'fred_infl5y5y', table: 'econ_inflation_1d' },
  { seriesId: 'DFII5', column: 'fred_tips5y', table: 'econ_inflation_1d' },
  { seriesId: 'DFII10', column: 'fred_tips10y', table: 'econ_inflation_1d' },

  // Commodities
  { seriesId: 'DCOILWTICO', column: 'fred_wti', table: 'econ_commodities_1d' },
  { seriesId: 'DHHNGSP', column: 'fred_natgas', table: 'econ_commodities_1d' },
  { seriesId: 'PCOPPUSDM', column: 'fred_copper', table: 'econ_commodities_1d' },

  // Liquidity / Fed balance sheet
  { seriesId: 'WALCL', column: 'fred_fed_assets', table: 'econ_money_1d' },
  { seriesId: 'RRPONTSYD', column: 'fred_rrp', table: 'econ_money_1d' },
  { seriesId: 'WRESBAL', column: 'fred_reserves', table: 'econ_money_1d' },

  // Labor (weekly)
  { seriesId: 'ICSA', column: 'fred_claims', table: 'econ_labor_1d' },
]

// ─── TYPES ────────────────────────────────────────────────────────────────

interface MesCandle {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}

type FredLookup = Map<string, number> // dateKey → value

// ─── HELPERS ──────────────────────────────────────────────────────────────

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** As-of lookup: find the most recent value on or before the given date */
function asofLookup(lookup: FredLookup, sortedKeys: string[], ts: Date): number | null {
  const target = dateKey(ts)
  let best: number | null = null
  for (const key of sortedKeys) {
    if (key > target) break
    best = lookup.get(key) ?? best
  }
  return best
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0 || !Number.isFinite(previous) || !Number.isFinite(current)) return null
  return (current - previous) / Math.abs(previous)
}

/** Simple RSI calculation */
function computeRSI(closes: number[], period: number): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return rsi

  let avgGain = 0
  let avgLoss = 0

  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) avgGain += change
    else avgLoss += Math.abs(change)
  }
  avgGain /= period
  avgLoss /= period

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  // Rolling
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? Math.abs(change) : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return rsi
}

/** Rolling mean over the last `window` values */
function rollingMean(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - window + 1; j <= i; j++) sum += values[j]
    result[i] = sum / window
  }
  return result
}

/** Rolling standard deviation over the last `window` values */
function rollingStd(values: number[], window: number): (number | null)[] {
  const means = rollingMean(values, window)
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    const mean = means[i]!
    let sumSq = 0
    for (let j = i - window + 1; j <= i; j++) sumSq += (values[j] - mean) ** 2
    result[i] = Math.sqrt(sumSq / window)
  }
  return result
}

/** Rolling min/max over the last `window` values */
function rollingMinMax(values: number[], window: number): { min: (number | null)[]; max: (number | null)[] } {
  const mins: (number | null)[] = new Array(values.length).fill(null)
  const maxs: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let lo = Infinity, hi = -Infinity
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] < lo) lo = values[j]
      if (values[j] > hi) hi = values[j]
    }
    mins[i] = lo
    maxs[i] = hi
  }
  return { min: mins, max: maxs }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  loadDotEnvFiles()

  const daysBack = Number(parseArg('days-back', '730'))
  const outFile = parseArg('out', 'datasets/autogluon/mes_1h_complete.csv')
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  console.log('[dataset] Building MES intraday training dataset')
  console.log(`[dataset] Days back: ${daysBack}, Start: ${start.toISOString().slice(0, 10)}`)

  // ── 1. Load MES 1h candles ──
  const candles = await prisma.mesPrice1h.findMany({
    where: { eventTime: { gte: start } },
    orderBy: { eventTime: 'asc' },
    select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
  }) as MesCandle[]

  if (candles.length < 200) {
    throw new Error(`Insufficient MES 1h data (${candles.length} rows, need 200+)`)
  }
  console.log(`[dataset] MES 1h candles: ${candles.length}`)

  // ── 2. Load individual FRED series ──
  console.log(`[dataset] Loading ${FRED_FEATURES.length} individual FRED series...`)

  const fredLookups: Map<string, { lookup: FredLookup; sortedKeys: string[] }> = new Map()

  // Query all FRED data in one batch per table, then split by seriesId
  const tableSeriesMap = new Map<string, FredSeriesConfig[]>()
  for (const f of FRED_FEATURES) {
    const list = tableSeriesMap.get(f.table) || []
    list.push(f)
    tableSeriesMap.set(f.table, list)
  }

  for (const [table, configs] of tableSeriesMap) {
    const seriesIds = configs.map((c) => c.seriesId)
    const rows = await prisma.$queryRawUnsafe<{ seriesId: string; eventDate: Date; value: number }[]>(
      `SELECT "seriesId", "eventDate"::date as "eventDate", value FROM ${table} WHERE "seriesId" = ANY($1) AND value IS NOT NULL ORDER BY "eventDate" ASC`,
      seriesIds
    )

    // Group by seriesId
    const grouped = new Map<string, Array<{ date: string; value: number }>>()
    for (const row of rows) {
      const list = grouped.get(row.seriesId) || []
      list.push({ date: dateKey(row.eventDate), value: Number(row.value) })
      grouped.set(row.seriesId, list)
    }

    for (const config of configs) {
      const data = grouped.get(config.seriesId) || []
      const lookup: FredLookup = new Map()
      const keys: string[] = []
      for (const d of data) {
        lookup.set(d.date, d.value)
        keys.push(d.date)
      }
      fredLookups.set(config.column, { lookup, sortedKeys: keys })
      console.log(`  ${config.column} (${config.seriesId}): ${data.length} points`)
    }
  }

  // ── 3. Load news/policy data ──
  console.log('[dataset] Loading news & policy data...')

  const newsRows = await prisma.$queryRaw<
    { eventDate: Date; total_count: number; fed_count: number }[]
  >`
    SELECT
      "eventDate"::date as "eventDate",
      COUNT(*)::int as total_count,
      COUNT(*) FILTER (WHERE source ILIKE '%fed%' OR headline ILIKE '%federal reserve%')::int as fed_count
    FROM econ_news_1d
    GROUP BY "eventDate"
    ORDER BY "eventDate" ASC
  `

  const policyRows = await prisma.$queryRaw<
    { eventDate: Date; count: number; avgSentiment: number | null; avgImpact: number | null }[]
  >`
    SELECT
      "eventDate"::date as "eventDate",
      COUNT(*)::int as count,
      AVG("sentimentScore") as "avgSentiment",
      AVG("impactScore") as "avgImpact"
    FROM policy_news_1d
    GROUP BY "eventDate"
    ORDER BY "eventDate" ASC
  `

  console.log(`  News: ${newsRows.length} days, Policy: ${policyRows.length} days`)

  // ── 4. Precompute technical indicators on MES ──
  console.log('[dataset] Computing technical indicators...')

  const closes = candles.map((c) => c.close)
  const highs = candles.map((c) => c.high)
  const lows = candles.map((c) => c.low)
  const volumes = candles.map((c) => Number(c.volume ?? 0))

  const rsi14 = computeRSI(closes, 14)
  const rsi2 = computeRSI(closes, 2)
  const ma8 = rollingMean(closes, 8)
  const ma24 = rollingMean(closes, 24)
  const ma120 = rollingMean(closes, 120)
  const std8 = rollingStd(closes, 8)
  const std24 = rollingStd(closes, 24)
  const std120 = rollingStd(closes, 120)
  const { min: lo24, max: hi24 } = rollingMinMax(closes, 24)
  const { min: lo120, max: hi120 } = rollingMinMax(closes, 120)
  const volMa24 = rollingMean(volumes, 24)

  // ── 5. Build output rows ──
  console.log('[dataset] Assembling feature matrix...')

  const header: string[] = [
    'item_id', 'timestamp', 'target',
    // Forward return targets
    'target_ret_1h', 'target_ret_4h', 'target_ret_8h', 'target_ret_24h',
    // Time features
    'hour_utc', 'day_of_week', 'is_us_session', 'is_asia_session', 'is_europe_session',
    'is_month_start', 'is_month_end',
    // MES technical features
    'mes_ret_1h', 'mes_ret_4h', 'mes_ret_8h', 'mes_ret_24h',
    'mes_range', 'mes_body_ratio',
    'mes_rsi14', 'mes_rsi2',
    'mes_ma8', 'mes_ma24', 'mes_ma120',
    'mes_dist_ma8', 'mes_dist_ma24', 'mes_dist_ma120',
    'mes_std8', 'mes_std24', 'mes_std120',
    'mes_dist_hi24', 'mes_dist_lo24', 'mes_dist_hi120', 'mes_dist_lo120',
    'mes_vol_ratio',
    // Individual FRED features
    ...FRED_FEATURES.map((f) => f.column),
    // Derived features
    'yield_curve_slope', 'yield_curve_curvature',
    'real_rate_5y', 'real_rate_10y',
    'credit_spread_diff', 'vix_term_structure',
    'fed_liquidity',
    // News/policy rolling
    'news_count_7d', 'news_fed_count_7d',
    'policy_count_7d', 'policy_avg_sentiment',
  ]

  const rows: string[][] = []

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const ts = c.eventTime
    const close = c.close

    // Forward return targets (shift forward)
    const tgtRet1h = i + 1 < candles.length ? pctChange(candles[i + 1].close, close) : null
    const tgtRet4h = i + 4 < candles.length ? pctChange(candles[i + 4].close, close) : null
    const tgtRet8h = i + 8 < candles.length ? pctChange(candles[i + 8].close, close) : null
    const tgtRet24h = i + 24 < candles.length ? pctChange(candles[i + 24].close, close) : null

    // Time features
    const hourUtc = ts.getUTCHours()
    const dayOfWeek = ts.getUTCDay()
    const isUsSession = hourUtc >= 13 && hourUtc < 21 ? 1 : 0  // 9:30-4 ET roughly
    const isAsiaSession = hourUtc >= 0 && hourUtc < 7 ? 1 : 0
    const isEuropeSession = hourUtc >= 7 && hourUtc < 13 ? 1 : 0
    const utcDate = ts.getUTCDate()
    const monthEnd = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth() + 1, 0)).getUTCDate()

    // MES technical features
    const ret1h = i >= 1 ? pctChange(close, candles[i - 1].close) : null
    const ret4h = i >= 4 ? pctChange(close, candles[i - 4].close) : null
    const ret8h = i >= 8 ? pctChange(close, candles[i - 8].close) : null
    const ret24h = i >= 24 ? pctChange(close, candles[i - 24].close) : null
    const range = c.high > 0 ? (c.high - c.low) / c.close : null
    const bodyRatio = c.high !== c.low ? Math.abs(c.close - c.open) / (c.high - c.low) : null
    const distMa8 = ma8[i] != null ? (close - ma8[i]!) / ma8[i]! : null
    const distMa24 = ma24[i] != null ? (close - ma24[i]!) / ma24[i]! : null
    const distMa120 = ma120[i] != null ? (close - ma120[i]!) / ma120[i]! : null
    const distHi24 = hi24[i] != null ? (close - hi24[i]!) / hi24[i]! : null
    const distLo24 = lo24[i] != null ? (close - lo24[i]!) / lo24[i]! : null
    const distHi120 = hi120[i] != null ? (close - hi120[i]!) / hi120[i]! : null
    const distLo120 = lo120[i] != null ? (close - lo120[i]!) / lo120[i]! : null
    const volRatio = volMa24[i] != null && volMa24[i]! > 0 ? volumes[i] / volMa24[i]! : null

    // FRED as-of lookups
    const fredValues: (number | null)[] = FRED_FEATURES.map((f) => {
      const data = fredLookups.get(f.column)
      if (!data) return null
      return asofLookup(data.lookup, data.sortedKeys, ts)
    })

    // Derived features
    const y2y = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_y2y')]
    const y10y = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_y10y')]
    const y30y = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_y30y')]
    const y3m = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_y3m')]
    const tips5y = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_tips5y')]
    const tips10y = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_tips10y')]
    const igOas = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_ig_oas')]
    const hyOas = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_hy_oas')]
    const vix = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_vix')]
    const vvix = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_vvix')]
    const fedAssets = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_fed_assets')]
    const rrp = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_rrp')]
    const reserves = fredValues[FRED_FEATURES.findIndex((f) => f.column === 'fred_reserves')]

    const yieldCurveSlope = y10y != null && y2y != null ? y10y - y2y : null
    const yieldCurveCurvature = y2y != null && y10y != null && y30y != null
      ? 2 * y10y - y2y - y30y : null
    const realRate5y = y2y != null && tips5y != null ? y2y - tips5y : null  // proxy
    const realRate10y = y10y != null && tips10y != null ? y10y - tips10y : null
    const creditSpreadDiff = hyOas != null && igOas != null ? hyOas - igOas : null
    const vixTermStructure = vvix != null && vix != null && vix > 0 ? vvix / vix : null
    const fedLiquidity = fedAssets != null && rrp != null
      ? fedAssets - rrp * 1000 : null  // RRP is in billions, assets in millions

    // News/policy 7d rolling
    const ts7dAgo = new Date(ts.getTime() - 7 * 24 * 60 * 60 * 1000)
    const tsKey = dateKey(ts)
    const ts7dKey = dateKey(ts7dAgo)

    let newsCount7d = 0, newsFedCount7d = 0
    for (const n of newsRows) {
      const nk = dateKey(n.eventDate)
      if (nk >= ts7dKey && nk <= tsKey) {
        newsCount7d += n.total_count
        newsFedCount7d += n.fed_count
      }
    }

    let policyCount7d = 0
    let policySentimentSum = 0, policySentimentN = 0
    for (const p of policyRows) {
      const pk = dateKey(p.eventDate)
      if (pk >= ts7dKey && pk <= tsKey) {
        policyCount7d += p.count
        if (p.avgSentiment != null) {
          policySentimentSum += p.avgSentiment * p.count
          policySentimentN += p.count
        }
      }
    }
    const policyAvgSentiment = policySentimentN > 0 ? policySentimentSum / policySentimentN : null

    // Assemble row
    const row: (string | number | null)[] = [
      'MES_1H',
      ts.toISOString(),
      close,
      tgtRet1h, tgtRet4h, tgtRet8h, tgtRet24h,
      hourUtc, dayOfWeek, isUsSession, isAsiaSession, isEuropeSession,
      utcDate === 1 ? 1 : 0,
      utcDate === monthEnd ? 1 : 0,
      ret1h, ret4h, ret8h, ret24h,
      range, bodyRatio,
      rsi14[i], rsi2[i],
      ma8[i], ma24[i], ma120[i],
      distMa8, distMa24, distMa120,
      std8[i], std24[i], std120[i],
      distHi24, distLo24, distHi120, distLo120,
      volRatio,
      ...fredValues,
      yieldCurveSlope, yieldCurveCurvature,
      realRate5y, realRate10y,
      creditSpreadDiff, vixTermStructure,
      fedLiquidity,
      newsCount7d, newsFedCount7d,
      policyCount7d, policyAvgSentiment,
    ]

    rows.push(row.map((v) => (v == null ? '' : String(v))))
  }

  // ── 6. Write CSV ──
  const outPath = path.resolve(outFile)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const csvLines = [header.join(','), ...rows.map((r) => r.join(','))]
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', 'utf8')

  // Summary
  const nonNullCounts: Record<string, number> = {}
  for (let col = 0; col < header.length; col++) {
    nonNullCounts[header[col]] = rows.filter((r) => r[col] !== '').length
  }

  const fredCoverage = FRED_FEATURES.map((f) => {
    const count = nonNullCounts[f.column] ?? 0
    const pct = ((count / rows.length) * 100).toFixed(1)
    return `  ${f.column.padEnd(22)} ${String(count).padStart(7)} / ${rows.length} (${pct}%)`
  })

  console.log(`\n[dataset] Written ${rows.length} rows × ${header.length} features to ${outFile}`)
  console.log(`[dataset] Date range: ${rows[0][1]} → ${rows[rows.length - 1][1]}`)
  console.log(`\n[dataset] FRED feature coverage:`)
  console.log(fredCoverage.join('\n'))

  const targets = ['target_ret_1h', 'target_ret_4h', 'target_ret_8h', 'target_ret_24h']
  for (const t of targets) {
    const idx = header.indexOf(t)
    const count = rows.filter((r) => r[idx] !== '').length
    console.log(`  ${t.padEnd(22)} ${count} / ${rows.length}`)
  }
}

run()
  .catch((error) => {
    console.error('[dataset] FATAL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
