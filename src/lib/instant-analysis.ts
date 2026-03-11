/**
 * Instant Multi-Timeframe Analysis Engine
 *
 * Computes 200+ technical signals across 15M, 1H, 4H timeframes.
 * Signal directions come from RAW MATH — fully transparent.
 * ChatGPT provides optional entry/stop/target levels and narrative overlay.
 *
 * Every signal is exposed: you see exactly WHY each timeframe
 * says BUY or SELL. No black boxes.
 */

import { classifyAIError, generateAIText, isAIAvailable } from './ai-provider'
import { CandleData, FibLevel, SwingPoint, MeasuredMove } from './types'
import { detectSwings } from './swing-detection'
import { calculateFibonacciMultiPeriod } from './fibonacci'
import { detectMeasuredMoves } from './measured-move'

interface AnalysisAiResponse {
  overallVerdict: string
  overallConfidence: number
  narrative: string
  timeframeGauges: { timeframe: string; entry: number; stop: number; target: number; reasoning: string }[]
  symbols: {
    symbol: string
    verdict: string
    confidence: number
    entry: number
    stop: number
    target1: number
    target2: number
    riskReward: number
    reasoning: string
  }[]
}

async function requestAnalysisOverlay(prompt: string): Promise<AnalysisAiResponse> {
  if (!isAIAvailable()) {
    throw new Error('AI provider connection is not configured (OPENROUTER_API_KEY).')
  }

  const { text } = await generateAIText(prompt, { maxTokens: 3000 })

  if (!text) {
    throw new Error('AI model returned empty text')
  }

  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as AnalysisAiResponse
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/)
    if (!m) {
      throw new Error('Failed to parse JSON from AI response')
    }
    return JSON.parse(m[0]) as AnalysisAiResponse
  }
}

// --- Technical indicator helpers ---

function sma(data: number[], period: number): number | null {
  if (data.length < period) return null
  return data.slice(-period).reduce((a, b) => a + b, 0) / period
}

function ema(data: number[], period: number): number | null {
  if (data.length < period) return null
  const k = 2 / (period + 1)
  let v = data.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < data.length; i++) v = data[i] * k + v * (1 - k)
  return v
}

// rsi() + stochastic() removed — replaced by edss()
// Ehlers DSP-based: roofing filter isolates tradeable cycles, super smoother halves lag

const EDSS_PI_IA = Math.PI

function edssSuperSmootherIA(price: number[], lower: number): number[] {
  const a1 = Math.exp(-EDSS_PI_IA * Math.sqrt(2) / lower)
  const c2 = 2 * a1 * Math.cos(Math.sqrt(2) * EDSS_PI_IA / lower)
  const c3 = -Math.pow(a1, 2)
  const c1 = 1 - c2 - c3
  const out: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    out[i] = c1 * (price[i] + p1) / 2 + c2 * (i >= 1 ? out[i - 1] : 0) + c3 * (i >= 2 ? out[i - 2] : 0)
  }
  return out
}

function edssRoofingFilterIA(price: number[], upper: number, lower: number): number[] {
  const a = (Math.cos(Math.sqrt(2) * EDSS_PI_IA / upper) + Math.sin(Math.sqrt(2) * EDSS_PI_IA / upper) - 1)
           / Math.cos(Math.sqrt(2) * EDSS_PI_IA / upper)
  const hp: number[] = new Array(price.length).fill(0)
  for (let i = 0; i < price.length; i++) {
    const p1 = i >= 1 ? price[i - 1] : price[i]
    const p2 = i >= 2 ? price[i - 2] : price[i]
    hp[i] = Math.pow(1 - a / 2, 2) * (price[i] - 2 * p1 + p2)
          + 2 * (1 - a) * (i >= 1 ? hp[i - 1] : 0)
          - Math.pow(1 - a, 2) * (i >= 2 ? hp[i - 2] : 0)
  }
  return edssSuperSmootherIA(hp, lower)
}

// Returns EDSS value (0–1) for the last bar, or null if insufficient data
function edss(candles: CandleData[], length = 14, roofUpper = 48, roofLower = 10): number | null {
  const warmup = roofUpper + length
  if (candles.length < warmup) return null
  const closes = candles.map(c => c.close)
  const filt = edssRoofingFilterIA(closes, roofUpper, roofLower)
  const rawStoch: number[] = new Array(closes.length).fill(0)
  for (let i = 0; i < closes.length; i++) {
    const start = Math.max(0, i - length + 1)
    const slice = filt.slice(start, i + 1)
    const hi = Math.max(...slice), lo = Math.min(...slice)
    // FIX: near-zero range = no cycle → neutral 0.5
    rawStoch[i] = (hi - lo) > 1e-10 ? (filt[i] - lo) / (hi - lo) : 0.5
  }
  // FIX: clamp [0,1] — super smoother overshoots ~4%
  const stoch = edssSuperSmootherIA(rawStoch, roofLower).map(v => Math.max(0, Math.min(1, v)))
  return stoch[stoch.length - 1]
}

function williamsR(candles: CandleData[], period = 14): number | null {
  if (candles.length < period) return null
  const r = candles.slice(-period)
  const hi = Math.max(...r.map(c => c.high))
  const lo = Math.min(...r.map(c => c.low))
  return hi === lo ? -50 : ((hi - r[r.length - 1].close) / (hi - lo)) * -100
}

function roc(closes: number[], period = 12): number | null {
  if (closes.length < period + 1) return null
  const prev = closes[closes.length - 1 - period]
  return prev === 0 ? null : ((closes[closes.length - 1] - prev) / prev) * 100
}

