/**
 * trade-features.ts — Live Trade Feature Vector Assembly
 *
 * Ports indicator computations from build-lean-dataset.ts into real-time
 * pure functions that operate on a candle window. Assembles the full
 * TradeFeatureVector consumed by the composite score and AI reasoning layers.
 *
 * All indicator functions are pure (no DB calls). The only async function
 * is computeTradeFeatures() which queries news_signals for 24h volume.
 */

import { prisma } from '@/lib/prisma'
import type { BhgSetup, SetupDirection } from '@/lib/bhg-engine'
import type { RiskResult } from '@/lib/risk-engine'
import type { EventContext } from '@/lib/event-awareness'
import type { MarketContext } from '@/lib/market-context'
import type { CorrelationAlignment } from '@/lib/correlation-filter'
import type { CandleData, MeasuredMove } from '@/lib/types'

// ─────────────────────────────────────────────
// Exported interfaces
// ─────────────────────────────────────────────

export interface TradeFeatureVector {
  // BHG features
  fibRatio: number
  goType: string
  hookQuality: number
  measuredMoveAligned: boolean
  measuredMoveQuality: number | null
  stopDistancePts: number
  rrRatio: number
  riskGrade: string

  // Event features
  eventPhase: string
  minutesToNextEvent: number | null
  minutesSinceEvent: number | null
  confidenceAdjustment: number

  // Market context
  vixLevel: number | null
  vixPercentile: number | null
  regime: string
  themeScores: Record<string, number>

  // Correlation
  compositeAlignment: number
  isAligned: boolean

  // Technical (from current candles)
  sqzMom: number | null
  sqzState: number | null
  wvfValue: number | null
  wvfPercentile: number | null
  macdHist: number | null
  macdHistColor: number | null

  // News
  newsVolume24h: number
  policyNewsVolume24h: number
}

// ─────────────────────────────────────────────
// Pure helper functions (ported from build-lean-dataset.ts)
// ─────────────────────────────────────────────

/** Simple moving average — returns null until window is filled. */
function computeSMA(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= window) sum -= values[i - window]
    if (i >= window - 1) result[i] = sum / window
  }
  return result
}

/** Rolling highest value in window. */
function rollingHighest(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let max = -Infinity
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] > max) max = values[j]
    }
    result[i] = max
  }
  return result
}

/** Rolling lowest value in window. */
function rollingLowest(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let min = Infinity
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] < min) min = values[j]
    }
    result[i] = min
  }
  return result
}

/** Rolling linear regression — returns endpoint value (offset=0). */
function linreg(values: (number | null)[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null)
  for (let i = window - 1; i < values.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, count = 0
    for (let j = 0; j < window; j++) {
      const v = values[i - window + 1 + j]
      if (v == null) continue
      sumX += j
      sumY += v
      sumXY += j * v
      sumX2 += j * j
      count++
    }
    if (count < window * 0.8) continue
    const denom = count * sumX2 - sumX * sumX
    if (denom === 0) continue
    const slope = (count * sumXY - sumX * sumY) / denom
    const intercept = (sumY - slope * sumX) / count
    result[i] = intercept + slope * (window - 1)
  }
  return result
}

