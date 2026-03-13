/**
 * AutoFib Structure Engine (Pine-parity baseline)
 *
 * Port of Kirk's Pine v6 AutoFib anchor/confluence methodology:
 * - Candidate windows: 8,13,21,34,55
 * - Confluence scoring over 0.382/0.5/0.618 with tolerance as % of range
 * - Tie-breaker preference for the longest window (55 -> 8)
 * - Locked anchors that only re-anchor on structural break outside range
 * - Direction-aware structure levels (pivot, zone, targets, down magnets)
 */

import { CandleData, FibLevel, FibResult } from './types'
import { FIB_COLORS } from './colors'

const ENGINE_PERIODS = [8, 13, 21, 34, 55] as const
const ENGINE_MIN_BARS = 55
const SCORE_RATIOS = [0.382, 0.5, 0.618] as const
const CONFLUENCE_TOLERANCE_PCT = 0.1

const RATIO_PIVOT = 0.5
const RATIO_ZONE_LOW = 0.618
const RATIO_ZONE_HIGH = 0.786
const RATIO_TARGET_1 = 1.236
const RATIO_TARGET_2 = 1.618
const RATIO_DOWN_MAGNET_1 = 0.382
const RATIO_DOWN_MAGNET_2 = 0.236

const LEVEL_RATIOS = [
  0.0,
  RATIO_DOWN_MAGNET_2,
  RATIO_DOWN_MAGNET_1,
  RATIO_PIVOT,
  RATIO_ZONE_LOW,
  RATIO_ZONE_HIGH,
  1.0,
  RATIO_TARGET_1,
  RATIO_TARGET_2,
] as const

const FIB_LABELS: Record<number, string> = {
  0: '0',
  0.236: '.236',
  0.382: '.382',
  0.5: '.5',
  0.618: '.618',
  0.786: '.786',
  1: '1',
  1.236: '1.236',
  1.618: '1.618',
}

const STYLE_COLORS = {
  pivot: '#FFFFFF',
  zone: '#FF9800',
  target: '#388E3C',
  downMagnet: '#F23645',
  anchor: '#787B86',
} as const

type WindowAnchor = {
  period: number
  high: number
  low: number
  range: number
  highBarIndex: number
  lowBarIndex: number
}

type LockedAnchorState = {
  anchorHigh: number
  anchorLow: number
  anchorHighBarIndex: number
  anchorLowBarIndex: number
  activeFibPeriod: number
  confluenceScore: number
}

function isNear(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps
}

function roleForRatio(ratio: number): FibLevel['role'] {
  if (isNear(ratio, RATIO_PIVOT)) return 'pivot'
  if (isNear(ratio, RATIO_ZONE_LOW) || isNear(ratio, RATIO_ZONE_HIGH)) return 'zone'
  if (isNear(ratio, RATIO_TARGET_1) || isNear(ratio, RATIO_TARGET_2)) return 'target'
  if (isNear(ratio, RATIO_DOWN_MAGNET_1) || isNear(ratio, RATIO_DOWN_MAGNET_2)) return 'downMagnet'
  if (isNear(ratio, 0) || isNear(ratio, 1)) return 'anchor'
  return 'other'
}

function colorForRole(ratio: number, role: FibLevel['role']): string {
  if (role === 'pivot') return STYLE_COLORS.pivot
  if (role === 'zone') return STYLE_COLORS.zone
  if (role === 'target') return STYLE_COLORS.target
  if (role === 'downMagnet') return STYLE_COLORS.downMagnet
  return FIB_COLORS[ratio] || STYLE_COLORS.anchor
}

function lineWidthForRole(role: FibLevel['role']): number {
  if (role === 'pivot') return 2
  if (role === 'zone') return 2
  if (role === 'target') return 2
  if (role === 'downMagnet') return 1
  return 1
}

