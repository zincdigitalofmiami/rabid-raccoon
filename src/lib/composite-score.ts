/**
 * composite-score.ts — Composite Trade Score
 *
 * Combines all Layer 1 signals into a single 0-100 score per setup:
 *   - Fib quality (ratio, R:R, hook quality)
 *   - Risk grade
 *   - Event awareness (phase, confidence adjustment)
 *   - Correlation alignment
 *   - Technical indicators (squeeze, WVF, MACD)
 *   - ML baseline (regime p(TP1)/p(TP2))
 *
 * All weights are marked BACKTEST-TBD and will be replaced by
 * feature importance scores from the retrained model.
 */

import type { TradeFeatureVector } from '@/lib/trade-features'
import type { MlBaseline } from '@/lib/ml-baseline'

// ─────────────────────────────────────────────
// Exported types
// ─────────────────────────────────────────────

export interface TradeScore {
  composite: number           // 0-100 overall score
  grade: 'A' | 'B' | 'C' | 'D'
  pTp1: number                // 0-1, adjusted probability of TP1 hit
  pTp2: number                // 0-1, adjusted probability of TP2 hit
  subScores: {
    fib: number               // 0-100
    risk: number              // 0-100
    event: number             // 0-100
    correlation: number       // 0-100
    technical: number         // 0-100
    mlBaseline: number        // 0-100
  }
  flags: string[]             // warnings/highlights for the trade
}

// ─────────────────────────────────────────────
// Weights — BACKTEST-TBD: replace with feature importance
// ─────────────────────────────────────────────

const WEIGHTS = {
  fib: 0.15,
  risk: 0.15,
  event: 0.20,
  correlation: 0.10,
  technical: 0.10,
  mlBaseline: 0.30,
} as const

// ─────────────────────────────────────────────
// Sub-score computation (each returns 0-100)
// ─────────────────────────────────────────────

/**
 * Fib quality score.
 * - 0.618 ratio > 0.5 ratio (deeper retracement = stronger)
 * - Higher hook quality = better
 * - Measured move alignment = bonus
 */
function scoreFib(features: TradeFeatureVector): number {
  let score = 50

  // Fib ratio bonus
  if (features.fibRatio >= 0.618) score += 15
  else if (features.fibRatio >= 0.5) score += 8

  // Hook quality (0-1 → 0-20 contribution)
  score += features.hookQuality * 20

  // Measured move alignment
  if (features.measuredMoveAligned) {
    score += 10
    if (features.measuredMoveQuality != null && features.measuredMoveQuality >= 0.7) {
      score += 5 // high quality measured move
    }
  }

  // Acceptance / failure quality
  if (features.acceptanceState === 'ACCEPTED') score += 10
  else if (features.acceptanceState === 'UNRESOLVED') score -= 4
  else if (features.acceptanceState === 'REJECTED') score -= 8
  else if (features.acceptanceState === 'WHIPSAW_RISK') score -= 10
  else if (features.acceptanceState === 'TRAP_RISK') score -= 14
  else if (features.acceptanceState === 'FAILED_BREAK') score -= 18

  if (features.sweepFlag) score += 3
  if (features.blockerDensity === 'CLEAN') score += 4
  else if (features.blockerDensity === 'CROWDED') score -= 6

  return clamp(score, 0, 100)
}

/**
 * Risk quality score.
 * - A grade = max score
 * - Higher R:R = better
 * - Tighter stop = better (less slippage risk)
 */
function scoreRisk(features: TradeFeatureVector): number {
  const gradeScores: Record<string, number> = { A: 90, B: 70, C: 50, D: 25 }
  let score = gradeScores[features.riskGrade] ?? 40

  // R:R bonus (above 2.0 is excellent)
  if (features.rrRatio >= 3.0) score += 10
  else if (features.rrRatio >= 2.5) score += 7
  else if (features.rrRatio >= 2.0) score += 4

  // Tight stop bonus (< 3 pts on MES is tight)
  if (features.stopDistancePts < 3) score += 5
  else if (features.stopDistancePts > 8) score -= 10

  return clamp(score, 0, 100)
}

