/**
 * build-bhg-dataset.ts
 *
 * Builds the Fib Setup Scorer training dataset.
 * One row per GO event, NOT per candle.
 *
 * Features (mandatory groups A-F):
 *   A) Fib context: touch level, distances, R ratios, hook quality, go type
 *   B) Event/news regime: vol shock, gap flag
 *   C) Session: time bucket, day of week
 *   D) Correlation: DXY/NQ/VIX returns, composite alignment
 *   E) Trap/sweep: sweep flag, acceptance flag
 *   F) Open-space/blocker: nearest blocker, open space ratio, blocker density
 *   +  All 85 existing features (technicals + FRED macro)
 *
 * Labels:
 *   tp1_before_sl_1h  — TP1 (1.272) hit before SL within 1h (4 bars)
 *   tp1_before_sl_4h  — TP1 hit before SL within 4h (16 bars)
 *   tp2_before_sl_8h  — TP2 (1.618) hit before SL within 8h (32 bars)
 *
 * Usage:
 *   npx tsx scripts/build-bhg-dataset.ts
 *   npx tsx scripts/build-bhg-dataset.ts --days-back=180
 *   npx tsx scripts/build-bhg-dataset.ts --out=datasets/custom_bhg.csv
 */

import { prisma } from '../src/lib/prisma'
import { loadDotEnvFiles, parseArg } from './ingest-utils'
import { detectSwings } from '../src/lib/swing-detection'
import { calculateFibonacci } from '../src/lib/fibonacci'
import { detectMeasuredMoves } from '../src/lib/measured-move'
import { advanceBhgSetups, BhgSetup } from '../src/lib/bhg-engine'
import { computeRisk, MES_DEFAULTS } from '../src/lib/risk-engine'
import type { CandleData, FibResult } from '../src/lib/types'
import { toNum } from '../src/lib/decimal'
import type { Decimal } from '@prisma/client/runtime/client'
import { dateKeyUtc, laggedWindowKeys, shiftUtcDays } from './feature-availability'
import fs from 'node:fs'
import path from 'node:path'

// ─── Configuration ───────────────────────────────────────────────────────────

const MES_TICK_SIZE = 0.25
const WINDOW_BARS = 96  // 24h lookback for BHG engine
const STEP_BARS = 16    // Advance 4h per window step (overlap is intentional)

// Label horizons (in 15m bars)
const LABEL_HORIZONS = {
  tp1_before_sl_1h: 4,   // 1h = 4 bars
  tp1_before_sl_4h: 16,  // 4h = 16 bars
  tp2_before_sl_8h: 32,  // 8h = 32 bars
}
const FRED_ENRICH_LAG_DAYS = 1

// Session buckets (CT = Central Time)
function getSessionBucket(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const ct = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const hour = ct.getHours()
  const min = ct.getMinutes()
  const hhmm = hour * 100 + min

  if (hhmm >= 1700 || hhmm < 830) return 'OVERNIGHT'
  if (hhmm < 1000) return 'RTH_OPEN'
  if (hhmm < 1200) return 'MIDDAY'
  if (hhmm < 1400) return 'LUNCH'
  return 'POWER_HOUR'
}

function getDayOfWeek(unixSeconds: number): number {
  return new Date(unixSeconds * 1000).getUTCDay()
}

// ─── Technical Indicators ────────────────────────────────────────────────────

function sma(arr: number[], period: number): number | null {
  if (arr.length < period) return null
  const slice = arr.slice(-period)
  return slice.reduce((a, b) => a + b, 0) / period
}

function ema(arr: number[], period: number): number | null {
  if (arr.length < period) return null
  const k = 2 / (period + 1)
  let val = arr.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < arr.length; i++) {
    val = arr[i] * k + val * (1 - k)
  }
  return val
}

function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff
    else losses -= diff
  }
  if (losses === 0) return 100
  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function atr(candles: CandleData[], period: number): number | null {
  if (candles.length < period + 1) return null
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
    sum += tr
  }
  return sum / period
}