function computeWindowAnchor(
  candles: CandleData[],
  endIndex: number,
  period: number,
): WindowAnchor | null {
  const startIndex = endIndex - period + 1
  if (startIndex < 0) return null

  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  let highBarIndex = startIndex
  let lowBarIndex = startIndex

  for (let i = startIndex; i <= endIndex; i++) {
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
  if (!Number.isFinite(range) || range <= 0) return null

  return { period, high, low, range, highBarIndex, lowBarIndex }
}

function computeConfluenceScore(anchor: WindowAnchor, windows: WindowAnchor[]): number {
  const tolerance = anchor.range * (CONFLUENCE_TOLERANCE_PCT * 0.01)
  if (tolerance <= 0) return 0

  let score = 0
  for (const targetRatio of SCORE_RATIOS) {
    const levelSelf = anchor.low + anchor.range * targetRatio
    for (const cmpRatio of SCORE_RATIOS) {
      for (const cmpWindow of windows) {
        const cmpLevel = cmpWindow.low + cmpWindow.range * cmpRatio
        if (Math.abs(levelSelf - cmpLevel) <= tolerance) {
          score += 1
        }
      }
    }
  }
  return score
}

function selectBestAnchor(windows: WindowAnchor[]): { best: WindowAnchor; score: number } | null {
  if (windows.length === 0) return null

  const scoreByPeriod = new Map<number, number>()
  let bestScore = Number.NEGATIVE_INFINITY

  for (const window of windows) {
    const score = computeConfluenceScore(window, windows)
    scoreByPeriod.set(window.period, score)
    if (score > bestScore) bestScore = score
  }

  // Pine tie-break preference: 55 -> 34 -> 21 -> 13 -> 8
  for (let i = ENGINE_PERIODS.length - 1; i >= 0; i--) {
    const period = ENGINE_PERIODS[i]
    if (scoreByPeriod.get(period) !== bestScore) continue
    const selected = windows.find((w) => w.period === period)
    if (selected) {
      return { best: selected, score: bestScore }
    }
  }

  return null
}

function resolveLockedAnchor(candles: CandleData[]): LockedAnchorState | null {
  if (candles.length < ENGINE_MIN_BARS) return null

  let locked: LockedAnchorState | null = null

  for (let endIndex = ENGINE_MIN_BARS - 1; endIndex < candles.length; endIndex++) {
    const windows: WindowAnchor[] = []
    for (const period of ENGINE_PERIODS) {
      const window = computeWindowAnchor(candles, endIndex, period)
      if (window) windows.push(window)
    }
    if (windows.length !== ENGINE_PERIODS.length) continue

    const selected = selectBestAnchor(windows)
    if (!selected) continue

    const close = candles[endIndex].close
    const structBreak =
      locked != null &&
      Number.isFinite(locked.anchorHigh) &&
      Number.isFinite(locked.anchorLow) &&
      (close > locked.anchorHigh || close < locked.anchorLow)
    const needsAnchor = locked == null || structBreak

    if (needsAnchor) {
      locked = {
        anchorHigh: selected.best.high,
        anchorLow: selected.best.low,
        anchorHighBarIndex: selected.best.highBarIndex,
        anchorLowBarIndex: selected.best.lowBarIndex,
        activeFibPeriod: selected.best.period,
        confluenceScore: selected.score,
      }
    }
  }

  return locked
}

function buildLevels(
  fibRange: number,
  fibBase: number,
  fibDir: 1 | -1,
): FibLevel[] {
  return LEVEL_RATIOS.map((ratio) => {
    const role = roleForRatio(ratio)
    return {
      ratio,
      price: fibBase + fibDir * fibRange * ratio,
      label: FIB_LABELS[ratio] || ratio.toString(),
      color: colorForRole(ratio, role),
      lineWidth: lineWidthForRole(role),
      role,
      isExtension: ratio > 1,
    }
  })
}

export function calculateFibonacciMultiPeriod(candles: CandleData[]): FibResult | null {
  const locked = resolveLockedAnchor(candles)
  if (!locked) return null

  const fibRange = locked.anchorHigh - locked.anchorLow
  if (!Number.isFinite(fibRange) || fibRange <= 0) return null

  const lastClose = candles[candles.length - 1]?.close
  if (!Number.isFinite(lastClose)) return null

  const fibMidpoint = locked.anchorLow + fibRange * 0.5
  const fibBull = lastClose >= fibMidpoint
  const fibBase = fibBull ? locked.anchorLow : locked.anchorHigh
  const fibDir: 1 | -1 = fibBull ? 1 : -1
  const fibPrice = (ratio: number): number => fibBase + fibDir * fibRange * ratio

  const pPivot = fibPrice(RATIO_PIVOT)
  const pZoneLo = fibPrice(RATIO_ZONE_LOW)
  const pZoneHi = fibPrice(RATIO_ZONE_HIGH)
  const pT1 = fibPrice(RATIO_TARGET_1)
  const pT2 = fibPrice(RATIO_TARGET_2)
  const pDn1 = fibPrice(RATIO_DOWN_MAGNET_1)
  const pDn2 = fibPrice(RATIO_DOWN_MAGNET_2)

  const zoneUpper = Math.max(pZoneLo, pZoneHi)
  const zoneLower = Math.min(pZoneLo, pZoneHi)

  const levels = buildLevels(fibRange, fibBase, fibDir)
  const drawLeftBarIndex = Math.max(0, Math.min(locked.anchorHighBarIndex, locked.anchorLowBarIndex))

  return {
    levels,
    anchorHigh: locked.anchorHigh,
    anchorLow: locked.anchorLow,
    isBullish: fibBull,
    anchorHighBarIndex: locked.anchorHighBarIndex,
    anchorLowBarIndex: locked.anchorLowBarIndex,
    fibBull,
    fibRange,
    activeFibPeriod: locked.activeFibPeriod,
    confluenceScore: locked.confluenceScore,
    drawLeftBarIndex,
    pivot: pPivot,
    zoneLow: pZoneLo,
    zoneHigh: pZoneHi,
    zoneLower,
    zoneUpper,
    target1: pT1,
    target2: pT2,
    downMagnet1: pDn1,
    downMagnet2: pDn2,
  }
}
