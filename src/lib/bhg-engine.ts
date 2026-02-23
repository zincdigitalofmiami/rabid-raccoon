/**
 * Break-Hook-Go (BHG) State Machine Engine
 *
 * Encodes the Touch → Hook → Go pattern as pure functions.
 * No DB, no API calls — takes candles + fib + measured moves, returns setups.
 *
 * Definitions (canonical):
 *   TOUCH: Price tags 0.5 or 0.618 fib level
 *   HOOK:  Wick rejection at fib level (wick >= body, close on approaching side)
 *   GO:    Break or close past hook extreme (strict inequality, fire once, 20-bar expiry)
 */

import { CandleData, FibResult, MeasuredMove } from './types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type GoType = 'BREAK' | 'CLOSE'
export type SetupPhase = 'AWAITING_CONTACT' | 'CONTACT' | 'CONFIRMED' | 'TRIGGERED' | 'EXPIRED' | 'INVALIDATED'
export type SetupDirection = 'BULLISH' | 'BEARISH'

export interface BhgSetup {
  id: string
  direction: SetupDirection
  phase: SetupPhase
  fibLevel: number
  fibRatio: number // 0.5 or 0.618

  // Touch
  touchTime?: number
  touchBarIndex?: number
  touchPrice?: number

  // Hook
  hookTime?: number
  hookBarIndex?: number
  hookLow?: number
  hookHigh?: number
  hookClose?: number

  // Go
  goTime?: number
  goBarIndex?: number
  goType?: GoType

  // Targets
  entry?: number
  stopLoss?: number
  tp1?: number // 1.236 extension
  tp2?: number // 1.618 extension

