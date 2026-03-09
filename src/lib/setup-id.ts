import type { TriggerCandidate } from "@/lib/trigger-candidates";

const DEFAULT_TIMEFRAME = "M15";

type SetupIdentity = Pick<
  TriggerCandidate,
  "direction" | "fibRatio" | "fibLevel" | "createdAt"
> &
  Partial<
    Pick<TriggerCandidate, "candidateTime" | "goTime" | "hookTime" | "touchTime">
  >;

function resolveSetupEpochSeconds(setup: SetupIdentity): number {
  return setup.candidateTime ?? setup.goTime ?? setup.hookTime ?? setup.touchTime ?? setup.createdAt;
}

/**
 * Canonical setup ID shared by chart, cards, and DB persistence.
 * This must remain stable across endpoint polls for the same setup.
 */
export function canonicalSetupId(
  setup: SetupIdentity,
  timeframe: string = DEFAULT_TIMEFRAME,
): string {
  const eventEpochSeconds = resolveSetupEpochSeconds(setup);
  return [
    timeframe,
    setup.direction,
    setup.fibRatio.toFixed(3),
    setup.fibLevel.toFixed(6),
    eventEpochSeconds,
  ].join("|");
}

export function withCanonicalSetupIds(
  setups: TriggerCandidate[],
  timeframe: string = DEFAULT_TIMEFRAME,
): TriggerCandidate[] {
  return setups.map((setup) => ({
    ...setup,
    id: canonicalSetupId(setup, timeframe),
  }));
}
