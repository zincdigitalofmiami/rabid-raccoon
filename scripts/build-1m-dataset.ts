/**
 * build-1m-dataset.ts
 *
 * Builds MES 1-minute training dataset for AutoGluon (Warbird).
 * 6 months of granular data matched with news, events, GPR, and Trump signals.
 *
 * Features (~100+ columns):
 *   - MES 1m OHLCV + technical indicators (returns, rolling stats, EDSS, range)
 *   - Individual FRED series as-of columns (VIX, yields, FX, spreads, etc.)
 *   - Derived features (yield curve slope/curvature, real rates, vol spreads)
 *   - GPR indices (GPRD, GPRD_ACT, GPRD_THREAT) + derived features
 *   - Trump effect counts by type + market impact scoring
 *   - Econ calendar proximity features (hours to next high-impact release)
 *   - News/policy rolling aggregates
 *   - Forward return targets: 1m, 5m, 15m, 1h, 4h
 *
 * Usage:
 *   npx tsx scripts/build-1m-dataset.ts
 *   npx tsx scripts/build-1m-dataset.ts --days-back=180
 *   npx tsx scripts/build-1m-dataset.ts --out=datasets/autogluon/mes_1m_complete.csv
 */

import { prisma } from '../src/lib/prisma'
import { toNum } from '../src/lib/decimal'
import { loadDotEnvFiles, parseArg, safeOutputPath, splitIntoDayChunks } from './ingest-utils'
import {
  asofLookupByDateKey,
  conservativeLagDaysForFrequency,
  dateKeyUtc,
  laggedWindowKeys,
} from './feature-availability'
import fs from 'node:fs'
import path from 'node:path'

// ─── KEY FRED SERIES ────────────────────────────────────────────────────────

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

// ─── Constants ──────────────────────────────────────────────────────────────

const NEWS_POLICY_LAG_DAYS = 1
const NEWS_POLICY_LOOKBACK_DAYS = 7
const MES_CANDLE_CHUNK_DAYS = 10  // Smaller chunks for 1m (many more rows per day)

// Max allowed gap (in ms) for forward targets.
// If candles[i+N].eventTime - candles[i].eventTime > threshold, target = null
// MES halts daily 17:00-18:00 ET (60 min) and weekends (49 hrs).
const TARGET_GAP_TOLERANCE_MS: Record<string, number> = {
  '1m':  2 * 60 * 1000,       // 2 min tolerance
  '5m':  10 * 60 * 1000,      // 10 min tolerance
  '15m': 30 * 60 * 1000,      // 30 min tolerance
  '1h':  90 * 60 * 1000,      // 90 min (allows for 1 daily halt)
  '4h':  5 * 60 * 60 * 1000,  // 5h (allows for 1 daily halt)
}

// Trump market impact → numeric score
const IMPACT_SCORE: Record<string, number> = { BULLISH: 1, NEUTRAL: 0, BEARISH: -1 }

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

// ─── Types ──────────────────────────────────────────────────────────────────

interface MesCandle {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}

type FredLookup = Map<string, number>

interface GprDay {
  eventDate: string  // YYYY-MM-DD
  gprd: number | null
  gprd_act: number | null
  gprd_threat: number | null
}