  // Metadata
  createdAt: number
  expiryBars: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOUCH_FIB_RATIOS = [0.5, 0.618] as const
const DEFAULT_EXPIRY_BARS = 20
const MES_TICK_SIZE = 0.25
const PRICE_BUFFER_RATIO = 0.02

// ─── Helpers ──────────────────────────────────────────────────────────────────

function roundToTick(price: number, tickSize: number = MES_TICK_SIZE): number {
  return Math.round(price / tickSize) * tickSize
}

function findFibLevelPrice(fibResult: FibResult, ratio: number): number | null {
  const level = fibResult.levels.find((l) => Math.abs(l.ratio - ratio) <= 0.002)
  return level ? level.price : null
}

/**
 * Extract the 0.5 and 0.618 retracement levels from a FibResult.
 */
export function findTouchableFibLevels(
  fibResult: FibResult
): { level: number; ratio: number }[] {
  const result: { level: number; ratio: number }[] = []
  for (const fl of fibResult.levels) {
    if (TOUCH_FIB_RATIOS.includes(fl.ratio as 0.5 | 0.618)) {
      result.push({ level: fl.price, ratio: fl.ratio })
    }
  }
  return result
}

/**
 * TOUCH: Does this candle tag the fib level?
 * Bullish setup (price retracing down to fib): candle.low <= fibLevel
 * Bearish setup (price retracing up to fib): candle.high >= fibLevel
 */
export function detectTouch(
  candle: CandleData,
  barIndex: number,
  fibLevel: number,
  fibRatio: number,
  isBullish: boolean
): BhgSetup | null {
  const isTagged = candle.low <= fibLevel && candle.high >= fibLevel
  if (!isTagged) return null

  const direction: SetupDirection = isBullish ? 'BULLISH' : 'BEARISH'
  return {
    id: `${direction}-${fibRatio}-${barIndex}`,
    direction,
    phase: 'CONTACT',
    fibLevel,
    fibRatio,
    touchTime: candle.time,
    touchBarIndex: barIndex,
    touchPrice: fibLevel,
    createdAt: candle.time,
    expiryBars: DEFAULT_EXPIRY_BARS,
  }
}

/**
 * HOOK: Wick rejection candle at the fib level.
 *
 * Bullish: candle.low <= fibLevel AND candle.close > fibLevel
 *          AND (candle.close - candle.low) >= |candle.close - candle.open|
 *
 * Bearish: candle.high >= fibLevel AND candle.close < fibLevel
 *          AND (candle.high - candle.close) >= |candle.close - candle.open|
 */
export function detectHook(
  candle: CandleData,
  barIndex: number,
  setup: BhgSetup
): BhgSetup | null {
  if (setup.phase !== 'CONTACT') return null

  const body = Math.abs(candle.close - candle.open)

  if (setup.direction === 'BULLISH') {
    const rejectionWick = candle.close - candle.low
    if (
      candle.low <= setup.fibLevel &&
      candle.close > setup.fibLevel &&
      rejectionWick >= body
    ) {
      return {
        ...setup,
        phase: 'CONFIRMED',
        hookTime: candle.time,
        hookBarIndex: barIndex,
        hookLow: candle.low,
        hookHigh: candle.high,
        hookClose: candle.close,
      }
    }
  }

  if (setup.direction === 'BEARISH') {
    const rejectionWick = candle.high - candle.close
    if (
      candle.high >= setup.fibLevel &&
      candle.close < setup.fibLevel &&
      rejectionWick >= body
    ) {
      return {
        ...setup,
        phase: 'CONFIRMED',
        hookTime: candle.time,
        hookBarIndex: barIndex,
        hookLow: candle.low,
        hookHigh: candle.high,
        hookClose: candle.close,
      }
    }
  }

  return null
}

/**
 * GO: Break or close past the hook extreme.
 *
 * Bullish: BREAK GO if candle.high > hookHigh (strict)
 *          CLOSE GO if candle.close > hookHigh
 *
 * Bearish: BREAK GO if candle.low < hookLow (strict)
 *          CLOSE GO if candle.close < hookLow
 *
 * BREAK takes priority over CLOSE. Fire once per setup.
 */
export function detectGo(
  candle: CandleData,
  barIndex: number,
  setup: BhgSetup
): BhgSetup | null {
  if (setup.phase !== 'CONFIRMED') return null

  // Check expiry first
  if (barIndex - (setup.hookBarIndex ?? 0) > setup.expiryBars) {
    return { ...setup, phase: 'EXPIRED' }
  }

  if (setup.direction === 'BULLISH') {
    const hookHigh = setup.hookHigh!
    // BREAK GO (strict inequality)
    if (candle.high > hookHigh) {
      return {
        ...setup,
        phase: 'TRIGGERED',
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: candle.close > hookHigh ? 'CLOSE' : 'BREAK',
      }
    }
    // CLOSE GO only
    if (candle.close > hookHigh) {
      return {
        ...setup,
        phase: 'TRIGGERED',
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: 'CLOSE',
      }
    }
  }

  if (setup.direction === 'BEARISH') {
    const hookLow = setup.hookLow!
    // BREAK GO (strict inequality)
    if (candle.low < hookLow) {
      return {
        ...setup,
        phase: 'TRIGGERED',
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: candle.close < hookLow ? 'CLOSE' : 'BREAK',
      }
    }
    // CLOSE GO only
    if (candle.close < hookLow) {
      return {
        ...setup,
        phase: 'TRIGGERED',
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: 'CLOSE',
      }
    }
  }

  return null
}

/**
 * Compute entry/SL/TP1/TP2 for a TRIGGERED setup.
 *
 * Entry: hook close price
 * SL: beyond the next fib level (0.618 stop for 0.5 touch, 0.786 stop for 0.618 touch)
 * TP1: 1.236 fib extension
 * TP2: 1.618 fib extension
 *
 * If an aligned measured move exists, prefer its target for TP1.
 */
export function computeTargets(
  setup: BhgSetup,
  fibResult: FibResult,
  measuredMoves: MeasuredMove[]
): BhgSetup {
  if (setup.phase !== 'TRIGGERED') return setup

  const range = fibResult.anchorHigh - fibResult.anchorLow
  if (range <= 0) return setup

  // Entry is at the hook close
  const entry = roundToTick(setup.hookClose ?? setup.fibLevel)
  const buffer = Math.max(MES_TICK_SIZE, range * PRICE_BUFFER_RATIO)
  const minDistance = Math.max(buffer * 1.5, MES_TICK_SIZE * 4)

  // Stop loss: beyond the next fib level
  const stopRatio = setup.fibRatio === 0.5 ? 0.618 : 0.786
  const stopCandidate = findFibLevelPrice(fibResult, stopRatio)
  let stopLoss = 0

  if (setup.direction === 'BULLISH') {
    const belowEntry = [stopCandidate, setup.fibLevel, fibResult.anchorLow]
      .filter((v): v is number => v != null && Number.isFinite(v) && v < entry)
    const stopBase = belowEntry.length > 0 ? Math.max(...belowEntry) : entry - minDistance
    stopLoss = roundToTick(stopBase - buffer)
    if (stopLoss >= entry) stopLoss = roundToTick(entry - minDistance)
  } else {
    const aboveEntry = [stopCandidate, setup.fibLevel, fibResult.anchorHigh]
      .filter((v): v is number => v != null && Number.isFinite(v) && v > entry)
    const stopBase = aboveEntry.length > 0 ? Math.min(...aboveEntry) : entry + minDistance
    stopLoss = roundToTick(stopBase + buffer)
    if (stopLoss <= entry) stopLoss = roundToTick(entry + minDistance)
  }

  // TP1 from 1.236 extension, TP2 from 1.618 extension
  const ext1236 = findFibLevelPrice(fibResult, 1.236)
  const ext1618 = findFibLevelPrice(fibResult, 1.618)

  let tp1 = 0
  let tp2 = 0
  if (setup.direction === 'BULLISH') {
    const tp1Candidates = [ext1236, fibResult.anchorHigh + range * 0.236]
      .filter((v): v is number => v != null && Number.isFinite(v) && v > entry)
    const tp1Base = tp1Candidates.length > 0 ? Math.min(...tp1Candidates) : entry + minDistance
    tp1 = roundToTick(tp1Base)

    const tp2Candidates = [ext1618, fibResult.anchorHigh + range * 0.618]
      .filter((v): v is number => v != null && Number.isFinite(v) && v > tp1)
    const tp2Base = tp2Candidates.length > 0 ? Math.min(...tp2Candidates) : tp1 + minDistance
    tp2 = roundToTick(tp2Base)
    if (tp2 <= tp1) tp2 = roundToTick(tp1 + minDistance)
  } else {
    const tp1Candidates = [ext1236, fibResult.anchorLow - range * 0.236]
      .filter((v): v is number => v != null && Number.isFinite(v) && v < entry)
    const tp1Base = tp1Candidates.length > 0 ? Math.max(...tp1Candidates) : entry - minDistance
    tp1 = roundToTick(tp1Base)

    const tp2Candidates = [ext1618, fibResult.anchorLow - range * 0.618]
      .filter((v): v is number => v != null && Number.isFinite(v) && v < tp1)
    const tp2Base = tp2Candidates.length > 0 ? Math.max(...tp2Candidates) : tp1 - minDistance
    tp2 = roundToTick(tp2Base)
    if (tp2 >= tp1) tp2 = roundToTick(tp1 - minDistance)
  }

  // If an aligned measured move exists, prefer its target
  const alignedMove = measuredMoves.find(
    (m) =>
      m.direction === setup.direction &&
      (m.status === 'ACTIVE' || m.status === 'FORMING')
  )
  if (alignedMove) {
    const mmTarget = roundToTick(alignedMove.target)
    const validDirectionalTarget =
      (setup.direction === 'BULLISH' && mmTarget > entry) ||
      (setup.direction === 'BEARISH' && mmTarget < entry)

    if (validDirectionalTarget) {
      tp1 = mmTarget
      if (setup.direction === 'BULLISH' && tp2 <= tp1) tp2 = roundToTick(tp1 + minDistance)
      if (setup.direction === 'BEARISH' && tp2 >= tp1) tp2 = roundToTick(tp1 - minDistance)
    }
  }

  return { ...setup, entry, stopLoss, tp1, tp2 }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run the BHG state machine over a candle array.
 *
 * Stateless: takes the full candle history and recomputes from scratch.
 * Returns all setups (active + terminal) for display.
 */
export function advanceBhgSetups(
  candles: CandleData[],
  fibResult: FibResult,
  measuredMoves: MeasuredMove[]
): BhgSetup[] {
  if (candles.length < 10 || !fibResult) return []

  const touchLevels = findTouchableFibLevels(fibResult)
  if (touchLevels.length === 0) return []

  const activeSetups: Map<string, BhgSetup> = new Map()
  const completedSetups: BhgSetup[] = []

  // Track which fib levels have already fired a GO to avoid duplicates
  const firedGoKeys = new Set<string>()

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]

    // 1. Check for new touches (only if no active setup for this level+direction)
    for (const { level, ratio } of touchLevels) {
      for (const isBullish of [true, false]) {
        const direction: SetupDirection = isBullish ? 'BULLISH' : 'BEARISH'
        const dedupeKey = `${direction}-${ratio}`

        // Skip if we already have an active setup for this combo
        const hasActive = [...activeSetups.values()].some(
          (s) =>
            s.direction === direction &&
            s.fibRatio === ratio &&
            s.phase !== 'EXPIRED' &&
            s.phase !== 'INVALIDATED' &&
            s.phase !== 'TRIGGERED'
        )
        if (hasActive) continue

        // Skip if we already fired a GO for this combo recently (within 40 bars)
        if (firedGoKeys.has(dedupeKey)) {
          const lastGo = completedSetups.find(
            (s) => s.direction === direction && s.fibRatio === ratio && s.phase === 'TRIGGERED'
          )
          if (lastGo && i - (lastGo.goBarIndex ?? 0) < 40) continue
          firedGoKeys.delete(dedupeKey)
        }

        const touch = detectTouch(candle, i, level, ratio, isBullish)
        if (touch) {
          activeSetups.set(touch.id, touch)
        }
      }
    }

    // 2. Advance active setups
    for (const [id, setup] of activeSetups) {
      let updated: BhgSetup | null = null

      if (setup.phase === 'CONTACT') {
        // Try hook detection on this candle (can happen same bar as touch)
        updated = detectHook(candle, i, setup)
      }

      if (!updated && setup.phase === 'CONFIRMED') {
        // Try GO detection
        updated = detectGo(candle, i, setup)
      }

      if (updated) {
        if (updated.phase === 'TRIGGERED') {
          // Compute targets and move to completed
          const withTargets = computeTargets(updated, fibResult, measuredMoves)
          completedSetups.push(withTargets)
          activeSetups.delete(id)
          firedGoKeys.add(`${updated.direction}-${updated.fibRatio}`)
        } else if (updated.phase === 'EXPIRED' || updated.phase === 'INVALIDATED') {
          completedSetups.push(updated)
          activeSetups.delete(id)
        } else {
          activeSetups.set(id, updated)
        }
      } else if (setup.phase === 'CONTACT') {
        // Check touch expiry (if no hook within 10 bars, invalidate)
        if (i - (setup.touchBarIndex ?? 0) > 10) {
          activeSetups.delete(id)
          completedSetups.push({ ...setup, phase: 'EXPIRED' })
        }
      } else if (setup.phase === 'CONFIRMED') {
        // Check hook expiry
        if (i - (setup.hookBarIndex ?? 0) > setup.expiryBars) {
          activeSetups.delete(id)
          completedSetups.push({ ...setup, phase: 'EXPIRED' })
        }
      }
    }
  }

  // Return all setups: active ones first, then completed (most recent first)
  const allSetups = [
    ...activeSetups.values(),
    ...completedSetups.sort((a, b) => (b.goTime ?? b.createdAt) - (a.goTime ?? a.createdAt)),
  ]

  return allSetups
}
