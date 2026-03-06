import type { BhgSetup } from "@/lib/bhg-engine";

const DEFAULT_TIMEFRAME = "M15";

function resolveSetupEpochSeconds(setup: BhgSetup): number {
  return setup.goTime ?? setup.hookTime ?? setup.touchTime ?? setup.createdAt;
}

/**
 * Canonical setup ID shared by chart, cards, and DB persistence.
 * This must remain stable across endpoint polls for the same setup.
 */
export function canonicalSetupId(
  setup: BhgSetup,
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
  setups: BhgSetup[],
  timeframe: string = DEFAULT_TIMEFRAME,
): BhgSetup[] {
  return setups.map((setup) => ({
    ...setup,
    id: canonicalSetupId(setup, timeframe),
  }));
}