function bollingerPos(closes: number[], period: number): number | null {
  const mean = sma(closes, period)
  if (!mean || closes.length < period) return null
  const slice = closes.slice(-period)
  const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period
  const std = Math.sqrt(variance)
  if (std === 0) return 0.5
  return (closes[closes.length - 1] - (mean - 2 * std)) / (4 * std)
}

function stochastic(candles: CandleData[], period: number): number | null {
  if (candles.length < period) return null
  const slice = candles.slice(-period)
  const hi = Math.max(...slice.map(c => c.high))
  const lo = Math.min(...slice.map(c => c.low))
  if (hi === lo) return 50
  return ((candles[candles.length - 1].close - lo) / (hi - lo)) * 100
}

// ─── Feature Extraction ──────────────────────────────────────────────────────

interface GoEventFeatures {
  // Metadata
  go_time: number
  go_timestamp: string
  direction: string
  go_type: string

  // A) Fib context
  fib_touch_level: number
  fib_ratio: number
  dist_to_50_ticks: number
  dist_to_618_ticks: number
  dist_entry_to_tp1_ticks: number
  dist_entry_to_tp2_ticks: number
  r_to_tp1: number
  r_to_tp2: number
  atr_at_entry: number
  stop_atr_multiple: number
  swing_ab_len_ticks: number
  hook_wick_ratio: number
  hook_body_ratio: number

  // B) Event/news regime
  vol_shock_flag: number
  gap_flag: number

  // C) Session
  session_bucket: string
  day_of_week: number
  hour_ct: number

  // D) Correlation (raw returns over lookback)
  // NOTE: Populated from FRED data if available
  vix_level: number | null
  vix_change_1d: number | null
  dxy_level: number | null
  nq_level: number | null

  // E) Trap/sweep
  sweep_flag: number
  acceptance_flag: number

  // F) Open-space/blocker
  nearest_blocker_ticks: number
  open_space_ratio: number
  blocker_density: number

  // Core technicals (computed on 15m candles at GO time)
  close: number
  ret_1h: number | null
  ret_4h: number | null
  rsi_14: number | null
  rsi_2: number | null
  atr_14: number | null
  atr_7: number | null
  bb_pos_20: number | null
  stoch_14: number | null
  ma_8: number | null
  ma_24: number | null
  dist_ma_8: number | null
  dist_ma_24: number | null
  range_pct: number | null
  body_ratio: number | null
  vol_ratio: number | null
  macd_line: number | null
  macd_hist: number | null
  fib_position: number | null

  // Risk metrics
  stop_distance_pts: number
  stop_ticks: number
  contracts: number
  dollar_risk: number
  rr: number
  grade: string

  // Headlines
  headlines_24h: string

  // Labels
  tp1_before_sl_1h: number | null
  tp1_before_sl_4h: number | null
  tp2_before_sl_8h: number | null
}

