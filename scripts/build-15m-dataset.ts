/**
 * build-15m-dataset.ts
 *
 * Builds MES 15-minute training dataset for AutoGluon.
 * Same feature engineering as build-complete-dataset.ts but at 15m granularity.
 *
 * Features (~80+ columns):
 *   - MES 15m OHLCV + technical indicators (returns, rolling stats, RSI, range)
 *   - Individual FRED series as-of columns (VIX, yields, FX, spreads, etc.)
 *   - Derived features (yield curve slope/curvature, real rates, vol spreads)
 *   - News/policy rolling aggregates
 *   - Forward return targets: 15m (1 bar), 1h (4 bars), 4h (16 bars)
 *
 * Usage:
 *   npx tsx scripts/build-15m-dataset.ts
 *   npx tsx scripts/build-15m-dataset.ts --days-back=365
 *   npx tsx scripts/build-15m-dataset.ts --out=datasets/autogluon/mes_15m_complete.csv
 */

import { prisma } from '../src/lib/prisma'
import { toNum } from '../src/lib/decimal'
import { loadDotEnvFiles, parseArg, splitIntoDayChunks } from './ingest-utils'
import {
  asofLookupByDateKey,
  conservativeLagDaysForFrequency,
  dateKeyUtc,
  laggedWindowKeys,
} from './feature-availability'
import fs from 'node:fs'
import path from 'node:path'

// ─── KEY FRED SERIES (same as 1h dataset) ──────────────────────────────────

interface FredSeriesConfig {
  seriesId: string
  column: string
  table: string
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly'
}