/** Population standard deviation. */
function stdDev(values: number[]): number | null {
  if (values.length < 2) return null
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// ─────────────────────────────────────────────
// Squeeze Pro (from build-lean-dataset.ts:264-391)
// ─────────────────────────────────────────────

export interface SqueezeProResult {
  mom: number | null
  state: number | null // 0=none, 1=wide, 2=normal, 3=narrow, 4=fired
}

/**
 * Compute Squeeze Pro for the latest bar in the candle window.
 * Requires at least `length` candles.
 */
export function computeSqueezeProLatest(
  candles: CandleData[],
  length = 20,
): SqueezeProResult {
  if (candles.length < length + 1) return { mom: null, state: null }

  const closes = candles.map(c => c.close)
  const highs = candles.map(c => c.high)
  const lows = candles.map(c => c.low)

  // SMA of closes
  const sma = computeSMA(closes, length)

  // True Range
  const tr: number[] = [highs[0] - lows[0]]
  for (let i = 1; i < candles.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]),
    ))
  }

  // Keltner Channel deviation (SMA of TR)
  const kcDev = computeSMA(tr, length)

  // Bollinger Band deviation (population stdev of closes)
  const bbDev: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = length - 1; i < candles.length; i++) {
    const window = closes.slice(i - length + 1, i + 1)
    bbDev[i] = stdDev(window)
  }

  // Momentum: linreg(close - midline, length)
  const highest = rollingHighest(highs, length)
  const lowest = rollingLowest(lows, length)
  const delta: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = 0; i < candles.length; i++) {
    if (highest[i] == null || lowest[i] == null || sma[i] == null) continue
    const midline = ((highest[i]! + lowest[i]!) / 2 + sma[i]!) / 2
    delta[i] = closes[i] - midline
  }
  const mom = linreg(delta, length)

  // Squeeze state at last bar
  const last = candles.length - 1
  if (bbDev[last] == null || kcDev[last] == null || kcDev[last] === 0) {
    return { mom: mom[last] ?? null, state: null }
  }

  const bb = bbDev[last]! * 2 // BB uses 2x stdev
  const kc1 = kcDev[last]! * 1.0
  const kc15 = kcDev[last]! * 1.5
  const kc2 = kcDev[last]! * 2.0

  let state: number
  if (bb < kc1) state = 3       // narrow (yellow)
  else if (bb < kc15) state = 2 // normal (red)
  else if (bb < kc2) state = 1  // wide (orange)
  else state = 4                // fired (green)

  return { mom: mom[last] ?? null, state }
}

// ─────────────────────────────────────────────
// Williams Vix Fix (from build-lean-dataset.ts:393-450)
// ─────────────────────────────────────────────

export interface WvfResult {
  value: number | null
  percentile: number | null // 0–2 scale
  signal: boolean           // true = fear spike
}

/**
 * Compute WVF for the latest bar.
 * Requires at least `pd + lb` candles.
 */
export function computeWvfLatest(
  candles: CandleData[],
  pd = 22,
  bbl = 20,
  mult = 2.0,
  lb = 50,
  ph = 0.85,
): WvfResult {
  const minBars = Math.max(pd, bbl, lb) + 10
  if (candles.length < minBars) return { value: null, percentile: null, signal: false }

  const closes = candles.map(c => c.close)
  const lows = candles.map(c => c.low)

  // Highest close over pd bars
  const hc = rollingHighest(closes, pd)

  // Raw WVF
  const wvf: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = pd - 1; i < candles.length; i++) {
    if (hc[i] == null || hc[i] === 0) continue
    wvf[i] = ((hc[i]! - lows[i]) / hc[i]!) * 100
  }

  // BB on WVF
  const wvfNums = wvf.map(v => v ?? 0)
  const wvfSma = computeSMA(wvfNums, bbl)

  // Range percentile
  const rangeHigh = rollingHighest(wvfNums, lb)

  const last = candles.length - 1
  const wvfVal = wvf[last]
  if (wvfVal == null) return { value: null, percentile: null, signal: false }

  // BB upper band
  let upperBand: number | null = null
  if (last >= bbl - 1) {
    const window = wvfNums.slice(last - bbl + 1, last + 1)
    const sd = stdDev(window)
    if (sd != null && wvfSma[last] != null) {
      upperBand = wvfSma[last]! + mult * sd
    }
  }

  const rh = rangeHigh[last]
  const pct = (rh != null && rh > 0) ? Math.min(wvfVal / rh, 2.0) : null
  const sig = (upperBand != null && wvfVal >= upperBand) ||
              (rh != null && wvfVal >= rh * ph)

  return { value: wvfVal, percentile: pct, signal: sig }
}

// ─────────────────────────────────────────────
// CM Ultimate MACD (from build-lean-dataset.ts:452-526)
// ─────────────────────────────────────────────

export interface MacdResult {
  hist: number | null
  histColor: number | null // 0=aqua, 1=blue, 2=red, 3=maroon
}

/**
 * Compute MACD histogram and color for the latest bar.
 * Requires at least slowLength + signalLength candles.
 */
