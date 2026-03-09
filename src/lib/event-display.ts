export type EventDisplayPhase =
  | 'OPEN'
  | 'WATCH'
  | 'LOCKOUT'
  | 'REPRICE'
  | 'NORMAL'

interface EventDisplayContextLike {
  phase?: string | null
  eventName?: string | null
  minutesToEvent?: number | null
  minutesSinceEvent?: number | null
}

/**
 * UI-facing event state vocabulary intentionally collapses internal machine
 * nuance into glanceable decision words for the trader-facing layer.
 */
export function getEventDisplayPhase(phase: string | null | undefined): EventDisplayPhase {
  switch (phase) {
    case 'APPROACHING':
    case 'IMMINENT':
      return 'WATCH'
    case 'BLACKOUT':
      return 'LOCKOUT'
    case 'SHOCK':
    case 'DIGESTION':
      return 'REPRICE'
    case 'SETTLED':
      return 'NORMAL'
    case 'CLEAR':
    default:
      return 'OPEN'
  }
}

export function isActiveEventDisplayPhase(phase: string | null | undefined): boolean {
  const displayPhase = getEventDisplayPhase(phase)
  return displayPhase === 'WATCH' || displayPhase === 'LOCKOUT' || displayPhase === 'REPRICE'
}

export function getEventDisplayLabel(eventContext: EventDisplayContextLike | null | undefined): string {
  const phase = eventContext?.phase ?? 'CLEAR'
  const eventName = eventContext?.eventName ?? 'Scheduled event'
  const minutesToEvent = eventContext?.minutesToEvent
  const minutesSinceEvent = eventContext?.minutesSinceEvent

  switch (phase) {
    case 'APPROACHING':
      return minutesToEvent == null
        ? `${eventName} on deck`
        : `${eventName} on deck in ${Math.round(minutesToEvent)} min`
    case 'IMMINENT':
      return minutesToEvent == null
        ? `${eventName} nearing release`
        : `${eventName} nearing release in ${Math.round(minutesToEvent)} min`
    case 'BLACKOUT':
      return minutesToEvent == null
        ? `${eventName} lockout active`
        : `${eventName} lockout active (${Math.ceil(minutesToEvent)} min)`
    case 'SHOCK':
      return minutesSinceEvent == null
        ? `${eventName} repricing after release`
        : `${eventName} repricing after release (${Math.round(minutesSinceEvent)} min ago)`
    case 'DIGESTION':
      return minutesSinceEvent == null
        ? `${eventName} still stabilizing`
        : `${eventName} still stabilizing (${Math.round(minutesSinceEvent)} min ago)`
    case 'SETTLED':
      return minutesSinceEvent == null
        ? `${eventName} normalizing`
        : `${eventName} normalizing (${Math.round(minutesSinceEvent)} min ago)`
    case 'CLEAR':
    default:
      return 'No nearby scheduled events'
  }
}
