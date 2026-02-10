/**
 * Auto-Fibonacci Engine
 * Ported from Pine Script: indicators/rabid-raccoon.pine.bak lines 193-276
 *
 * Takes the most recent swing high + swing low pair and calculates
 * Fibonacci retracement and extension levels.
 *
 * Direction logic (line 203 of .bak):
 *   isBullish = swingLow.barIdx > swingHigh.barIdx
 *   (if swing low is more recent, we're in a bullish retracement)
 */

import { SwingPoint, FibLevel, FibResult } from './types'
import { FIB_COLORS } from './colors'

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
const FIB_EXTENSIONS = [1.272, 1.618]

const FIB_LABELS: Record<number, string> = {
  0:     '0',
  0.236: '.236',
  0.382: '.382',
  0.5:   '.5',
  0.618: '.618',
  0.786: '.786',
  1.0:   '1',
  1.272: '1.272',
  1.618: '1.618',
}

export function calculateFibonacci(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[]
): FibResult | null {
  if (swingHighs.length < 1 || swingLows.length < 1) {
    return null
  }

  const sh = swingHighs[0] // most recent swing high
  const sl = swingLows[0]  // most recent swing low

  // Direction: if swing low is more recent → bullish retracement
  // Ported from .bak line 203: bool newBull = sl.barIdx > sh.barIdx
  const isBullish = sl.barIndex > sh.barIndex

  const anchorHigh = sh.price
  const anchorLow = sl.price
  const fibRange = anchorHigh - anchorLow

  if (fibRange <= 0) {
    return null
  }

  const levels: FibLevel[] = []

  // Retracement levels (ported from .bak lines 239-256)
  for (const ratio of FIB_RATIOS) {
    // Pine: float lvl = fibIsBullish ? fibAnchorLow + fibRange * r : fibAnchorHigh - fibRange * r
    const price = isBullish
      ? anchorLow + fibRange * ratio
      : anchorHigh - fibRange * ratio

    levels.push({
      ratio,
      price,
      label: FIB_LABELS[ratio] || ratio.toString(),
      color: FIB_COLORS[ratio] || '#787b86',
      isExtension: false,
    })
  }

  // Extension levels (ported from .bak lines 264-276)
  for (const ratio of FIB_EXTENSIONS) {
    const price = isBullish
      ? anchorLow + fibRange * ratio
      : anchorHigh - fibRange * ratio

    levels.push({
      ratio,
      price,
      label: FIB_LABELS[ratio] || ratio.toString(),
      color: FIB_COLORS[ratio] || '#787b86',
      isExtension: true,
    })
  }

  return {
    levels,
    anchorHigh,
    anchorLow,
    isBullish,
    anchorHighBarIndex: sh.barIndex,
    anchorLowBarIndex: sl.barIndex,
  }
}
