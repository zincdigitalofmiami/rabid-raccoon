/**
 * Monte Carlo Price Path Simulation — "Pinball" Model
 *
 * TRAINING-TIME MODEL — runs during dataset construction and model validation.
 * Not executed in the live signal pipeline.
 *
 * Simulates N independent price paths using Geometric Brownian Motion seeded
 * with historical volatility (ATR-based) and Warbird ML directional drift.
 *
 * "Pinball" analogy: price bounces between fib support/resistance levels.
 * We count how many simulated balls reach TP1 or TP2 before hitting the stop.
 *
 * Usage in training scripts:
 *   import { runMonteCarlo } from './monte-carlo'
 *   const mc = runMonteCarlo({ entry, stop, tp1, tp2, candles, mlProbUp })
 *   // mc.pTp1 ≈ 0.62   → 62% of simulated paths hit TP1 before stop
 *   // mc.pTp2 ≈ 0.38   → 38% of ALL paths hit TP2 (subset of pTp1 paths)
 *
 * In the live app, pTp1/pTp2 come directly from Warbird trained predictions
 * (public/ml-predictions.json), not from this model.
 */

import type { CandleData } from '../src/lib/types'

// ─── Configuration ────────────────────────────────────────────────────────────

const N_PATHS = 2000    // simulation paths — standard error of mean ≈ sqrt(p*(1-p)/N) ≤ 0.011
const N_STEPS = 96      // bars to simulate (96 × 15m = 24h = 1 trading day)

/**
 * Maximum per-bar drift contribution from the ML model.
 * Calibrated so that a 70% ML probability (strong conviction) adds ~0.015%
 * directional drift per 15m bar — consistent with MES intraday momentum.
 * Formula: drift = (mlProb - 0.5) * 2 * MAX_ML_DRIFT_PER_BAR
 */
const MAX_ML_DRIFT_PER_BAR = 0.00015

// ─── Output ───────────────────────────────────────────────────────────────────

export interface MonteCarloResult {
  /** Fraction of paths that reached TP1 before hitting the stop (0-1). */
  pTp1: number
  /** Fraction of ALL paths that reached TP2 (a subset of pTp1 paths). */
  pTp2: number
  /** Volatility (σ per bar) used in the simulation. */
  sigma: number
  /** Drift (μ per bar) applied from the ML model. */
  drift: number
  /** Number of simulated paths. */
  nPaths: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Box-Muller transform: generates a standard normal random variate.
 * Pure-JS, no dependency.
 */
function randNormal(): number {
  let u = 0, v = 0
  while (u === 0) u = Math.random()
  while (v === 0) v = Math.random()
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

/**
 * Per-bar log-return volatility from the last `period` candles.
 * Returns σ as a fraction (e.g., 0.0012 = 0.12% per 15m bar).
 */
function computeSigma(candles: CandleData[], period = 20): number {
  const n = candles.length
  if (n < period + 1) return 0.001  // safe fallback ≈ 1 MES point at 5,000
  const logReturns: number[] = []
  for (let i = n - period; i < n; i++) {
    const prev = candles[i - 1].close
    const curr = candles[i].close
    if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev))
  }
  if (logReturns.length < 4) return 0.001
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length
  const variance =
    logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1)
  return Math.sqrt(variance)
}

// ─── Core simulation ─────────────────────────────────────────────────────────

export interface MonteCarloInput {
  /** Entry price (= fib level). */
  entry: number
  /** Stop price (next deeper fib). */
  stop: number
  /** Take-profit 1 (1.236 extension). */
  tp1: number
  /** Take-profit 2 (1.618 extension). */
  tp2: number
  /** OHLCV candles for historical vol estimation (oldest first). */
  candles: CandleData[]
  /**
   * Warbird probability of price going UP over the next 1-4h (0-1).
   * 0.5 = neutral (no drift). 0.65 = moderate bullish drift.
   * Pass (1 - prob) for bearish setups if the probability is expressed as prob_up.
   */
  mlProbUp: number
  /** Override N_PATHS for tests. */
  nPaths?: number
  /** Override N_STEPS for tests. */
  nSteps?: number
}

/**
 * Run Monte Carlo simulation and return TP1/TP2 hit probabilities.
 *
 * Direction is inferred from entry vs. stop:
 *   - entry > stop → BULLISH (stop is below entry)
 *   - entry < stop → BEARISH (stop is above entry)
 */
export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const { entry, stop, tp1, tp2, candles, mlProbUp } = input
  const paths = input.nPaths ?? N_PATHS
  const steps = input.nSteps ?? N_STEPS

  const isBullish = entry > stop

  // Per-bar sigma from historical log returns
  const sigma = computeSigma(candles)

  // ML-derived drift per bar (small directional nudge from Warbird)
  // Convert probability to drift: prob=0.5 → drift=0, prob=0.65 → drift≈+0.00015
  // Clamped to avoid unrealistic values
  const probClamped = Math.max(0.1, Math.min(0.9, mlProbUp))
  const rawDrift = (probClamped - 0.5) * 2 * MAX_ML_DRIFT_PER_BAR
  const drift = isBullish ? rawDrift : -Math.abs(rawDrift)  // align with direction

  // GBM parameters: X_{t+1} = X_t * exp((μ - σ²/2) * dt + σ * Z)
  const driftAdj = drift - 0.5 * sigma * sigma  // drift adjustment for GBM

  let tp1Hits = 0
  let tp2Hits = 0

  for (let p = 0; p < paths; p++) {
    let price = entry
    let hitTp1 = false

    for (let t = 0; t < steps; t++) {
      const z = randNormal()
      price = price * Math.exp(driftAdj + sigma * z)

      if (isBullish) {
        if (price <= stop) break                       // stopped out
        if (!hitTp1 && price >= tp1) { hitTp1 = true; tp1Hits++ }
        if (hitTp1 && price >= tp2) { tp2Hits++; break }
      } else {
        if (price >= stop) break                       // stopped out
        if (!hitTp1 && price <= tp1) { hitTp1 = true; tp1Hits++ }
        if (hitTp1 && price <= tp2) { tp2Hits++; break }
      }
    }
  }

  return {
    pTp1: Math.round((tp1Hits / paths) * 10000) / 10000,
    pTp2: Math.round((tp2Hits / paths) * 10000) / 10000,
    sigma,
    drift,
    nPaths: paths,
  }
}