function bollingerPos(closes: number[], period = 20): number | null {
  if (closes.length < period) return null
  const s = closes.slice(-period)
  const mean = s.reduce((a, b) => a + b, 0) / period
  const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / period)
  if (std === 0) return 0.5
  return (closes[closes.length - 1] - (mean - 2 * std)) / (4 * std)
}

function atr(candles: CandleData[], period = 14): number | null {
  if (candles.length < period + 1) return null
  let sum = 0
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    )
  }
  return sum / period
}

function cci(candles: CandleData[], period = 20): number | null {
  if (candles.length < period) return null
  const r = candles.slice(-period)
  const tps = r.map(c => (c.high + c.low + c.close) / 3)
  const mean = tps.reduce((a, b) => a + b, 0) / period
  const md = tps.reduce((a, b) => a + Math.abs(b - mean), 0) / period
  return md === 0 ? 0 : (tps[tps.length - 1] - mean) / (0.015 * md)
}

function vwap(candles: CandleData[]): number | null {
  if (candles.length < 2) return null
  let cumVol = 0, cumTP = 0
  for (const c of candles) {
    const vol = c.volume || 1
    cumVol += vol
    cumTP += ((c.high + c.low + c.close) / 3) * vol
  }
  return cumVol > 0 ? cumTP / cumVol : null
}

// --- Signal computation ---

export interface SignalSummary {
  buy: number
  sell: number
  neutral: number
  total: number
  buySignals: string[]
  sellSignals: string[]
}

