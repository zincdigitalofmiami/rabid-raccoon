import { advanceBhgSetups, type BhgSetup } from '@/lib/bhg-engine'
import type { CandleData, FibResult, MeasuredMove } from '@/lib/types'

export type TriggerDirection = 'BULLISH' | 'BEARISH'
export type TriggerGoType = 'BREAK' | 'CLOSE'
export type TriggerLifecyclePhase =
  | 'AWAITING_CONTACT'
  | 'CONTACT'
  | 'CONFIRMED'
  | 'TRIGGERED'
  | 'EXPIRED'
  | 'INVALIDATED'

export type TriggerSourceFamily =
  | 'HOOK_REJECTION'
  | 'MEASURED_MOVE'
  | 'LIQUIDITY_SWEEP'
  | 'OPENING_DRIVE'

export type TriggerType =
  | 'RETRACE_REJECTION'
  | 'MEASURED_MOVE_RETRACE'
  | 'LIQUIDITY_SWEEP_RECLAIM'
  | 'OPENING_DRIVE_CONTINUATION'

export type ImpulseContext =
  | 'RETRACE'
  | 'CONTINUATION'
  | 'REVERSAL'
  | 'UNSPECIFIED'

export type LiquidityContext =
  | 'UNSPECIFIED'
  | 'RESTING_LEVEL'
  | 'SWEEP_RECLAIM'
  | 'EXPANSION'

export type StructureContext =
  | 'FIB_REJECTION'
  | 'MEASURED_MOVE'
  | 'LIQUIDITY_RECLAIM'
  | 'OPENING_DRIVE'
  | 'UNSPECIFIED'

/**
 * Engine-neutral trigger candidate contract. The current adapter still sources
 * candidates from the legacy hook-rejection engine, but downstream trigger
 * code now depends on this contract instead of a setup-family type alias.
 */
export interface TriggerCandidate {
  id: string
  sourceFamily: TriggerSourceFamily
  triggerType: TriggerType
  direction: TriggerDirection
  phase: TriggerLifecyclePhase
  thesis: string
  structuralReason: string
  candidateTime: number
  referenceLevel: number
  entryZoneLow: number | null
  entryZoneHigh: number | null
  invalidationLevel: number | null
  impulseContext: ImpulseContext
  liquidityContext: LiquidityContext
  structureContext: StructureContext

  fibLevel: number
  fibRatio: number

  touchTime?: number
  touchBarIndex?: number
  touchPrice?: number

  hookTime?: number
  hookBarIndex?: number
  hookLow?: number
  hookHigh?: number
  hookClose?: number

  goTime?: number
  goBarIndex?: number
  goType?: TriggerGoType

  entry?: number
  stopLoss?: number
  tp1?: number
  tp2?: number

  createdAt: number
  expiryBars: number
}

function buildThesis(setup: BhgSetup): string {
  const fibPercent = `${(setup.fibRatio * 100).toFixed(1)}%`
  if (setup.phase === 'TRIGGERED') {
    return `${fibPercent} retracement rejection has triggered ${setup.direction.toLowerCase()} continuation`
  }
  if (setup.phase === 'CONFIRMED') {
    return `${fibPercent} retracement rejection confirmed; waiting for trigger`
  }
  if (setup.phase === 'CONTACT') {
    return `${fibPercent} retracement tagged; waiting for rejection confirmation`
  }
  return `${fibPercent} retracement candidate forming`
}

function buildStructuralReason(setup: BhgSetup): string {
  if (setup.phase === 'TRIGGERED') {
    const triggerMode = setup.goType === 'CLOSE' ? 'close-through' : 'break-through'
    return `Hook rejection resolved via ${triggerMode} of the hook extreme`
  }
  if (setup.phase === 'CONFIRMED') {
    return 'Hook rejection is confirmed at the retracement level'
  }
  if (setup.phase === 'CONTACT') {
    return 'Price contacted the retracement level; rejection still pending'
  }
  if (setup.phase === 'EXPIRED') {
    return 'Retracement candidate expired before confirmation or trigger'
  }
  if (setup.phase === 'INVALIDATED') {
    return 'Retracement candidate invalidated before trigger'
  }
  return 'Retracement candidate is waiting for contact'
}