const FRED_FEATURES: FredSeriesConfig[] = [
  // Volatility & risk
  { seriesId: 'VIXCLS', column: 'fred_vix', table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'VXVCLS', column: 'fred_vvix', table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'OVXCLS', column: 'fred_ovx', table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'BAMLC0A0CM', column: 'fred_ig_oas', table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'BAMLH0A0HYM2', column: 'fred_hy_oas', table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'NFCI', column: 'fred_nfci', table: 'econ_vol_indices_1d', frequency: 'weekly' },
  { seriesId: 'USEPUINDXD', column: 'fred_epu', table: 'econ_vol_indices_1d', frequency: 'daily' },
  // Rates
  { seriesId: 'DFF', column: 'fred_dff', table: 'econ_rates_1d', frequency: 'daily' },
  { seriesId: 'SOFR', column: 'fred_sofr', table: 'econ_rates_1d', frequency: 'daily' },
  { seriesId: 'T10Y2Y', column: 'fred_t10y2y', table: 'econ_rates_1d', frequency: 'daily' },
  // Yield curve
  { seriesId: 'DGS3MO', column: 'fred_y3m', table: 'econ_yields_1d', frequency: 'daily' },
  { seriesId: 'DGS2', column: 'fred_y2y', table: 'econ_yields_1d', frequency: 'daily' },
  { seriesId: 'DGS5', column: 'fred_y5y', table: 'econ_yields_1d', frequency: 'daily' },
  { seriesId: 'DGS10', column: 'fred_y10y', table: 'econ_yields_1d', frequency: 'daily' },
  { seriesId: 'DGS30', column: 'fred_y30y', table: 'econ_yields_1d', frequency: 'daily' },
  // FX
  { seriesId: 'DTWEXBGS', column: 'fred_dxy', table: 'econ_fx_1d', frequency: 'daily' },
  { seriesId: 'DEXUSEU', column: 'fred_eurusd', table: 'econ_fx_1d', frequency: 'daily' },
  { seriesId: 'DEXJPUS', column: 'fred_jpyusd', table: 'econ_fx_1d', frequency: 'daily' },
  { seriesId: 'DEXCHUS', column: 'fred_cnyusd', table: 'econ_fx_1d', frequency: 'daily' },
  // Inflation expectations & real yields
  { seriesId: 'T5YIE', column: 'fred_infl5y', table: 'econ_inflation_1d', frequency: 'daily' },
  { seriesId: 'T10YIE', column: 'fred_infl10y', table: 'econ_inflation_1d', frequency: 'daily' },
  { seriesId: 'T5YIFR', column: 'fred_infl5y5y', table: 'econ_inflation_1d', frequency: 'daily' },
  { seriesId: 'DFII5', column: 'fred_tips5y', table: 'econ_inflation_1d', frequency: 'daily' },
  { seriesId: 'DFII10', column: 'fred_tips10y', table: 'econ_inflation_1d', frequency: 'daily' },
  // Commodities
  { seriesId: 'DCOILWTICO', column: 'fred_wti', table: 'econ_commodities_1d', frequency: 'daily' },
  { seriesId: 'DCOILBRENTEU', column: 'fred_brent', table: 'econ_commodities_1d', frequency: 'daily' },
  { seriesId: 'PCOPPUSDM', column: 'fred_copper', table: 'econ_commodities_1d', frequency: 'monthly' },

  // Liquidity / Fed balance sheet
  { seriesId: 'WALCL', column: 'fred_fed_assets', table: 'econ_money_1d', frequency: 'weekly' },
  { seriesId: 'RRPONTSYD', column: 'fred_rrp', table: 'econ_money_1d', frequency: 'daily' },
  { seriesId: 'M2SL', column: 'fred_m2', table: 'econ_money_1d', frequency: 'monthly' },

  // Labor
  { seriesId: 'ICSA', column: 'fred_claims', table: 'econ_labor_1d', frequency: 'weekly' },
  { seriesId: 'CCSA', column: 'fred_continuing_claims', table: 'econ_labor_1d', frequency: 'weekly' },
  { seriesId: 'PAYEMS', column: 'fred_nfp', table: 'econ_labor_1d', frequency: 'monthly' },
  { seriesId: 'UNRATE', column: 'fred_unemployment', table: 'econ_labor_1d', frequency: 'monthly' },

  // Rates (fed funds target range)
  { seriesId: 'DFEDTARL', column: 'fred_fed_target_lower', table: 'econ_rates_1d', frequency: 'daily' },
  { seriesId: 'DFEDTARU', column: 'fred_fed_target_upper', table: 'econ_rates_1d', frequency: 'daily' },

  // FX (additional)
  { seriesId: 'DEXMXUS', column: 'fred_mxnusd', table: 'econ_fx_1d', frequency: 'daily' },

  // Inflation (monthly event series — forward-filled)
  { seriesId: 'CPIAUCSL', column: 'fred_cpi', table: 'econ_inflation_1d', frequency: 'monthly' },
  { seriesId: 'CPILFESL', column: 'fred_core_cpi', table: 'econ_inflation_1d', frequency: 'monthly' },
  { seriesId: 'PCEPILFE', column: 'fred_core_pce', table: 'econ_inflation_1d', frequency: 'monthly' },
  { seriesId: 'PPIACO', column: 'fred_ppi', table: 'econ_inflation_1d', frequency: 'monthly' },

  // Activity (monthly/quarterly — forward-filled)
  { seriesId: 'GDPC1', column: 'fred_real_gdp', table: 'econ_activity_1d', frequency: 'quarterly' },
  { seriesId: 'RSXFS', column: 'fred_retail_sales', table: 'econ_activity_1d', frequency: 'monthly' },
  { seriesId: 'UMCSENT', column: 'fred_consumer_sent', table: 'econ_activity_1d', frequency: 'monthly' },
  { seriesId: 'INDPRO', column: 'fred_ind_production', table: 'econ_activity_1d', frequency: 'monthly' },
  { seriesId: 'BOPGSTB', column: 'fred_trade_balance', table: 'econ_activity_1d', frequency: 'monthly' },
  { seriesId: 'IMPCH', column: 'fred_china_imports', table: 'econ_activity_1d', frequency: 'monthly' },
]

const NEWS_POLICY_LAG_DAYS = 1
const NEWS_POLICY_LOOKBACK_DAYS = 7
const MES_CANDLE_CHUNK_DAYS = 45

function featureIndex(column: string): number {
  const idx = FRED_FEATURES.findIndex((f) => f.column === column)
  if (idx < 0) throw new Error(`Missing feature column '${column}'`)
  return idx
}

