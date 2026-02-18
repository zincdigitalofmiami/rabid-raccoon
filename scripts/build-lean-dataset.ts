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
 *   npx tsx scripts/build-lean-dataset.ts --start-date=2022-01-01
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
  alignCrossAssetBars,
} from './feature-utils'
import fs from 'node:fs'
import path from 'node:path'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const EVENT_LOOKBACK_WINDOW_DAYS = 365 * 3
const EVENT_LOOKBACK_MIN_OBS = 6
const EVENT_FEATURE_LAG_DAYS = 1
const BHG_RESOLUTION_LAG_MS = 24 * 60 * 60 * 1000

interface EventSignalConfig {
  column: string
  names: string[]
  weight: number
}

const EVENT_SIGNAL_CONFIGS: EventSignalConfig[] = [
  { column: 'nfp_release_z', names: ['NFP'], weight: 3 },
  { column: 'cpi_release_z', names: ['CPI'], weight: 3 },
  { column: 'retail_sales_release_z', names: ['Retail Sales'], weight: 2 },
  { column: 'ppi_release_z', names: ['PPI'], weight: 2 },
  { column: 'gdp_release_z', names: ['GDP'], weight: 2 },
  { column: 'claims_release_z', names: ['Jobless Claims'], weight: 1 },
]

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

// ─── CROSS-ASSET SYMBOLS — regime-aligned intermarket features ────────────
// These are loaded from mkt_futures_1h (hourly, multi-symbol table).
// 6 technicals per symbol × 8 symbols = 48 columns + 6 derived = 54 total.

interface CrossAssetSymbol {
  code: string       // DB symbolCode
  prefix: string     // feature column prefix (safe for CSV headers)
}

