/**
 * Swing High/Low Detection
 * Ported from Pine Script: indicators/rabid-raccoon.pine lines 103-162
 *
 * Pine Script uses ta.pivothigh(high, leftBars, rightBars) which confirms
 * a pivot when the candidate bar's high/low is the extreme in the window.
 * This is the batch equivalent for pre-loaded OHLCV data.
 */

import { CandleData, SwingPoint } from './types'

export function detectSwings(
  candles: CandleData[],
  leftBars: number = 5,
  rightBars: number = 5,
  maxHistory: number = 50
): { highs: SwingPoint[]; lows: SwingPoint[] } {
  const highs: SwingPoint[] = []
  const lows: SwingPoint[] = []

  if (candles.length < leftBars + rightBars + 1) {
    return { highs, lows }
  }

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    // Check pivot high: candle[i].high must be strictly > all highs in window
    let isPivotHigh = true
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j !== i && candles[j].high >= candles[i].high) {
        isPivotHigh = false
        break
      }
    }
    if (isPivotHigh) {
      highs.push({
        price: candles[i].high,
        barIndex: i,
        isHigh: true,
        time: candles[i].time,
      })
    }

    // Check pivot low: candle[i].low must be strictly < all lows in window
    let isPivotLow = true
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j !== i && candles[j].low <= candles[i].low) {
        isPivotLow = false
        break
      }
    }
    if (isPivotLow) {
      lows.push({
        price: candles[i].low,
        barIndex: i,
        isHigh: false,
        time: candles[i].time,
      })
    }
  }

  // Return most recent first (matching Pine Script array.unshift behavior),
  // limited to maxHistory
  return {
    highs: highs.reverse().slice(0, maxHistory),
    lows: lows.reverse().slice(0, maxHistory),
  }
}