interface TrumpDay {
  eventDate: string  // YYYY-MM-DD
  tariff_count: number
  policy_count: number
  eo_count: number
  net_impact: number  // sum of BULLISH(+1) + NEUTRAL(0) + BEARISH(-1)
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function pctChange(current: number, previous: number): number | null {
  if (previous === 0 || !Number.isFinite(previous) || !Number.isFinite(current)) return null
  return (current - previous) / Math.abs(previous)
}

// Ehlers Double-Smooth Stochastic (DSP-based) — adapted for 1m bars
const EDSS_PI = Math.PI

function edssSuperSmoother(price: number[], lower: number): number[] {
  const a1 = Math.exp(-EDSS_PI * Math.sqrt(2) / lower)
  const coeff2 = 2 * a1 * Math.cos(Math.sqrt(2) * EDSS_PI / lower)
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

function edssRoofingFilter(price: number[], upper: number, lower: number): number[] {
  const alpha1 = (Math.cos(Math.sqrt(2) * EDSS_PI / upper) + Math.sin(Math.sqrt(2) * EDSS_PI / upper) - 1)
                / Math.cos(Math.sqrt(2) * EDSS_PI / upper)
  const hp: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    const p2 = i >= 2 ? price[i - 2] : price[i]
    const h1 = i >= 1 ? hp[i - 1] : 0
    const h2 = i >= 2 ? hp[i - 2] : 0
    hp[i] = Math.pow(1 - alpha1 / 2, 2) * (price[i] - 2 * p1 + p2) + 2 * (1 - alpha1) * h1 - Math.pow(1 - alpha1, 2) * h2
  }
  return edssSuperSmoother(hp, lower)
}

// 1m EDSS: use longer windows than 15m since each bar is 1/15th the timeframe
// 14-bar on 15m = 3.5h → 210 bars on 1m. roofUpper/lower scaled similarly.
function computeEDSS1m(closes: number[], length = 210, roofUpper = 720, roofLower = 150): (number | null)[] {
  const warmup = roofUpper + length
  const filt = edssRoofingFilter(closes, roofUpper, roofLower)
  const rawStoch: number[] = new Array(closes.length).fill(0)
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - length + 1)
    const slice = filt.slice(start, i + 1)
    const hi = Math.max(...slice), lo = Math.min(...slice)
    rawStoch[i] = (hi - lo) > 1e-10 ? (filt[i] - lo) / (hi - lo) : 0.5
  }
  const stoch = edssSuperSmoother(rawStoch, roofLower).map(v => Math.max(0, Math.min(1, v)))
  return stoch.map((v, i) => i < warmup ? null : v)
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

  const daysBack = Number(parseArg('days-back', '185'))  // ~6 months
  const outFile = parseArg('out', 'datasets/autogluon/mes_1m_complete.csv')
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  console.log('[dataset:1m] Building MES 1-minute training dataset')
  console.log(`[dataset:1m] Days back: ${daysBack}, Start: ${start.toISOString().slice(0, 10)}`)
  console.log('[dataset:1m] Anti-leakage policy: daily=1d, weekly=8d, monthly=35d, quarterly=100d lag')

  // ── 1. Load MES 1m candles ──
  const now = new Date()
  const candleChunks = splitIntoDayChunks(start, now, MES_CANDLE_CHUNK_DAYS)
  const candles: MesCandle[] = []
  for (let i = 0; i < candleChunks.length; i++) {
    const chunk = candleChunks[i]
    const rows = await prisma.mktFuturesMes1m.findMany({
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
    if (i === 0 || (i + 1) % 5 === 0 || i === candleChunks.length - 1) {
      console.log(`[dataset:1m] MES chunk ${i + 1}/${candleChunks.length} -> ${rows.length} rows (total: ${candles.length})`)
    }
  }

  if (candles.length < 1000) {
    throw new Error(`Insufficient MES 1m data (${candles.length} rows, need 1000+)`)
  }
  console.log(`[dataset:1m] MES 1m candles: ${candles.length}`)

  // ── 2. Load individual FRED series ──
  console.log(`[dataset:1m] Loading ${FRED_FEATURES.length} individual FRED series...`)

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

  // ── 3. Load GPR data ──
  console.log('[dataset:1m] Loading GPR indices...')
  const gprRows = await prisma.$queryRawUnsafe<{ eventDate: Date; indexName: string; value: number }[]>(
    `SELECT "eventDate", "indexName", value FROM geopolitical_risk_1d WHERE value IS NOT NULL ORDER BY "eventDate" ASC`
  )
  const gprByDate = new Map<string, GprDay>()
  for (const row of gprRows) {
    const dk = dateKeyUtc(row.eventDate)
    const entry = gprByDate.get(dk) || { eventDate: dk, gprd: null, gprd_act: null, gprd_threat: null }
    if (row.indexName === 'GPRD') entry.gprd = Number(row.value)
    else if (row.indexName === 'GPRD_ACT') entry.gprd_act = Number(row.value)
    else if (row.indexName === 'GPRD_THREAT') entry.gprd_threat = Number(row.value)
    gprByDate.set(dk, entry)
  }
  const gprSortedKeys = [...gprByDate.keys()].sort()
  console.log(`  GPR: ${gprByDate.size} days loaded`)

  // ── 4. Load Trump effect data ──
  console.log('[dataset:1m] Loading Trump effect data...')
  const trumpRows = await prisma.$queryRawUnsafe<{
    eventDate: Date; eventType: string; marketImpact: string
  }[]>(
    `SELECT "eventDate", "eventType", "marketImpact" FROM trump_effect_1d ORDER BY "eventDate" ASC`
  )
  const trumpByDate = new Map<string, TrumpDay>()
  for (const row of trumpRows) {
    const dk = dateKeyUtc(row.eventDate)
    const entry = trumpByDate.get(dk) || { eventDate: dk, tariff_count: 0, policy_count: 0, eo_count: 0, net_impact: 0 }
    if (row.eventType === 'tariff') entry.tariff_count++
    else if (row.eventType === 'policy') entry.policy_count++
    else if (row.eventType === 'executive_order') entry.eo_count++
    entry.net_impact += IMPACT_SCORE[row.marketImpact] ?? 0
    trumpByDate.set(dk, entry)
  }
  const trumpSortedKeys = [...trumpByDate.keys()].sort()
  console.log(`  Trump: ${trumpByDate.size} days loaded`)

  // ── 5. Load econ calendar (for proximity features) ──
  console.log('[dataset:1m] Loading econ calendar...')
  const calRows = await prisma.$queryRawUnsafe<{
    eventDate: Date; eventTime: string | null; eventName: string; impactRating: string | null
  }[]>(
    `SELECT "eventDate", "eventTime", "eventName", "impactRating" FROM econ_calendar WHERE "eventDate" >= $1 ORDER BY "eventDate" ASC`,
    start,
  )
  // Build sorted list of high-impact calendar events (with timestamps)
  // DST-aware ET → UTC conversion:
  //   EDT (UTC-4): Second Sunday of March → First Sunday of November
  //   EST (UTC-5): First Sunday of November → Second Sunday of March
  function isEDT(date: Date): boolean {
    const year = date.getUTCFullYear()
    // Second Sunday of March
    const mar1 = new Date(Date.UTC(year, 2, 1))
    const marSecondSunday = new Date(Date.UTC(year, 2, 14 - mar1.getUTCDay()))
    // First Sunday of November
    const nov1 = new Date(Date.UTC(year, 10, 1))
    const novFirstSunday = new Date(Date.UTC(year, 10, 7 - (nov1.getUTCDay() || 7) + 1))
    // EDT starts at 2:00 AM ET on marSecondSunday → 07:00 UTC
    const edtStart = new Date(marSecondSunday.getTime() + 7 * 3600_000)
    // EST starts at 2:00 AM ET on novFirstSunday → 06:00 UTC
    const estStart = new Date(novFirstSunday.getTime() + 6 * 3600_000)
    return date >= edtStart && date < estStart
  }

  const highImpactEvents: { tsMs: number; name: string }[] = []
  for (const row of calRows) {
    const impact = (row.impactRating ?? '').toLowerCase()
    if (impact !== 'high' && impact !== 'medium') continue
    // eventTime is a string like "14:00 ET" — parse it with DST awareness
    let tsMs: number
    if (row.eventTime && typeof row.eventTime === 'string') {
      const match = (row.eventTime as string).match(/^(\d{1,2}):(\d{2})/)
      if (match) {
        const etHour = parseInt(match[1], 10)
        const etMin = parseInt(match[2], 10)
        const dateStr = dateKeyUtc(row.eventDate)
        // Determine if this date is in EDT or EST
        const utcOffset = isEDT(row.eventDate) ? 4 : 5
        const utcHour = etHour + utcOffset
        tsMs = new Date(`${dateStr}T${String(utcHour).padStart(2, '0')}:${String(etMin).padStart(2, '0')}:00Z`).getTime()
      } else {
        // No parseable time — default to 8:30 AM ET
        const utcOffset = isEDT(row.eventDate) ? 4 : 5
        tsMs = new Date(dateKeyUtc(row.eventDate) + `T${String(8 + utcOffset).padStart(2, '0')}:30:00Z`).getTime()
      }
    } else {
      const utcOffset = isEDT(row.eventDate) ? 4 : 5
      tsMs = new Date(dateKeyUtc(row.eventDate) + `T${String(8 + utcOffset).padStart(2, '0')}:30:00Z`).getTime()
    }
    highImpactEvents.push({ tsMs, name: row.eventName })
  }
  highImpactEvents.sort((a, b) => a.tsMs - b.tsMs)
  console.log(`  Calendar: ${calRows.length} total, ${highImpactEvents.length} high/medium impact events`)

  // ── 6. Load news/policy data ──
  console.log('[dataset:1m] Loading news & policy data...')

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

  // NOTE: news_signals (headlines) loaded separately for future NLP features
  // Skipping for now — headline text needs embedding before it's useful as a feature

  // ── 7. Precompute technical indicators (1m-adjusted windows) ──
  // Windows scaled for 1m: 60 bars=1h, 240 bars=4h, 1440 bars=1d, 7200 bars=5d
  console.log('[dataset:1m] Computing technical indicators at 1m granularity...')

  const closes = candles.map((c) => c.close)
  const volumes = candles.map((c) => Number(c.volume ?? 0))

  const edss = computeEDSS1m(closes)
  // 1m-scaled MAs: 60=1h, 240=4h, 1440=1d, 7200=5d
  const ma60 = rollingMean(closes, 60)
  const ma240 = rollingMean(closes, 240)
  const ma1440 = rollingMean(closes, 1440)
  const std60 = rollingStd(closes, 60)
  const std240 = rollingStd(closes, 240)
  const std1440 = rollingStd(closes, 1440)
  const { min: lo240, max: hi240 } = rollingMinMax(closes, 240)
  const { min: lo1440, max: hi1440 } = rollingMinMax(closes, 1440)
  const volMa240 = rollingMean(volumes, 240)

  console.log('[dataset:1m] Technical indicators computed')

  // ── 8. Build output rows ──
  console.log('[dataset:1m] Assembling feature matrix...')

  const header: string[] = [
    'item_id', 'timestamp', 'target',
    // Forward return targets at 1m granularity
    'target_ret_1m', 'target_ret_5m', 'target_ret_15m', 'target_ret_1h', 'target_ret_4h',
    // Forward price targets (for regression)
    'target_price_1h', 'target_price_4h',
    // Time features
    'hour_utc', 'minute_utc', 'day_of_week', 'is_us_session', 'is_asia_session', 'is_europe_session',
    'is_month_start', 'is_month_end',
    'minutes_since_midnight_utc', 'session_minute',
    // MES technical features (1m bar lookbacks)
    'mes_ret_1bar', 'mes_ret_5bar', 'mes_ret_15bar', 'mes_ret_60bar', 'mes_ret_240bar',
    'mes_range', 'mes_body_ratio',
    'mes_edss',
    'mes_ma60', 'mes_ma240', 'mes_ma1440',
    'mes_dist_ma60', 'mes_dist_ma240', 'mes_dist_ma1440',
    'mes_std60', 'mes_std240', 'mes_std1440',
    'mes_dist_hi240', 'mes_dist_lo240', 'mes_dist_hi1440', 'mes_dist_lo1440',
    'mes_vol_ratio',
    // Individual FRED features
    ...FRED_FEATURES.map((f) => f.column),
    // Derived features
    'yield_curve_slope', 'yield_curve_curvature',
    'real_rate_5y', 'real_rate_10y',
    'credit_spread_diff', 'vix_term_structure',
    'fed_liquidity',
    // GPR features
    'gpr_index', 'gpr_acts', 'gpr_threats',
    'gpr_threat_act_ratio',
    // Trump features
    'trump_tariff_count_7d', 'trump_policy_count_7d', 'trump_eo_count_7d',
    'trump_net_impact_7d',
    // Calendar proximity features
    'hours_to_next_high_impact', 'is_near_event',
    // News/policy rolling
    'news_count_7d', 'news_fed_count_7d',
    'policy_count_7d',
  ]

  const rows: string[][] = []
  let emittedProgress = 0

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const ts = c.eventTime
    const close = c.close
    const tsMs = ts.getTime()

    // Progress every 10K rows
    if (i - emittedProgress >= 10000) {
      console.log(`[dataset:1m] Processing row ${i}/${candles.length} (${((i/candles.length)*100).toFixed(1)}%)`)
      emittedProgress = i
    }

    // Forward return targets (1m bars) — with gap validation
    // MES halts daily 17:00-18:00 ET and on weekends. If a target bar is
    // across a gap, the elapsed time won't match the horizon. Null those
    // targets so the model doesn't learn fake cross-gap returns.
    function safeTarget(offset: number, horizon: string): { ret: number | null; price: number | null } {
      if (i + offset >= candles.length) return { ret: null, price: null }
      const futureBar = candles[i + offset]
      const elapsedMs = futureBar.eventTime.getTime() - tsMs
      const maxMs = TARGET_GAP_TOLERANCE_MS[horizon]
      if (maxMs && elapsedMs > maxMs) return { ret: null, price: null }
      return { ret: pctChange(futureBar.close, close), price: futureBar.close }
    }

    const t1m = safeTarget(1, '1m')
    const t5m = safeTarget(5, '5m')
    const t15m = safeTarget(15, '15m')
    const t1h = safeTarget(60, '1h')
    const t4h = safeTarget(240, '4h')

    const tgtRet1m = t1m.ret
    const tgtRet5m = t5m.ret
    const tgtRet15m = t15m.ret
    const tgtRet1h = t1h.ret
    const tgtRet4h = t4h.ret

    // Forward price targets (absolute price — for regression)
    const tgtPrice1h = t1h.price
    const tgtPrice4h = t4h.price

    // Time features
    const hourUtc = ts.getUTCHours()
    const minuteUtc = ts.getUTCMinutes()
    const dayOfWeek = ts.getUTCDay()
    const isUsSession = hourUtc >= 13 && hourUtc < 21 ? 1 : 0
    const isAsiaSession = hourUtc >= 0 && hourUtc < 7 ? 1 : 0
    const isEuropeSession = hourUtc >= 7 && hourUtc < 13 ? 1 : 0
    const utcDate = ts.getUTCDate()
    const monthEnd = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth() + 1, 0)).getUTCDate()
    const minutesSinceMidnight = hourUtc * 60 + minuteUtc
    // Session minute: minutes since US session open (13:30 UTC = 8:30 AM ET)
    const sessionOpen = 13 * 60 + 30
    const sessionMinute = minutesSinceMidnight >= sessionOpen ? minutesSinceMidnight - sessionOpen : null

    // MES technical features (1m bar lookbacks)
    const ret1bar = i >= 1 ? pctChange(close, candles[i - 1].close) : null
    const ret5bar = i >= 5 ? pctChange(close, candles[i - 5].close) : null
    const ret15bar = i >= 15 ? pctChange(close, candles[i - 15].close) : null
    const ret60bar = i >= 60 ? pctChange(close, candles[i - 60].close) : null
    const ret240bar = i >= 240 ? pctChange(close, candles[i - 240].close) : null
    const range = c.high > 0 ? (c.high - c.low) / c.close : null
    const bodyRatio = c.high !== c.low ? Math.abs(c.close - c.open) / (c.high - c.low) : null
    const distMa60 = ma60[i] != null ? (close - ma60[i]!) / ma60[i]! : null
    const distMa240 = ma240[i] != null ? (close - ma240[i]!) / ma240[i]! : null
    const distMa1440 = ma1440[i] != null ? (close - ma1440[i]!) / ma1440[i]! : null
    const distHi240 = hi240[i] != null ? (close - hi240[i]!) / hi240[i]! : null
    const distLo240 = lo240[i] != null ? (close - lo240[i]!) / lo240[i]! : null
    const distHi1440 = hi1440[i] != null ? (close - hi1440[i]!) / hi1440[i]! : null
    const distLo1440 = lo1440[i] != null ? (close - lo1440[i]!) / lo1440[i]! : null
    const volRatio = volMa240[i] != null && volMa240[i]! > 0 ? volumes[i] / volMa240[i]! : null

    // FRED as-of lookups (lagged to prevent leakage)
    const laggedTargetKeyCache = new Map<number, string>()
    const laggedTargetKey = (lagDays: number): string => {
      const cached = laggedTargetKeyCache.get(lagDays)
      if (cached) return cached
      const key = dateKeyUtc(new Date(tsMs - lagDays * 24 * 60 * 60 * 1000))
      laggedTargetKeyCache.set(lagDays, key)
      return key
    }

    const fredValues: (number | null)[] = FRED_FEATURES.map((f) => {
      const data = fredLookups.get(f.column)
      if (!data) return null
      const lagDays = FRED_LAG_BY_COLUMN.get(f.column) ?? 1
      return asofLookupByDateKey(data.lookup, data.sortedKeys, laggedTargetKey(lagDays))
    })

    // Derived FRED features
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

    // GPR features (1-day lag to prevent leakage)
    const gprDate = laggedTargetKey(1)
    let gprIndex: number | null = null
    let gprActs: number | null = null
    let gprThreats: number | null = null
    // As-of lookup: find most recent GPR on or before gprDate
    const gprKeyIdx = binarySearchFloor(gprSortedKeys, gprDate)
    if (gprKeyIdx >= 0) {
      const gprDay = gprByDate.get(gprSortedKeys[gprKeyIdx])
      if (gprDay) {
        gprIndex = gprDay.gprd
        gprActs = gprDay.gprd_act
        gprThreats = gprDay.gprd_threat
      }
    }
    const gprThreatActRatio = gprActs != null && gprThreats != null && gprActs > 0
      ? gprThreats / gprActs
      : null

    // Trump features (7-day rolling window, 1-day lag)
    const { startKey: trump7dStart, endKey: trump7dEnd } = laggedWindowKeys(ts, 1, 7)
    let trumpTariff7d = 0, trumpPolicy7d = 0, trumpEo7d = 0, trumpNetImpact7d = 0
    for (const tk of trumpSortedKeys) {
      if (tk < trump7dStart) continue
      if (tk > trump7dEnd) break
      const day = trumpByDate.get(tk)
      if (!day) continue
      trumpTariff7d += day.tariff_count
      trumpPolicy7d += day.policy_count
      trumpEo7d += day.eo_count
      trumpNetImpact7d += day.net_impact
    }

    // Calendar proximity: hours until next high-impact event
    let hoursToNext: number | null = null
    let isNearEvent = 0
    for (const evt of highImpactEvents) {
      if (evt.tsMs >= tsMs) {
        hoursToNext = (evt.tsMs - tsMs) / (60 * 60 * 1000)
        if (hoursToNext <= 2) isNearEvent = 1
        break
      }
    }

    // News/policy 7d rolling (same as 15m dataset)
    const { startKey: ts7dKey, endKey: tsKey } = laggedWindowKeys(ts, NEWS_POLICY_LAG_DAYS, NEWS_POLICY_LOOKBACK_DAYS)

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

    // Assemble row
    const row: (string | number | null)[] = [
      'MES_1M',
      ts.toISOString(),
      close,
      tgtRet1m, tgtRet5m, tgtRet15m, tgtRet1h, tgtRet4h,
      tgtPrice1h, tgtPrice4h,
      hourUtc, minuteUtc, dayOfWeek, isUsSession, isAsiaSession, isEuropeSession,
      utcDate === 1 ? 1 : 0,
      utcDate === monthEnd ? 1 : 0,
      minutesSinceMidnight, sessionMinute,
      ret1bar, ret5bar, ret15bar, ret60bar, ret240bar,
      range, bodyRatio,
      edss[i],
      ma60[i], ma240[i], ma1440[i],
      distMa60, distMa240, distMa1440,
      std60[i], std240[i], std1440[i],
      distHi240, distLo240, distHi1440, distLo1440,
      volRatio,
      ...fredValues,
      yieldCurveSlope, yieldCurveCurvature,
      realRate5y, realRate10y,
      creditSpreadDiff, vixTermStructure,
      fedLiquidity,
      gprIndex, gprActs, gprThreats,
      gprThreatActRatio,
      trumpTariff7d, trumpPolicy7d, trumpEo7d,
      trumpNetImpact7d,
      hoursToNext, isNearEvent,
      newsCount7d, newsFedCount7d,
      policyCount7d,
    ]

    rows.push(row.map((v) => {
      if (v == null) return ''
      const s = String(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
      return s
    }))
  }

  // ── 9. Write CSV ──
  const outPath = safeOutputPath(outFile, path.resolve(__dirname, '..'))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const csvLines = [header.join(','), ...rows.map((r) => r.join(','))]
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', 'utf8')

  // Summary
  const nonNullCounts: Record<string, number> = {}
  for (let col = 0; col < header.length; col++) {
    nonNullCounts[header[col]] = rows.filter((r) => r[col] !== '').length
  }

  const fileSizeMb = (fs.statSync(outPath).size / 1024 / 1024).toFixed(1)

  console.log(`\n[dataset:1m] Written ${rows.length} rows × ${header.length} features to ${outFile} (${fileSizeMb} MB)`)
  console.log(`[dataset:1m] Date range: ${rows[0]?.[1]} → ${rows[rows.length - 1]?.[1]}`)

  console.log(`\n[dataset:1m] FRED feature coverage:`)
  for (const f of FRED_FEATURES) {
    const count = nonNullCounts[f.column] ?? 0
    const pct = ((count / rows.length) * 100).toFixed(1)
    console.log(`  ${f.column.padEnd(28)} ${String(count).padStart(7)} / ${rows.length} (${pct}%)`)
  }

  console.log(`\n[dataset:1m] Event feature coverage:`)
  for (const col of ['gpr_index', 'gpr_acts', 'gpr_threats', 'trump_tariff_count_7d', 'hours_to_next_high_impact']) {
    const count = nonNullCounts[col] ?? 0
    const pct = ((count / rows.length) * 100).toFixed(1)
    console.log(`  ${col.padEnd(28)} ${String(count).padStart(7)} / ${rows.length} (${pct}%)`)
  }

  console.log(`\n[dataset:1m] Target coverage:`)
  for (const t of ['target_ret_1m', 'target_ret_5m', 'target_ret_15m', 'target_ret_1h', 'target_ret_4h', 'target_price_1h', 'target_price_4h']) {
    const idx = header.indexOf(t)
    const count = rows.filter((r) => r[idx] !== '').length
    console.log(`  ${t.padEnd(28)} ${count} / ${rows.length}`)
  }
}

// Binary search: find largest index where keys[idx] <= target
function binarySearchFloor(keys: string[], target: string): number {
  let lo = 0, hi = keys.length - 1, result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (keys[mid] <= target) {
      result = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}

run()
  .catch((error) => {
    console.error('[dataset:1m] FATAL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