const CROSS_ASSET_SYMBOLS: CrossAssetSymbol[] = [
  { code: 'NQ',  prefix: 'nq'  },  // tech beta / duration
  { code: 'SOX', prefix: 'sox' },  // semiconductor leadership
  { code: 'ZN',  prefix: 'zn'  },  // 10Y rate impulse
  { code: 'CL',  prefix: 'cl'  },  // energy / AI power narrative
  { code: '6E',  prefix: 'e6'  },  // EUR/USD — USD liquidity (prefix avoids leading digit)
  { code: '6J',  prefix: 'j6'  },  // JPY/USD — carry unwind stress
  { code: 'NG',  prefix: 'ng'  },  // natural gas — AI data center power
  { code: 'SR3', prefix: 'sr3' },  // 3-month SOFR — front-end policy shock
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

type FredLookup = Map<string, number>

interface CalendarEventLite {
  eventDate: Date
  eventName: string
  eventType: string
  impactRating: string | null
  eventTime: string | null
  actual: number | null
}

interface EventSignalRow {
  releaseMs: number
  dateKey: string
  eventName: string
  actual: number
}

interface BhgOutcomeRow {
  goTimeMs: number
  direction: 'BULLISH' | 'BEARISH'
  outcomeR: number
}

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

function parseEventDateTimeMs(eventDate: Date, eventTime: string | null): number {
  const base = new Date(Date.UTC(
    eventDate.getUTCFullYear(),
    eventDate.getUTCMonth(),
    eventDate.getUTCDate(),
    0, 0, 0, 0
  ))
  if (!eventTime) return base.getTime()

  const match = eventTime.match(/(\d{1,2}):(\d{2})/)
  if (!match) return base.getTime()
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return base.getTime()
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return base.getTime()

  base.setUTCHours(hours, minutes, 0, 0)
  return base.getTime()
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function buildReleaseChangeZLookup(
  rows: EventSignalRow[],
  names: string[],
  windowDays: number,
  minObs: number
): { lookup: FredLookup; sortedKeys: string[]; computed: number } {
  const nameSet = new Set(names.map((name) => name.toUpperCase()))
  const filtered = rows
    .filter((row) => nameSet.has(row.eventName.toUpperCase()))
    .sort((a, b) => a.releaseMs - b.releaseMs)

  let prevActual: number | null = null
  const deltas: Array<{ releaseMs: number; delta: number }> = []
  const lookup: FredLookup = new Map()
  let computed = 0

  for (const row of filtered) {
    if (prevActual != null) {
      const delta = row.actual - prevActual
      const cutoff = row.releaseMs - windowDays * MS_PER_DAY
      const windowDeltas = deltas
        .filter((point) => point.releaseMs >= cutoff)
        .map((point) => point.delta)

      if (windowDeltas.length >= minObs) {
        const sigma = stdDev(windowDeltas)
        if (sigma != null && sigma > 0) {
          lookup.set(row.dateKey, delta / sigma)
          computed += 1
        }
      }
      deltas.push({ releaseMs: row.releaseMs, delta })
    }

    prevActual = row.actual
  }

  return {
    lookup,
    sortedKeys: [...lookup.keys()].sort(),
    computed,
  }
}

function weightedAverage(values: Array<number | null>, weights: number[]): number | null {
  let weightedSum = 0
  let weightTotal = 0
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    if (value == null) continue
    const weight = weights[i]
    weightedSum += value * weight
    weightTotal += weight
  }
  if (weightTotal === 0) return null
  return weightedSum / weightTotal
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function trailingCountLagged(
  ts: Date,
  countsByDate: ReadonlyMap<string, number>,
  trailingDays: number,
  lagDays: number
): number {
  const endMs = ts.getTime() - lagDays * MS_PER_DAY
  const startMs = endMs - (trailingDays - 1) * MS_PER_DAY
  let total = 0
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    total += countsByDate.get(dateKeyUtc(new Date(ms))) ?? 0
  }
  return total
}

function centeredCount(
  ts: Date,
  countsByDate: ReadonlyMap<string, number>,
  daysBack: number,
  daysForward: number
): number {
  const centerDayMs = new Date(Date.UTC(
    ts.getUTCFullYear(),
    ts.getUTCMonth(),
    ts.getUTCDate(),
    0, 0, 0, 0
  )).getTime()
  const startMs = centerDayMs - daysBack * MS_PER_DAY
  const endMs = centerDayMs + daysForward * MS_PER_DAY
  let total = 0
  for (let ms = startMs; ms <= endMs; ms += MS_PER_DAY) {
    total += countsByDate.get(dateKeyUtc(new Date(ms))) ?? 0
  }
  return total
}

function lowerBound(sorted: readonly number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(sorted: readonly number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function countInTimeRange(sortedTimes: readonly number[], startInclusive: number, endInclusive: number): number {
  if (sortedTimes.length === 0 || endInclusive < startInclusive) return 0
  const startIdx = lowerBound(sortedTimes, startInclusive)
  const endIdx = upperBound(sortedTimes, endInclusive)
  return Math.max(0, endIdx - startIdx)
}

function rollingWinRate(points: readonly BhgOutcomeRow[]): number | null {
  if (points.length === 0) return null
  const wins = points.filter((point) => point.outcomeR > 0).length
  return wins / points.length
}

function rollingAvgOutcome(points: readonly BhgOutcomeRow[]): number | null {
  if (points.length === 0) return null
  const sum = points.reduce((acc, point) => acc + point.outcomeR, 0)
  return sum / points.length
}

// ─── MAIN ─────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  loadDotEnvFiles()

  const timeframe = parseArg('timeframe', '1h') as '1h' | '15m'
  const startDateArg = parseArg('start-date', '2020-01-01')
  const daysBackArg = parseArg('days-back', '')
  const defaultOut = timeframe === '15m'
    ? 'datasets/autogluon/mes_lean_15m.csv'
    : 'datasets/autogluon/mes_lean_1h.csv'
  const outFile = parseArg('out', defaultOut)
  // --days-back overrides --start-date if provided; otherwise default to 2020-01-01
  const start = daysBackArg
    ? new Date(Date.now() - Number(daysBackArg) * 24 * 60 * 60 * 1000)
    : new Date(startDateArg + 'T00:00:00Z')
  const calendarLoadStart = new Date(start.getTime() - (EVENT_LOOKBACK_WINDOW_DAYS + 60) * MS_PER_DAY)

  const barsPerDay = timeframe === '15m' ? 96 : 24
  const velocityLookback = 5 * barsPerDay  // 5 trading days

  const daysBack = Math.ceil((Date.now() - start.getTime()) / (24 * 60 * 60 * 1000))
  console.log(`[lean-dataset] Building LEAN MES ${timeframe} dataset for intraday trading`)
  console.log(`[lean-dataset] Timeframe: ${timeframe}, Start: ${start.toISOString().slice(0,10)}, Days back: ${daysBack}`)
  console.log(`[lean-dataset] Bars/day: ${barsPerDay}, Velocity lookback: ${velocityLookback} bars`)

  // ── 1. Load MES candles (paginated to stay under Prisma Accelerate 5MB limit) ──
  const tableName = timeframe === '15m' ? 'mktFuturesMes15m' : 'mktFuturesMes1h'
  const candles: MesCandle[] = []
  const CHUNK_MS = 365 * 24 * 60 * 60 * 1000 // 1 year per chunk
  let chunkStart = start
  const now = new Date()
  while (chunkStart < now) {
    const chunkEnd = new Date(Math.min(chunkStart.getTime() + CHUNK_MS, now.getTime()))
    const rawChunk = await (prisma as any)[tableName].findMany({
      where: { eventTime: { gte: chunkStart, lt: chunkEnd } },
      orderBy: { eventTime: 'asc' },
      select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
    })
    for (const r of rawChunk) {
      candles.push({
        eventTime: r.eventTime,
        open: toNum(r.open),
        high: toNum(r.high),
        low: toNum(r.low),
        close: toNum(r.close),
        volume: r.volume,
      })
    }
    chunkStart = chunkEnd
  }

  if (candles.length < 200) {
    throw new Error(`Insufficient MES ${timeframe} data (${candles.length} rows, need 200+)`)
  }
  console.log(`[lean-dataset] MES ${timeframe} candles: ${candles.length}`)

  // ── 1b. Load cross-asset hourly candles from mkt_futures_1h ──
  // Only meaningful for 1h timeframe; for 15m we still align on the hourly bars.
  console.log(`[lean-dataset] Loading cross-asset hourly candles (${CROSS_ASSET_SYMBOLS.map(s => s.code).join(', ')})...`)

  interface CrossAssetBar { eventTime: Date; close: number; volume: bigint | null }

  // Map: symbolCode → Map<isoString → bar>
  const crossAssetBars = new Map<string, Map<string, CrossAssetBar>>()

  const crossAssetStart = new Date(start.getTime() - 200 * 60 * 60 * 1000) // extra 200h for warmup
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const barMap = new Map<string, CrossAssetBar>()
    let caChunkStart = crossAssetStart
    while (caChunkStart < now) {
      const caChunkEnd = new Date(Math.min(caChunkStart.getTime() + CHUNK_MS, now.getTime()))
      const rows = await prisma.mktFutures1h.findMany({
        where: {
          symbolCode: sym.code,
          eventTime: { gte: caChunkStart, lt: caChunkEnd },
        },
        orderBy: { eventTime: 'asc' },
        select: { eventTime: true, close: true, volume: true },
      })
      for (const r of rows) {
        barMap.set(r.eventTime.toISOString(), {
          eventTime: r.eventTime,
          close: toNum(r.close),
          volume: r.volume,
        })
      }
      caChunkStart = caChunkEnd
    }
    crossAssetBars.set(sym.code, barMap)
    console.log(`  ${sym.code.padEnd(4)} ${barMap.size} hourly bars`)
  }

  // Align each symbol's close prices to MES timestamps
  const crossAssetAligned = new Map<string, (number | null)[]>()
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const barMap = crossAssetBars.get(sym.code)!
    const closeMap = new Map<string, number>()
    for (const [key, bar] of barMap) closeMap.set(key, bar.close)
    crossAssetAligned.set(sym.code, alignCrossAssetBars(candles.map(c => c.eventTime), closeMap))
  }

  // Also align volumes for vol_ratio
  const crossAssetVolAligned = new Map<string, (number | null)[]>()
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const barMap = crossAssetBars.get(sym.code)!
    const volMap = new Map<string, number>()
    for (const [key, bar] of barMap) {
      if (bar.volume != null) volMap.set(key, Number(bar.volume))
    }
    crossAssetVolAligned.set(sym.code, alignCrossAssetBars(candles.map(c => c.eventTime), volMap))
  }

  console.log(`[lean-dataset] Cross-asset bars aligned to MES timeline`)

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

  // ── 3. Load econ_calendar for event, regime, and release-signal features ──
  console.log('[lean-dataset] Loading economic calendar for event and release-signal features...')
  const calendarEventsRaw = await prisma.econCalendar.findMany({
    where: { eventDate: { gte: calendarLoadStart } },
    select: {
      eventDate: true,
      eventName: true,
      eventType: true,
      impactRating: true,
      eventTime: true,
      actual: true,
    },
    orderBy: { eventDate: 'asc' },
  })

  const calendarEvents: CalendarEventLite[] = calendarEventsRaw.map((evt) => ({
    eventDate: evt.eventDate,
    eventName: evt.eventName,
    eventType: evt.eventType,
    impactRating: evt.impactRating,
    eventTime: evt.eventTime,
    actual: evt.actual == null ? null : toNum(evt.actual),
  }))

  const calendarLookup = new Map<string, CalendarEventLite[]>()
  const calendarCountsByDate = new Map<string, number>()
  const highImpactReleaseTimesMs: number[] = []
  const eventSignalRows: EventSignalRow[] = []

  for (const evt of calendarEvents) {
    const dateKey = dateKeyUtc(evt.eventDate)
    const list = calendarLookup.get(dateKey) || []
    list.push(evt)
    calendarLookup.set(dateKey, list)
    incrementCount(calendarCountsByDate, dateKey)

    const releaseMs = parseEventDateTimeMs(evt.eventDate, evt.eventTime)
    if (evt.impactRating?.toLowerCase() === 'high') {
      highImpactReleaseTimesMs.push(releaseMs)
    }
    if (evt.actual != null && Number.isFinite(evt.actual)) {
      eventSignalRows.push({
        releaseMs,
        dateKey,
        eventName: evt.eventName,
        actual: evt.actual,
      })
    }
  }
  highImpactReleaseTimesMs.sort((a, b) => a - b)

  const eventSignalLookups = new Map<string, { lookup: FredLookup; sortedKeys: string[] }>()
  for (const config of EVENT_SIGNAL_CONFIGS) {
    const built = buildReleaseChangeZLookup(
      eventSignalRows,
      config.names,
      EVENT_LOOKBACK_WINDOW_DAYS,
      EVENT_LOOKBACK_MIN_OBS
    )
    eventSignalLookups.set(config.column, { lookup: built.lookup, sortedKeys: built.sortedKeys })
    console.log(`  ${config.column.padEnd(24)} ${String(built.computed).padStart(4)} z-points`)
  }
  console.log(`  Calendar events: ${calendarEvents.length} rows, ${calendarLookup.size} unique dates`)

  // ── 4. Load news_signals for 7d layer/category features ──
  console.log('[lean-dataset] Loading news_signals for trailing regime counts...')
  const newsSignals = await prisma.newsSignal.findMany({
    where: { pubDate: { gte: new Date(start.getTime() - 45 * MS_PER_DAY) } },
    select: { pubDate: true, layer: true, category: true },
    orderBy: { pubDate: 'asc' },
  })

  const tariffCountsByDate = new Map<string, number>()
  const selloffCountsByDate = new Map<string, number>()
  const rallyCountsByDate = new Map<string, number>()

  for (const signal of newsSignals) {
    const dateKey = dateKeyUtc(signal.pubDate)
    const layer = signal.layer.toLowerCase()
    const category = signal.category.toLowerCase()

    if (layer.includes('tariff') || category.includes('tariff')) incrementCount(tariffCountsByDate, dateKey)
    if (layer.includes('selloff') || category.includes('selloff')) incrementCount(selloffCountsByDate, dateKey)
    if (layer.includes('rally') || category.includes('rally')) incrementCount(rallyCountsByDate, dateKey)
  }
  console.log(`  News signals: ${newsSignals.length} rows`)

  // ── 5. Load BHG outcomes for rolling setup-quality features ──
  console.log('[lean-dataset] Loading bhg_setups for rolling performance features...')
  const bhgRows = await prisma.bhgSetup.findMany({
    where: { goTime: { gte: new Date(start.getTime() - 400 * MS_PER_DAY) } },
    select: {
      goTime: true,
      direction: true,
      tp1Hit: true,
      tp2Hit: true,
      slHit: true,
    },
    orderBy: { goTime: 'asc' },
  })

  const bhgAllGoTimesMs: number[] = []
  const bhgResolvedRows: BhgOutcomeRow[] = []
  for (const row of bhgRows) {
    if (!row.goTime) continue
    const goTimeMs = row.goTime.getTime()
    bhgAllGoTimesMs.push(goTimeMs)

    let outcomeR: number | null = null
    if (row.tp2Hit === true) outcomeR = 2
    else if (row.tp1Hit === true) outcomeR = 1
    else if (row.slHit === true) outcomeR = -1

    if (outcomeR != null) {
      bhgResolvedRows.push({
        goTimeMs,
        direction: row.direction,
        outcomeR,
      })
    }
  }
  console.log(`  BHG setups: ${bhgRows.length} total, ${bhgResolvedRows.length} with resolved outcomes`)

  // ── 6. Build FRED arrays for velocity/momentum/percentile features ──
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

  // ── 7. Precompute MES technical indicators ──
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

  // ── 7b. Precompute cross-asset technical indicators ──
  // For each symbol: ret_1h, ret_4h, ret_24h, rsi14, dist_ma24, vol_ratio
  interface CrossAssetTechnicals {
    ret1h: (number | null)[]
    ret4h: (number | null)[]
    ret24h: (number | null)[]
    rsi14: (number | null)[]
    distMa24: (number | null)[]
    volRatio: (number | null)[]
  }

  const crossAssetTech = new Map<string, CrossAssetTechnicals>()
  for (const sym of CROSS_ASSET_SYMBOLS) {
    const symCloses = crossAssetAligned.get(sym.code)!
    const symVols = crossAssetVolAligned.get(sym.code)!

    // Fill nulls for RSI/MA computation (forward-fill within array)
    const filledCloses: number[] = []
    let lastClose = 0
    for (const v of symCloses) {
      if (v != null) { lastClose = v; filledCloses.push(v) }
      else filledCloses.push(lastClose)
    }

    const symRsi14 = computeRSI(filledCloses, 14)
    const symMa24 = rollingMean(filledCloses, 24)
    const symVolMa24 = rollingMean(symVols.map(v => v ?? 0), 24)

    const ret1h: (number | null)[] = []
    const ret4h: (number | null)[] = []
    const ret24h: (number | null)[] = []
    const distMa24: (number | null)[] = []
    const volRatio: (number | null)[] = []

    for (let i = 0; i < symCloses.length; i++) {
      const cur = symCloses[i]
      const prev1 = i >= 1 ? symCloses[i - 1] : null
      const prev4 = i >= 4 ? symCloses[i - 4] : null
      const prev24 = i >= 24 ? symCloses[i - 24] : null
      const ma = symMa24[i]
      const volMa = symVolMa24[i]
      const vol = symVols[i]

      ret1h.push(cur != null && prev1 != null && prev1 !== 0 ? (cur - prev1) / Math.abs(prev1) : null)
      ret4h.push(cur != null && prev4 != null && prev4 !== 0 ? (cur - prev4) / Math.abs(prev4) : null)
      ret24h.push(cur != null && prev24 != null && prev24 !== 0 ? (cur - prev24) / Math.abs(prev24) : null)
      distMa24.push(cur != null && ma != null && ma !== 0 ? (cur - ma) / ma : null)
      volRatio.push(vol != null && volMa != null && volMa > 0 ? vol / volMa : null)

      // Mask RSI/distMa if underlying close was null (no bar)
      if (symCloses[i] == null) {
        symRsi14[i] = null
      }
    }

    crossAssetTech.set(sym.code, {
      ret1h,
      ret4h,
      ret24h,
      rsi14: symRsi14,
      distMa24,
      volRatio,
    })
  }

  console.log(`[lean-dataset] Cross-asset technicals computed for ${CROSS_ASSET_SYMBOLS.length} symbols`)

  // ── 8. Assemble feature matrix ──
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
    // Calendar + event timing (6)
    'is_fomc_day', 'is_high_impact_day', 'is_cpi_day', 'is_nfp_day',
    'events_this_week_count', 'hours_to_next_high_impact',
    // Release signal proxies (7) — z-scored release deltas from econ_calendar actuals
    'nfp_release_z', 'cpi_release_z', 'retail_sales_release_z', 'ppi_release_z',
    'gdp_release_z', 'claims_release_z', 'econ_surprise_index',
    // News layer regime (4)
    'tariff_count_7d', 'selloff_count_7d', 'rally_count_7d', 'net_sentiment_7d',
    // BHG rolling quality feedback (9)
    'bhg_win_rate_last20', 'bhg_win_rate_last50', 'bhg_avg_outcome_r_last20',
    'bhg_consecutive_wins', 'bhg_consecutive_losses',
    'bhg_setups_count_7d', 'bhg_setups_count_30d',
    'bhg_bull_win_rate_20', 'bhg_bear_win_rate_20',
    // Cross-asset technicals (8 symbols × 6 = 48)
    ...CROSS_ASSET_SYMBOLS.flatMap(sym => [
      `${sym.prefix}_ret_1h`,
      `${sym.prefix}_ret_4h`,
      `${sym.prefix}_ret_24h`,
      `${sym.prefix}_rsi14`,
      `${sym.prefix}_dist_ma24`,
      `${sym.prefix}_vol_ratio`,
    ]),
    // Derived regime features (6)
    'sox_minus_nq',        // semis vs tech spread
    'nq_minus_mes',        // tech premium vs broad market
    'yield_proxy',         // -ret(ZN) — rate impulse direction
    'usd_shock',           // -ret(6E) — dollar liquidity
    'carry_stress',        // abs(ret(6J)) — carry unwind magnitude
    'mes_zn_corr_21d',     // rolling 21-day MES vs ZN correlation
  ]

  console.log(`[lean-dataset] Header: ${header.length} columns`)

  const rows: string[][] = []
  let nextHighImpactIdx = 0
  let bhgResolvedCursor = 0
  const eventSignalWeights = EVENT_SIGNAL_CONFIGS.map((config) => config.weight)

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

    // Calendar + event timing
    const todayKey = dateKeyUtc(ts)
    const todayEvents = calendarLookup.get(todayKey) || []
    const isFomcDay = todayEvents.some((event) => {
      const eventName = event.eventName.toUpperCase()
      const eventType = event.eventType.toUpperCase()
      return (
        eventName.includes('FOMC') ||
        eventType.includes('FOMC') ||
        eventName.includes('FEDERAL FUNDS') ||
        eventType.includes('RATE_DECISION')
      )
    }) ? 1 : 0
    const isHighImpactDay = todayEvents.some((event) => event.impactRating?.toLowerCase() === 'high') ? 1 : 0
    const isCpiDay = todayEvents.some((event) => event.eventName.toUpperCase().includes('CPI')) ? 1 : 0
    const isNfpDay = todayEvents.some((event) => event.eventName.toUpperCase().includes('NFP')) ? 1 : 0
    const eventsThisWeekCount = centeredCount(ts, calendarCountsByDate, 3, 3)

    const tsMs = ts.getTime()
    while (nextHighImpactIdx < highImpactReleaseTimesMs.length && highImpactReleaseTimesMs[nextHighImpactIdx] < tsMs) {
      nextHighImpactIdx += 1
    }
    const hoursToNextHighImpact = nextHighImpactIdx < highImpactReleaseTimesMs.length
      ? (highImpactReleaseTimesMs[nextHighImpactIdx] - tsMs) / (60 * 60 * 1000)
      : null

    // Release signal proxies (z-scored release deltas from econ_calendar actuals)
    const releaseSignalValues = EVENT_SIGNAL_CONFIGS.map((config) => {
      const signal = eventSignalLookups.get(config.column)
      if (!signal) return null
      return asofLookupByDateKey(signal.lookup, signal.sortedKeys, laggedTargetKey(EVENT_FEATURE_LAG_DAYS))
    })
    const [
      nfpReleaseZ,
      cpiReleaseZ,
      retailSalesReleaseZ,
      ppiReleaseZ,
      gdpReleaseZ,
      claimsReleaseZ,
    ] = releaseSignalValues
    const econSurpriseIndex = weightedAverage(releaseSignalValues, eventSignalWeights)

    // News layer regime
    const tariffCount7d = trailingCountLagged(ts, tariffCountsByDate, 7, 1)
    const selloffCount7d = trailingCountLagged(ts, selloffCountsByDate, 7, 1)
    const rallyCount7d = trailingCountLagged(ts, rallyCountsByDate, 7, 1)
    const sentimentTotal = rallyCount7d + selloffCount7d
    const netSentiment7d = sentimentTotal > 0 ? (rallyCount7d - selloffCount7d) / sentimentTotal : null

    // BHG rolling quality feedback (strictly historical + 24h resolution lag)
    while (
      bhgResolvedCursor < bhgResolvedRows.length &&
      bhgResolvedRows[bhgResolvedCursor].goTimeMs <= tsMs - BHG_RESOLUTION_LAG_MS
    ) {
      bhgResolvedCursor += 1
    }
    const last20Start = Math.max(0, bhgResolvedCursor - 20)
    const last50Start = Math.max(0, bhgResolvedCursor - 50)
    const last20 = bhgResolvedRows.slice(last20Start, bhgResolvedCursor)
    const last50 = bhgResolvedRows.slice(last50Start, bhgResolvedCursor)
    const last20Bull = last20.filter((row) => row.direction === 'BULLISH')
    const last20Bear = last20.filter((row) => row.direction === 'BEARISH')

    const bhgWinRateLast20 = rollingWinRate(last20)
    const bhgWinRateLast50 = rollingWinRate(last50)
    const bhgAvgOutcomeRLast20 = rollingAvgOutcome(last20)
    const bhgBullWinRate20 = rollingWinRate(last20Bull)
    const bhgBearWinRate20 = rollingWinRate(last20Bear)

    let bhgConsecutiveWins: number | null = null
    let bhgConsecutiveLosses: number | null = null
    if (bhgResolvedCursor > 0) {
      let winStreak = 0
      for (let j = bhgResolvedCursor - 1; j >= 0; j--) {
        if (bhgResolvedRows[j].outcomeR > 0) winStreak += 1
        else break
      }
      bhgConsecutiveWins = winStreak

      let lossStreak = 0
      for (let j = bhgResolvedCursor - 1; j >= 0; j--) {
        if (bhgResolvedRows[j].outcomeR < 0) lossStreak += 1
        else break
      }
      bhgConsecutiveLosses = lossStreak
    }

    const bhgSetupsCount7d = countInTimeRange(bhgAllGoTimesMs, tsMs - 7 * MS_PER_DAY, tsMs)
    const bhgSetupsCount30d = countInTimeRange(bhgAllGoTimesMs, tsMs - 30 * MS_PER_DAY, tsMs)

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
      // Calendar + event timing (6)
      isFomcDay, isHighImpactDay, isCpiDay, isNfpDay,
      eventsThisWeekCount, hoursToNextHighImpact,
      // Release signal proxies (7)
      nfpReleaseZ, cpiReleaseZ, retailSalesReleaseZ, ppiReleaseZ,
      gdpReleaseZ, claimsReleaseZ, econSurpriseIndex,
      // News layer regime (4)
      tariffCount7d, selloffCount7d, rallyCount7d, netSentiment7d,
      // BHG rolling quality feedback (9)
      bhgWinRateLast20, bhgWinRateLast50, bhgAvgOutcomeRLast20,
      bhgConsecutiveWins, bhgConsecutiveLosses,
      bhgSetupsCount7d, bhgSetupsCount30d,
      bhgBullWinRate20, bhgBearWinRate20,
      // Cross-asset technicals (8 symbols × 6 = 48)
      ...CROSS_ASSET_SYMBOLS.flatMap(sym => {
        const tech = crossAssetTech.get(sym.code)!
        return [
          tech.ret1h[i],
          tech.ret4h[i],
          tech.ret24h[i],
          tech.rsi14[i],
          tech.distMa24[i],
          tech.volRatio[i],
        ]
      }),
      // Derived regime features (6)
      (() => {
        // sox_minus_nq: SOX ret_1h − NQ ret_1h
        const sox = crossAssetTech.get('SOX')!.ret1h[i]
        const nq = crossAssetTech.get('NQ')!.ret1h[i]
        return sox != null && nq != null ? sox - nq : null
      })(),
      (() => {
        // nq_minus_mes: NQ ret_1h − MES ret_1h
        const nq = crossAssetTech.get('NQ')!.ret1h[i]
        const mesRet = i >= 1 && candles[i - 1].close !== 0
          ? (close - candles[i - 1].close) / Math.abs(candles[i - 1].close)
          : null
        return nq != null && mesRet != null ? nq - mesRet : null
      })(),
      (() => {
        // yield_proxy: -ret(ZN)
        const znRet = crossAssetTech.get('ZN')!.ret1h[i]
        return znRet != null ? -znRet : null
      })(),
      (() => {
        // usd_shock: -ret(6E)
        const e6Ret = crossAssetTech.get('6E')!.ret1h[i]
        return e6Ret != null ? -e6Ret : null
      })(),
      (() => {
        // carry_stress: abs(ret(6J))
        const j6Ret = crossAssetTech.get('6J')!.ret1h[i]
        return j6Ret != null ? Math.abs(j6Ret) : null
      })(),
      (() => {
        // mes_zn_corr_21d: rolling 21-bar correlation between MES and ZN returns
        if (i < 21) return null
        const mesRets: number[] = []
        const znRets: number[] = []
        for (let j = i - 20; j <= i; j++) {
          const mRet = j >= 1 && candles[j - 1].close !== 0
            ? (candles[j].close - candles[j - 1].close) / Math.abs(candles[j - 1].close)
            : null
          const zRet = crossAssetTech.get('ZN')!.ret1h[j]
          if (mRet != null && zRet != null) { mesRets.push(mRet); znRets.push(zRet) }
        }
        if (mesRets.length < 10) return null
        const meanM = mesRets.reduce((a, b) => a + b, 0) / mesRets.length
        const meanZ = znRets.reduce((a, b) => a + b, 0) / znRets.length
        let cov = 0, varM = 0, varZ = 0
        for (let k = 0; k < mesRets.length; k++) {
          cov += (mesRets[k] - meanM) * (znRets[k] - meanZ)
          varM += (mesRets[k] - meanM) ** 2
          varZ += (znRets[k] - meanZ) ** 2
        }
        const denom = Math.sqrt(varM * varZ)
        return denom > 0 ? cov / denom : null
      })(),
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
    'is_fomc_day', 'is_high_impact_day', 'is_cpi_day', 'is_nfp_day',
    'events_this_week_count', 'hours_to_next_high_impact',
    'nfp_release_z', 'cpi_release_z', 'retail_sales_release_z', 'ppi_release_z',
    'gdp_release_z', 'claims_release_z', 'econ_surprise_index',
    'tariff_count_7d', 'selloff_count_7d', 'rally_count_7d', 'net_sentiment_7d',
    'bhg_win_rate_last20', 'bhg_win_rate_last50', 'bhg_avg_outcome_r_last20',
    'bhg_consecutive_wins', 'bhg_consecutive_losses',
    'bhg_setups_count_7d', 'bhg_setups_count_30d',
    'bhg_bull_win_rate_20', 'bhg_bear_win_rate_20',
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
