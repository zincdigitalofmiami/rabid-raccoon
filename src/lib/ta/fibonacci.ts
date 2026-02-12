/**
 * Pure Fibonacci Math Functions
 *
 * Ported from TradingView Auto Fib Retracement indicator:
 *   price = startPrice + height * ratio
 *
 * These are the building blocks for snap-blend target alignment.
 */

/**
 * Fibonacci retracement: retrace from B back toward A by ratio r.
 * r = 0 -> B, r = 1 -> A, r = 0.618 -> 61.8% retrace from B toward A.
 */
export function fibRetracement(A: number, B: number, r: number): number {
  return B - (B - A) * r
}

/**
 * Fibonacci extension: project from C in the direction of A->B by ratio r.
 * r = 1.0 -> C + full AB distance, r = 0.618 -> C + 61.8% of AB distance.
 */
export function fibExtension(A: number, B: number, C: number, r: number): number {
  return C + (B - A) * r
}

/**
 * Round price to nearest tick increment.
 * MES tick = 0.25, so 5962.13 -> 5962.25
 */
export function roundToTick(price: number, tick: number): number {
  return Math.round(price / tick) * tick
}
