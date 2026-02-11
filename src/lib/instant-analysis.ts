/**
 * Instant Multi-Timeframe Analysis Engine
 *
 * Computes 200+ technical signals across 15M, 1H, 1D timeframes,
 * then feeds the signal summary to Claude for an AI-driven instant verdict:
 * "Where is this going in the next 15 minutes?"
 *
 * Returns BUY/SELL with exact entry, stop, targets.
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

// --- Signal computation ---

interface SignalSummary {
  buy: number
  sell: number
  neutral: number
  total: number
  details: string[]
}

function computeSignals(candles: CandleData[], tf: string): SignalSummary {
  const closes = candles.map(c => c.close)
  const price = closes[closes.length - 1]
  let buy = 0, sell = 0, neutral = 0
  const details: string[] = []

  const check = (name: string, isBuy: boolean | null) => {
    if (isBuy === null) { neutral++; return }
    if (isBuy) { buy++; details.push(`${name}: BUY`) } else { sell++; details.push(`${name}: SELL`) }
  }

  // 12 SMA signals
  for (const p of [5, 10, 20, 50, 100, 200]) {
    const v = sma(closes, p)
    if (v) check(`SMA(${p})`, price > v); else neutral++
  }
  // 12 EMA signals
  for (const p of [5, 10, 20, 50, 100, 200]) {
    const v = ema(closes, p)
    if (v) check(`EMA(${p})`, price > v); else neutral++
  }
  // 11 SMA/EMA crossovers
  const pairs = [[5,10],[5,20],[10,20],[20,50],[50,100],[50,200]]
  for (const [a,b] of pairs) {
    const sa = sma(closes, a), sb = sma(closes, b)
    if (sa && sb) check(`SMA(${a}/${b})`, sa > sb); else neutral++
  }
  for (const [a,b] of [[5,10],[10,20],[20,50],[50,100],[50,200]]) {
    const ea = ema(closes, a), eb = ema(closes, b)
    if (ea && eb) check(`EMA(${a}/${b})`, ea > eb); else neutral++
  }
  // 3 RSI
  for (const p of [7, 14, 21]) {
    const v = rsi(closes, p)
    if (v != null) check(`RSI(${p})=${v.toFixed(0)}`, v > 70 ? false : v < 30 ? true : v > 50); else neutral++
  }
  // 3 Stochastic
  for (const p of [9, 14, 21]) {
    const v = stochastic(candles, p)
    if (v != null) check(`Stoch(${p})=${v.toFixed(0)}`, v > 80 ? false : v < 20 ? true : v > 50); else neutral++
  }
  // 2 Bollinger
  for (const p of [10, 20]) {
    const v = bollingerPos(closes, p)
    if (v != null) check(`BB(${p})=${(v*100).toFixed(0)}%`, v > 0.8 ? false : v < 0.2 ? true : v > 0.5); else neutral++
  }
  // MACD
  const e12 = ema(closes, 12), e26 = ema(closes, 26)
  if (e12 && e26) check(`MACD`, e12 > e26); else neutral++
  // ATR expansion
  const a7 = atr(candles, 7), a14 = atr(candles, 14)
  if (a7 && a14) check(`ATR_expansion`, a7 > a14); else neutral++

  // Fib
  const { highs, lows } = detectSwings(candles, 5, 5, 20)
  const fib = calculateFibonacci(highs, lows)
  if (fib) {
    check('Fib_trend', fib.isBullish)
    const range = fib.anchorHigh - fib.anchorLow
    const pos = range > 0 ? (price - fib.anchorLow) / range : 0.5
    check('Fib_position', pos > 0.618 ? true : pos < 0.382 ? false : null)
  }
  // Measured moves
  const mms = detectMeasuredMoves(highs, lows, price)
  for (const mm of mms.filter(m => m.status === 'ACTIVE')) {
    check(`AB=CD_${mm.direction}_Q${mm.quality}`, mm.direction === 'BULLISH')
  }
  // Swing structure
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[0].price > highs[1].price
    const hl = lows[0].price > lows[1].price
    check('Swing_structure', hh && hl ? true : (!hh && !hl) ? false : null)
  }
  // Price vs session
  if (candles.length > 1) {
    check('Price_vs_open', price > candles[0].open)
    const hi = Math.max(...candles.map(c => c.high))
    const lo = Math.min(...candles.map(c => c.low))
    const pos = hi > lo ? (price - lo) / (hi - lo) : 0.5
    check('Range_position', pos > 0.6 ? true : pos < 0.4 ? false : null)
  }

  return { buy, sell, neutral, total: buy + sell + neutral, details }
}

// --- Public types ---

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
  symbols: InstantSymbolResult[]
  totalSignalsAnalysed: number
}

// --- Main entry ---

export async function runInstantAnalysis(
  allData: Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles1d: CandleData[]; price: number }>,
  symbolNames: Map<string, string>,
): Promise<InstantAnalysisResult> {
  // Step 1: Compute raw signals for every symbol x timeframe
  const signalData: { symbol: string; displayName: string; price: number; breakdown: { tf: string; buy: number; sell: number; neutral: number; total: number; topSignals: string[] }[] }[] = []
  let grandTotal = 0

  for (const [symbol, data] of allData.entries()) {
    const tfs: { tf: string; candles: CandleData[] }[] = [
      { tf: '15m', candles: data.candles15m },
      { tf: '1h', candles: data.candles1h },
      { tf: '1d', candles: data.candles1d },
    ]
    const breakdown: { tf: string; buy: number; sell: number; neutral: number; total: number; topSignals: string[] }[] = []
    for (const { tf, candles } of tfs) {
      if (candles.length < 10) continue
      const result = computeSignals(candles, tf)
      breakdown.push({ tf, buy: result.buy, sell: result.sell, neutral: result.neutral, total: result.total, topSignals: result.details.slice(0, 8) })
      grandTotal += result.total
    }
    signalData.push({ symbol, displayName: symbolNames.get(symbol) || symbol, price: data.price, breakdown })
  }

  // Step 2: Build Claude prompt with all signal data
  const signalLines = signalData.map(s => {
    const bdown = s.breakdown.map(b =>
      `  ${b.tf}: ${b.buy}B/${b.sell}S/${b.neutral}N (${b.total} signals) | ${b.topSignals.slice(0, 5).join(', ')}`
    ).join('\n')
    return `${s.displayName} @ ${s.price.toFixed(2)}:\n${bdown}`
  }).join('\n\n')

  const prompt = `You are an elite futures day trader. I just hit "ANALYSE NOW" — give me an INSTANT, no-bullshit verdict.

${grandTotal} SIGNALS COMPUTED across 15M/1H/1D timeframes:

${signalLines}

RESPOND WITH JSON ONLY (no markdown, no fences):
{
  "overallVerdict": "BUY" or "SELL" (no neutral — pick a side),
  "overallConfidence": number 55-95,
  "narrative": "2-3 punchy sentences. Where is MES going in the next 15 minutes? What's the trade? Be specific with price levels. Talk like a trader, not a textbook.",
  "symbols": [
    {
      "symbol": "MES",
      "verdict": "BUY" or "SELL",
      "confidence": number,
      "entry": exact_price,
      "stop": exact_price,
      "target1": exact_price (15-min target),
      "target2": exact_price (1-hour target),
      "riskReward": number,
      "reasoning": "1 sentence — why this trade"
    }
    ... (only MES, NQ, VIX, DXY — the 4 that matter most)
  ]
}`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 1500,
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
    symbols: { symbol: string; verdict: string; confidence: number; entry: number; stop: number; target1: number; target2: number; riskReward: number; reasoning: string }[]
  }

  try {
    parsed = JSON.parse(text)
  } catch {
    const m = text.match(/\{[\s\S]*\}/)
    if (m) parsed = JSON.parse(m[0])
    else throw new Error('Failed to parse AI response')
  }

  return {
    timestamp: new Date().toISOString(),
    overallVerdict: parsed.overallVerdict,
    overallConfidence: parsed.overallConfidence,
    narrative: parsed.narrative,
    symbols: parsed.symbols.map(s => ({
      ...s,
      signalBreakdown: signalData.find(d => d.symbol === s.symbol)?.breakdown.map(b => ({
        tf: b.tf, buy: b.buy, sell: b.sell, neutral: b.neutral, total: b.total,
      })) || [],
    })),
    totalSignalsAnalysed: grandTotal,
  }
}