export function computeSignals(candles: CandleData[]): SignalSummary {
  const closes = candles.map(c => c.close)
  const price = closes[closes.length - 1]
  let buy = 0, sell = 0, neutral = 0
  const buySignals: string[] = []
  const sellSignals: string[] = []

  const check = (name: string, isBuy: boolean | null) => {
    if (isBuy === null) { neutral++; return }
    if (isBuy) { buy++; buySignals.push(name) } else { sell++; sellSignals.push(name) }
  }

  // --- Moving Averages (12 signals) ---
  for (const p of [5, 10, 20, 50, 100, 200]) {
    const v = sma(closes, p)
    if (v) check(`Price ${price > v ? '>' : '<'} SMA(${p}) @ ${v.toFixed(2)}`, price > v); else neutral++
  }
  for (const p of [5, 10, 20, 50, 100, 200]) {
    const v = ema(closes, p)
    if (v) check(`Price ${price > v ? '>' : '<'} EMA(${p}) @ ${v.toFixed(2)}`, price > v); else neutral++
  }

  // --- MA Crossovers (11 signals) ---
  for (const [a, b] of [[5, 10], [5, 20], [10, 20], [20, 50], [50, 100], [50, 200]]) {
    const sa = sma(closes, a), sb = sma(closes, b)
    if (sa && sb) check(`SMA(${a}) ${sa > sb ? '>' : '<'} SMA(${b})`, sa > sb); else neutral++
  }
  for (const [a, b] of [[5, 10], [10, 20], [20, 50], [50, 100], [50, 200]]) {
    const ea = ema(closes, a), eb = ema(closes, b)
    if (ea && eb) check(`EMA(${a}) ${ea > eb ? '>' : '<'} EMA(${b})`, ea > eb); else neutral++
  }

  // --- Oscillators ---
  // EDSS — Ehlers DBLsmooth Stochastic (replaces RSI + standard Stochastic)
  // 3 signals: short (length=8), standard (length=14), slow (length=21)
  for (const len of [8, 14, 21]) {
    const v = edss(candles, len)
    if (v != null) {
      const pct = (v * 100).toFixed(1)
      const label = v > 0.8 ? 'overbought' : v < 0.2 ? 'oversold' : v > 0.5 ? 'bullish' : 'bearish'
      check(`EDSS(${len}) = ${pct} [${label}]`, v > 0.8 ? false : v < 0.2 ? true : v > 0.5)
    } else neutral++
  }
  // Williams %R (2 signals)
  for (const p of [14, 21]) {
    const v = williamsR(candles, p)
    if (v != null) {
      const label = v < -80 ? 'oversold' : v > -20 ? 'overbought' : v < -50 ? 'bearish' : 'bullish'
      check(`W%R(${p}) = ${v.toFixed(1)} [${label}]`, v < -80 ? true : v > -20 ? false : v < -50)
    } else neutral++
  }
  // CCI (2 signals)
  for (const p of [14, 20]) {
    const v = cci(candles, p)
    if (v != null) {
      check(`CCI(${p}) = ${v.toFixed(1)}`, v > 100 ? true : v < -100 ? false : v > 0)
    } else neutral++
  }
  // ROC (2 signals)
  for (const p of [9, 14]) {
    const v = roc(closes, p)
    if (v != null) check(`ROC(${p}) = ${v.toFixed(2)}%`, v > 0); else neutral++
  }

  // --- Bands ---
  // Bollinger (2 signals)
  for (const p of [10, 20]) {
    const v = bollingerPos(closes, p)
    if (v != null) {
      const label = v > 0.8 ? 'upper band' : v < 0.2 ? 'lower band' : v > 0.5 ? 'above mid' : 'below mid'
      check(`BB(${p}) = ${(v * 100).toFixed(0)}% [${label}]`, v > 0.8 ? false : v < 0.2 ? true : v > 0.5)
    } else neutral++
  }

  // --- Trend ---
  // CM Ultimate MACD (ChrisMoody CM_MacD_Ult_MTF) — 3 sign-state signals
  // fast=12, slow=26, signal=EMA-9.
  if (closes.length >= 26 + 9) {
    const macdArr: number[] = []
    for (let i = 0; i < closes.length; i++) {
      const f = ema(closes.slice(0, i + 1), 12)
      const s = ema(closes.slice(0, i + 1), 26)
      if (f != null && s != null) macdArr.push(f - s)
    }
    if (macdArr.length >= 9) {
      const macdLine = macdArr[macdArr.length - 1]
      const sigVal = ema(macdArr, 9)
      if (sigVal != null) {
        const hist = macdLine - sigVal
        // Signal 1: MACD line vs zero
        check(`CM-MACD line ${macdLine > 0 ? 'above' : 'below'} zero (${macdLine.toFixed(2)})`, macdLine > 0)
        // Signal 2: MACD line vs signal line (color: lime=above, red=below)
        check(`CM-MACD ${macdLine > sigVal ? '>' : '<='} signal (${sigVal.toFixed(2)})`, macdLine > sigVal)
        // Signal 3: histogram above/below zero
        check(`CM-MACD hist ${hist > 0 ? 'above' : 'below/equal'} zero (${hist.toFixed(2)})`, hist > 0)
      } else {
        neutral += 3
      }
    } else { neutral += 3 }
  } else { neutral += 3 }

  // ATR expansion (1 signal)
  const a7 = atr(candles, 7), a14 = atr(candles, 14)
  if (a7 && a14) check(`ATR(7)=${a7.toFixed(2)} ${a7 > a14 ? '>' : '<'} ATR(14)=${a14.toFixed(2)} [${a7 > a14 ? 'expanding' : 'contracting'}]`, a7 > a14)
  else neutral++

  // VWAP (1 signal)
  const vwapVal = vwap(candles)
  if (vwapVal) check(`Price ${price > vwapVal ? '>' : '<'} VWAP @ ${vwapVal.toFixed(2)}`, price > vwapVal)
  else neutral++

  // --- Structure ---
  // Fibonacci (2 signals) — multi-period confluence anchor (8,13,21,34,55)
  const { highs, lows } = detectSwings(candles, 5, 5, 20)
  const fib = calculateFibonacciMultiPeriod(candles)
  if (fib) {
    check(`Fib structure [${fib.isBullish ? 'bullish' : 'bearish'}] (${fib.anchorLow.toFixed(2)} → ${fib.anchorHigh.toFixed(2)})`, fib.isBullish)
    const range = fib.anchorHigh - fib.anchorLow
    const pos = range > 0 ? (price - fib.anchorLow) / range : 0.5
    const fibLabel = pos > 0.786 ? 'above .786' : pos > 0.618 ? 'above .618' : pos > 0.5 ? 'above .500' : pos > 0.382 ? 'above .382' : 'below .382'
    check(`Fib position ${(pos * 100).toFixed(0)}% [${fibLabel}]`, pos > 0.618 ? true : pos < 0.382 ? false : null)
  }

  // Measured moves (variable signals)
  const mms = detectMeasuredMoves(highs, lows, price)
  for (const mm of mms.filter(m => m.status === 'ACTIVE')) {
    check(
      `AB=CD ${mm.direction} (quality ${mm.quality}) → target ${mm.target.toFixed(2)} | entry ${mm.entry.toFixed(2)} stop ${mm.stop.toFixed(2)}`,
      mm.direction === 'BULLISH'
    )
  }

  // Swing structure (1 signal)
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[0].price > highs[1].price
    const hl = lows[0].price > lows[1].price
    const label = hh && hl ? 'Higher Highs + Higher Lows [uptrend]' : (!hh && !hl) ? 'Lower Highs + Lower Lows [downtrend]' : 'Mixed structure'
    check(`Swing: ${label}`, hh && hl ? true : (!hh && !hl) ? false : null)
  }

  // Price action (2 signals)
  if (candles.length > 1) {
    check(`Price ${price > candles[0].open ? '>' : '<'} session open @ ${candles[0].open.toFixed(2)}`, price > candles[0].open)
    const hi = Math.max(...candles.map(c => c.high))
    const lo = Math.min(...candles.map(c => c.low))
    const pos = hi > lo ? (price - lo) / (hi - lo) : 0.5
    const label = pos > 0.8 ? 'near highs' : pos < 0.2 ? 'near lows' : pos > 0.5 ? 'upper half' : 'lower half'
    check(`Range position ${(pos * 100).toFixed(0)}% [${label}] (${lo.toFixed(2)} → ${hi.toFixed(2)})`, pos > 0.6 ? true : pos < 0.4 ? false : null)
  }

  return { buy, sell, neutral, total: buy + sell + neutral, buySignals, sellSignals }
}

// --- Public types ---

export interface TimeframeGauge {
  timeframe: '15M' | '1H' | '4H'
  direction: 'BUY' | 'SELL'
  confidence: number
  buyCount: number
  sellCount: number
  neutralCount: number
  totalSignals: number
  buySignals: string[]
  sellSignals: string[]
  entry: number
  stop: number
  target: number
  reasoning: string
}

export interface InstantSymbolResult {
  symbol: string
  verdict: string
  confidence: number
  entry: number
  stop: number
  target1: number
  target2: number
  riskReward: number
  reasoning: string
  signalBreakdown: { tf: string; buy: number; sell: number; neutral: number; total: number }[]
}

export interface ChartData {
  candles: CandleData[]
  fibLevels: FibLevel[]
  isBullish: boolean
  swingHighs: SwingPoint[]
  swingLows: SwingPoint[]
  measuredMoves: MeasuredMove[]
}