const IDX_Y2Y = featureIndex('fred_y2y')
const IDX_Y10Y = featureIndex('fred_y10y')
const IDX_Y30Y = featureIndex('fred_y30y')
const IDX_TIPS5Y = featureIndex('fred_tips5y')
const IDX_TIPS10Y = featureIndex('fred_tips10y')
const IDX_IG_OAS = featureIndex('fred_ig_oas')
const IDX_HY_OAS = featureIndex('fred_hy_oas')
const IDX_VIX = featureIndex('fred_vix')
const IDX_VVIX = featureIndex('fred_vvix')
const IDX_FED_ASSETS = featureIndex('fred_fed_assets')
const IDX_RRP = featureIndex('fred_rrp')
const FRED_LAG_BY_COLUMN = new Map(
  FRED_FEATURES.map((f) => [f.column, conservativeLagDaysForFrequency(f.frequency)])
)

// ─── TYPES ────────────────────────────────────────────────────────────────

interface MesCandle {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}

type FredLookup = Map<string, number>

// ─── HELPERS ──────────────────────────────────────────────────────────────

function pctChange(current: number, previous: number): number | null {
  if (previous === 0 || !Number.isFinite(previous) || !Number.isFinite(current)) return null
  return (current - previous) / Math.abs(previous)
}

function computeRSI(closes: number[], period: number): (number | null)[] {
  const rsi: (number | null)[] = new Array(closes.length).fill(null)
  if (closes.length < period + 1) return rsi
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change)
  }
  avgGain /= period; avgLoss /= period
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
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

function rollingMean(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let sum = 0
    for (let j = i - window + 1; j <= i; j++) sum += values[j]
    result[i] = sum / window
  }
  return result
}

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

