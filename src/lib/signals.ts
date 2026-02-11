/**
 * Signal Engine — Confluence-based trade signal generation
 *
 * Scores multiple factors per symbol to produce a directional bias:
 * - Fibonacci position & trend
 * - Active measured moves (AB=CD)
 * - Swing structure (higher highs/lows vs lower)
 * - Price momentum (vs session open)
 *
 * Composite signal aggregates all 8 symbols weighted toward MES.
 */

import { CandleData, FibResult, MeasuredMove, TradeSignal, CompositeSignal } from './types'

interface SymbolData {
  symbol: string
  candles: CandleData[]
  fibResult: FibResult | null
  measuredMoves: MeasuredMove[]
  currentPrice: number
  percentChange: number
}

export function generateSignal(data: SymbolData): TradeSignal {
  let score = 0
  const factors: string[] = []
  let bestMove: MeasuredMove | undefined

  const { fibResult, measuredMoves, currentPrice, candles } = data

  // 1. Fibonacci trend direction (+/- 15)
  if (fibResult) {
    if (fibResult.isBullish) {
      score += 15
      factors.push('Fib trend bullish')
    } else {
      score -= 15
      factors.push('Fib trend bearish')
    }

    // 2. Price position relative to key fib levels (+/- 10)
    const fib618 = fibResult.isBullish
      ? fibResult.anchorLow + (fibResult.anchorHigh - fibResult.anchorLow) * 0.618
      : fibResult.anchorHigh - (fibResult.anchorHigh - fibResult.anchorLow) * 0.618
    const fib382 = fibResult.isBullish
      ? fibResult.anchorLow + (fibResult.anchorHigh - fibResult.anchorLow) * 0.382
      : fibResult.anchorHigh - (fibResult.anchorHigh - fibResult.anchorLow) * 0.382

    if (fibResult.isBullish) {
      if (currentPrice > fib618) {
        score += 10
        factors.push('Above .618 fib')
      } else if (currentPrice < fib382) {
        score -= 5
        factors.push('Below .382 fib')
      }
    } else {
      if (currentPrice < fib618) {
        score -= 10
        factors.push('Below .618 fib')
      } else if (currentPrice > fib382) {
        score += 5
        factors.push('Above .382 fib')
      }
    }
  }

  // 3. Active measured moves (+/- 20)
  const activeMoves = measuredMoves.filter((m) => m.status === 'ACTIVE')
  if (activeMoves.length > 0) {
    bestMove = activeMoves[0]
    if (bestMove.direction === 'BULLISH') {
      score += 20
      factors.push(`AB=CD targeting ${bestMove.target.toFixed(2)}`)
    } else {
      score -= 20
      factors.push(`AB=CD targeting ${bestMove.target.toFixed(2)}`)
    }
  }

  // 4. Swing structure: higher highs/lows vs lower (+/- 10)
  if (candles.length >= 20) {
    const recent = candles.slice(-20)
    const midpoint = Math.floor(recent.length / 2)
    const firstHalf = recent.slice(0, midpoint)
    const secondHalf = recent.slice(midpoint)

    const firstHighAvg = firstHalf.reduce((s, c) => s + c.high, 0) / firstHalf.length
    const secondHighAvg = secondHalf.reduce((s, c) => s + c.high, 0) / secondHalf.length
    const firstLowAvg = firstHalf.reduce((s, c) => s + c.low, 0) / firstHalf.length
    const secondLowAvg = secondHalf.reduce((s, c) => s + c.low, 0) / secondHalf.length

    if (secondHighAvg > firstHighAvg && secondLowAvg > firstLowAvg) {
      score += 10
      factors.push('Higher highs & lows')
    } else if (secondHighAvg < firstHighAvg && secondLowAvg < firstLowAvg) {
      score -= 10
      factors.push('Lower highs & lows')
    }
  }

  // 5. Price momentum vs session open (+/- 5)
  if (candles.length > 0) {
    const openPrice = candles[0].open
    if (currentPrice > openPrice) {
      score += 5
      factors.push('Above session open')
    } else if (currentPrice < openPrice) {
      score -= 5
      factors.push('Below session open')
    }
  }

  // Convert score to direction and confidence (50-95% range)
  const direction = score >= 0 ? 'BULLISH' : 'BEARISH'
  const maxPossible = 60 // 15 + 10 + 20 + 10 + 5
  const rawConfidence = Math.abs(score) / maxPossible
  const confidence = Math.round(50 + rawConfidence * 45) // 50% base, up to 95%

  return {
    symbol: data.symbol,
    direction,
    confidence: Math.min(confidence, 95),
    confluenceFactors: factors,
    entry: bestMove?.entry,
    stop: bestMove?.stop,
    target: bestMove?.target,
    measuredMove: bestMove,
  }
}

