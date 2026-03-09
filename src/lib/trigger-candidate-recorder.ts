import {
  recordTriggeredSetups,
  type SetupScoringContext,
} from '@/lib/bhg-setup-recorder'
import type { TriggerCandidate } from '@/lib/trigger-candidates'

export type TriggerScoringContext = SetupScoringContext

export async function recordTriggeredCandidates(
  candidates: TriggerCandidate[],
  scoringByCandidateId?: Map<string, TriggerScoringContext>,
): Promise<number> {
  return recordTriggeredSetups(candidates, scoringByCandidateId)
}
