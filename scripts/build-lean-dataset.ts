/**
 * build-lean-dataset.ts
 *
 * THE RABID RACCOON — Lean MES Intraday Dataset Builder
 *
 * ~66 columns, optimized for high-frequency MES day trading.
 * Every feature either moves intraday or defines the trading regime.
 *
 * Design principles:
 *   - Price action first (22 MES technicals)
 *   - Daily macro context that sets the day's tone (19 FRED series)
 *   - Velocity/regime features (6 derived — VIX percentile, yield velocity, dollar momentum)
 *   - Event flags from econ_calendar (FOMC day, high-impact day)
 *   - NO monthly/quarterly stale data (GDP, CPI, NFP, trade balance, etc.)
 *   - NO redundant series (no VVIX when we have VIX, no Brent when we have WTI)
 *
 * Supports both 1h and 15m timeframes via --timeframe flag.
 *
 * Usage:
 *   npx tsx scripts/build-lean-dataset.ts
 *   npx tsx scripts/build-lean-dataset.ts --timeframe=15m
 *   npx tsx scripts/build-lean-dataset.ts --days-back=365
 *   npx tsx scripts/build-lean-dataset.ts --out=datasets/autogluon/mes_lean_1h.csv
 */

import { prisma } from '../src/lib/prisma'
import { toNum } from '../src/lib/decimal'
import { loadDotEnvFiles, parseArg } from './ingest-utils'
import {
  asofLookupByDateKey,
  conservativeLagDaysForFrequency,
  dateKeyUtc,
} from './feature-availability'
import {
  buildFredArray,
  rollingPercentile,
  deltaBack,
  pctDeltaBack,
} from './feature-utils'
import fs from 'node:fs'
import path from 'node:path'

// ─── LEAN FRED SERIES — Only what moves intraday or sets daily tone ──────

interface FredSeriesConfig {
  seriesId: string
  column: string
  table: string
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly'
}

const FRED_FEATURES: FredSeriesConfig[] = [
  // Volatility — the #1 intraday signal
  { seriesId: 'VIXCLS',       column: 'fred_vix',              table: 'econ_vol_indices_1d', frequency: 'daily' },

  // Rates — where the Fed is
  { seriesId: 'DFF',           column: 'fred_dff',              table: 'econ_rates_1d',       frequency: 'daily' },
  { seriesId: 'SOFR',          column: 'fred_sofr',             table: 'econ_rates_1d',       frequency: 'daily' },
  { seriesId: 'DFEDTARL',      column: 'fred_fed_target_lower', table: 'econ_rates_1d',       frequency: 'daily' },
  { seriesId: 'DFEDTARU',      column: 'fred_fed_target_upper', table: 'econ_rates_1d',       frequency: 'daily' },

  // Yield curve — shape defines regime
  { seriesId: 'DGS2',          column: 'fred_y2y',              table: 'econ_yields_1d',      frequency: 'daily' },
  { seriesId: 'DGS10',         column: 'fred_y10y',             table: 'econ_yields_1d',      frequency: 'daily' },
  { seriesId: 'DGS30',         column: 'fred_y30y',             table: 'econ_yields_1d',      frequency: 'daily' },

  // FX — dollar strength drives everything
  { seriesId: 'DTWEXBGS',      column: 'fred_dxy',              table: 'econ_fx_1d',          frequency: 'daily' },
  { seriesId: 'DEXUSEU',       column: 'fred_eurusd',           table: 'econ_fx_1d',          frequency: 'daily' },
  { seriesId: 'DEXJPUS',       column: 'fred_jpyusd',           table: 'econ_fx_1d',          frequency: 'daily' },

  // Commodities — energy shock proxy
  { seriesId: 'DCOILWTICO',    column: 'fred_wti',              table: 'econ_commodities_1d', frequency: 'daily' },
  { seriesId: 'PCOPPUSDM',     column: 'fred_copper',           table: 'econ_commodities_1d', frequency: 'monthly' },

  // Liquidity — Fed balance sheet dynamics
  { seriesId: 'WALCL',         column: 'fred_fed_assets',       table: 'econ_money_1d',       frequency: 'weekly' },
  { seriesId: 'RRPONTSYD',     column: 'fred_rrp',              table: 'econ_money_1d',       frequency: 'daily' },

  // Labor — weekly pulse
  { seriesId: 'ICSA',          column: 'fred_claims',           table: 'econ_labor_1d',       frequency: 'weekly' },

  // Credit — risk appetite
  { seriesId: 'BAMLC0A0CM',    column: 'fred_ig_oas',           table: 'econ_vol_indices_1d', frequency: 'daily' },
  { seriesId: 'BAMLH0A0HYM2',  column: 'fred_hy_oas',           table: 'econ_vol_indices_1d', frequency: 'daily' },

  // Real yields — TIPS 10Y for proper real rate
  { seriesId: 'DFII10',         column: 'fred_tips10y',          table: 'econ_inflation_1d',   frequency: 'daily' },
]