export interface InstantAnalysisResult {
  timestamp: string
  overallVerdict: string
  overallConfidence: number
  narrative: string
  timeframeGauges: TimeframeGauge[]
  symbols: InstantSymbolResult[]
  totalSignalsAnalysed: number
  chartData: ChartData | null
  marketContext: {
    regime: string
    regimeFactors: string[]
    correlations: { pair: string; value: number; interpretation: string }[]
    headlines: string[]
    goldContext: { price: number; change: number; changePercent: number; signal: string } | null
    oilContext: { price: number; change: number; changePercent: number; signal: string } | null
    yieldContext: {
      tenYearYield: number
      tenYearChangeBp: number
      fedFundsRate: number | null
      spread10yMinusFedBp: number | null
      signal: string
    } | null
    techLeaders: {
      symbol: string
      name: string
      price: number
      dayChangePercent: number
      weekChangePercent: number
      signal: string
    }[]
    themeScores: {
      tariffs: number
      rates: number
      trump: number
      analysts: number
      aiTech: number
      eventRisk: number
    }
    shockReactions: {
      vixSpikeSample: number
      vixSpikeAvgNextDayMesPct: number | null
      vixSpikeMedianNextDayMesPct: number | null
      yieldSpikeSample: number
      yieldSpikeAvgNextDayMesPct: number | null
      yieldSpikeMedianNextDayMesPct: number | null
    }
    breakout7000: {
      level: number
      status:
        | 'CONFIRMED_BREAKOUT'
        | 'UNCONFIRMED_BREAKOUT'
        | 'REJECTED_AT_LEVEL'
        | 'TESTING_7000'
        | 'BELOW_7000'
      latestClose: number
      latestHigh: number
      distanceFromLevel: number
      lastTwoCloses: [number, number]
      closesAboveLevelLast2: number
      closesBelowLevelLast2: number
      consecutiveClosesAboveLevel: number
      consecutiveClosesBelowLevel: number
      twoCloseConfirmation: boolean
      signal: string
      tradePlan: string
    } | null
  }
}

// --- Main entry ---

import { MarketContext } from './market-context'

interface SymbolSignalSnapshot {
  symbol: string
  displayName: string
  price: number
  candles15m: CandleData[]
  breakdown: { tf: string; tfLabel: '15M' | '1H' | '4H'; signals: SignalSummary }[]
}

interface RawGaugeSnapshot {
  timeframe: '15M' | '1H' | '4H'
  direction: 'BUY' | 'SELL'
  confidence: number
  buyCount: number
  sellCount: number
  neutralCount: number
  totalSignals: number
  buySignals: string[]
  sellSignals: string[]
}

interface AnalysisCoreSnapshot {
  signalData: SymbolSignalSnapshot[]
  rawGauges: RawGaugeSnapshot[]
  grandTotal: number
  chartData: ChartData | null
  mesTimeframes: MesTimeframes
}

type TimeframeLabel = '15M' | '1H' | '4H'

interface MesTimeframeSnapshot {
  candles: CandleData[]
  measuredMoves: MeasuredMove[]
}

type MesTimeframes = Record<TimeframeLabel, MesTimeframeSnapshot>

type VixRegime = 'LOW' | 'MODERATE' | 'HIGH'

interface DirectionBias {
  direction: 'BUY' | 'SELL'
  confidence: number
  note: string | null
}

const EMPTY_MES_TIMEFRAMES: MesTimeframes = {
  '15M': { candles: [], measuredMoves: [] },
  '1H': { candles: [], measuredMoves: [] },
  '4H': { candles: [], measuredMoves: [] },
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function classifyVixRegime(vixLevel: number | null): VixRegime {
  if (vixLevel != null && vixLevel >= 20) return 'HIGH'
  if (vixLevel != null && vixLevel < 16) return 'LOW'
  return 'MODERATE'
}

function vixLevelFromSignalData(signalData: SymbolSignalSnapshot[]): number | null {
  const vx = signalData.find((s) => s.symbol === 'VX')
  const v = vx?.price
  return v != null && Number.isFinite(v) && v > 0 ? v : null
}

function formatVixSnapshot(vixLevel: number | null): string {
  if (vixLevel == null) return 'VIX data unavailable'
  const regime = classifyVixRegime(vixLevel)
  return `VIX ${vixLevel.toFixed(2)} (${regime}; LOW<16, ELEVATED>=18, HIGH>=20)`
}

function applyVixBias(
  direction: 'BUY' | 'SELL',
  confidence: number,
  vixLevel: number | null
): DirectionBias {
  const baseConfidence = clampNumber(Math.round(confidence), 50, 95)
  if (vixLevel == null) {
    return { direction, confidence: baseConfidence, note: null }
  }

  if (vixLevel >= 20 && direction === 'BUY') {
    return {
      direction: 'SELL',
      confidence: clampNumber(Math.max(baseConfidence, 70), 50, 95),
      note: `VIX ${vixLevel.toFixed(2)} >= 20.00 hard short filter applied.`,
    }
  }

  if (vixLevel >= 18 && direction === 'BUY') {
    return {
      direction,
      confidence: clampNumber(baseConfidence - 6, 50, 95),
      note: `VIX ${vixLevel.toFixed(2)} is elevated; long confidence damped.`,
    }
  }

  if (vixLevel < 16 && direction === 'BUY') {
    return {
      direction,
      confidence: clampNumber(baseConfidence + 5, 50, 95),
      note: `VIX ${vixLevel.toFixed(2)} is low; long confidence accelerated.`,
    }
  }

  if (vixLevel < 16 && direction === 'SELL') {
    return {
      direction,
      confidence: clampNumber(baseConfidence - 5, 50, 95),
      note: `VIX ${vixLevel.toFixed(2)} is low; short confidence reduced.`,
    }
  }

  return { direction, confidence: baseConfidence, note: null }
}

function calcRiskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop)
  if (risk <= 0) return 0
  const reward = Math.abs(target - entry)
  return Number((reward / risk).toFixed(2))
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function requireFiniteNumber(value: unknown, label: string): number {
  const parsed = toFiniteNumber(value)
  if (parsed == null) {
    throw new Error(`AI overlay unavailable: invalid ${label}.`)
  }
  return parsed
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  throw new Error(`AI overlay unavailable: invalid ${label}.`)
}