function computeGoFeatures(
  setup: BhgSetup,
  candles: CandleData[],
  allCandles: CandleData[],  // Full history for look-forward
  fibResult: FibResult,
  goBarGlobalIndex: number
): GoEventFeatures | null {
  if (setup.phase !== 'GO_FIRED' || !setup.entry || !setup.stopLoss || !setup.tp1 || !setup.tp2) {
    return null
  }

  const goBarLocal = setup.goBarIndex ?? candles.length - 1
  const goCandle = candles[goBarLocal]
  if (!goCandle) return null

  const closes = candles.slice(0, goBarLocal + 1).map(c => c.close)
  const candleWindow = candles.slice(0, goBarLocal + 1)

  // ── A) Fib context ─────────────────────────────────────────────────────
  const fibRange = fibResult.anchorHigh - fibResult.anchorLow
  const tickSize = MES_TICK_SIZE

  const fib50Level = fibResult.levels.find(l => l.ratio === 0.5)?.price ?? 0
  const fib618Level = fibResult.levels.find(l => l.ratio === 0.618)?.price ?? 0

  const dist_to_50_ticks = Math.round(Math.abs(setup.entry - fib50Level) / tickSize)
  const dist_to_618_ticks = Math.round(Math.abs(setup.entry - fib618Level) / tickSize)
  const dist_entry_to_tp1 = Math.abs(setup.tp1 - setup.entry)
  const dist_entry_to_tp2 = Math.abs(setup.tp2 - setup.entry)
  const stopDist = Math.abs(setup.entry - setup.stopLoss)

  const r_to_tp1 = stopDist > 0 ? dist_entry_to_tp1 / stopDist : 0
  const r_to_tp2 = stopDist > 0 ? dist_entry_to_tp2 / stopDist : 0

  const atrVal = atr(candleWindow, 14) ?? 0

  const hookBody = setup.hookClose && setup.hookLow && setup.hookHigh
    ? Math.abs(setup.hookClose - (candleWindow[setup.hookBarIndex ?? 0]?.open ?? setup.hookClose))
    : 0
  const hookWick = setup.direction === 'BULLISH'
    ? (setup.hookClose ?? 0) - (setup.hookLow ?? 0)
    : (setup.hookHigh ?? 0) - (setup.hookClose ?? 0)

  const hook_wick_ratio = hookBody > 0 ? hookWick / hookBody : hookWick > 0 ? 10 : 0
  const hookRange = (setup.hookHigh ?? 0) - (setup.hookLow ?? 0)
  const hook_body_ratio = hookRange > 0 ? hookBody / hookRange : 0

  // ── B) Event/news regime ───────────────────────────────────────────────
  const atr7 = atr(candleWindow, 7)
  const atr14 = atr(candleWindow, 14)
  const vol_shock_flag = atr7 && atr14 && atr7 > atr14 * 1.5 ? 1 : 0

  const prevClose = goBarLocal > 0 ? candles[goBarLocal - 1].close : goCandle.open
  const gapPct = Math.abs(goCandle.open - prevClose) / prevClose
  const gap_flag = gapPct > 0.002 ? 1 : 0  // > 0.2% gap

  // ── C) Session ─────────────────────────────────────────────────────────
  const goTime = setup.goTime ?? goCandle.time
  const session_bucket = getSessionBucket(goTime)
  const day_of_week = getDayOfWeek(goTime)

  const ctDate = new Date(new Date(goTime * 1000).toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const hour_ct = ctDate.getHours()

  // ── E) Trap/sweep ──────────────────────────────────────────────────────
  // Sweep: price broke prior swing extreme then reversed back
  let sweep_flag = 0
  let acceptance_flag = 0

  if (goBarLocal >= 5) {
    const recentLows = candleWindow.slice(-10).map(c => c.low)
    const recentHighs = candleWindow.slice(-10).map(c => c.high)
    const priorLow = Math.min(...recentLows.slice(0, -2))
    const priorHigh = Math.max(...recentHighs.slice(0, -2))

    if (setup.direction === 'BEARISH') {
      // Sweep high: broke prior high then reversed
      if (goCandle.high > priorHigh && goCandle.close < priorHigh) {
        sweep_flag = 1
      }
      // Acceptance: 2+ closes above broken level
      const closesAbove = candleWindow.slice(-5).filter(c => c.close > priorHigh).length
      acceptance_flag = closesAbove >= 2 ? 1 : 0
    } else {
      // Sweep low
      if (goCandle.low < priorLow && goCandle.close > priorLow) {
        sweep_flag = 1
      }
      const closesBelow = candleWindow.slice(-5).filter(c => c.close < priorLow).length
      acceptance_flag = closesBelow >= 2 ? 1 : 0
    }
  }

  // ── F) Open-space/blocker ──────────────────────────────────────────────
  // Blockers = fib levels between entry and target
  const allFibPrices = fibResult.levels.map(l => l.price)
  const entryPrice = setup.entry
  const tp1Price = setup.tp1

  let blockerCount = 0
  let nearestBlockerDist = Infinity

  for (const fibPrice of allFibPrices) {
    const isBetween = setup.direction === 'BULLISH'
      ? fibPrice > entryPrice && fibPrice < tp1Price
      : fibPrice < entryPrice && fibPrice > tp1Price

    if (isBetween) {
      blockerCount++
      const dist = Math.abs(fibPrice - entryPrice)
      if (dist < nearestBlockerDist) nearestBlockerDist = dist
    }
  }

  const nearest_blocker_ticks = nearestBlockerDist === Infinity
    ? Math.round(dist_entry_to_tp1 / tickSize)
    : Math.round(nearestBlockerDist / tickSize)

  const open_space_ratio = dist_entry_to_tp1 > 0
    ? (nearestBlockerDist === Infinity ? 1 : nearestBlockerDist / dist_entry_to_tp1)
    : 0

  // ── Core technicals ────────────────────────────────────────────────────
  const ret_1h = closes.length >= 4
    ? (closes[closes.length - 1] - closes[closes.length - 4]) / closes[closes.length - 4]
    : null
  const ret_4h = closes.length >= 16
    ? (closes[closes.length - 1] - closes[closes.length - 16]) / closes[closes.length - 16]
    : null

  const rsi14 = rsi(closes, 14)
  const rsi2 = rsi(closes, 2)
  const bb20 = bollingerPos(closes, 20)
  const stoch14 = stochastic(candleWindow, 14)
  const ma8 = sma(closes, 8)
  const ma24 = sma(closes, 24)
  const price = closes[closes.length - 1]

  const ema12 = ema(closes, 12)
  const ema26 = ema(closes, 26)
  const macd_line = ema12 && ema26 ? ema12 - ema26 : null

  const currentRange = goCandle.high - goCandle.low
  const currentBody = Math.abs(goCandle.close - goCandle.open)

  // Volume ratio
  const recentVols = candleWindow.slice(-24).map(c => c.volume ?? 0)
  const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 0
  const vol_ratio = avgVol > 0 ? (goCandle.volume ?? 0) / avgVol : 0

  // Fib position
  const fib_position = fibRange > 0 ? (price - fibResult.anchorLow) / fibRange : 0.5

  // ── Risk ───────────────────────────────────────────────────────────────
  const risk = computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)

  // ── Labels (look forward from GO bar in allCandles) ────────────────────
  const tp1_before_sl_1h = lookForwardLabel(
    allCandles, goBarGlobalIndex, setup, 'tp1', LABEL_HORIZONS.tp1_before_sl_1h
  )
  const tp1_before_sl_4h = lookForwardLabel(
    allCandles, goBarGlobalIndex, setup, 'tp1', LABEL_HORIZONS.tp1_before_sl_4h
  )
  const tp2_before_sl_8h = lookForwardLabel(
    allCandles, goBarGlobalIndex, setup, 'tp2', LABEL_HORIZONS.tp2_before_sl_8h
  )

  return {
    go_time: goTime,
    go_timestamp: new Date(goTime * 1000).toISOString(),
    direction: setup.direction,
    go_type: setup.goType ?? 'BREAK',

    fib_touch_level: setup.fibLevel,
    fib_ratio: setup.fibRatio,
    dist_to_50_ticks,
    dist_to_618_ticks,
    dist_entry_to_tp1_ticks: Math.round(dist_entry_to_tp1 / tickSize),
    dist_entry_to_tp2_ticks: Math.round(dist_entry_to_tp2 / tickSize),
    r_to_tp1,
    r_to_tp2,
    atr_at_entry: atrVal,
    stop_atr_multiple: atrVal > 0 ? stopDist / atrVal : 0,
    swing_ab_len_ticks: Math.round(fibRange / tickSize),
    hook_wick_ratio,
    hook_body_ratio,

    vol_shock_flag,
    gap_flag,

    session_bucket,
    day_of_week,
    hour_ct,

    vix_level: null,  // Filled in post-processing from FRED
    vix_change_1d: null,
    dxy_level: null,
    nq_level: null,

    sweep_flag,
    acceptance_flag,

    nearest_blocker_ticks,
    open_space_ratio,
    blocker_density: blockerCount,

    close: price,
    ret_1h,
    ret_4h,
    rsi_14: rsi14,
    rsi_2: rsi2,
    atr_14: atrVal,
    atr_7: atr7 ?? null,
    bb_pos_20: bb20,
    stoch_14: stoch14,
    ma_8: ma8,
    ma_24: ma24,
    dist_ma_8: ma8 ? (price - ma8) / price : null,
    dist_ma_24: ma24 ? (price - ma24) / price : null,
    range_pct: price > 0 ? currentRange / price : null,
    body_ratio: currentRange > 0 ? currentBody / currentRange : null,
    vol_ratio,
    macd_line,
    macd_hist: null,  // Would need signal line history
    fib_position,

    stop_distance_pts: risk.stopDistance,
    stop_ticks: risk.stopTicks,
    contracts: risk.contracts,
    dollar_risk: risk.dollarRisk,
    rr: risk.rr,
    grade: risk.grade,

    headlines_24h: '',  // Filled in post-processing

    tp1_before_sl_1h,
    tp1_before_sl_4h,
    tp2_before_sl_8h,
  }
}