// Feature index helpers
function featureIndex(column: string): number {
  const idx = FRED_FEATURES.findIndex((f) => f.column === column)
  if (idx < 0) throw new Error(`Missing feature column '${column}'`)
  return idx
}

const IDX_VIX = featureIndex('fred_vix')
const IDX_DFF = featureIndex('fred_dff')
const IDX_FED_TARGET_LOWER = featureIndex('fred_fed_target_lower')
const IDX_FED_TARGET_UPPER = featureIndex('fred_fed_target_upper')
const IDX_Y2Y = featureIndex('fred_y2y')
const IDX_Y10Y = featureIndex('fred_y10y')
const IDX_DXY = featureIndex('fred_dxy')
const IDX_IG_OAS = featureIndex('fred_ig_oas')
const IDX_HY_OAS = featureIndex('fred_hy_oas')
const IDX_FED_ASSETS = featureIndex('fred_fed_assets')
const IDX_RRP = featureIndex('fred_rrp')
const IDX_TIPS10Y = featureIndex('fred_tips10y')

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
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period
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

  const timeframe = parseArg('timeframe', '1h') as '1h' | '15m'
  const daysBack = Number(parseArg('days-back', '730'))
  const defaultOut = timeframe === '15m'
    ? 'datasets/autogluon/mes_lean_15m.csv'
    : 'datasets/autogluon/mes_lean_1h.csv'
  const outFile = parseArg('out', defaultOut)
  const start = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)

  const barsPerDay = timeframe === '15m' ? 96 : 24
  const velocityLookback = 5 * barsPerDay  // 5 trading days

  console.log(`[lean-dataset] Building LEAN MES ${timeframe} dataset for intraday trading`)
  console.log(`[lean-dataset] Timeframe: ${timeframe}, Days back: ${daysBack}`)
  console.log(`[lean-dataset] Bars/day: ${barsPerDay}, Velocity lookback: ${velocityLookback} bars`)

  // ── 1. Load MES candles ──
  const tableName = timeframe === '15m' ? 'mktFuturesMes15m' : 'mktFuturesMes1h'
  const rawCandles = await (prisma as any)[tableName].findMany({
    where: { eventTime: { gte: start } },
    orderBy: { eventTime: 'asc' },
    select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
  })

  const candles: MesCandle[] = rawCandles.map((r: any) => ({
    eventTime: r.eventTime,
    open: toNum(r.open),
    high: toNum(r.high),
    low: toNum(r.low),
    close: toNum(r.close),
    volume: r.volume,
  }))

  if (candles.length < 200) {
    throw new Error(`Insufficient MES ${timeframe} data (${candles.length} rows, need 200+)`)
  }
  console.log(`[lean-dataset] MES ${timeframe} candles: ${candles.length}`)

  // ── 2. Load FRED series ──
  console.log(`[lean-dataset] Loading ${FRED_FEATURES.length} FRED series (lean set)...`)

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

  // ── 3. Load econ_calendar for event flags ──
  console.log('[lean-dataset] Loading economic calendar for event flags...')
  const calendarEvents = await prisma.econCalendar.findMany({
    where: { eventDate: { gte: start } },
    select: { eventDate: true, eventName: true, eventType: true, impactRating: true },
    orderBy: { eventDate: 'asc' },
  })

  // Build calendar lookup: dateKey → events[]
  const calendarLookup = new Map<string, typeof calendarEvents>()
  for (const evt of calendarEvents) {
    const key = dateKeyUtc(evt.eventDate)
    const list = calendarLookup.get(key) || []
    list.push(evt)
    calendarLookup.set(key, list)
  }
  console.log(`  Calendar events: ${calendarEvents.length} rows, ${calendarLookup.size} unique dates`)

  // ── 4. Build FRED arrays for velocity/momentum/percentile features ──
  console.log('[lean-dataset] Building FRED arrays for derived features...')

  const buildArr = (column: string): (number | null)[] => {
    const data = fredLookups.get(column)
    if (!data) return new Array(candles.length).fill(null)
    const lagDays = FRED_LAG_BY_COLUMN.get(column) ?? 1
    return buildFredArray(candles, data.lookup, data.sortedKeys, lagDays, dateKeyUtc, asofLookupByDateKey)
  }

  const vixArr = buildArr('fred_vix')
  const y10yArr = buildArr('fred_y10y')
  const y2yArr = buildArr('fred_y2y')
  const dxyArr = buildArr('fred_dxy')
  const hyOasArr = buildArr('fred_hy_oas')

  console.log('[lean-dataset] Built 5 FRED arrays for velocity/percentile features')

  // ── 5. Precompute MES technical indicators ──
  console.log('[lean-dataset] Computing technical indicators...')

  const closes = candles.map((c) => c.close)
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

  // ── 6. Assemble feature matrix ──
  console.log('[lean-dataset] Assembling lean feature matrix...')

  // Forward target horizons depend on timeframe
  const targetHorizons = timeframe === '15m'
    ? { '15m': 1, '1h': 4, '4h': 16 }
    : { '1h': 1, '4h': 4, '8h': 8, '24h': 24, '1w': 168 }
  const targetCols = Object.keys(targetHorizons).map(h => `target_ret_${h}`)

  const header: string[] = [
    'item_id', 'timestamp', 'target',
    ...targetCols,
    // Time features (5)
    'hour_utc', 'day_of_week', 'is_us_session', 'is_asia_session', 'is_europe_session',
    // MES technicals (22)
    'mes_ret_1h', 'mes_ret_4h', 'mes_ret_8h', 'mes_ret_24h',
    'mes_range', 'mes_body_ratio',
    'mes_rsi14', 'mes_rsi2',
    'mes_ma8', 'mes_ma24', 'mes_ma120',
    'mes_dist_ma8', 'mes_dist_ma24', 'mes_dist_ma120',
    'mes_std8', 'mes_std24', 'mes_std120',
    'mes_dist_hi24', 'mes_dist_lo24', 'mes_dist_hi120', 'mes_dist_lo120',
    'mes_vol_ratio',
    // Lean FRED raw (19)
    ...FRED_FEATURES.map((f) => f.column),
    // Derived — macro context (4)
    'yield_curve_slope', 'credit_spread_diff', 'real_rate_10y', 'fed_liquidity',
    // Derived — velocity/regime (6)
    'fed_midpoint', 'vix_percentile_20d', 'vix_1d_change',
    'dgs10_velocity_5d', 'dollar_momentum_5d', 'hy_spread_momentum_5d',
    // Calendar event flags (2)
    'is_fomc_day', 'is_high_impact_day',
  ]

  console.log(`[lean-dataset] Header: ${header.length} columns`)

  const rows: string[][] = []

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const ts = c.eventTime
    const close = c.close

    // Forward return targets
    const targets: (number | null)[] = Object.values(targetHorizons).map(offset =>
      i + offset < candles.length ? pctChange(candles[i + offset].close, close) : null
    )

    // Time features
    const hourUtc = ts.getUTCHours()
    const dayOfWeek = ts.getUTCDay()
    const isUsSession = hourUtc >= 13 && hourUtc < 21 ? 1 : 0
    const isAsiaSession = hourUtc >= 0 && hourUtc < 7 ? 1 : 0
    const isEuropeSession = hourUtc >= 7 && hourUtc < 13 ? 1 : 0

    // MES technicals
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

    // FRED as-of lookups (point-in-time with conservative lag)
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

    // Derived — macro context
    const y2y = fredValues[IDX_Y2Y]
    const y10y = fredValues[IDX_Y10Y]
    const igOas = fredValues[IDX_IG_OAS]
    const hyOas = fredValues[IDX_HY_OAS]
    const vix = fredValues[IDX_VIX]
    const tips10y = fredValues[IDX_TIPS10Y]
    const fedAssets = fredValues[IDX_FED_ASSETS]
    const rrp = fredValues[IDX_RRP]
    const fedTargetLower = fredValues[IDX_FED_TARGET_LOWER]
    const fedTargetUpper = fredValues[IDX_FED_TARGET_UPPER]

    const yieldCurveSlope = y10y != null && y2y != null ? y10y - y2y : null
    const creditSpreadDiff = hyOas != null && igOas != null ? hyOas - igOas : null
    // Real rate 10y: nominal 10Y minus TIPS 10Y
    const realRate10y = y10y != null && tips10y != null ? y10y - tips10y : null
    const fedLiquidity = fedAssets != null && rrp != null ? fedAssets - rrp * 1000 : null

    // Derived — velocity/regime features (from FRED arrays)
    const fedMidpoint = fedTargetLower != null && fedTargetUpper != null
      ? (fedTargetLower + fedTargetUpper) / 2 : null
    const vixPercentile20d = rollingPercentile(vixArr, i, 20 * barsPerDay)
    const vix1dChange = deltaBack(vixArr, i, barsPerDay)
    const dgs10Velocity5d = deltaBack(y10yArr, i, velocityLookback)
    const dollarMomentum5d = pctDeltaBack(dxyArr, i, velocityLookback)
    const hySpreadMomentum5d = deltaBack(hyOasArr, i, velocityLookback)

    // Calendar event flags
    const todayKey = dateKeyUtc(ts)
    const todayEvents = calendarLookup.get(todayKey) || []
    const isFomcDay = todayEvents.some(e =>
      e.eventName.includes('FOMC') || e.eventType.includes('FOMC') ||
      e.eventName.includes('Federal Funds') || e.eventName.includes('Fed Interest')
    ) ? 1 : 0
    const isHighImpactDay = todayEvents.some(e => e.impactRating === 'high') ? 1 : 0

    // ── ASSEMBLE ROW ──
    // CRITICAL: order MUST match header exactly
    const row: (string | number | null)[] = [
      `MES_${timeframe.toUpperCase()}`,               // item_id
      ts.toISOString(),                                // timestamp
      close,                                           // target
      ...targets,                                      // forward return targets
      // Time features (5)
      hourUtc, dayOfWeek, isUsSession, isAsiaSession, isEuropeSession,
      // MES technicals (22)
      ret1h, ret4h, ret8h, ret24h,
      range, bodyRatio,
      rsi14[i], rsi2[i],
      ma8[i], ma24[i], ma120[i],
      distMa8, distMa24, distMa120,
      std8[i], std24[i], std120[i],
      distHi24, distLo24, distHi120, distLo120,
      volRatio,
      // FRED raw (19)
      ...fredValues,
      // Derived — macro context (4)
      yieldCurveSlope, creditSpreadDiff, realRate10y, fedLiquidity,
      // Derived — velocity/regime (6)
      fedMidpoint, vixPercentile20d, vix1dChange,
      dgs10Velocity5d, dollarMomentum5d, hySpreadMomentum5d,
      // Calendar flags (2)
      isFomcDay, isHighImpactDay,
    ]

    // Sanity check: row length must match header
    if (i === 0 && row.length !== header.length) {
      throw new Error(`ROW/HEADER MISMATCH: row has ${row.length} values, header has ${header.length} columns. Fix before proceeding.`)
    }

    rows.push(row.map((v) => {
      if (v == null) return ''
      const s = String(v)
      if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
      return s
    }))
  }

  // ── 7. Write CSV ──
  const outPath = path.resolve(outFile)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })

  const csvLines = [header.join(','), ...rows.map((r) => r.join(','))]
  fs.writeFileSync(outPath, csvLines.join('\n') + '\n', 'utf8')

  // ── 8. Summary ──
  const nonNullCounts: Record<string, number> = {}
  for (let col = 0; col < header.length; col++) {
    nonNullCounts[header[col]] = rows.filter((r) => r[col] !== '').length
  }

  const fredCoverage = FRED_FEATURES.map((f) => {
    const count = nonNullCounts[f.column] ?? 0
    const pct = ((count / rows.length) * 100).toFixed(1)
    return `  ${f.column.padEnd(24)} ${String(count).padStart(7)} / ${rows.length} (${pct}%)`
  })

  console.log(`\n[lean-dataset] ✅ Written ${rows.length} rows × ${header.length} features to ${outFile}`)
  console.log(`[lean-dataset] Date range: ${rows[0][1]} → ${rows[rows.length - 1][1]}`)
  console.log(`\n[lean-dataset] FRED feature coverage:`)
  console.log(fredCoverage.join('\n'))

  const derivedCols = [
    'yield_curve_slope', 'credit_spread_diff', 'real_rate_10y', 'fed_liquidity',
    'fed_midpoint', 'vix_percentile_20d', 'vix_1d_change',
    'dgs10_velocity_5d', 'dollar_momentum_5d', 'hy_spread_momentum_5d',
    'is_fomc_day', 'is_high_impact_day',
  ]
  console.log(`\n[lean-dataset] Derived feature coverage:`)
  for (const col of derivedCols) {
    const idx = header.indexOf(col)
    const count = rows.filter((r) => r[idx] !== '').length
    const pct = ((count / rows.length) * 100).toFixed(1)
    console.log(`  ${col.padEnd(24)} ${String(count).padStart(7)} / ${rows.length} (${pct}%)`)
  }

  console.log(`\n[lean-dataset] Target coverage:`)
  for (const t of targetCols) {
    const idx = header.indexOf(t)
    const count = rows.filter((r) => r[idx] !== '').length
    console.log(`  ${t.padEnd(24)} ${count} / ${rows.length}`)
  }
}

run()
  .catch((error) => {
    console.error('[lean-dataset] FATAL:', error instanceof Error ? error.message : error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
