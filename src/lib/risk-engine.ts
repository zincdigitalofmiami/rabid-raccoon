/**
 * Risk Engine — Position Sizing
 *
 * Pure functions for computing stop distance, contract size, dollar risk,
 * and risk:reward ratio. Extracted from instant-analysis.ts for reuse
 * across BHG engine and API endpoints.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RiskParams {
  accountSize: number   // e.g. 10000
  riskPercent: number   // e.g. 0.01 = 1%
  tickValue: number     // MES = $1.25 per tick
  tickSize: number      // MES = 0.25 points per tick
}

export interface RiskResult {
  stopPrice: number
  stopDistance: number   // in points
  stopTicks: number      // in ticks
  contracts: number
  dollarRisk: number
  rr: number             // risk:reward ratio
  grade: RiskGrade
}

export type RiskGrade = 'A' | 'B' | 'C' | 'D'

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const MES_DEFAULTS: RiskParams = {
  accountSize: 10000,
  riskPercent: 0.01,
  tickValue: 1.25,
  tickSize: 0.25,
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Compute position sizing and risk metrics for a trade.
 */
export function computeRisk(
  entry: number,
  stopLoss: number,
  target: number,
  params: RiskParams = MES_DEFAULTS
): RiskResult {
  const stopDistance = Math.abs(entry - stopLoss)
  const stopTicks = Math.round(stopDistance / params.tickSize)
  const dollarRiskPerContract = stopTicks * params.tickValue
  const maxRisk = params.accountSize * params.riskPercent

  // Minimum 1 contract
  const contracts =
    dollarRiskPerContract > 0
      ? Math.max(1, Math.floor(maxRisk / dollarRiskPerContract))
      : 1

  const dollarRisk = contracts * dollarRiskPerContract
  const reward = Math.abs(target - entry)
  const rr = stopDistance > 0 ? Number((reward / stopDistance).toFixed(2)) : 0

  const grade = computeRiskGrade(rr)

  return {
    stopPrice: stopLoss,
    stopDistance: Number(stopDistance.toFixed(2)),
    stopTicks,
    contracts,
    dollarRisk: Number(dollarRisk.toFixed(2)),
    rr,
    grade,
  }
}

/**
 * Grade the trade based on risk:reward ratio.
 *
 * A: R:R >= 2.5 (excellent)
 * B: R:R >= 1.8 (good)
 * C: R:R >= 1.2 (acceptable)
 * D: R:R < 1.2 (poor)
 */
export function computeRiskGrade(rr: number): RiskGrade {
  if (rr >= 2.5) return 'A'
  if (rr >= 1.8) return 'B'
  if (rr >= 1.2) return 'C'
  return 'D'
}