// ─── Look-Forward Label Computation ──────────────────────────────────────────

function lookForwardLabel(
  allCandles: CandleData[],
  goBarIndex: number,
  setup: BhgSetup,
  targetType: 'tp1' | 'tp2',
  horizonBars: number
): number | null {
  const target = targetType === 'tp1' ? setup.tp1 : setup.tp2
  const sl = setup.stopLoss
  if (!target || !sl || !setup.entry) return null

  const endIdx = Math.min(goBarIndex + horizonBars, allCandles.length)

  for (let i = goBarIndex + 1; i < endIdx; i++) {
    const candle = allCandles[i]

    if (setup.direction === 'BULLISH') {
      // Check SL first (bearish = price drops to SL)
      if (candle.low <= sl) return 0
      // Check target hit
      if (candle.high >= target) return 1
    } else {
      // Bearish: SL is above entry, target is below
      if (candle.high >= sl) return 0
      if (candle.low <= target) return 1
    }
  }

  // Horizon expired without hitting either
  return 0
}

// ─── FRED Data Enrichment ────────────────────────────────────────────────────

interface FredSnapshot {
  date: string // YYYY-MM-DD
  vix: number | null
  dxy: number | null
  nq: number | null
}

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ regclass: string | null }[]>(
    'SELECT to_regclass($1)::text as regclass',
    `public.${tableName}`
  )
  return rows[0]?.regclass != null
}