/**
 * Event awareness score.
 * - BLACKOUT = 0 (no trade)
 * - SHOCK = 0 (no trade)
 * - CLEAR = 100 (safe)
 * - Others scaled by confidence adjustment
 */
function scoreEvent(features: TradeFeatureVector): number {
  if (features.eventPhase === 'BLACKOUT') return 0
  if (features.eventPhase === 'SHOCK') return 0
  if (features.eventPhase === 'CLEAR') return 100

  // Scale by confidence adjustment (0-1 → 0-100)
  return Math.round(features.confidenceAdjustment * 100)
}

/**
 * Correlation alignment score.
 * - Aligned composite = high score
 * - Misaligned = penalize
 */
function scoreCorrelation(features: TradeFeatureVector): number {
  let score: number

  // compositeAlignment is -1 to +1 where positive = aligned with setup direction
  // isAligned already factors in direction
  if (features.isAligned) {
    // Scale positive alignment to 60-100 range
    score = Math.round(60 + Math.abs(features.compositeAlignment) * 40)
  } else {
    // Misaligned — penalize proportionally
    score = Math.round(40 - Math.abs(features.compositeAlignment) * 40)
  }

  if (features.alignedCorrelationSymbols.length >= 3) score += 4
  if (features.divergingCorrelationSymbols.length >= 2) score -= 8

  return clamp(score, 0, 100)
}

/**
 * Technical indicator score.
 * - Squeeze fired (state 4) = strong
 * - MACD state agreement = good
 * - WVF fear spike = caution
 */
function scoreTechnical(features: TradeFeatureVector): number {
  let score = 50

  // Squeeze state
  if (features.sqzState === 4) score += 20      // fired — momentum breakout
  else if (features.sqzState === 3) score += 10  // narrow squeeze — building energy
  else if (features.sqzState === 0) score += 5   // no squeeze — neutral

  // Squeeze momentum direction
  if (features.sqzMom != null) {
    // Positive mom = bullish, negative = bearish
    // We don't know the setup direction here, so just reward magnitude
    if (Math.abs(features.sqzMom) > 2) score += 5
  }

  // MACD sign-state coherence. Reward clean agreement, not bullish/bearish direction.
  if (
    features.macdAboveZero != null &&
    features.macdAboveSignal != null &&
    features.macdHistAboveZero != null
  ) {
    const bullishVotes = [
      features.macdAboveZero,
      features.macdAboveSignal,
      features.macdHistAboveZero,
    ].filter(Boolean).length

    if (bullishVotes === 0 || bullishVotes === 3) score += 8
    else score -= 3
  }

  // WVF fear spike — caution
  if (features.wvfPercentile != null && features.wvfPercentile > 1.0) {
    score -= 10 // elevated fear
  }

  return clamp(score, 0, 100)
}

/**
 * ML baseline score — scales p(TP1) to 0-100.
 */
function scoreMlBaseline(baseline: MlBaseline): number {
  // p(TP1) of 0.5 = 50, p(TP1) of 0.8 = 80, etc.
  // Apply a small confidence discount for low-sample buckets
  let score = baseline.pTp1 * 100

  if (baseline.confidence === 'low') score *= 0.9
  else if (baseline.confidence === 'medium') score *= 0.95

  return clamp(Math.round(score), 0, 100)
}

// ─────────────────────────────────────────────
// Main composite computation
// ─────────────────────────────────────────────

/**
 * Compute the composite trade score from features + ML baseline.
 *
 * Pure function — no DB calls, no side effects.
 */