export function computeMacdLatest(
  candles: CandleData[],
  fastLength = 12,
  slowLength = 26,
  signalLength = 9,
): MacdResult {
  const warmup = slowLength + signalLength - 1
  if (candles.length < warmup + 2) return { hist: null, histColor: null }

  const closes = candles.map(c => c.close)
  const fastMult = 2 / (fastLength + 1)
  const slowMult = 2 / (slowLength + 1)

  // EMA computation
  let fastEma = closes[0]
  let slowEma = closes[0]
  const macdLine: number[] = []

  for (let i = 0; i < closes.length; i++) {
    fastEma = (closes[i] - fastEma) * fastMult + fastEma
    slowEma = (closes[i] - slowEma) * slowMult + slowEma
    macdLine.push(fastEma - slowEma)
  }

  // Signal = SMA of MACD line
  const signal = computeSMA(macdLine, signalLength)

  const last = closes.length - 1
  const prev = last - 1
  if (signal[last] == null || signal[prev] == null) return { hist: null, histColor: null }

  const hist = macdLine[last] - signal[last]!
  const prevHist = macdLine[prev] - signal[prev]!
  const rising = hist > prevHist

  let color: number
  if (hist > 0 && rising) color = 0       // aqua — bullish momentum growing
  else if (hist > 0 && !rising) color = 1  // blue — bullish but fading
  else if (hist <= 0 && !rising) color = 2 // red — bearish momentum growing
  else color = 3                           // maroon — bearish but recovering

  return { hist, histColor: color }
}

// ─────────────────────────────────────────────
// Hook quality scorer
// ─────────────────────────────────────────────

/**
 * Score the quality of a hook (CONFIRMED phase).
 * Higher = better hook.
 *  - Tight range hook (small body) = better
 *  - Hook in direction of setup = better
 *  - Multiple hook bars = better confirmation
 */
export function scoreHookQuality(setup: BhgSetup, candles: CandleData[]): number {
  if (!setup.hookBarIndex || !setup.touchBarIndex) return 0.5

  const hookBars = setup.hookBarIndex - setup.touchBarIndex
  if (hookBars <= 0) return 0.5

  let score = 0.5

  // Tighter hooks are better (fewer bars between touch and hook)
  if (hookBars <= 3) score += 0.2
  else if (hookBars <= 5) score += 0.1

  // Check hook candle body size vs average
  const hookCandle = candles[setup.hookBarIndex]
  if (hookCandle) {
    const bodySize = Math.abs(hookCandle.close - hookCandle.open)
    const rangeSize = hookCandle.high - hookCandle.low
    if (rangeSize > 0 && bodySize / rangeSize < 0.3) {
      score += 0.15 // small body = indecision = good hook
    }
  }

  // Hook direction alignment
  if (hookCandle) {
    const bullishCandle = hookCandle.close > hookCandle.open
    if (setup.direction === 'BULLISH' && bullishCandle) score += 0.15
    if (setup.direction === 'BEARISH' && !bullishCandle) score += 0.15
  }

  return Math.min(score, 1.0)
}

// ─────────────────────────────────────────────
// Measured move alignment
// ─────────────────────────────────────────────

/**
 * Check if a measured move supports the setup direction and score quality.
 */
export function checkMeasuredMoveAlignment(
  setup: BhgSetup,
  measuredMoves: MeasuredMove[],
): { aligned: boolean; quality: number | null } {
  if (!measuredMoves || measuredMoves.length === 0) {
    return { aligned: false, quality: null }
  }

  // Find the best active measured move matching setup direction
  const matching = measuredMoves.filter(
    mm => mm.direction === setup.direction && mm.status === 'ACTIVE',
  )

  if (matching.length === 0) return { aligned: false, quality: null }

  // Pick the highest quality one
  const best = matching.reduce((a, b) => a.quality > b.quality ? a : b)
  return { aligned: true, quality: best.quality }
}

// ─────────────────────────────────────────────
// VIX percentile (rolling 252-day)
// ─────────────────────────────────────────────

/**
 * Compute VIX percentile from market context correlations.
 * We approximate from the VIX level using historical distribution.
 */
export function vixPercentile(vixLevel: number | null): number | null {
  if (vixLevel == null) return null
  // Approximate historical VIX percentiles (based on 1990-2024 data)
  // These are rough bucket boundaries — BACKTEST-TBD
  if (vixLevel <= 12) return 0.10
  if (vixLevel <= 14) return 0.25
  if (vixLevel <= 16) return 0.40
  if (vixLevel <= 18) return 0.50
  if (vixLevel <= 20) return 0.60
  if (vixLevel <= 25) return 0.75
  if (vixLevel <= 30) return 0.85
  if (vixLevel <= 40) return 0.93
  return 0.98
}