function resolveCandidateTime(setup: BhgSetup): number {
  return setup.goTime ?? setup.hookTime ?? setup.touchTime ?? setup.createdAt
}

function resolveEntryZoneLow(setup: BhgSetup): number | null {
  if (setup.entry == null) return setup.fibLevel
  return Math.min(setup.entry, setup.fibLevel)
}

function resolveEntryZoneHigh(setup: BhgSetup): number | null {
  if (setup.entry == null) return setup.fibLevel
  return Math.max(setup.entry, setup.fibLevel)
}

export function fromBhgSetup(setup: BhgSetup): TriggerCandidate {
  return {
    id: setup.id,
    sourceFamily: 'HOOK_REJECTION',
    triggerType: 'RETRACE_REJECTION',
    direction: setup.direction,
    phase: setup.phase,
    thesis: buildThesis(setup),
    structuralReason: buildStructuralReason(setup),
    candidateTime: resolveCandidateTime(setup),
    referenceLevel: setup.hookHigh ?? setup.hookLow ?? setup.touchPrice ?? setup.fibLevel,
    entryZoneLow: resolveEntryZoneLow(setup),
    entryZoneHigh: resolveEntryZoneHigh(setup),
    invalidationLevel: setup.stopLoss ?? null,
    impulseContext: 'RETRACE',
    liquidityContext: 'RESTING_LEVEL',
    structureContext: 'FIB_REJECTION',
    fibLevel: setup.fibLevel,
    fibRatio: setup.fibRatio,
    touchTime: setup.touchTime,
    touchBarIndex: setup.touchBarIndex,
    touchPrice: setup.touchPrice,
    hookTime: setup.hookTime,
    hookBarIndex: setup.hookBarIndex,
    hookLow: setup.hookLow,
    hookHigh: setup.hookHigh,
    hookClose: setup.hookClose,
    goTime: setup.goTime,
    goBarIndex: setup.goBarIndex,
    goType: setup.goType,
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    tp1: setup.tp1,
    tp2: setup.tp2,
    createdAt: setup.createdAt,
    expiryBars: setup.expiryBars,
  }
}

export function toBhgSetup(candidate: TriggerCandidate): BhgSetup {
  return {
    id: candidate.id,
    direction: candidate.direction,
    phase: candidate.phase,
    fibLevel: candidate.fibLevel,
    fibRatio: candidate.fibRatio,
    touchTime: candidate.touchTime,
    touchBarIndex: candidate.touchBarIndex,
    touchPrice: candidate.touchPrice,
    hookTime: candidate.hookTime,
    hookBarIndex: candidate.hookBarIndex,
    hookLow: candidate.hookLow,
    hookHigh: candidate.hookHigh,
    hookClose: candidate.hookClose,
    goTime: candidate.goTime,
    goBarIndex: candidate.goBarIndex,
    goType: candidate.goType,
    entry: candidate.entry,
    stopLoss: candidate.stopLoss,
    tp1: candidate.tp1,
    tp2: candidate.tp2,
    createdAt: candidate.createdAt,
    expiryBars: candidate.expiryBars,
  }
}

export function generateTriggerCandidates(
  candles: CandleData[],
  fibResult: FibResult,
  measuredMoves: MeasuredMove[],
): TriggerCandidate[] {
  return advanceBhgSetups(candles, fibResult, measuredMoves).map(fromBhgSetup)
}

export function getTriggeredCandidates(
  candidates: TriggerCandidate[],
): TriggerCandidate[] {
  return candidates.filter((candidate) => candidate.phase === 'TRIGGERED')
}
