/**
 * Fib Signal Engine — Retracement + Warbird Confirmation
 *
 * Architecture (replaces BHG Hook-and-Go):
 *   1. Multi-period fib identifies the dominant anchor (high/low) and direction.
 *   2. Four retracement levels watched: 0.382, 0.5, 0.618, 0.786.
 *   3. When the current 15m candle TAGS a fib level (candle.low ≤ level ≤ candle.high)
 *      AND the Warbird ML model confirms direction → TRIGGERED immediately.
 *   4. Without ML confirmation the level shows as CONTACT (watching).
 *
 * Output: BhgSetup-compatible objects so all downstream chart/score/risk
 *         consumers work without type changes.
 *
 *   Entry   = fib level price (rounded to MES 0.25 tick)
 *   Stop    = next deeper fib level (0.5→0.618→0.786) + buffer
 *   TP1     = 1.236 extension from anchor
 *   TP2     = 1.618 extension from anchor
 */

import type { CandleData, FibResult } from './types'
import type { BhgSetup, SetupDirection } from './bhg-engine'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Fib ratios that generate entry signals (ordered shallow→deep). */
const SIGNAL_RATIOS = [0.382, 0.5, 0.618, 0.786] as const

/** Extension targets (TP1, TP2). */
const TP1_EXT = 1.236
const TP2_EXT = 1.618

const MES_TICK = 0.25
const EXPIRY_BARS = 20

/** How many bars must pass before the same fib level can re-fire. */
const COOLDOWN_BARS = 40

/**
 * Minimum ML directional probability to confirm a BULLISH signal.
 * Below 0.52 is treated as "no opinion" (too close to 50/50).
 */
const ML_CONFIDENCE_THRESHOLD = 0.52

/**
 * Touch zone half-width = ATR * this multiplier.
 * Price must be within this distance of a fib level to count as a touch.
 */
const TOUCH_ZONE_ATR_MULTIPLIER = 0.5

/**
 * Fallback ATR in MES points when the candle window is too short to compute it.
 * 5 points ≈ typical quiet-session ATR(14) for MES at ~5,000.
 */
const FALLBACK_ATR_PTS = 5

/**
 * Maximum age of Warbird ML predictions before they are considered stale.
 * Training runs daily; predictions older than 4h are discarded.
 */
const MAX_PREDICTION_AGE_MS = 4 * 60 * 60 * 1000

// ─── ML prediction shape (matches /api/ml-forecast response) ─────────────────

export interface WarbirdPrediction {
  direction_1h: string | null
  direction_4h: string | null
  prob_up_1h: number | null
  prob_up_4h: number | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function roundTick(price: number): number {
  return Math.round(price / MES_TICK) * MES_TICK
}

function findFibPrice(fibResult: FibResult, ratio: number): number | null {
  const level = fibResult.levels.find((l) => Math.abs(l.ratio - ratio) <= 0.001)
  return level ? level.price : null
}

/**
 * Compute ATR-14 for the last candle window.
 * Returns points (e.g. 8.5 = 8.5 MES points).
 */
function computeAtr(candles: CandleData[], period = 14): number {
  const n = candles.length
  if (n < period + 1) return FALLBACK_ATR_PTS
  let atrSum = 0
  for (let i = n - period; i < n; i++) {
    const c = candles[i]
    const prev = candles[i - 1].close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev))
    atrSum += tr
  }
  return atrSum / period
}

/**
 * Is ML direction aligned with the setup direction?
 * Uses 1h as primary signal, 4h as confirmation.
 * Returns true only when ML has a meaningful opinion.
 */