function rollingMinMax(values: number[], window: number): { min: (number | null)[]; max: (number | null)[] } {
  const mins: (number | null)[] = new Array(values.length).fill(null)
  const maxs: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let lo = Infinity, hi = -Infinity
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] < lo) lo = values[j]
      if (values[j] > hi) hi = values[j]
    }
    mins[i] = lo; maxs[i] = hi
  }
  return { min: mins, max: maxs }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  loadDotEnvFiles()

  const daysBack = Number(parseArg('days-back', '730'))
  const outFile = parseArg('out', 'datasets/autogluon/mes_15m_complete.csv')
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  console.log('[dataset:15m] Building MES 15-minute training dataset')
  console.log(`[dataset:15m] Days back: ${daysBack}, Start: ${start.toISOString().slice(0, 10)}`)
  console.log('[dataset:15m] Anti-leakage policy: daily=1d, weekly=8d, monthly=35d, quarterly=100d lag')

  // ── 1. Load MES 15m candles ──
  const now = new Date()
  const candleChunks = splitIntoDayChunks(start, now, MES_CANDLE_CHUNK_DAYS)
  const candles: MesCandle[] = []
  for (let i = 0; i < candleChunks.length; i++) {
    const chunk = candleChunks[i]
    const rows = await prisma.mktFuturesMes15m.findMany({
      where: {
        eventTime: {
          gte: chunk.start,
          lt: chunk.end,
        },
      },
      orderBy: { eventTime: 'asc' },
      select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
    })
    candles.push(
      ...rows.map((r) => ({
        eventTime: r.eventTime,
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
        volume: r.volume,
      }))
    )
    if (i === 0 || (i + 1) % 4 === 0 || i === candleChunks.length - 1) {
      console.log(`[dataset:15m] MES chunk ${i + 1}/${candleChunks.length} -> ${rows.length} rows`)
    }
  }

  if (candles.length < 500) {
    throw new Error(`Insufficient MES 15m data (${candles.length} rows, need 500+)`)
  }
  console.log(`[dataset:15m] MES 15m candles: ${candles.length}`)

  // ── 2. Load individual FRED series ──
  console.log(`[dataset:15m] Loading ${FRED_FEATURES.length} individual FRED series...`)

  const fredLookups: Map<string, { lookup: FredLookup; sortedKeys: string[] }> = new Map()
  const tableSeriesMap = new Map<string, FredSeriesConfig[]>()
  for (const f of FRED_FEATURES) {
    const list = tableSeriesMap.get(f.table) || []
    list.push(f)
    tableSeriesMap.set(f.table, list)
  }

  for (const [table, configs] of tableSeriesMap) {
    const seriesIds = configs.map((c) => c.seriesId)
    const rows = await prisma.$queryRawUnsafe<{ seriesId: string; eventDate: Date; value: number }[]>(
      `SELECT "seriesId", "eventDate"::date as "eventDate", value FROM "${table}" WHERE "seriesId" = ANY($1) AND value IS NOT NULL ORDER BY "eventDate" ASC`,
      seriesIds
    )
    const grouped = new Map<string, Array<{ date: string; value: number }>>()
    for (const row of rows) {
      const list = grouped.get(row.seriesId) || []
      list.push({ date: dateKeyUtc(row.eventDate), value: Number(row.value) })
      grouped.set(row.seriesId, list)
    }
    for (const config of configs) {
      const data = grouped.get(config.seriesId) || []
      const lookup: FredLookup = new Map()
      const keys: string[] = []
      for (const d of data) { lookup.set(d.date, d.value); keys.push(d.date) }
      fredLookups.set(config.column, { lookup, sortedKeys: keys })
      console.log(`  ${config.column} (${config.seriesId}): ${data.length} points`)
    }
  }

  // ── 3. Load news/policy data ──
  console.log('[dataset:15m] Loading news & policy data...')

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
    { eventDate: Date; count: number }[]
  >`
    SELECT
      "eventDate"::date as "eventDate",
      COUNT(*)::int as count
    FROM policy_news_1d
    GROUP BY "eventDate"
    ORDER BY "eventDate" ASC
  `
  console.log(`  News: ${newsRows.length} days, Policy: ${policyRows.length} days`)

  // Load headlines from news_signals for text feature
  const newsSignals = await prisma.newsSignal.findMany({
    select: { title: true, pubDate: true },
    orderBy: { pubDate: 'asc' },
  })
  console.log(`  News signals (headlines): ${newsSignals.length} rows`)

  // ── 4. Precompute technical indicators (15m-adjusted windows) ──
  // Windows are 4x the 1h equivalents: 8-bar MA on 1h = 32-bar MA on 15m
  console.log('[dataset:15m] Computing technical indicators at 15m granularity...')

  const closes = candles.map((c) => c.close)
  const volumes = candles.map((c) => Number(c.volume ?? 0))

  const rsi14 = computeRSI(closes, 14)
  const rsi2 = computeRSI(closes, 2)
  // 15m-scaled MAs: 32 bars=8h, 96 bars=24h, 480 bars=5 trading days
  const ma32 = rollingMean(closes, 32)
  const ma96 = rollingMean(closes, 96)
  const ma480 = rollingMean(closes, 480)
  const std32 = rollingStd(closes, 32)
  const std96 = rollingStd(closes, 96)
  const std480 = rollingStd(closes, 480)
  const { min: lo96, max: hi96 } = rollingMinMax(closes, 96)
  const { min: lo480, max: hi480 } = rollingMinMax(closes, 480)
  const volMa96 = rollingMean(volumes, 96)

  // ── 5. Build output rows ──
  console.log('[dataset:15m] Assembling feature matrix...')

  const header: string[] = [
    'item_id', 'timestamp', 'target',
    // Forward return targets at 15m granularity
    'target_ret_15m', 'target_ret_1h', 'target_ret_4h',
    // Time features
    'hour_utc', 'minute_utc', 'day_of_week', 'is_us_session', 'is_asia_session', 'is_europe_session',
    'is_month_start', 'is_month_end',
    // 15m bars back as returns (1=15m, 4=1h, 16=4h, 96=24h)
    'mes_ret_1bar', 'mes_ret_4bar', 'mes_ret_16bar', 'mes_ret_96bar',
    'mes_range', 'mes_body_ratio',
    'mes_rsi14', 'mes_rsi2',
    'mes_ma32', 'mes_ma96', 'mes_ma480',
    'mes_dist_ma32', 'mes_dist_ma96', 'mes_dist_ma480',
    'mes_std32', 'mes_std96', 'mes_std480',
    'mes_dist_hi96', 'mes_dist_lo96', 'mes_dist_hi480', 'mes_dist_lo480',
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
    'policy_count_7d',
    'headlines_7d',
  ]

  const rows: string[][] = []

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const ts = c.eventTime
    const close = c.close

    // Forward return targets (15m bars: 1 bar=15m, 4 bars=1h, 16 bars=4h)
    const tgtRet15m = i + 1 < candles.length ? pctChange(candles[i + 1].close, close) : null
    const tgtRet1h = i + 4 < candles.length ? pctChange(candles[i + 4].close, close) : null
    const tgtRet4h = i + 16 < candles.length ? pctChange(candles[i + 16].close, close) : null

    // Time features
    const hourUtc = ts.getUTCHours()
    const minuteUtc = ts.getUTCMinutes()
    const dayOfWeek = ts.getUTCDay()
    const isUsSession = hourUtc >= 13 && hourUtc < 21 ? 1 : 0
    const isAsiaSession = hourUtc >= 0 && hourUtc < 7 ? 1 : 0
    const isEuropeSession = hourUtc >= 7 && hourUtc < 13 ? 1 : 0
    const utcDate = ts.getUTCDate()
    const monthEnd = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth() + 1, 0)).getUTCDate()

    // MES technical features (15m bar lookbacks)
    const ret1bar = i >= 1 ? pctChange(close, candles[i - 1].close) : null
    const ret4bar = i >= 4 ? pctChange(close, candles[i - 4].close) : null
    const ret16bar = i >= 16 ? pctChange(close, candles[i - 16].close) : null
    const ret96bar = i >= 96 ? pctChange(close, candles[i - 96].close) : null
    const range = c.high > 0 ? (c.high - c.low) / c.close : null
    const bodyRatio = c.high !== c.low ? Math.abs(c.close - c.open) / (c.high - c.low) : null
    const distMa32 = ma32[i] != null ? (close - ma32[i]!) / ma32[i]! : null
    const distMa96 = ma96[i] != null ? (close - ma96[i]!) / ma96[i]! : null
    const distMa480 = ma480[i] != null ? (close - ma480[i]!) / ma480[i]! : null
    const distHi96 = hi96[i] != null ? (close - hi96[i]!) / hi96[i]! : null
    const distLo96 = lo96[i] != null ? (close - lo96[i]!) / lo96[i]! : null
    const distHi480 = hi480[i] != null ? (close - hi480[i]!) / hi480[i]! : null
    const distLo480 = lo480[i] != null ? (close - lo480[i]!) / lo480[i]! : null
    const volRatio = volMa96[i] != null && volMa96[i]! > 0 ? volumes[i] / volMa96[i]! : null

    // FRED as-of lookups
    const laggedTargetKeyCache = new Map<number, string>()
    const laggedTargetKey = (lagDays: number): string => {
      const cached = laggedTargetKeyCache.get(lagDays)
      if (cached) return cached
      const key = dateKeyUtc(new Date(ts.getTime() - lagDays * 24 * 60 * 60 * 1000))
      laggedTargetKeyCache.set(lagDays, key)
      return key
    }

    const fredValues: (number | null)[] = FRED_FEATURES.map((f) => {
      const data = fredLookups.get(f.column)
      if (!data) return null
      const lagDays = FRED_LAG_BY_COLUMN.get(f.column) ?? 1
      return asofLookupByDateKey(data.lookup, data.sortedKeys, laggedTargetKey(lagDays))
    })

    // Derived features
    const y2y = fredValues[IDX_Y2Y]
    const y10y = fredValues[IDX_Y10Y]
    const y30y = fredValues[IDX_Y30Y]
    const tips5y = fredValues[IDX_TIPS5Y]
    const tips10y = fredValues[IDX_TIPS10Y]
    const igOas = fredValues[IDX_IG_OAS]
    const hyOas = fredValues[IDX_HY_OAS]
    const vix = fredValues[IDX_VIX]
    const vvix = fredValues[IDX_VVIX]
    const fedAssets = fredValues[IDX_FED_ASSETS]
    const rrp = fredValues[IDX_RRP]

    const yieldCurveSlope = y10y != null && y2y != null ? y10y - y2y : null
    const yieldCurveCurvature = y2y != null && y10y != null && y30y != null ? 2 * y10y - y2y - y30y : null
    const realRate5y = y2y != null && tips5y != null ? y2y - tips5y : null
    const realRate10y = y10y != null && tips10y != null ? y10y - tips10y : null
    const creditSpreadDiff = hyOas != null && igOas != null ? hyOas - igOas : null
    const vixTermStructure = vvix != null && vix != null && vix > 0 ? vvix / vix : null
    const fedLiquidity = fedAssets != null && rrp != null ? fedAssets - rrp * 1000 : null

    // News/policy 7d rolling
    const { startKey: ts7dKey, endKey: tsKey } = laggedWindowKeys(
      ts,
      NEWS_POLICY_LAG_DAYS,
      NEWS_POLICY_LOOKBACK_DAYS
    )

    let newsCount7d = 0, newsFedCount7d = 0
    for (const n of newsRows) {
      const nk = dateKeyUtc(n.eventDate)
      if (nk >= ts7dKey && nk <= tsKey) {
        newsCount7d += n.total_count
        newsFedCount7d += n.fed_count
      }
    }

    let policyCount7d = 0
    for (const p of policyRows) {
      const pk = dateKeyUtc(p.eventDate)
      if (pk >= ts7dKey && pk <= tsKey) {
        policyCount7d += p.count
      }
    }

    // Headlines from news_signals (same lagged 7-day window)
    const headlineTexts: string[] = []
    for (const ns of newsSignals) {
      const nk = dateKeyUtc(ns.pubDate)
      if (nk >= ts7dKey && nk <= tsKey) {
        headlineTexts.push(ns.title)
        if (headlineTexts.length >= 20) break
      }
    }
    const headlines7d = headlineTexts.join(' | ')

    // Assemble row
    const row: (string | number | null)[] = [
      'MES_15M',
      ts.toISOString(),
      close,
      tgtRet15m, tgtRet1h, tgtRet4h,
      hourUtc, minuteUtc, dayOfWeek, isUsSession, isAsiaSession, isEuropeSession,
      utcDate === 1 ? 1 : 0,
      utcDate === monthEnd ? 1 : 0,
      ret1bar, ret4bar, ret16bar, ret96bar,
      range, bodyRatio,
      rsi14[i], rsi2[i],
      ma32[i], ma96[i], ma480[i],
      distMa32, distMa96, distMa480,
      std32[i], std96[i], std480[i],
      distHi96, distLo96, distHi480, distLo480,
      volRatio,
      ...fredValues,
      yieldCurveSlope, yieldCurveCurvature,
      realRate5y, realRate10y,
      creditSpreadDiff, vixTermStructure,
      fedLiquidity,
      newsCount7d, newsFedCount7d,
      policyCount7d,
      headlines7d,
    ]

    rows.push(row.map((v) => {
      if (v == null) return ''
      const s = String(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
      return s
    }))
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

  console.log(`\n[dataset:15m] Written ${rows.length} rows × ${header.length} features to ${outFile}`)
  console.log(`[dataset:15m] Date range: ${rows[0][1]} → ${rows[rows.length - 1][1]}`)
  console.log(`\n[dataset:15m] FRED feature coverage:`)
  console.log(fredCoverage.join('\n'))

  const targets = ['target_ret_15m', 'target_ret_1h', 'target_ret_4h']
  for (const t of targets) {
    const idx = header.indexOf(t)
    const count = rows.filter((r) => r[idx] !== '').length
    console.log(`  ${t.padEnd(22)} ${count} / ${rows.length}`)
  }
}

run()
  .catch((error) => {
    console.error('[dataset:15m] FATAL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