export function computeCompositeScore(
  features: TradeFeatureVector,
  baseline: MlBaseline,
): TradeScore {
  const subScores = {
    fib: scoreFib(features),
    risk: scoreRisk(features),
    event: scoreEvent(features),
    correlation: scoreCorrelation(features),
    technical: scoreTechnical(features),
    mlBaseline: scoreMlBaseline(baseline),
  }

  // Weighted composite
  const composite = Math.round(
    subScores.fib * WEIGHTS.fib +
    subScores.risk * WEIGHTS.risk +
    subScores.event * WEIGHTS.event +
    subScores.correlation * WEIGHTS.correlation +
    subScores.technical * WEIGHTS.technical +
    subScores.mlBaseline * WEIGHTS.mlBaseline,
  )

  // Grade from composite
  let grade: TradeScore['grade']
  if (composite >= 75) grade = 'A'
  else if (composite >= 55) grade = 'B'
  else if (composite >= 35) grade = 'C'
  else grade = 'D'

  // Hard event veto — override to D regardless
  if (features.eventPhase === 'BLACKOUT' || features.eventPhase === 'SHOCK') {
    return {
      composite: 0,
      grade: 'D',
      pTp1: 0,
      pTp2: 0,
      subScores,
      flags: [
        features.eventPhase === 'SHOCK'
          ? 'SHOCK — immediate post-release price discovery, no trades'
          : 'BLACKOUT — economic event releasing, no trades',
      ],
    }
  }

  // Adjusted probabilities
  // Start from ML baseline, modify by event confidence and correlation alignment
  let pTp1 = baseline.pTp1 * features.confidenceAdjustment
  let pTp2 = baseline.pTp2 * features.confidenceAdjustment

  // Alignment boost/penalty
  if (features.isAligned) {
    pTp1 = Math.min(pTp1 * 1.05, 0.95) // 5% boost, capped
    pTp2 = Math.min(pTp2 * 1.05, 0.90)
  } else {
    pTp1 *= 0.90 // 10% penalty for misalignment
    pTp2 *= 0.90
  }

  // Flags
  const flags: string[] = []
  if (features.eventPhase === 'IMMINENT') {
    flags.push('Event imminent — reduced position size recommended')
  }
  if (features.eventPhase === 'SHOCK') {
    flags.push('Shock state — immediate post-release repricing underway')
  }
  if (features.eventPhase === 'DIGESTING') {
    flags.push('Post-event digestion — volatility may be elevated')
  }
  if (features.wvfPercentile != null && features.wvfPercentile > 1.0) {
    flags.push('Elevated fear (WVF) — wider stops may be needed')
  }
  if (features.riskGrade === 'D') {
    flags.push('Low R:R — consider skipping')
  }
  if (!features.isAligned) {
    flags.push('Cross-asset misalignment — lower conviction')
  }
  if (features.alignedCorrelationSymbols.length >= 3) {
    flags.push(`Correlation basket confirms: ${features.alignedCorrelationSymbols.join(', ')}`)
  }
  if (features.divergingCorrelationSymbols.length >= 2) {
    flags.push(`Correlation divergences: ${features.divergingCorrelationSymbols.join(', ')}`)
  }
  if (features.volumeState === 'THIN') {
    flags.push('Thin volume — move lacks participation')
  }
  if (features.volumeState === 'ABSORPTION') {
    flags.push('Absorption state — heavy volume with poor progress')
  }
  if (features.volumeState === 'EXHAUSTION') {
    flags.push('Exhaustion state — late move / blowoff risk')
  }
  if (baseline.confidence === 'low') {
    flags.push('Low sample count — baseline less reliable')
  }
  if (features.measuredMoveAligned) {
    flags.push('Measured move confirms direction')
  }
  if (features.sqzState === 4) {
    flags.push('Squeeze fired — momentum breakout')
  }
  if (features.acceptanceState === 'FAILED_BREAK') {
    flags.push('Failed break — invalidation risk elevated')
  }
  if (features.acceptanceState === 'TRAP_RISK') {
    flags.push('Trap risk — move may be reversing back through structure')
  }
  if (features.acceptanceState === 'WHIPSAW_RISK') {
    flags.push('Whipsaw risk — price is crossing the reference zone repeatedly')
  }
  if (features.blockerDensity === 'CROWDED') {
    flags.push('Crowded path to target — limited open space')
  }

  return {
    composite: clamp(composite, 0, 100),
    grade,
    pTp1: Math.round(pTp1 * 10000) / 10000,
    pTp2: Math.round(pTp2 * 10000) / 10000,
    subScores,
    flags,
  }
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
