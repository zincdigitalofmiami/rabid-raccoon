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
import { toNum } from '../src/lib/decimal'
import { loadDotEnvFiles, neutralizeFormula, parseArg, safeOutputPath } from './ingest-utils'
import {
  asofLookupByDateKey,
  conservativeLagDaysForFrequency,
  dateKeyUtc,
  laggedWindowKeys,
} from './feature-availability'
import {
  buildFredArray,
} from './feature-utils'
import fs from 'node:fs'
import path from 'node:path'

// ─── KEY FRED SERIES FOR MES TRADING ──────────────────────────────────────
// Individual series → individual columns (not aggregated)

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

  // Yield curve (full term structure)
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
// Phase 2: Additional feature indices for derived features
const _IDX_Y5Y = featureIndex('fred_y5y')
const _IDX_OVX = featureIndex('fred_ovx')
const _IDX_DFF = featureIndex('fred_dff')
const _IDX_SOFR = featureIndex('fred_sofr')
const _IDX_FED_TARGET_LOWER = featureIndex('fred_fed_target_lower')
const _IDX_FED_TARGET_UPPER = featureIndex('fred_fed_target_upper')
const _IDX_INFL5Y = featureIndex('fred_infl5y')
const _IDX_INFL10Y = featureIndex('fred_infl10y')
const _IDX_INFL5Y5Y = featureIndex('fred_infl5y5y')
const _IDX_DXY = featureIndex('fred_dxy')
const _IDX_JPYUSD = featureIndex('fred_jpyusd')
const _IDX_CNYUSD = featureIndex('fred_cnyusd')
const _IDX_CLAIMS = featureIndex('fred_claims')
const _IDX_CCSA = featureIndex('fred_continuing_claims')
const _IDX_UNEMPLOYMENT = featureIndex('fred_unemployment')
const _IDX_CONSUMER_SENT = featureIndex('fred_consumer_sent')
const _IDX_IND_PRODUCTION = featureIndex('fred_ind_production')
const _IDX_TRADE_BALANCE = featureIndex('fred_trade_balance')
const _IDX_WTI = featureIndex('fred_wti')
const _IDX_BRENT = featureIndex('fred_brent')
const _IDX_M2 = featureIndex('fred_m2')
const _IDX_EPU = featureIndex('fred_epu')
const _IDX_NFCI = featureIndex('fred_nfci')

const FRED_LAG_BY_COLUMN = new Map(
  FRED_FEATURES.map((f) => [f.column, conservativeLagDaysForFrequency(f.frequency)])
)

// Phase 2: Lookback constants for 1h builder
const BARS_PER_DAY = 24
const _VELOCITY_LOOKBACK = 5 * BARS_PER_DAY        // 5 trading days = 120 bars
const _MOMENTUM_20D_LOOKBACK = 20 * BARS_PER_DAY   // 20 trading days = 480 bars

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

function pctChange(current: number, previous: number): number | null {
  if (previous === 0 || !Number.isFinite(previous) || !Number.isFinite(current)) return null
  return (current - previous) / Math.abs(previous)
}

// computeRSI removed — replaced by computeEDSS (Ehlers DSP-based)

const EDSS_PI_COMPLETE = Math.PI

function edssSuperSmootherComplete(price: number[], lower: number): number[] {
  const a1 = Math.exp(-EDSS_PI_COMPLETE * Math.sqrt(2) / lower)
  const coeff2 = 2 * a1 * Math.cos(Math.sqrt(2) * EDSS_PI_COMPLETE / lower)
  const coeff3 = -Math.pow(a1, 2)
  const coeff1 = 1 - coeff2 - coeff3
  const out: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    const f1 = i >= 1 ? out[i - 1] : 0
    const f2 = i >= 2 ? out[i - 2] : 0
    out[i] = coeff1 * (price[i] + p1) / 2 + coeff2 * f1 + coeff3 * f2
  }
  return out
}

function edssRoofingFilterComplete(price: number[], upper: number, lower: number): number[] {
  const alpha1 = (Math.cos(Math.sqrt(2) * EDSS_PI_COMPLETE / upper) + Math.sin(Math.sqrt(2) * EDSS_PI_COMPLETE / upper) - 1)
                / Math.cos(Math.sqrt(2) * EDSS_PI_COMPLETE / upper)
  const hp: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    const p2 = i >= 2 ? price[i - 2] : price[i]
    const h1 = i >= 1 ? hp[i - 1] : 0
    const h2 = i >= 2 ? hp[i - 2] : 0
    hp[i] = Math.pow(1 - alpha1 / 2, 2) * (price[i] - 2 * p1 + p2) + 2 * (1 - alpha1) * h1 - Math.pow(1 - alpha1, 2) * h2
  }
  return edssSuperSmootherComplete(hp, lower)
}