// ─────────────────────────────────────────────
// News volume query (24h)
// ─────────────────────────────────────────────

interface NewsVolume {
  total: number
  policy: number
}

/**
 * Count news signals in the last 24 hours. Cached per minute.
 */
let newsVolumeCache: { time: number; data: NewsVolume } | null = null

async function getNewsVolume24h(): Promise<NewsVolume> {
  const now = Date.now()
  if (newsVolumeCache && now - newsVolumeCache.time < 60_000) {
    return newsVolumeCache.data
  }

  const since = new Date(now - 24 * 60 * 60 * 1000)

  const [total, policy] = await Promise.all([
    prisma.newsSignal.count({
      where: { pubDate: { gte: since } },
    }),
    prisma.newsSignal.count({
      where: {
        pubDate: { gte: since },
        layer: 'trump_policy',
      },
    }),
  ])

  const data = { total, policy }
  newsVolumeCache = { time: now, data }
  return data
}

/** Reset cache — for testing. */
export function resetNewsVolumeCache(): void {
  newsVolumeCache = null
}

// ─────────────────────────────────────────────
// Main assembly function
// ─────────────────────────────────────────────

/**
 * Assemble the complete trade feature vector for a single BHG setup.
 *
 * All indicator computations are pure. The only async call is the
 * news_signals count query (cached per minute).
 *
 * @param setup - The BHG setup (must be TRIGGERED phase for scoring)
 * @param candles - Recent candle window (at least 60 bars recommended)
 * @param risk - Pre-computed risk result for this setup
 * @param eventContext - Current event awareness context
 * @param marketContext - Current market context (regime, correlations, etc.)
 * @param alignment - Pre-computed correlation alignment
 * @param measuredMoves - Active measured moves (if any)
 */
export async function computeTradeFeatures(
  setup: BhgSetup,
  candles: CandleData[],
  risk: RiskResult,
  eventContext: EventContext,
  marketContext: MarketContext,
  alignment: CorrelationAlignment,
  measuredMoves: MeasuredMove[],
): Promise<TradeFeatureVector> {
  // Technical indicators (pure, computed from candle window)
  const squeeze = computeSqueezeProLatest(candles)
  const wvf = computeWvfLatest(candles)
  const macd = computeMacdLatest(candles)

  // Hook quality (pure)
  const hookQuality = scoreHookQuality(setup, candles)

  // Measured move alignment (pure)
  const mmAlign = checkMeasuredMoveAlignment(setup, measuredMoves)

  // VIX — extract from market context correlations
  const vixCorr = marketContext.correlations.find(c => c.pair.includes('VX'))
  // VIX level approximated from breakout7000 or yield context
  // The actual VIX spot is not stored directly — we use correlation as proxy
  const vixLvl: number | null = null // BACKTEST-TBD: wire VIX spot from data source

  // News volume (async, cached)
  const newsVol = await getNewsVolume24h()

  return {
    // BHG
    fibRatio: setup.fibRatio,
    goType: setup.goType ?? 'BREAK',
    hookQuality,
    measuredMoveAligned: mmAlign.aligned,
    measuredMoveQuality: mmAlign.quality,
    stopDistancePts: risk.stopDistance,
    rrRatio: risk.rr,
    riskGrade: risk.grade,

    // Event
    eventPhase: eventContext.phase,
    minutesToNextEvent: eventContext.minutesToEvent,
    minutesSinceEvent: eventContext.minutesSinceEvent,
    confidenceAdjustment: eventContext.confidenceAdjustment,

    // Market
    vixLevel: vixLvl,
    vixPercentile: vixPercentile(vixLvl),
    regime: marketContext.regime,
    themeScores: marketContext.themeScores as unknown as Record<string, number>,

    // Correlation
    compositeAlignment: alignment.composite,
    isAligned: alignment.isAligned,

    // Technical
    sqzMom: squeeze.mom,
    sqzState: squeeze.state,
    wvfValue: wvf.value,
    wvfPercentile: wvf.percentile,
    macdHist: macd.hist,
    macdHistColor: macd.histColor,

    // News
    newsVolume24h: newsVol.total,
    policyNewsVolume24h: newsVol.policy,
  }
}