function parseDirection(value: unknown, label: string): 'BUY' | 'SELL' {
  if (value === 'BUY' || value === 'SELL') return value
  throw new Error(`AI overlay unavailable: invalid ${label}.`)
}

function isDirectionalLevelOrder(
  direction: 'BUY' | 'SELL',
  entry: number,
  stop: number,
  target: number
): boolean {
  if (direction === 'BUY') return stop < entry && entry < target
  return target < entry && entry < stop
}

function assertDirectionalLevelOrder(
  direction: 'BUY' | 'SELL',
  entry: number,
  stop: number,
  target: number,
  label: string,
): void {
  if (!isDirectionalLevelOrder(direction, entry, stop, target)) {
    throw new Error(`AI overlay unavailable: invalid directional level order for ${label}.`)
  }
}

function assertEntrySide(
  direction: 'BUY' | 'SELL',
  entry: number,
  spotPrice: number,
  label: string,
): void {
  const directionalBuffer = Math.max(spotPrice * 0.00008, 0.5)
  const valid =
    (direction === 'BUY' && entry < spotPrice - directionalBuffer) ||
    (direction === 'SELL' && entry > spotPrice + directionalBuffer)
  if (!valid) {
    throw new Error(`AI overlay unavailable: invalid entry side for ${label}.`)
  }
}

function normalizeAiGaugeLevels(
  raw: RawGaugeSnapshot,
  aiGauge: AnalysisAiResponse['timeframeGauges'][number] | undefined,
  mesPrice: number,
): { entry: number; stop: number; target: number; reasoning: string } {
  if (!aiGauge) {
    throw new Error(`AI overlay unavailable: missing timeframe gauge for ${raw.timeframe}.`)
  }

  const entry = requireFiniteNumber(aiGauge.entry, `${raw.timeframe} entry`)
  const stop = requireFiniteNumber(aiGauge.stop, `${raw.timeframe} stop`)
  const target = requireFiniteNumber(aiGauge.target, `${raw.timeframe} target`)
  const reasoning = requireString(aiGauge.reasoning, `${raw.timeframe} reasoning`)

  assertDirectionalLevelOrder(
    raw.direction,
    entry,
    stop,
    target,
    `${raw.timeframe} gauge`,
  )
  assertEntrySide(raw.direction, entry, mesPrice, `${raw.timeframe} gauge`)

  return {
    entry,
    stop,
    target,
    reasoning,
  }
}

function normalizeAiSymbol(
  aiSymbol: AnalysisAiResponse['symbols'][number] | undefined,
  signalSnapshot: SymbolSignalSnapshot,
  vixLevel: number | null
): InstantSymbolResult {
  if (!aiSymbol) {
    throw new Error(`AI overlay unavailable: missing symbol analysis for ${signalSnapshot.symbol}.`)
  }

  const verdict = parseDirection(aiSymbol.verdict, `${signalSnapshot.symbol} verdict`)
  const confidence = Math.round(
    requireFiniteNumber(aiSymbol.confidence, `${signalSnapshot.symbol} confidence`),
  )
  if (confidence < 50 || confidence > 95) {
    throw new Error(`AI overlay unavailable: invalid confidence for ${signalSnapshot.symbol}.`)
  }

  const entry = requireFiniteNumber(aiSymbol.entry, `${signalSnapshot.symbol} entry`)
  const stop = requireFiniteNumber(aiSymbol.stop, `${signalSnapshot.symbol} stop`)
  const target1 = requireFiniteNumber(aiSymbol.target1, `${signalSnapshot.symbol} target1`)
  const target2 = requireFiniteNumber(aiSymbol.target2, `${signalSnapshot.symbol} target2`)

  assertDirectionalLevelOrder(verdict, entry, stop, target1, `${signalSnapshot.symbol} symbol`)
  assertEntrySide(verdict, entry, signalSnapshot.price, `${signalSnapshot.symbol} symbol`)

  if (signalSnapshot.symbol === 'MES' && vixLevel != null && vixLevel >= 20 && verdict === 'BUY') {
    throw new Error('AI overlay unavailable: MES verdict violates VIX hard short filter.')
  }
  if (verdict === 'BUY' && target2 < target1) {
    throw new Error(`AI overlay unavailable: invalid target ladder for ${signalSnapshot.symbol}.`)
  }
  if (verdict === 'SELL' && target2 > target1) {
    throw new Error(`AI overlay unavailable: invalid target ladder for ${signalSnapshot.symbol}.`)
  }

  const rr = calcRiskReward(entry, stop, target1)
  if (!Number.isFinite(rr) || rr <= 0) {
    throw new Error(`AI overlay unavailable: invalid risk/reward for ${signalSnapshot.symbol}.`)
  }

  const aiSymbolName = requireString(aiSymbol.symbol, `${signalSnapshot.symbol} symbol field`)
  if (aiSymbolName !== signalSnapshot.symbol) {
    throw new Error(
      `AI overlay unavailable: symbol mismatch (expected ${signalSnapshot.symbol}, got ${aiSymbolName}).`,
    )
  }
  const reasoning = requireString(aiSymbol.reasoning, `${signalSnapshot.symbol} reasoning`)

  return {
    symbol: signalSnapshot.symbol,
    verdict,
    confidence,
    entry,
    stop,
    target1,
    target2,
    riskReward: rr,
    reasoning,
    signalBreakdown: signalSnapshot.breakdown.map((b) => ({
      tf: b.tf,
      buy: b.signals.buy,
      sell: b.signals.sell,
      neutral: b.signals.neutral,
      total: b.signals.total,
    })),
  }
}