async function loadFredSnapshots(): Promise<Map<string, FredSnapshot>> {
  const map = new Map<string, FredSnapshot>()

  try {
    // VIX
    const vixRows = await prisma.$queryRawUnsafe<{ eventDate: Date; value: number }[]>(
      `SELECT "eventDate", value FROM "econ_vol_indices_1d" WHERE "seriesId" = 'VIXCLS' AND value IS NOT NULL ORDER BY "eventDate"`
    )
    const vixByDate = new Map(vixRows.map(r => [new Date(r.eventDate).toISOString().slice(0, 10), r.value]))

    // DXY
    const dxyRows = await prisma.$queryRawUnsafe<{ eventDate: Date; value: number }[]>(
      `SELECT "eventDate", value FROM "econ_fx_1d" WHERE "seriesId" = 'DTWEXBGS' AND value IS NOT NULL ORDER BY "eventDate"`
    )
    const dxyByDate = new Map(dxyRows.map(r => [new Date(r.eventDate).toISOString().slice(0, 10), r.value]))

    // Merge all dates
    const allDates = new Set([...vixByDate.keys(), ...dxyByDate.keys()])
    for (const date of allDates) {
      map.set(date, {
        date,
        vix: vixByDate.get(date) ?? null,
        dxy: dxyByDate.get(date) ?? null,
        nq: null,
      })
    }
  } catch (err) {
    console.warn('  WARNING: Could not load FRED data for enrichment:', (err as Error).message)
  }

  return map
}

