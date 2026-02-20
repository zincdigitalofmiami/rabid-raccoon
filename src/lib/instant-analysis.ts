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

import OpenAI from 'openai'
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

function getAnalysisModelCandidates(): string[] {
  const fromEnv = (process.env.OPENAI_ANALYSIS_MODEL || '').trim()
  const candidates = [
    fromEnv,
    'gpt-5.2-pro',
    'gpt-5-pro',
    'gpt-5.2',
    'gpt-5.1',
    'gpt-5',
  ].filter(Boolean)
  return [...new Set(candidates)]
}

async function requestAnalysisOverlay(prompt: string): Promise<AnalysisAiResponse> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set')
  }

  const client = new OpenAI({ apiKey })
  const models = getAnalysisModelCandidates()
  let lastError: unknown = null

  for (const model of models) {
    try {
      const response = await client.responses.create({
        model,
        input: prompt,
        max_output_tokens: 3000,
      })

      const text = response.output_text?.trim()
      if (!text) {
        throw new Error(`OpenAI returned empty text for model ${model}`)
      }

      try {
        return JSON.parse(text) as AnalysisAiResponse
      } catch {
        const m = text.match(/\{[\s\S]*\}/)
        if (!m) {
          throw new Error(`Failed to parse JSON from model ${model}`)
        }
        return JSON.parse(m[0]) as AnalysisAiResponse
      }
    } catch (error) {
      lastError = error
      const msg = error instanceof Error ? error.message : String(error)
      const isModelIssue =
        /model|not found|does not exist|unsupported|permission|access/i.test(msg)
      const isParseIssue = /parse json|failed to parse|expected .*json|unexpected token/i.test(msg)

      if (!isModelIssue && !isParseIssue) {
        throw error
      }
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`OpenAI analysis request failed for all candidate models: ${msg}`)
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
  // CM Ultimate MACD (ChrisMoody CM_MacD_Ult_MTF) — 3 signals
  // fast=12, slow=26, signal=SMA-9. Histogram 4-color state.
  if (closes.length >= 26 + 9) {
    const macdArr: number[] = []
    for (let i = 0; i < closes.length; i++) {
      const f = ema(closes.slice(0, i + 1), 12)
      const s = ema(closes.slice(0, i + 1), 26)
      if (f != null && s != null) macdArr.push(f - s)
    }
    if (macdArr.length >= 9) {
      const macdLine = macdArr[macdArr.length - 1]
      const sigVal = macdArr.slice(-9).reduce((a, b) => a + b, 0) / 9
      const hist = macdLine - sigVal
      const histPrev = macdArr.length >= 2
        ? macdArr[macdArr.length - 2] - (macdArr.slice(-10, -1).reduce((a, b) => a + b, 0) / 9)
        : hist
      const histRising = hist > histPrev
      // Signal 1: MACD line vs zero
      check(`CM-MACD line ${macdLine > 0 ? 'above' : 'below'} zero (${macdLine.toFixed(2)})`, macdLine > 0)
      // Signal 2: MACD line vs signal line (color: lime=above, red=below)
      check(`CM-MACD ${macdLine >= sigVal ? '>' : '<'} signal (${sigVal.toFixed(2)})`, macdLine >= sigVal)
      // Signal 3: histogram direction (aqua/maroon=rising, blue/red=falling)
      check(`CM-MACD hist ${histRising ? 'rising' : 'falling'} (${hist.toFixed(2)})`, histRising)
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

interface MesLevels {
  entry: number
  stop: number
  target: number
  source: 'MEASURED_MOVE' | 'DETERMINISTIC_FALLBACK'
}

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

function selectMesMeasuredMove(
  measuredMoves: MeasuredMove[],
  direction: 'BUY' | 'SELL'
): MeasuredMove | null {
  if (measuredMoves.length === 0) return null
  const wantedDirection = direction === 'BUY' ? 'BULLISH' : 'BEARISH'
  return (
    measuredMoves.find((m) => m.status === 'ACTIVE' && m.direction === wantedDirection) ||
    measuredMoves.find((m) => m.direction === wantedDirection) ||
    measuredMoves.find((m) => m.status === 'ACTIVE') ||
    measuredMoves[0] ||
    null
  )
}

function computeMesLevels(
  timeframe: TimeframeLabel,
  mesTimeframe: MesTimeframeSnapshot,
  mesPrice: number,
  direction: 'BUY' | 'SELL',
  vixLevel: number | null
): MesLevels {
  const mesMove = selectMesMeasuredMove(mesTimeframe.measuredMoves, direction)
  if (
    mesMove &&
    ((direction === 'BUY' && mesMove.direction === 'BULLISH') ||
      (direction === 'SELL' && mesMove.direction === 'BEARISH'))
  ) {
    return {
      entry: mesMove.entry,
      stop: mesMove.stop,
      target: mesMove.target,
      source: 'MEASURED_MOVE',
    }
  }

  const atrValue = atr(mesTimeframe.candles, 14)
  const baseRisk =
    atrValue != null && Number.isFinite(atrValue) && atrValue > 0
      ? Math.max(atrValue * 0.85, mesPrice * 0.0008, 1.5)
      : Math.max(mesPrice * 0.0012, 1.5)

  const riskMultiplierByTf: Record<TimeframeLabel, number> = {
    '15M': 1,
    '1H': 1.5,
    '4H': 2.2,
  }
  const rewardMultiplierByTf: Record<TimeframeLabel, number> = {
    '15M': 1.8,
    '1H': 2.0,
    '4H': 2.2,
  }
  const vixRegime = classifyVixRegime(vixLevel)
  const riskMultiplierByVix: Record<VixRegime, number> = {
    LOW: 0.9,
    MODERATE: 1.0,
    HIGH: 1.25,
  }
  const rewardMultiplierByVix: Record<VixRegime, number> = {
    LOW: 1.08,
    MODERATE: 1.0,
    HIGH: 0.92,
  }
  const entryOffsetByVix: Record<VixRegime, number> = {
    LOW: 0.9,
    MODERATE: 1.0,
    HIGH: 1.3,
  }

  const risk = baseRisk * riskMultiplierByTf[timeframe] * riskMultiplierByVix[vixRegime]
  const reward = risk * rewardMultiplierByTf[timeframe] * rewardMultiplierByVix[vixRegime]
  const entryOffsetMultiplierByTf: Record<TimeframeLabel, number> = {
    '15M': 0.2,
    '1H': 0.28,
    '4H': 0.38,
  }
  const entryOffset = Math.max(
    risk * entryOffsetMultiplierByTf[timeframe] * entryOffsetByVix[vixRegime],
    mesPrice * 0.00004,
    0.25
  )

  if (direction === 'BUY') {
    const entry = mesPrice - entryOffset
    return {
      entry,
      stop: entry - risk,
      target: entry + reward,
      source: 'DETERMINISTIC_FALLBACK',
    }
  }
  const entry = mesPrice + entryOffset
  return {
    entry,
    stop: entry + risk,
    target: entry - reward,
    source: 'DETERMINISTIC_FALLBACK',
  }
}

function calcRiskReward(entry: number, stop: number, target: number): number {
  const risk = Math.abs(entry - stop)
  if (risk <= 0) return 0
  const reward = Math.abs(target - entry)
  return Number((reward / risk).toFixed(2))
}

function computeAtrSymbolLevels(
  candles: CandleData[],
  symbolPrice: number,
  verdict: 'BUY' | 'SELL',
  vixLevel: number | null
): { entry: number; stop: number; target1: number; target2: number; riskReward: number } {
  const atrValue = atr(candles, 14)
  const vixRegime = classifyVixRegime(vixLevel)
  const baseRisk =
    atrValue != null && Number.isFinite(atrValue) && atrValue > 0
      ? Math.max(atrValue * 0.85, symbolPrice * 0.0008, 0.2)
      : Math.max(symbolPrice * 0.0012, 0.2)

  const riskMultiplierByVix: Record<VixRegime, number> = {
    LOW: 0.9,
    MODERATE: 1.0,
    HIGH: 1.2,
  }
  const rewardMultiplierByVix: Record<VixRegime, number> = {
    LOW: 2.1,
    MODERATE: 2.0,
    HIGH: 1.85,
  }
  const entryOffsetByVix: Record<VixRegime, number> = {
    LOW: 0.9,
    MODERATE: 1.0,
    HIGH: 1.25,
  }

  const risk = baseRisk * riskMultiplierByVix[vixRegime]
  const reward1 = risk * rewardMultiplierByVix[vixRegime]
  const entryOffset = Math.max(
    risk * 0.22 * entryOffsetByVix[vixRegime],
    symbolPrice * 0.00006,
    0.2
  )

  if (verdict === 'BUY') {
    const entry = symbolPrice - entryOffset
    const stop = entry - risk
    const target1 = entry + reward1
    const target2 = target1 + reward1 * 0.45
    return {
      entry,
      stop,
      target1,
      target2,
      riskReward: calcRiskReward(entry, stop, target1),
    }
  }

  const entry = symbolPrice + entryOffset
  const stop = entry + risk
  const target1 = entry - reward1
  const target2 = target1 - reward1 * 0.45
  return {
    entry,
    stop,
    target1,
    target2,
    riskReward: calcRiskReward(entry, stop, target1),
  }
}

function getMesReasonPrefix(
  timeframe: TimeframeLabel,
  source: MesLevels['source']
): string {
  return source === 'MEASURED_MOVE'
    ? `Deterministic ${timeframe} MES measured move`
    : `Deterministic ${timeframe} MES ATR levels`
}

function formatMesLevelsReason(timeframe: TimeframeLabel, levels: MesLevels): string {
  return `${getMesReasonPrefix(timeframe, levels.source)}: entry ${levels.entry.toFixed(2)}, stop ${levels.stop.toFixed(2)}, target ${levels.target.toFixed(2)}.`
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

function normalizeAiGaugeLevels(
  raw: RawGaugeSnapshot,
  aiGauge: AnalysisAiResponse['timeframeGauges'][number] | undefined,
  mesTimeframes: MesTimeframes,
  mesPrice: number,
  vixLevel: number | null
): { entry: number; stop: number; target: number; reasoning: string } {
  const fallback = computeMesLevels(
    raw.timeframe,
    mesTimeframes[raw.timeframe],
    mesPrice,
    raw.direction,
    vixLevel
  )
  const fallbackReason = formatMesLevelsReason(raw.timeframe, fallback)

  const entry = toFiniteNumber(aiGauge?.entry)
  const stop = toFiniteNumber(aiGauge?.stop)
  const target = toFiniteNumber(aiGauge?.target)

  if (entry == null || stop == null || target == null) {
    return {
      entry: fallback.entry,
      stop: fallback.stop,
      target: fallback.target,
      reasoning: fallbackReason,
    }
  }

  if (!isDirectionalLevelOrder(raw.direction, entry, stop, target)) {
    return {
      entry: fallback.entry,
      stop: fallback.stop,
      target: fallback.target,
      reasoning: fallbackReason,
    }
  }

  const directionalBuffer = Math.max(
    Math.abs(fallback.entry - mesPrice) * 0.5,
    mesPrice * 0.00008,
    0.5
  )
  const violatesDirectionalSide =
    (raw.direction === 'BUY' && entry >= mesPrice - directionalBuffer) ||
    (raw.direction === 'SELL' && entry <= mesPrice + directionalBuffer)

  if (violatesDirectionalSide) {
    return {
      entry: fallback.entry,
      stop: fallback.stop,
      target: fallback.target,
      reasoning: fallbackReason,
    }
  }

  return {
    entry,
    stop,
    target,
    reasoning: aiGauge?.reasoning?.trim() || fallbackReason,
  }
}

function normalizeVerdict(value: unknown, fallback: 'BUY' | 'SELL'): 'BUY' | 'SELL' {
  if (value === 'BUY' || value === 'SELL') return value
  return fallback
}

function normalizeAiSymbol(
  aiSymbol: AnalysisAiResponse['symbols'][number] | undefined,
  fallback: InstantSymbolResult,
  symbolPrice: number,
  vixLevel: number | null
): InstantSymbolResult {
  if (!aiSymbol) return fallback

  const verdict = normalizeVerdict(aiSymbol.verdict, normalizeVerdict(fallback.verdict, 'BUY'))
  const confidenceRaw = toFiniteNumber(aiSymbol.confidence)
  const confidence = confidenceRaw == null
    ? fallback.confidence
    : Math.max(50, Math.min(95, Math.round(confidenceRaw)))

  const entry = toFiniteNumber(aiSymbol.entry)
  const stop = toFiniteNumber(aiSymbol.stop)
  const target1 = toFiniteNumber(aiSymbol.target1)
  const target2 = toFiniteNumber(aiSymbol.target2)

  const hasDirectionalOrder =
    entry != null &&
    stop != null &&
    target1 != null &&
    isDirectionalLevelOrder(verdict, entry, stop, target1)

  const directionalBuffer = Math.max(symbolPrice * 0.00008, 0.5)
  const validDirectionalSide =
    entry != null &&
    ((verdict === 'BUY' && entry < symbolPrice - directionalBuffer) ||
      (verdict === 'SELL' && entry > symbolPrice + directionalBuffer))

  const mesVixHardShort =
    fallback.symbol === 'MES' &&
    vixLevel != null &&
    vixLevel >= 20 &&
    verdict === 'BUY'
  if (mesVixHardShort) {
    return {
      ...fallback,
      reasoning: `VIX ${vixLevel.toFixed(2)} >= 20.00 hard short filter applied. ${fallback.reasoning}`,
    }
  }

  if (!hasDirectionalOrder || !validDirectionalSide) {
    return {
      ...fallback,
      reasoning: fallback.reasoning,
    }
  }

  const normalizedTarget2 = target2 != null
    ? (verdict === 'BUY' ? Math.max(target2, target1) : Math.min(target2, target1))
    : target1

  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target1 - entry)
  const rr = risk > 0 ? reward / risk : 0

  return {
    symbol: aiSymbol.symbol || fallback.symbol,
    verdict,
    confidence,
    entry,
    stop,
    target1,
    target2: normalizedTarget2,
    riskReward: Number.isFinite(rr) ? Number(rr.toFixed(2)) : fallback.riskReward,
    reasoning: aiSymbol.reasoning?.trim() || fallback.reasoning,
    signalBreakdown: fallback.signalBreakdown,
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

function buildDeterministicTimeframeGauges(
  rawGauges: RawGaugeSnapshot[],
  mesTimeframes: MesTimeframes,
  mesPrice: number,
  vixLevel: number | null
): TimeframeGauge[] {
  return rawGauges.map(raw => {
    const bias = applyVixBias(raw.direction, raw.confidence, vixLevel)
    const adjustedRaw: RawGaugeSnapshot = {
      ...raw,
      direction: bias.direction,
      confidence: bias.confidence,
    }
    const levels = computeMesLevels(
      adjustedRaw.timeframe,
      mesTimeframes[adjustedRaw.timeframe],
      mesPrice,
      adjustedRaw.direction,
      vixLevel
    )
    return {
      ...adjustedRaw,
      entry: levels.entry,
      stop: levels.stop,
      target: levels.target,
      reasoning: `${bias.note ? `${bias.note} ` : ''}${formatMesLevelsReason(adjustedRaw.timeframe, levels)}`,
    }
  })
}

function buildDeterministicSymbols(
  signalData: SymbolSignalSnapshot[],
  mesTimeframes: MesTimeframes,
  vixLevel: number | null
): InstantSymbolResult[] {
  const mes = signalData.find((s) => s.symbol === 'MES')
  const mesPrice = mes?.price || 0
  return signalData.map((s) => {
    const primary = s.breakdown.find((b) => b.tfLabel === '15M') || s.breakdown[0]
    if (!primary) {
      return {
        symbol: s.symbol,
        verdict: 'BUY',
        confidence: 50,
        entry: s.price,
        stop: 0,
        target1: 0,
        target2: 0,
        riskReward: 0,
        reasoning: 'Insufficient candles for deterministic signal breakdown.',
        signalBreakdown: [],
      }
    }

    const voting = primary.signals.buy + primary.signals.sell
    let verdict: 'BUY' | 'SELL' =
      primary.signals.buy >= primary.signals.sell ? 'BUY' : 'SELL'
    let confidence = voting > 0
      ? Math.round((Math.max(primary.signals.buy, primary.signals.sell) / voting) * 100)
      : 50
    const mesBias = s.symbol === 'MES' ? applyVixBias(verdict, confidence, vixLevel) : null
    if (mesBias) {
      verdict = mesBias.direction
      confidence = mesBias.confidence
    }
    const rationale = verdict === 'BUY'
      ? (primary.signals.buySignals.slice(0, 2).join(' | ') || 'Buy votes exceeded sell votes.')
      : (primary.signals.sellSignals.slice(0, 2).join(' | ') || 'Sell votes exceeded buy votes.')
    const mesLevels = s.symbol === 'MES'
      ? computeMesLevels('15M', mesTimeframes['15M'], mesPrice || s.price, verdict, vixLevel)
      : null
    const fallbackLevels = s.symbol === 'MES' && mesLevels
      ? (() => {
        const target2 =
          verdict === 'BUY'
            ? mesLevels.target + Math.abs(mesLevels.target - mesLevels.entry) * 0.45
            : mesLevels.target - Math.abs(mesLevels.target - mesLevels.entry) * 0.45
        return {
          entry: mesLevels.entry,
          stop: mesLevels.stop,
          target1: mesLevels.target,
          target2,
          riskReward: calcRiskReward(mesLevels.entry, mesLevels.stop, mesLevels.target),
        }
      })()
      : computeAtrSymbolLevels(s.candles15m, s.price, verdict, vixLevel)
    const levelReason =
      s.symbol === 'MES' && mesLevels
        ? `MES ${mesLevels.source === 'MEASURED_MOVE' ? 'measured move' : 'fallback'} levels applied.`
        : 'ATR-derived deterministic levels applied.'

    return {
      symbol: s.symbol,
      verdict,
      confidence,
      entry: fallbackLevels.entry,
      stop: fallbackLevels.stop,
      target1: fallbackLevels.target1,
      target2: fallbackLevels.target2,
      riskReward: fallbackLevels.riskReward,
      reasoning:
        `${mesBias?.note ? `${mesBias.note} ` : ''}Deterministic ${primary.tfLabel} vote: ` +
        `${primary.signals.buy}B/${primary.signals.sell}S/${primary.signals.neutral}N. ` +
        `${levelReason} ${rationale}`,
      signalBreakdown: s.breakdown.map((b) => ({
        tf: b.tf,
        buy: b.signals.buy,
        sell: b.signals.sell,
        neutral: b.signals.neutral,
        total: b.signals.total,
      })),
    }
  })
}

export function runDeterministicAnalysis(
  allData: Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles4h: CandleData[]; price: number }>,
  symbolNames: Map<string, string>,
  marketContext: MarketContext,
): InstantAnalysisResult {
  const core = buildAnalysisCore(allData, symbolNames)
  const vixLevel = vixLevelFromSignalData(core.signalData)
  const mesPrice = core.signalData.find((s) => s.symbol === 'MES')?.price || 0
  const timeframeGauges = buildDeterministicTimeframeGauges(
    core.rawGauges,
    core.mesTimeframes,
    mesPrice,
    vixLevel
  )
  const symbols = buildDeterministicSymbols(core.signalData, core.mesTimeframes, vixLevel)
  const leadGauge = timeframeGauges.find((g) => g.timeframe === '15M') || timeframeGauges[0]

  const overallVerdict = leadGauge?.direction || 'BUY'
  const overallConfidence = leadGauge?.confidence ?? 50
  const narrative =
    `Deterministic signal-only mode. MES ${leadGauge?.timeframe || 'N/A'} vote is ` +
    `${leadGauge?.direction || 'NEUTRAL'} at ${overallConfidence}% confidence. ` +
    `${formatVixSnapshot(vixLevel)}. ` +
    `Regime: ${marketContext.regime}. ${marketContext.regimeFactors.slice(0, 2).join(' ')}`

  return {
    timestamp: new Date().toISOString(),
    overallVerdict,
    overallConfidence,
    narrative,
    timeframeGauges,
    symbols,
    totalSignalsAnalysed: core.grandTotal,
    chartData: core.chartData,
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

export async function runInstantAnalysis(
  allData: Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles4h: CandleData[]; price: number }>,
  symbolNames: Map<string, string>,
  marketContext: MarketContext,
): Promise<InstantAnalysisResult> {
  const core = buildAnalysisCore(allData, symbolNames)
  const { signalData, rawGauges, grandTotal, chartData, mesTimeframes } = core
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
    const msg = error instanceof Error ? error.message : 'AI overlay unavailable'
    const publicMsg = /openai_api_key|api key|not set/i.test(msg)
      ? 'AI overlay disabled in this environment.'
      : 'AI overlay unavailable.'
    const deterministic = runDeterministicAnalysis(allData, symbolNames, marketContext)
    return {
      ...deterministic,
      narrative: `${deterministic.narrative} ${publicMsg}`,
      chartData,
      totalSignalsAnalysed: grandTotal,
    }
  }
  if (!parsed) {
    const deterministic = runDeterministicAnalysis(allData, symbolNames, marketContext)
    return {
      ...deterministic,
      chartData,
      totalSignalsAnalysed: grandTotal,
    }
  }

  // Step 4: Merge raw signal data with AI levels
  const mesPrice = signalData.find((s) => s.symbol === 'MES')?.price || 0
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
      mesTimeframes,
      mesPrice,
      vixLevel
    )
    return {
      ...adjustedRaw,
      entry: normalized.entry,
      stop: normalized.stop,
      target: normalized.target,
      reasoning: `${bias.note ? `${bias.note} ` : ''}${normalized.reasoning}`,
    }
  })

  const fallbackSymbols = buildDeterministicSymbols(signalData, mesTimeframes, vixLevel)
  const signalBySymbol = new Map(signalData.map((s) => [s.symbol, s]))
  const parsedSymbols = Array.isArray(parsed.symbols) ? parsed.symbols : []
  const parsedBySymbol = new Map(parsedSymbols.map((s) => [s.symbol, s]))
  const mergedSymbols = fallbackSymbols.map((fallback) => {
    const signalSnapshot = signalBySymbol.get(fallback.symbol)
    const symbolPrice = signalSnapshot?.price || fallback.entry || 0
    return normalizeAiSymbol(parsedBySymbol.get(fallback.symbol), fallback, symbolPrice, vixLevel)
  })

  const overallBias = applyVixBias(
    normalizeVerdict(parsed.overallVerdict, 'BUY'),
    toFiniteNumber(parsed.overallConfidence) ?? 50,
    vixLevel
  )
  const overallVerdict = overallBias.direction
  const overallConfidence = overallBias.confidence
  const narrative = `${overallBias.note ? `${overallBias.note} ` : ''}${parsed.narrative}`

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
