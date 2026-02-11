/**
 * Instant Multi-Timeframe Analysis Engine
 *
 * Computes 200+ technical signals across 15M, 1H, 4H timeframes.
 * Signal directions come from RAW MATH — fully transparent.
 * Claude AI provides entry/stop/target levels and narrative.
 *
 * Every signal is exposed: you see exactly WHY each timeframe
 * says BUY or SELL. No black boxes.
 */

import Anthropic from '@anthropic-ai/sdk'
import { CandleData } from './types'
import { detectSwings } from './swing-detection'
import { calculateFibonacci } from './fibonacci'
import { detectMeasuredMoves } from './measured-move'

const client = new Anthropic()

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

function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gains += d; else losses -= d
  }
  if (losses === 0) return 100
  return 100 - 100 / (1 + (gains / period) / (losses / period))
}

function stochastic(candles: CandleData[], k = 14): number | null {
  if (candles.length < k) return null
  const r = candles.slice(-k)
  const hi = Math.max(...r.map(c => c.high))
  const lo = Math.min(...r.map(c => c.low))
  return hi === lo ? 50 : ((r[r.length - 1].close - lo) / (hi - lo)) * 100
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

interface SignalSummary {
  buy: number
  sell: number
  neutral: number
  total: number
  buySignals: string[]
  sellSignals: string[]
}

function computeSignals(candles: CandleData[]): SignalSummary {
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
  // RSI (3 signals)
  for (const p of [7, 14, 21]) {
    const v = rsi(closes, p)
    if (v != null) {
      const label = v > 70 ? 'overbought' : v < 30 ? 'oversold' : v > 50 ? 'bullish' : 'bearish'
      check(`RSI(${p}) = ${v.toFixed(1)} [${label}]`, v > 70 ? false : v < 30 ? true : v > 50)
    } else neutral++
  }
  // Stochastic (3 signals)
  for (const p of [9, 14, 21]) {
    const v = stochastic(candles, p)
    if (v != null) {
      const label = v > 80 ? 'overbought' : v < 20 ? 'oversold' : v > 50 ? 'bullish' : 'bearish'
      check(`Stoch(${p}) = ${v.toFixed(1)} [${label}]`, v > 80 ? false : v < 20 ? true : v > 50)
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
  // MACD (2 signals)
  const e12 = ema(closes, 12), e26 = ema(closes, 26)
  if (e12 && e26) {
    const macdLine = e12 - e26
    check(`MACD line = ${macdLine.toFixed(2)} [${macdLine > 0 ? 'above' : 'below'} zero]`, macdLine > 0)
    // MACD vs signal
    const macdArr = closes.map((_, i) => {
      const e12v = ema(closes.slice(0, i + 1), 12)
      const e26v = ema(closes.slice(0, i + 1), 26)
      return e12v && e26v ? e12v - e26v : 0
    })
    const sig = ema(macdArr, 9)
    if (sig != null) check(`MACD ${macdLine > sig ? '>' : '<'} signal`, macdLine > sig)
    else neutral++
  } else { neutral += 2 }

  // ATR expansion (1 signal)
  const a7 = atr(candles, 7), a14 = atr(candles, 14)
  if (a7 && a14) check(`ATR(7)=${a7.toFixed(2)} ${a7 > a14 ? '>' : '<'} ATR(14)=${a14.toFixed(2)} [${a7 > a14 ? 'expanding' : 'contracting'}]`, a7 > a14)
  else neutral++

  // VWAP (1 signal)
  const vwapVal = vwap(candles)
  if (vwapVal) check(`Price ${price > vwapVal ? '>' : '<'} VWAP @ ${vwapVal.toFixed(2)}`, price > vwapVal)
  else neutral++

  // --- Structure ---
  // Fibonacci (2 signals)
  const { highs, lows } = detectSwings(candles, 5, 5, 20)
  const fib = calculateFibonacci(highs, lows)
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

export interface InstantAnalysisResult {
  timestamp: string
  overallVerdict: string
  overallConfidence: number
  narrative: string
  timeframeGauges: TimeframeGauge[]
  symbols: InstantSymbolResult[]
  totalSignalsAnalysed: number
}

// --- Main entry ---

export async function runInstantAnalysis(
  allData: Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles4h: CandleData[]; price: number }>,
  symbolNames: Map<string, string>,
): Promise<InstantAnalysisResult> {
  // Step 1: Compute raw signals for every symbol x timeframe
  const signalData: {
    symbol: string
    displayName: string
    price: number
    breakdown: { tf: string; tfLabel: '15M' | '1H' | '4H'; signals: SignalSummary }[]
  }[] = []
  let grandTotal = 0

  // Track MES signals per timeframe for the 3 gauges
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
    signalData.push({ symbol, displayName: symbolNames.get(symbol) || symbol, price: data.price, breakdown })
  }

  // Step 2: Build gauges from RAW signals — direction is pure math, not AI
  const rawGauges = mesGaugeData.map(g => ({
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

  // Step 3: Build Claude prompt — ask for levels + reasoning that references SPECIFIC signals
  const signalLines = signalData.map(s => {
    const bdown = s.breakdown.map(b =>
      `  ${b.tf.toUpperCase()}: ${b.signals.buy}B / ${b.signals.sell}S / ${b.signals.neutral}N = ${b.signals.total} signals\n` +
      `    BUY signals: ${b.signals.buySignals.join(' | ')}\n` +
      `    SELL signals: ${b.signals.sellSignals.join(' | ')}`
    ).join('\n')
    return `${s.displayName} @ ${s.price.toFixed(2)}:\n${bdown}`
  }).join('\n\n')

  const gaugeLines = rawGauges.map(g =>
    `  ${g.timeframe}: ${g.direction} — ${g.buyCount} buy vs ${g.sellCount} sell = ${g.confidence}% confidence`
  ).join('\n')

  const prompt = `You are an elite futures day trader. I hit "ANALYSE NOW" — give me an INSTANT, no-bullshit verdict.

${grandTotal} TECHNICAL SIGNALS computed across 15M / 1H / 4H for MES, NQ, VIX, DXY:

${signalLines}

RAW SIGNAL GAUGES (MES — direction from pure math):
${gaugeLines}

YOUR TASK: Based on these EXACT signals, provide entry/stop/target levels for each timeframe. Reference the SPECIFIC signals by name.

RESPOND WITH JSON ONLY (no markdown, no code fences):
{
  "overallVerdict": "BUY" or "SELL",
  "overallConfidence": number 55-95,
  "narrative": "3-4 sentences. Reference SPECIFIC indicator values (e.g. 'RSI(14)=62 confirms bullish momentum', 'SMA(20) at 5832 acting as support'). Explain the confluence. Talk like a trader.",
  "timeframeGauges": [
    {
      "timeframe": "15M",
      "entry": exact_MES_price,
      "stop": exact_MES_price,
      "target": exact_MES_price,
      "reasoning": "2 sentences max. Name the SPECIFIC indicators that drive this timeframe: which MAs, what RSI value, what fib level, what measured move."
    },
    {
      "timeframe": "1H",
      "entry": exact_MES_price,
      "stop": exact_MES_price,
      "target": exact_MES_price,
      "reasoning": "2 sentences. Name specific indicators."
    },
    {
      "timeframe": "4H",
      "entry": exact_MES_price,
      "stop": exact_MES_price,
      "target": exact_MES_price,
      "reasoning": "2 sentences. Name specific indicators."
    }
  ],
  "symbols": [
    {
      "symbol": "MES",
      "verdict": "BUY" or "SELL",
      "confidence": number,
      "entry": exact_price,
      "stop": exact_price,
      "target1": exact_price,
      "target2": exact_price,
      "riskReward": number,
      "reasoning": "1 sentence referencing specific signals"
    }
  ]
}

CRITICAL: Only include MES, NQ, VX, DX in symbols array. Entry/stop/target must be realistic price levels based on the signal data provided.`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('')

  let parsed: {
    overallVerdict: string
    overallConfidence: number
    narrative: string
    timeframeGauges: { timeframe: string; entry: number; stop: number; target: number; reasoning: string }[]
    symbols: { symbol: string; verdict: string; confidence: number; entry: number; stop: number; target1: number; target2: number; riskReward: number; reasoning: string }[]
  }

  try {
    parsed = JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
    else throw new Error('Failed to parse AI response')
  }

  // Step 4: Merge raw signal data with Claude's levels
  const timeframeGauges: TimeframeGauge[] = rawGauges.map(raw => {
    const claudeGauge = parsed.timeframeGauges?.find(g => g.timeframe === raw.timeframe)
    return {
      ...raw,
      entry: claudeGauge?.entry || 0,
      stop: claudeGauge?.stop || 0,
      target: claudeGauge?.target || 0,
      reasoning: claudeGauge?.reasoning || '',
    }
  })

  return {
    timestamp: new Date().toISOString(),
    overallVerdict: parsed.overallVerdict,
    overallConfidence: parsed.overallConfidence,
    narrative: parsed.narrative,
    timeframeGauges,
    symbols: parsed.symbols.map(s => ({
      ...s,
      signalBreakdown: signalData.find(d => d.symbol === s.symbol)?.breakdown.map(b => ({
        tf: b.tf, buy: b.signals.buy, sell: b.signals.sell, neutral: b.signals.neutral, total: b.signals.total,
      })) || [],
    })),
    totalSignalsAnalysed: grandTotal,
  }
}