function computeEDSSComplete(closes: number[], length = 14, roofUpper = 48, roofLower = 10): (number | null)[] {
  const warmup = roofUpper + length
  const filt = edssRoofingFilterComplete(closes, roofUpper, roofLower)
  const rawStoch: number[] = new Array(closes.length).fill(0)
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - length + 1)
    const slice = filt.slice(start, i + 1)
    const hi = Math.max(...slice), lo = Math.min(...slice)
    // FIX: near-zero range = no cycle detected → neutral 0.5, not 0
    rawStoch[i] = (hi - lo) > 1e-10 ? (filt[i] - lo) / (hi - lo) : 0.5
  }
  // FIX: clamp to [0,1] — super smoother overshoots ~4%
  const stoch = edssSuperSmootherComplete(rawStoch, roofLower).map(v => Math.max(0, Math.min(1, v)))
  // FIX: null-mask warmup bars
  return stoch.map((v, i) => i < warmup ? null : v)
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
  console.log('[dataset] Anti-leakage policy: daily=1d, weekly=8d, monthly=35d, quarterly=100d lag')

  // ── 1. Load MES 1h candles ──
  const candles: MesCandle[] = (await prisma.mktFuturesMes1h.findMany({
    where: { eventTime: { gte: start } },
    orderBy: { eventTime: 'asc' },
    select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
  })).map(r => ({
    eventTime: r.eventTime,
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: r.volume,
  }))

  if (candles.length < 200) {
    throw new Error(`Insufficient MES 1h data (${candles.length} rows, need 200+)`)
  }
  console.log(`[dataset] MES 1h candles: ${candles.length}`)

  // ── 2. Load individual FRED series ──
  console.log(`[dataset] Loading ${FRED_FEATURES.length} individual FRED series...`)

  const fredLookups: Map<string, { lookup: FredLookup; sortedKeys: string[] }> = new Map()

  // Query FRED data from split domain tables, grouped by table
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

    // Group by seriesId
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

  // ── 3b. Build FRED arrays for velocity/momentum/percentile features ──
  console.log('[dataset] Building FRED arrays for derived features...')

  const buildArr = (column: string): (number | null)[] => {
    const data = fredLookups.get(column)
    if (!data) return new Array(candles.length).fill(null)
    const lagDays = FRED_LAG_BY_COLUMN.get(column) ?? 1
    return buildFredArray(candles, data.lookup, data.sortedKeys, lagDays, dateKeyUtc, asofLookupByDateKey)
  }

  // Arrays needed for velocity/momentum/percentile features
  const _vixArr = buildArr('fred_vix')
  const _hyOasArr = buildArr('fred_hy_oas')
  const _y10yArr = buildArr('fred_y10y')
  const _y2yArr = buildArr('fred_y2y')
  const _infl10yArr = buildArr('fred_infl10y')
  const _dxyArr = buildArr('fred_dxy')
  const _jpyArr = buildArr('fred_jpyusd')
  const _cnyArr = buildArr('fred_cnyusd')
  const _claimsArr = buildArr('fred_claims')
  const _ccsaArr = buildArr('fred_continuing_claims')
  const _unemploymentArr = buildArr('fred_unemployment')
  const _consumerSentArr = buildArr('fred_consumer_sent')
  const _indProArr = buildArr('fred_ind_production')
  const _tradeBalArr = buildArr('fred_trade_balance')
  const _wtiArr = buildArr('fred_wti')
  const _walclArr = buildArr('fred_fed_assets')
  const _rrpArr = buildArr('fred_rrp')
  const _m2Arr = buildArr('fred_m2')
  const _epuArr = buildArr('fred_epu')
  const _nfciArr = buildArr('fred_nfci')

  console.log('[dataset] FRED arrays built for 20 series')

  // ── 4. Precompute technical indicators on MES ──
  console.log('[dataset] Computing technical indicators...')

  const closes = candles.map((c) => c.close)
  const _highs = candles.map((c) => c.high)
  const _lows = candles.map((c) => c.low)
  const volumes = candles.map((c) => Number(c.volume ?? 0))

  const edss14 = computeEDSSComplete(closes)
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
    'target_ret_1h', 'target_ret_4h', 'target_ret_8h', 'target_ret_24h', 'target_ret_1w',
    // Time features
    'hour_utc', 'day_of_week', 'is_us_session', 'is_asia_session', 'is_europe_session',
    'is_month_start', 'is_month_end',
    // MES technical features
    'mes_ret_1h', 'mes_ret_4h', 'mes_ret_8h', 'mes_ret_24h',
    'mes_range', 'mes_body_ratio',
    'mes_edss',
    'mes_ma8', 'mes_ma24', 'mes_ma120',
    'mes_dist_ma8', 'mes_dist_ma24', 'mes_dist_ma120',
    'mes_std8', 'mes_std24', 'mes_std120',
    'mes_dist_hi24', 'mes_dist_lo24', 'mes_dist_hi120', 'mes_dist_lo120',
    'mes_vol_ratio',
    // Individual FRED features
    ...FRED_FEATURES.map((f) => f.column),
    // Derived features (Phase 1 originals)
    'yield_curve_slope', 'yield_curve_curvature',
    'real_rate_5y', 'real_rate_10y',
    'credit_spread_diff', 'vix_term_structure',
    'fed_liquidity',
    // Phase 2: Rates derived
    'fed_midpoint', 'rate_cut_distance', 'sofr_dff_spread',
    // Phase 2: Yields derived
    'yield_curve_5y30y', 'dgs10_velocity_5d', 'dgs2_velocity_5d',
    // Phase 2: Volatility & credit derived
    'vix_percentile_20d', 'vix_1d_change', 'hy_spread_momentum_5d', 'ovx_vix_divergence',
    // Phase 2: Inflation derived
    'breakeven_spread_10y5y', 'inflation_deanchor_flag', 'real_yield_slope', 't10yie_5d_change',
    // Phase 2: FX derived
    'dollar_momentum_5d', 'dollar_momentum_20d', 'jpy_spike_flag', 'cny_stress_flag',
    // Phase 2: Labor derived
    'claims_4wk_ma', 'ccsa_4wk_roc', 'sahm_rule_proxy',
    // Phase 2: Activity derived
    'umcsent_3mo_trend', 'indpro_3mo_trend', 'trade_balance_3mo_trend',
    // Phase 2: Commodities derived
    'wti_brent_spread', 'wti_shock_flag',
    // Phase 2: Money/liquidity derived
    'walcl_4wk_change', 'rrp_5d_change', 'm2_yoy_growth',
    // Phase 2: EPU & NFCI derived
    'epu_20d_percentile', 'nfci_4wk_trend',
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

    // Forward return targets (shift forward — 1h bars)
    const tgtRet1h = i + 1 < candles.length ? pctChange(candles[i + 1].close, close) : null
    const tgtRet4h = i + 4 < candles.length ? pctChange(candles[i + 4].close, close) : null
    const tgtRet8h = i + 8 < candles.length ? pctChange(candles[i + 8].close, close) : null
    const tgtRet24h = i + 24 < candles.length ? pctChange(candles[i + 24].close, close) : null
    const tgtRet1w = i + 168 < candles.length ? pctChange(candles[i + 168].close, close) : null

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
    const yieldCurveCurvature = y2y != null && y10y != null && y30y != null
      ? 2 * y10y - y2y - y30y : null
    const realRate5y = y2y != null && tips5y != null ? y2y - tips5y : null  // proxy
    const realRate10y = y10y != null && tips10y != null ? y10y - tips10y : null
    const creditSpreadDiff = hyOas != null && igOas != null ? hyOas - igOas : null
    const vixTermStructure = vvix != null && vix != null && vix > 0 ? vvix / vix : null
    const fedLiquidity = fedAssets != null && rrp != null
      ? fedAssets - rrp * 1000 : null  // RRP is in billions, assets in millions

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
        headlineTexts.push(neutralizeFormula(ns.title))
        if (headlineTexts.length >= 20) break
      }
    }
    const headlines7d = headlineTexts.join(' | ')

    // Assemble row
    const row: (string | number | null)[] = [
      'MES_1H',
      ts.toISOString(),
      close,
      tgtRet1h, tgtRet4h, tgtRet8h, tgtRet24h, tgtRet1w,
      hourUtc, dayOfWeek, isUsSession, isAsiaSession, isEuropeSession,
      utcDate === 1 ? 1 : 0,
      utcDate === monthEnd ? 1 : 0,
      ret1h, ret4h, ret8h, ret24h,
      range, bodyRatio,
      edss14[i],
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
  const outPath = safeOutputPath(outFile, path.resolve(__dirname, '..'))
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

  const targets = ['target_ret_1h', 'target_ret_4h', 'target_ret_8h', 'target_ret_24h', 'target_ret_1w']
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