function buildAnalysisCore(
  allData: Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles4h: CandleData[]; price: number }>,
  symbolNames: Map<string, string>,
): AnalysisCoreSnapshot {
  const signalData: SymbolSignalSnapshot[] = []
  let grandTotal = 0

  const mesGaugeData: { tf: '15M' | '1H' | '4H'; signals: SignalSummary }[] = []

  for (const [symbol, data] of allData.entries()) {
    const tfs: { tf: string; tfLabel: '15M' | '1H' | '4H'; candles: CandleData[] }[] = [
      { tf: '15m', tfLabel: '15M', candles: data.candles15m },
      { tf: '1h', tfLabel: '1H', candles: data.candles1h },
      { tf: '4h', tfLabel: '4H', candles: data.candles4h },
    ]
    const breakdown: { tf: string; tfLabel: '15M' | '1H' | '4H'; signals: SignalSummary }[] = []

    for (const { tf, tfLabel, candles } of tfs) {
      if (candles.length < 5) continue
      const result = computeSignals(candles)
      breakdown.push({ tf, tfLabel, signals: result })
      grandTotal += result.total

      if (symbol === 'MES') {
        mesGaugeData.push({ tf: tfLabel, signals: result })
      }
    }

    signalData.push({
      symbol,
      displayName: symbolNames.get(symbol) || symbol,
      price: data.price,
      candles15m: data.candles15m,
      breakdown,
    })
  }

  const rawGauges: RawGaugeSnapshot[] = mesGaugeData.map(g => ({
    timeframe: g.tf,
    direction: (g.signals.buy > g.signals.sell ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    confidence: g.signals.buy + g.signals.sell > 0
      ? Math.round((Math.max(g.signals.buy, g.signals.sell) / (g.signals.buy + g.signals.sell)) * 100)
      : 50,
    buyCount: g.signals.buy,
    sellCount: g.signals.sell,
    neutralCount: g.signals.neutral,
    totalSignals: g.signals.total,
    buySignals: g.signals.buySignals,
    sellSignals: g.signals.sellSignals,
  }))

  let mesTimeframes: MesTimeframes = {
    '15M': { candles: [], measuredMoves: [] },
    '1H': { candles: [], measuredMoves: [] },
    '4H': { candles: [], measuredMoves: [] },
  }

  let chartData: ChartData | null = null
  const mesData = allData.get('MES')
  if (mesData) {
    const buildMesTimeframe = (candles: CandleData[]): MesTimeframeSnapshot => {
      if (candles.length < 5) {
        return { candles, measuredMoves: [] }
      }
      const { highs, lows } = detectSwings(candles, 5, 5, 20)
      const measuredMoves = detectMeasuredMoves(highs, lows, candles[candles.length - 1].close)
      return { candles, measuredMoves }
    }

    mesTimeframes = {
      '15M': buildMesTimeframe(mesData.candles15m),
      '1H': buildMesTimeframe(mesData.candles1h),
      '4H': buildMesTimeframe(mesData.candles4h),
    }
  }

  if (mesData && mesData.candles15m.length > 5) {
    const { highs: chHighs, lows: chLows } = detectSwings(mesData.candles15m, 5, 5, 20)
    const chFib = calculateFibonacciMultiPeriod(mesData.candles15m)
    chartData = {
      candles: mesData.candles15m,
      fibLevels: chFib?.levels || [],
      isBullish: chFib?.isBullish ?? true,
      swingHighs: chHighs,
      swingLows: chLows,
      measuredMoves: mesTimeframes['15M'].measuredMoves,
    }
  }

  return {
    signalData,
    rawGauges,
    grandTotal,
    chartData,
    mesTimeframes: mesData ? mesTimeframes : EMPTY_MES_TIMEFRAMES,
  }
}

export async function runInstantAnalysis(
  allData: Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles4h: CandleData[]; price: number }>,
  symbolNames: Map<string, string>,
  marketContext: MarketContext,
): Promise<InstantAnalysisResult> {
  const core = buildAnalysisCore(allData, symbolNames)
  const { signalData, rawGauges, grandTotal, chartData } = core
  const vixLevel = vixLevelFromSignalData(signalData)
  const vixSnapshot = formatVixSnapshot(vixLevel)

  // Step 3: Build the FULL macro analysis prompt
  const signalLines = signalData.map(s => {
    const bdown = s.breakdown.map(b =>
      `  ${b.tf.toUpperCase()}: ${b.signals.buy}B / ${b.signals.sell}S / ${b.signals.neutral}N = ${b.signals.total} signals\n` +
      `    BUY: ${b.signals.buySignals.join(' | ')}\n` +
      `    SELL: ${b.signals.sellSignals.join(' | ')}`
    ).join('\n')
    return `${s.displayName} @ ${s.price.toFixed(2)}:\n${bdown}`
  }).join('\n\n')

  const gaugeLines = rawGauges.map(g =>
    `  ${g.timeframe}: ${g.direction} — ${g.buyCount}B vs ${g.sellCount}S = ${g.confidence}%`
  ).join('\n')

  const corrLines = marketContext.correlations.map(c =>
    `  ${c.pair}: ${c.value} — ${c.interpretation}`
  ).join('\n')

  const headlineBlock = marketContext.headlines.length > 0
    ? `\n== CURRENT MARKET HEADLINES ==\n${marketContext.headlines.map(h => `  - ${h}`).join('\n')}`
    : '\n== NO LIVE HEADLINES AVAILABLE — reason from cross-asset data =='

  const goldBlock = marketContext.goldContext
    ? `GOLD @ ${marketContext.goldContext.price.toFixed(2)} (${marketContext.goldContext.changePercent >= 0 ? '+' : ''}${marketContext.goldContext.changePercent.toFixed(2)}%) — ${marketContext.goldContext.signal}`
    : 'GOLD: data unavailable'

  const oilBlock = marketContext.oilContext
    ? `OIL @ ${marketContext.oilContext.price.toFixed(2)} (${marketContext.oilContext.changePercent >= 0 ? '+' : ''}${marketContext.oilContext.changePercent.toFixed(2)}%) — ${marketContext.oilContext.signal}`
    : 'OIL: data unavailable'

  const yieldBlock = marketContext.yieldContext
    ? `US10Y @ ${marketContext.yieldContext.tenYearYield.toFixed(2)}% (${marketContext.yieldContext.tenYearChangeBp >= 0 ? '+' : ''}${marketContext.yieldContext.tenYearChangeBp.toFixed(1)} bp) | FedFunds ${marketContext.yieldContext.fedFundsRate == null ? 'n/a' : `${marketContext.yieldContext.fedFundsRate.toFixed(2)}%`} | 10Y-Fed spread ${marketContext.yieldContext.spread10yMinusFedBp == null ? 'n/a' : `${marketContext.yieldContext.spread10yMinusFedBp.toFixed(1)} bp`} | ${marketContext.yieldContext.signal}`
    : 'US10Y: data unavailable'

  const techLeaderBlock = marketContext.techLeaders.length > 0
    ? marketContext.techLeaders
      .map((t) =>
        `  ${t.symbol} ${t.dayChangePercent >= 0 ? '+' : ''}${t.dayChangePercent.toFixed(2)}% 1D | ${t.weekChangePercent >= 0 ? '+' : ''}${t.weekChangePercent.toFixed(2)}% 1W | ${t.signal}`
      )
      .join('\n')
    : '  data unavailable'

  const themeScoreBlock = `Tariffs=${marketContext.themeScores.tariffs}, Rates=${marketContext.themeScores.rates}, Trump=${marketContext.themeScores.trump}, Analysts=${marketContext.themeScores.analysts}, AI/Tech=${marketContext.themeScores.aiTech}, EventRisk=${marketContext.themeScores.eventRisk}`

  const shockBlock = `VIX spike reactions: n=${marketContext.shockReactions.vixSpikeSample}, next-day MES avg=${marketContext.shockReactions.vixSpikeAvgNextDayMesPct == null ? 'n/a' : `${marketContext.shockReactions.vixSpikeAvgNextDayMesPct.toFixed(2)}%`}, median=${marketContext.shockReactions.vixSpikeMedianNextDayMesPct == null ? 'n/a' : `${marketContext.shockReactions.vixSpikeMedianNextDayMesPct.toFixed(2)}%`} | 10Y spike reactions: n=${marketContext.shockReactions.yieldSpikeSample}, next-day MES avg=${marketContext.shockReactions.yieldSpikeAvgNextDayMesPct == null ? 'n/a' : `${marketContext.shockReactions.yieldSpikeAvgNextDayMesPct.toFixed(2)}%`}, median=${marketContext.shockReactions.yieldSpikeMedianNextDayMesPct == null ? 'n/a' : `${marketContext.shockReactions.yieldSpikeMedianNextDayMesPct.toFixed(2)}%`}`
  const breakout7000Block = marketContext.breakout7000
    ? `Status=${marketContext.breakout7000.status}; last close=${marketContext.breakout7000.latestClose.toFixed(2)}; dist=${marketContext.breakout7000.distanceFromLevel >= 0 ? '+' : ''}${marketContext.breakout7000.distanceFromLevel.toFixed(2)}; last two closes=${marketContext.breakout7000.lastTwoCloses[0].toFixed(2)}, ${marketContext.breakout7000.lastTwoCloses[1].toFixed(2)}; consecutive above=${marketContext.breakout7000.consecutiveClosesAboveLevel}; two-close-confirmed=${marketContext.breakout7000.twoCloseConfirmation}; signal=${marketContext.breakout7000.signal}`
    : 'data unavailable'

  const prompt = `You are a senior macro strategist and chart technician.
Focus on measured-move and signal-math interpretation with probabilistic framing (neural-net style probability language).
Write short, concrete, and tradeable output.
Use ONLY the data provided below; do not invent external facts, policy events, or macro numbers.
If a datapoint is unavailable, explicitly say "data unavailable".

== TECHNICAL SIGNALS (${grandTotal} computed across 15M/1H/4H) ==

${signalLines}

== MES RAW SIGNAL GAUGES (direction from pure math) ==
${gaugeLines}

== VIX REGIME FILTER ==
${vixSnapshot}

== CROSS-ASSET CORRELATIONS (rolling 15-min returns) ==
${corrLines || '  No correlation data available'}

== RATES (PRIORITIZE THIS) ==
${yieldBlock}

== TOP 10 AI/TECH DRIVERS ==
${techLeaderBlock}

== NEWS/THEME SCORES (from current headlines) ==
${themeScoreBlock}

== HISTORICAL SHOCK REACTION BASELINE ==
${shockBlock}

== SPX 7,000 BREAKOUT DETECTOR (STRICT TWO-CLOSE RULE) ==
${breakout7000Block}

== MARKET REGIME: ${marketContext.regime} ==
${marketContext.regimeFactors.map(f => `  - ${f}`).join('\n')}

== COMMODITIES ==
${goldBlock}
${oilBlock}
${headlineBlock}

== YOUR ANALYSIS ==
Required style:
- math-first and concrete
- include a TL;DR sentence at the start of narrative
- include horizon ranges for 1-week / 1-month / 1-quarter using explicit numbers
- explicitly cite MES↔VX and MES↔US10Y correlations when available
- include one clear invalidation/risk condition
- include one short "how to trade it" plan (trigger + invalidation)
- narrative must stay short (4-7 sentences)
- explicitly respect the two-close breakout rule for 7,000 when discussing breakout validity

RESPOND WITH JSON ONLY (no markdown):
{
  "overallVerdict": "BUY" or "SELL",
  "overallConfidence": number 50-95,
  "narrative": "4-7 concise sentences. Start with TL;DR. Include: signal math snapshot, VIX/10Y references, horizons (1W/1M/1Q), and invalidation.",
  "timeframeGauges": [
    {
      "timeframe": "15M",
      "entry": numeric_trigger_price,
      "stop": numeric_invalidation_price,
      "target": numeric_take_profit_price,
      "reasoning": "1-2 short sentences. Include numeric technical factors and VIX/10Y confirmation/conflict."
    },
    {
      "timeframe": "1H",
      "entry": numeric_trigger_price,
      "stop": numeric_invalidation_price,
      "target": numeric_take_profit_price,
      "reasoning": "2-4 sentences."
    },
    {
      "timeframe": "4H",
      "entry": numeric_trigger_price,
      "stop": numeric_invalidation_price,
      "target": numeric_take_profit_price,
      "reasoning": "2-4 sentences."
    }
  ],
  "symbols": [
    {
      "symbol": "MES",
      "verdict": "BUY" or "SELL",
      "confidence": number,
      "entry": numeric_trigger_price,
      "stop": numeric_invalidation_price,
      "target1": numeric_take_profit_price,
      "target2": numeric_extended_take_profit_price,
      "riskReward": number,
      "reasoning": "1-3 sentences with at least one numeric reference"
    }
  ]
}

CRITICAL:
- Include at least MES, NQ, VX, US10Y, DX, GC, CL in symbols array.
- Keep all numbers realistic to the provided prices.
- Directional level consistency is mandatory: BUY => stop < entry < target and entry below current MES; SELL => target < entry < stop and entry above current MES.
- Do not use identical entry prices for opposing BUY/SELL setups.
- Apply VIX filter: VIX >= 20.00 means timeframe gauges must be SELL; 18.00-19.99 dampens long aggressiveness; VIX < 16.00 allows slightly tighter long risk.
- Do not output any text outside the JSON object.`

  let parsed: AnalysisAiResponse | null = null
  try {
    parsed = await requestAnalysisOverlay(prompt)
  } catch (error) {
    const classified = classifyAIError(error)
    throw new Error(`AI overlay unavailable: ${classified.publicMessage}`)
  }
  if (!parsed) {
    throw new Error('AI overlay unavailable: model returned empty response.')
  }

  // Step 4: Validate and merge AI response with raw signal metadata
  const mesPrice = signalData.find((s) => s.symbol === 'MES')?.price || 0
  if (mesPrice <= 0) {
    throw new Error('AI overlay unavailable: MES spot price is missing.')
  }

  const timeframeGauges: TimeframeGauge[] = rawGauges.map(raw => {
    const bias = applyVixBias(raw.direction, raw.confidence, vixLevel)
    const adjustedRaw: RawGaugeSnapshot = {
      ...raw,
      direction: bias.direction,
      confidence: bias.confidence,
    }
    const aiGauge = parsed.timeframeGauges?.find(g => g.timeframe === raw.timeframe)
    const normalized = normalizeAiGaugeLevels(
      adjustedRaw,
      aiGauge,
      mesPrice,
    )
    return {
      ...adjustedRaw,
      entry: normalized.entry,
      stop: normalized.stop,
      target: normalized.target,
      reasoning: `${bias.note ? `${bias.note} ` : ''}${normalized.reasoning}`,
    }
  })

  const parsedSymbols = Array.isArray(parsed.symbols) ? parsed.symbols : []
  const parsedBySymbol = new Map(parsedSymbols.map((s) => [s.symbol, s]))
  const mergedSymbols = signalData.map((signalSnapshot) => {
    return normalizeAiSymbol(parsedBySymbol.get(signalSnapshot.symbol), signalSnapshot, vixLevel)
  })

  const overallConfidenceRaw = Math.round(
    requireFiniteNumber(parsed.overallConfidence, 'overallConfidence'),
  )
  if (overallConfidenceRaw < 50 || overallConfidenceRaw > 95) {
    throw new Error('AI overlay unavailable: overallConfidence must be between 50 and 95.')
  }

  const overallBias = applyVixBias(
    parseDirection(parsed.overallVerdict, 'overallVerdict'),
    overallConfidenceRaw,
    vixLevel
  )
  const overallVerdict = overallBias.direction
  const overallConfidence = overallBias.confidence
  const narrativeRaw = requireString(parsed.narrative, 'narrative')
  const narrative = `${overallBias.note ? `${overallBias.note} ` : ''}${narrativeRaw}`

  return {
    timestamp: new Date().toISOString(),
    overallVerdict,
    overallConfidence,
    narrative,
    timeframeGauges,
    symbols: mergedSymbols,
    totalSignalsAnalysed: grandTotal,
    chartData,
    marketContext: {
      regime: marketContext.regime,
      regimeFactors: marketContext.regimeFactors,
      correlations: marketContext.correlations,
      headlines: marketContext.headlines,
      goldContext: marketContext.goldContext,
      oilContext: marketContext.oilContext,
      yieldContext: marketContext.yieldContext,
      techLeaders: marketContext.techLeaders,
      themeScores: marketContext.themeScores,
      shockReactions: marketContext.shockReactions,
      breakout7000: marketContext.breakout7000,
    },
  }
}