// Intermarket weights — VIX, ZN, ZB, DXY are inverse to equities
const SYMBOL_WEIGHTS: Record<string, { weight: number; invert: boolean }> = {
  MES: { weight: 0.40, invert: false },
  NQ: { weight: 0.10, invert: false },
  YM: { weight: 0.10, invert: false },
  RTY: { weight: 0.10, invert: false },
  VX: { weight: 0.10, invert: true },
  US10Y: { weight: 0.05, invert: true },
  ZN: { weight: 0.05, invert: true },
  ZB: { weight: 0.05, invert: true },
  DX: { weight: 0.05, invert: true },
}

export function generateCompositeSignal(allSymbolData: SymbolData[]): CompositeSignal {
  const symbolSignals: TradeSignal[] = allSymbolData.map(generateSignal)

  // Weighted composite score
  let compositeScore = 0
  const confluenceSummary: string[] = []

  for (const signal of symbolSignals) {
    const config = SYMBOL_WEIGHTS[signal.symbol]
    if (!config) continue

    const signalScore = signal.direction === 'BULLISH' ? signal.confidence : -signal.confidence
    const adjusted = config.invert ? -signalScore : signalScore
    compositeScore += adjusted * config.weight
  }

  // Intermarket analysis factors
  const mesSignal = symbolSignals.find((s) => s.symbol === 'MES')
  const nqSignal = symbolSignals.find((s) => s.symbol === 'NQ')
  const vxSignal = symbolSignals.find((s) => s.symbol === 'VX')

  if (mesSignal && nqSignal) {
    const mesData = allSymbolData.find((d) => d.symbol === 'MES')
    const nqData = allSymbolData.find((d) => d.symbol === 'NQ')
    if (mesData && nqData) {
      if (nqData.percentChange > mesData.percentChange + 0.1) {
        confluenceSummary.push('NQ leading ES (risk-on)')
      } else if (nqData.percentChange < mesData.percentChange - 0.1) {
        confluenceSummary.push('NQ lagging ES (risk-off)')
      }
    }
  }

  if (vxSignal) {
    const vxData = allSymbolData.find((d) => d.symbol === 'VX')
    if (vxData && vxData.percentChange < -1) {
      confluenceSummary.push('VIX declining')
    } else if (vxData && vxData.percentChange > 1) {
      confluenceSummary.push('VIX rising')
    }
  }

  // Add MES measured move info
  if (mesSignal?.measuredMove) {
    confluenceSummary.push(
      `MES AB=CD ${mesSignal.measuredMove.direction.toLowerCase()} → ${mesSignal.measuredMove.target.toFixed(2)}`
    )
  }

  // Add MES fib factor
  const mesFibFactors = mesSignal?.confluenceFactors.filter(
    (f) => f.includes('fib') || f.includes('Fib')
  )
  if (mesFibFactors && mesFibFactors.length > 0) {
    confluenceSummary.push(...mesFibFactors)
  }

  const direction = compositeScore >= 0 ? 'BULLISH' : 'BEARISH'
  const maxWeightedScore = Object.values(SYMBOL_WEIGHTS).reduce(
    (sum, cfg) => sum + cfg.weight * 95,
    0
  )
  const rawConfidence = maxWeightedScore > 0 ? Math.abs(compositeScore) / maxWeightedScore : 0
  const confidence = Math.round(50 + rawConfidence * 45)

  return {
    direction,
    confidence: Math.min(confidence, 95),
    primarySignal: mesSignal || symbolSignals[0],
    symbolSignals,
    confluenceSummary,
    timestamp: new Date().toISOString(),
  }
}
