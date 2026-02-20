/**
 * Auto-Fibonacci Engine — Multi-Period Confluence (TSoFib approach)
 *
 * Replaces single swing-pair anchor with Fibonacci-sequence lookback periods
 * (8, 13, 21, 34, 55 bars) to find the highest-confluence fib anchor.
 *
 * Algorithm (ported from TSoFib Pine Script):
 *   1. For each period N in [8, 13, 21, 34, 55]:
 *      - highN = highest high over last N bars
 *      - lowN  = lowest low over last N bars
 *      - Derive retracement levels at 0.382, 0.5, 0.618
 *   2. Cluster detection: count how many periods produce a level within
 *      `confluenceTolerance` (0.1% of range) of each other.
 *   3. Score each period pair by its confluence count; pick the anchor
 *      whose retracements have the most agreement across periods.
 *   4. Direction: isBullish = most recent bar's close is above the 0.5 level
 *      of the winning anchor (price is in upper half of the range).
 */

import { CandleData, FibLevel, FibResult } from './types'
import { FIB_COLORS } from './colors'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIB_RATIOS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0]
const FIB_EXTENSIONS = [1.236, 1.618]
const FIB_LOOKBACKS = [8, 13, 21, 34, 55] as const

/** Confluence tolerance: levels within this fraction of range are "the same" */
const CONFLUENCE_TOLERANCE = 0.001 // 0.1 %

/** Retracement ratios used for confluence voting */
const CONFLUENCE_RATIOS = [0.382, 0.5, 0.618]

const FIB_LABELS: Record<number, string> = {
  0:     '0',
  0.236: '.236',
  0.382: '.382',
  0.5:   '.5',
  0.618: '.618',
  0.786: '.786',
  1.0:   '1',
  1.236: '1.236',
  1.618: '1.618',
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildLevels(anchorHigh: number, anchorLow: number, isBullish: boolean): FibLevel[] {
  const fibRange = anchorHigh - anchorLow
  const levels: FibLevel[] = []

  for (const ratio of FIB_RATIOS) {
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

  return levels
}

// ---------------------------------------------------------------------------
// Public API — Multi-Period Confluence (primary)
// ---------------------------------------------------------------------------

/**
 * calculateFibonacciMultiPeriod
 *
 * Uses Fibonacci-sequence lookback periods (8, 13, 21, 34, 55) to find the
 * highest-confluence anchor pair, then returns a full FibResult.
 *
 * Falls back to the largest period (55) if no confluence is detected.
 *
 * @param candles  Full OHLCV array (chronological, oldest first)
 */
export function calculateFibonacciMultiPeriod(candles: CandleData[]): FibResult | null {
  const n = candles.length
  if (n < FIB_LOOKBACKS[FIB_LOOKBACKS.length - 1]) {
    // Not enough bars for even the smallest multi-period; fall back to swing pair
    return null
  }

  // Step 1: compute high/low for each lookback period using the last N bars
  type PeriodAnchor = {
    period: number
    high: number
    low: number
    highBarIndex: number
    lowBarIndex: number
    range: number
    /** Derived retracement prices at [0.382, 0.5, 0.618] — direction-neutral midpoints */
    midLevels: number[]
  }

  const anchors: PeriodAnchor[] = []

  for (const period of FIB_LOOKBACKS) {
    const startIdx = n - period
    if (startIdx < 0) continue

    let high = -Infinity
    let low = Infinity
    let highBarIndex = startIdx
    let lowBarIndex = startIdx

    for (let i = startIdx; i < n; i++) {
      if (candles[i].high > high) {
        high = candles[i].high
        highBarIndex = i
      }
      if (candles[i].low < low) {
        low = candles[i].low
        lowBarIndex = i
      }
    }

    const range = high - low
    if (range <= 0) continue

    // Direction-neutral midpoint levels for confluence voting
    const midLevels = CONFLUENCE_RATIOS.map((r) => low + range * r)

    anchors.push({ period, high, low, highBarIndex, lowBarIndex, range, midLevels })
  }

  if (anchors.length === 0) return null

  // Step 2: score each anchor by counting how many OTHER period levels fall
  // within tolerance of its own midLevels (confluence vote)
  let bestAnchor = anchors[anchors.length - 1] // default: largest period (55)
  let bestScore = -1

  for (let a = 0; a < anchors.length; a++) {
    const anchor = anchors[a]
    const tolerance = anchor.range * CONFLUENCE_TOLERANCE

    let score = 0
    for (let b = 0; b < anchors.length; b++) {
      if (a === b) continue
      for (const levelA of anchor.midLevels) {
        for (const levelB of anchors[b].midLevels) {
          if (Math.abs(levelA - levelB) <= tolerance) {
            score++
          }
        }
      }
    }

    if (score > bestScore) {
      bestScore = score
      bestAnchor = anchor
    }
  }

  // Step 3: determine direction from the current close vs. 0.5 level
  const lastClose = candles[n - 1].close
  const midpoint = bestAnchor.low + bestAnchor.range * 0.5
  const isBullish = lastClose >= midpoint

  const levels = buildLevels(bestAnchor.high, bestAnchor.low, isBullish)

  return {
    levels,
    anchorHigh: bestAnchor.high,
    anchorLow: bestAnchor.low,
    isBullish,
    anchorHighBarIndex: bestAnchor.highBarIndex,
    anchorLowBarIndex: bestAnchor.lowBarIndex,
  }
}