function isMlAligned(
  direction: SetupDirection,
  ml: WarbirdPrediction | null,
): { aligned: boolean; confidence: number | null } {
  if (!ml) return { aligned: false, confidence: null }

  const prob1h = ml.prob_up_1h
  const prob4h = ml.prob_up_4h
  const dir1h = ml.direction_1h
  const dir4h = ml.direction_4h

  if (direction === 'BULLISH') {
    // Need at least one horizon clearly bullish
    const aligned =
      (dir1h === 'BULLISH' && (prob1h ?? 0) > ML_CONFIDENCE_THRESHOLD) ||
      (dir4h === 'BULLISH' && (prob4h ?? 0) > ML_CONFIDENCE_THRESHOLD)
    const conf = prob1h ?? prob4h ?? null
    return { aligned, confidence: conf }
  } else {
    const aligned =
      (dir1h === 'BEARISH' && (prob1h ?? 1) < (1 - ML_CONFIDENCE_THRESHOLD)) ||
      (dir4h === 'BEARISH' && (prob4h ?? 1) < (1 - ML_CONFIDENCE_THRESHOLD))
    const conf = prob1h != null ? 1 - prob1h : prob4h != null ? 1 - prob4h : null
    return { aligned, confidence: conf }
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * detectFibSignals
 *
 * Scans the candle window for fib level touches and generates signals.
 *
 * @param candles      Full OHLCV history (oldest first, last = current bar)
 * @param fibResult    From calculateFibonacciMultiPeriod
 * @param ml           Latest Warbird ML prediction (or null if unavailable)
 * @param recentSignals Previously triggered signals for cooldown deduplication
 */
export function detectFibSignals(
  candles: CandleData[],
  fibResult: FibResult,
  ml: WarbirdPrediction | null,
  recentSignals: BhgSetup[] = [],
): BhgSetup[] {
  if (candles.length < 20) return []

  const n = candles.length
  const current = candles[n - 1]  // latest (current) 15m bar
  const currentBarIndex = n - 1
  const atr = computeAtr(candles)
  const touchZone = atr * TOUCH_ZONE_ATR_MULTIPLIER

  const { anchorHigh, anchorLow, isBullish } = fibResult
  const range = anchorHigh - anchorLow

  const direction: SetupDirection = isBullish ? 'BULLISH' : 'BEARISH'
  const tp1Price = isBullish
    ? roundTick(anchorLow + TP1_EXT * range)
    : roundTick(anchorHigh - TP1_EXT * range)
  const tp2Price = isBullish
    ? roundTick(anchorLow + TP2_EXT * range)
    : roundTick(anchorHigh - TP2_EXT * range)

  const signals: BhgSetup[] = []

  for (const ratio of SIGNAL_RATIOS) {
    const fibLevel = findFibPrice(fibResult, ratio)
    if (fibLevel == null) continue

    // Is current candle touching this fib level?
    const candleTouches =
      current.low <= fibLevel + touchZone && current.high >= fibLevel - touchZone

    if (!candleTouches) continue

    const id = `${direction}-${ratio}`

    // Cooldown check — skip if same level fired recently
    const lastSignal = recentSignals.find(
      (s) => s.direction === direction && Math.abs(s.fibRatio - ratio) < 0.01,
    )
    if (lastSignal?.goTime != null) {
      const barsSince = currentBarIndex - (lastSignal.goBarIndex ?? 0)
      if (barsSince < COOLDOWN_BARS) continue
    }

    // Determine stop level (next deeper fib)
    const deeperRatios = SIGNAL_RATIOS.filter((r) => r > ratio)
    const stopRatio = deeperRatios[0] ?? ratio + 0.1
    const stopFibPrice = findFibPrice(fibResult, stopRatio)
    const stopBuffer = atr * 0.15

    let stopLoss: number
    if (isBullish) {
      stopLoss = roundTick((stopFibPrice ?? anchorLow) - stopBuffer)
      if (stopLoss >= fibLevel) stopLoss = roundTick(fibLevel - atr * 0.5)
    } else {
      stopLoss = roundTick((stopFibPrice ?? anchorHigh) + stopBuffer)
      if (stopLoss <= fibLevel) stopLoss = roundTick(fibLevel + atr * 0.5)
    }

    const entry = roundTick(fibLevel)

    const { aligned: mlAligned } = isMlAligned(direction, ml)

    const phase = mlAligned ? 'TRIGGERED' : 'CONTACT'

    const setup: BhgSetup = {
      id,
      direction,
      phase,
      fibLevel: entry,
      fibRatio: ratio,

      // Touch (fib retracement touch = the trigger event)
      touchTime: current.time,
      touchBarIndex: currentBarIndex,
      touchPrice: entry,

      // Go fields populated for TRIGGERED setups
      ...(phase === 'TRIGGERED'
        ? {
            goTime: current.time,
            goBarIndex: currentBarIndex,
            goType: 'CLOSE',       // entry on close of the retracement bar
            entry,
            stopLoss,
            tp1: tp1Price,
            tp2: tp2Price,
          }
        : {}),

      createdAt: current.time,
      expiryBars: EXPIRY_BARS,
    }

    signals.push(setup)
  }

  return signals
}

/**
 * Load the latest Warbird ML prediction from the pre-computed JSON file.
 * Returns null if the file is unavailable or stale (> 2h old).
 */
export async function loadWarbirdPrediction(): Promise<WarbirdPrediction | null> {
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const file = path.join(process.cwd(), 'public', 'ml-predictions.json')
    if (!fs.existsSync(file)) return null

    const raw = fs.readFileSync(file, 'utf8')
    const data = JSON.parse(raw) as {
      meta: { generated_at: string }
      predictions: WarbirdPrediction[]
    }

    // Reject stale predictions (Warbird trains daily; >4h = stale)
    const age = Date.now() - new Date(data.meta.generated_at).getTime()
    if (age > MAX_PREDICTION_AGE_MS) return null

    const preds = data.predictions
    return preds.length > 0 ? preds[preds.length - 1] : null
  } catch {
    return null
  }
}
