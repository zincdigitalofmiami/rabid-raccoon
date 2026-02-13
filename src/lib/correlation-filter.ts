/**
 * Correlation Filter — Alignment Scoring
 *
 * Wraps the existing computeCorrelations() from market-context.ts
 * and adds directional alignment scoring for BHG setups.
 */

import { CandleData } from './types'
import { computeCorrelations } from './market-context'
import type { SetupDirection } from './bhg-engine'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CorrelationAlignment {
  vix: number        // raw MES-VIX correlation
  dxy: number        // raw MES-DXY correlation
  nq: number         // raw MES-NQ correlation
  composite: number  // -1 (short-aligned) to +1 (long-aligned)
  isAligned: boolean // composite agrees with setup direction
  details: string    // human-readable summary
}

// ─── Core ─────────────────────────────────────────────────────────────────────

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/**
 * Compute alignment score for a given setup direction.
 *
 * Uses the existing pearson correlation computation from market-context.ts,
 * then translates raw correlations into a directional alignment score.
 *
 * Logic:
 * - VIX: Negative MES-VIX = risk-on = bullish-aligned. Weight: 0.4
 * - NQ:  Positive MES-NQ = tech confirming = bullish-aligned. Weight: 0.3
 * - DXY: Negative MES-DXY = weak dollar = bullish-aligned. Weight: 0.3
 */
export function computeAlignmentScore(
  symbolCandles: Map<string, CandleData[]>,
  setupDirection: SetupDirection
): CorrelationAlignment {
  const correlations = computeCorrelations(symbolCandles)

  const vixCorr = correlations.find((c) => c.pair === 'MES↔VX')
  const dxyCorr = correlations.find((c) => c.pair === 'MES↔DX')
  const nqCorr = correlations.find((c) => c.pair === 'MES↔NQ')

  const vixRaw = vixCorr?.value ?? 0
  const dxyRaw = dxyCorr?.value ?? 0
  const nqRaw = nqCorr?.value ?? 0

  // Translate to bullish-alignment scores:
  // VIX inverse: negative correlation = bullish (risk-on)
  const vixScore = -vixRaw
  // DXY inverse: negative correlation = bullish (weak dollar)
  const dxyScore = -dxyRaw
  // NQ positive: positive correlation = bullish (tech confirming)
  const nqScore = nqRaw

  // Weighted composite (bullish-aligned scale: -1 to +1)
  const composite = clamp(
    0.4 * vixScore + 0.3 * nqScore + 0.3 * dxyScore,
    -1,
    1
  )

  // Alignment with the specific setup direction
  const isAligned =
    setupDirection === 'BULLISH' ? composite > 0 : composite < 0

  // Human-readable summary
  const parts: string[] = []
  if (Math.abs(vixRaw) > 0.3) {
    parts.push(`VIX ${vixRaw > 0 ? 'positive' : 'inverse'} (${vixRaw.toFixed(2)})`)
  }
  if (Math.abs(nqRaw) > 0.3) {
    parts.push(`NQ ${nqRaw > 0 ? 'confirming' : 'diverging'} (${nqRaw.toFixed(2)})`)
  }
  if (Math.abs(dxyRaw) > 0.3) {
    parts.push(`DXY ${dxyRaw > 0 ? 'headwind' : 'tailwind'} (${dxyRaw.toFixed(2)})`)
  }
  const details =
    parts.length > 0
      ? `${isAligned ? 'Aligned' : 'Conflicted'}: ${parts.join(', ')}`
      : `Neutral cross-asset regime (composite ${composite.toFixed(2)})`

  return {
    vix: vixRaw,
    dxy: dxyRaw,
    nq: nqRaw,
    composite: Number(composite.toFixed(3)),
    isAligned,
    details,
  }
}