function enrichWithFred(
  features: GoEventFeatures,
  fredSnapshots: Map<string, FredSnapshot>
): GoEventFeatures {
  // Use lagged availability date, then look back up to 5 days for weekends/holidays.
  const effectiveDate = shiftUtcDays(new Date(features.go_time * 1000), -FRED_ENRICH_LAG_DAYS)
  let snapshot: FredSnapshot | undefined
  for (let d = 0; d < 5; d++) {
    const lookDate = dateKeyUtc(shiftUtcDays(effectiveDate, -d))
    snapshot = fredSnapshots.get(lookDate)
    if (snapshot) break
  }

  if (!snapshot) return features

  // VIX change (1d)
  let vixChange: number | null = null
  if (snapshot.vix != null) {
    const prevDate = dateKeyUtc(shiftUtcDays(effectiveDate, -1))
    const prevSnap = fredSnapshots.get(prevDate)
    if (prevSnap?.vix != null && prevSnap.vix > 0) {
      vixChange = (snapshot.vix - prevSnap.vix) / prevSnap.vix
    }
  }

  return {
    ...features,
    vix_level: snapshot.vix,
    vix_change_1d: vixChange,
    dxy_level: snapshot.dxy,
    nq_level: snapshot.nq,
  }
}

// ─── DB Row → CandleData ────────────────────────────────────────────────────

