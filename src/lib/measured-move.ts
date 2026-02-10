/**
 * David Halsey Measured Move (AB=CD) Pattern Detection
 *
 * Uses swing points from detectSwings() to find AB=CD patterns:
 * - A→B is the impulse leg
 * - B→C is a 38.2%–61.8% retracement of AB
 * - C→D is the measured move where CD ≈ AB in distance
 *
 * Entry at .500 retrace (point C area), stop beyond .618, target at 1:1 projection.
 */

import { SwingPoint, MeasuredMove } from './types'

export function detectMeasuredMoves(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[],
  currentPrice: number
): MeasuredMove[] {
  const moves: MeasuredMove[] = []

  // Build alternating swing sequence sorted by barIndex (oldest first)
  const allSwings = [...swingHighs, ...swingLows].sort((a, b) => a.barIndex - b.barIndex)

  if (allSwings.length < 3) return moves

  // Scan for valid A-B-C triplets
  for (let i = 0; i < allSwings.length - 2; i++) {
    const a = allSwings[i]
    const b = allSwings[i + 1]
    const c = allSwings[i + 2]

    // A and B must be opposite types (high/low alternating)
    if (a.isHigh === b.isHigh) continue
    // B and C must be opposite types
    if (b.isHigh === c.isHigh) continue

    // Bullish: A=low, B=high, C=low (retraces down, then targets higher)
    // Bearish: A=high, B=low, C=high (retraces up, then targets lower)
    const isBullish = !a.isHigh && b.isHigh && !c.isHigh
    const isBearish = a.isHigh && !b.isHigh && c.isHigh

    if (!isBullish && !isBearish) continue

    const abDistance = Math.abs(b.price - a.price)
    if (abDistance <= 0) continue

    // Calculate retracement ratio: how much of AB did BC retrace?
    const bcRetrace = Math.abs(c.price - b.price) / abDistance

    // Halsey valid zone: 38.2% to 61.8% retracement
    if (bcRetrace < 0.382 || bcRetrace > 0.618) continue

    // Project D: measured move where CD ≈ AB
    let projectedD: number
    let entry: number
    let stop: number

    if (isBullish) {
      // Bullish: A(low) → B(high) → C(low retrace) → D(high target)
      projectedD = c.price + abDistance
      entry = b.price - abDistance * 0.5   // .500 retrace of AB = point C area
      stop = b.price - abDistance * 0.618 - abDistance * 0.02 // just beyond .618
    } else {
      // Bearish: A(high) → B(low) → C(high retrace) → D(low target)
      projectedD = c.price - abDistance
      entry = b.price + abDistance * 0.5
      stop = b.price + abDistance * 0.618 + abDistance * 0.02
    }

    // Score quality: 50% retrace = perfect (100), edges of range = lower
    const idealDeviation = Math.abs(bcRetrace - 0.5)
    const quality = Math.round(100 - idealDeviation * 500) // 0 deviation = 100, 0.118 = ~41

    // Determine status based on current price
    let status: MeasuredMove['status']
    if (isBullish) {
      if (currentPrice >= projectedD) {
        status = 'TARGET_HIT'
      } else if (currentPrice < stop) {
        status = 'STOPPED_OUT'
      } else if (currentPrice <= c.price) {
        status = 'FORMING'
      } else {
        status = 'ACTIVE'
      }
    } else {
      if (currentPrice <= projectedD) {
        status = 'TARGET_HIT'
      } else if (currentPrice > stop) {
        status = 'STOPPED_OUT'
      } else if (currentPrice >= c.price) {
        status = 'FORMING'
      } else {
        status = 'ACTIVE'
      }
    }

    moves.push({
      direction: isBullish ? 'BULLISH' : 'BEARISH',
      pointA: a,
      pointB: b,
      pointC: c,
      projectedD,
      retracementRatio: bcRetrace,
      entry,
      stop,
      target: projectedD,
      quality,
      status,
    })
  }

  // Return sorted by quality (best first), limited to top 5
  return moves
    .sort((a, b) => b.quality - a.quality)
    .slice(0, 5)
}
