import { advanceBhgSetups, type BhgSetup } from '@/lib/bhg-engine'
import type { CandleData, FibResult, MeasuredMove } from '@/lib/types'

// Current runtime candidate generation still delegates to the legacy BHG engine.
// This seam keeps the live trigger path from hard-coding that dependency everywhere.
export type TriggerCandidate = BhgSetup
export type TriggerDirection = TriggerCandidate['direction']

export function generateTriggerCandidates(
  candles: CandleData[],
  fibResult: FibResult,
  measuredMoves: MeasuredMove[],
): TriggerCandidate[] {
  return advanceBhgSetups(candles, fibResult, measuredMoves)
}

export function getTriggeredCandidates(
  candidates: TriggerCandidate[],
): TriggerCandidate[] {
  return candidates.filter((candidate) => candidate.phase === 'TRIGGERED')
}