function rowToCandle(row: {
  eventTime: Date
  open: Decimal | number
  high: Decimal | number
  low: Decimal | number
  close: Decimal | number
  volume: bigint | null
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnvFiles()

  const daysBack = parseInt(parseArg('days-back', '730'), 10)
  const outPath = parseArg('out', 'datasets/autogluon/bhg_setups.csv')
  const shouldPersist = parseArg('persist', 'true').toLowerCase() !== 'false'

  console.log(`Building BHG setup dataset (last ${daysBack} days)`)
  console.log(`  Output: ${outPath}`)

  // 1. Fetch all 15m candles
  const cutoff = new Date(Date.now() - daysBack * 86400000)
  console.log(`  Fetching MES 15m candles since ${cutoff.toISOString().slice(0, 10)}...`)

  const rows = await prisma.mktFuturesMes15m.findMany({
    where: { eventTime: { gte: cutoff } },
    orderBy: { eventTime: 'asc' },
  })

  if (rows.length < WINDOW_BARS) {
    console.error(`  ERROR: Only ${rows.length} 15m candles. Need at least ${WINDOW_BARS}.`)
    process.exit(1)
  }

  const allCandles = rows.map(rowToCandle)
  console.log(`  Loaded ${allCandles.length.toLocaleString()} candles`)
  console.log(`  Date range: ${new Date(allCandles[0].time * 1000).toISOString().slice(0, 10)} → ${new Date(allCandles[allCandles.length - 1].time * 1000).toISOString().slice(0, 10)}`)

  // 2. Load FRED data for enrichment
  console.log('  Loading FRED snapshots...')
  console.log('  Anti-leakage policy: FRED snapshot enrichment lagged by 1 day')
  const fredSnapshots = await loadFredSnapshots()
  console.log(`  FRED snapshots: ${fredSnapshots.size.toLocaleString()} dates`)

  // 2b. Load headlines from news_signals
  const newsSignals = await prisma.newsSignal.findMany({
    select: { title: true, pubDate: true },
    orderBy: { pubDate: 'asc' },
  })
  console.log(`  News signals (headlines): ${newsSignals.length} rows`)

  // 3. Slide window over candles, run BHG engine, collect GO events
  const goEvents: GoEventFeatures[] = []
  const seenGoKeys = new Set<string>()

  console.log('  Running BHG engine over sliding windows...')

  for (let start = 0; start <= allCandles.length - WINDOW_BARS; start += STEP_BARS) {
    const windowEnd = start + WINDOW_BARS
    const window = allCandles.slice(start, windowEnd)

    // Need at least enough look-ahead for labels
    const maxLookAhead = Math.max(...Object.values(LABEL_HORIZONS))
    if (windowEnd + maxLookAhead > allCandles.length) {
      // Not enough future data for labels — stop
      break
    }

    const swings = detectSwings(window, 5, 5, 20)
    const fibResult = calculateFibonacci(swings.highs, swings.lows)
    if (!fibResult) continue

    const measuredMoves = detectMeasuredMoves(swings.highs, swings.lows, window[window.length - 1].close)
    const setups = advanceBhgSetups(window, fibResult, measuredMoves)

    // Extract GO_FIRED setups
    for (const setup of setups) {
      if (setup.phase !== 'GO_FIRED' || !setup.goTime) continue

      // Deduplicate by goTime + direction + fibRatio
      const dedupeKey = `${setup.goTime}-${setup.direction}-${setup.fibRatio}`
      if (seenGoKeys.has(dedupeKey)) continue
      seenGoKeys.add(dedupeKey)

      // Map local bar index to global
      const goBarGlobal = start + (setup.goBarIndex ?? 0)

      const features = computeGoFeatures(
        setup, window, allCandles, fibResult, goBarGlobal
      )

      if (features) {
        const enriched = enrichWithFred(features, fredSnapshots)

        // Headlines from news_signals (lagged 1 day, 24h window)
        const goDate = new Date(features.go_time * 1000)
        const { startKey: h24Start, endKey: h24End } = laggedWindowKeys(goDate, 1, 1)
        const headlineTexts: string[] = []
        for (const ns of newsSignals) {
          const nk = dateKeyUtc(ns.pubDate)
          if (nk >= h24Start && nk <= h24End) {
            headlineTexts.push(ns.title)
            if (headlineTexts.length >= 20) break
          }
        }
        enriched.headlines_24h = headlineTexts.join(' | ')

        goEvents.push(enriched)
      }
    }
  }

  console.log(`  GO events found: ${goEvents.length.toLocaleString()}`)

  if (goEvents.length === 0) {
    console.error('  ERROR: No GO events found. Check data quality.')
    process.exit(1)
  }

  // 4. Statistics
  const bullish = goEvents.filter(e => e.direction === 'BULLISH').length
  const bearish = goEvents.filter(e => e.direction === 'BEARISH').length
  const tp1_1h = goEvents.filter(e => e.tp1_before_sl_1h === 1).length
  const tp1_4h = goEvents.filter(e => e.tp1_before_sl_4h === 1).length
  const tp2_8h = goEvents.filter(e => e.tp2_before_sl_8h === 1).length
  const labeled = goEvents.filter(e => e.tp1_before_sl_4h != null).length

  console.log(`\n  ── Dataset Statistics ──`)
  console.log(`  Total GO events:     ${goEvents.length}`)
  console.log(`  Bullish:             ${bullish} (${(bullish/goEvents.length*100).toFixed(1)}%)`)
  console.log(`  Bearish:             ${bearish} (${(bearish/goEvents.length*100).toFixed(1)}%)`)
  console.log(`  Labeled rows:        ${labeled}`)
  console.log(`  TP1 hit (1h):        ${tp1_1h} / ${labeled} = ${(tp1_1h/labeled*100).toFixed(1)}%`)
  console.log(`  TP1 hit (4h):        ${tp1_4h} / ${labeled} = ${(tp1_4h/labeled*100).toFixed(1)}%`)
  console.log(`  TP2 hit (8h):        ${tp2_8h} / ${labeled} = ${(tp2_8h/labeled*100).toFixed(1)}%`)

  const gradeA = goEvents.filter(e => e.grade === 'A').length
  const gradeB = goEvents.filter(e => e.grade === 'B').length
  const gradeC = goEvents.filter(e => e.grade === 'C').length
  console.log(`  Grade A: ${gradeA}  B: ${gradeB}  C: ${gradeC}  D: ${goEvents.length - gradeA - gradeB - gradeC}`)

  // Session distribution
  const sessions = new Map<string, number>()
  for (const e of goEvents) {
    sessions.set(e.session_bucket, (sessions.get(e.session_bucket) ?? 0) + 1)
  }
  console.log(`  Sessions: ${[...sessions.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`)

  // 5. Write CSV
  const outDir = path.dirname(outPath)
  fs.mkdirSync(outDir, { recursive: true })

  const header = Object.keys(goEvents[0])
  const csvLines = [
    header.join(','),
    ...goEvents.map(row =>
      header.map(col => {
        const val = (row as unknown as Record<string, unknown>)[col]
        if (val == null) return ''
        if (typeof val === 'string') return `"${val}"`
        if (typeof val === 'number') return Number.isFinite(val) ? val.toString() : ''
        return String(val)
      }).join(',')
    ),
  ]

  fs.writeFileSync(outPath, csvLines.join('\n') + '\n')
  console.log(`\n  Written to ${outPath} (${goEvents.length} rows x ${header.length} columns)`)

  // 6. Also persist to bhg_setups table
  if (shouldPersist) {
    console.log('  Persisting GO events to bhg_setups table...')

    const bhgTablePresent = await tableExists('bhg_setups')
    if (!bhgTablePresent) {
      throw new Error(
        'Persistence target table public.bhg_setups is missing. Run Prisma migration before using --persist=true.'
      )
    }

    let persisted = 0
    let failed = 0
    const sampleErrors: string[] = []

    for (const event of goEvents) {
      const setupId = `${event.direction}-${event.fib_ratio}-${event.go_time}`
      const sign = event.direction === 'BULLISH' ? 1 : -1

      try {
        await prisma.bhgSetup.upsert({
          where: { setupId },
          create: {
            setupId,
            direction: event.direction as 'BULLISH' | 'BEARISH',
            timeframe: 'M15',
            phase: 'GO_FIRED',
            fibLevel: event.fib_touch_level,
            fibRatio: event.fib_ratio,
            goTime: new Date(event.go_time * 1000),
            goType: event.go_type,
            entry: event.close,
            stopLoss: event.close - event.stop_distance_pts * sign,
            tp1: event.close + event.dist_entry_to_tp1_ticks * MES_TICK_SIZE * sign,
            tp2: event.close + event.dist_entry_to_tp2_ticks * MES_TICK_SIZE * sign,
            tp1Hit: event.tp1_before_sl_4h === 1,
            tp2Hit: event.tp2_before_sl_8h === 1,
            slHit: event.tp1_before_sl_4h === 0 && event.tp2_before_sl_8h === 0,
            vixLevel: event.vix_level,
          },
          update: {
            tp1Hit: event.tp1_before_sl_4h === 1,
            tp2Hit: event.tp2_before_sl_8h === 1,
            slHit: event.tp1_before_sl_4h === 0 && event.tp2_before_sl_8h === 0,
            vixLevel: event.vix_level,
          },
        })
        persisted++
      } catch (err) {
        failed++
        if (sampleErrors.length < 5) {
          sampleErrors.push(err instanceof Error ? err.message : String(err))
        }
      }
    }

    console.log(`  Persisted: ${persisted} / ${goEvents.length}`)
    if (failed > 0) {
      console.error(`  Persistence failures: ${failed}`)
      for (const msg of sampleErrors) {
        console.error(`   - ${msg}`)
      }
      throw new Error(`Failed to persist ${failed}/${goEvents.length} GO events to bhg_setups.`)
    }
  } else {
    console.log('  Skipping DB persistence (--persist=false).')
  }

  await prisma.$disconnect()
  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
