import type { WarbirdSetup } from "@/lib/warbird-engine";
import { prisma } from "@/lib/prisma";
import { canonicalSetupId } from "@/lib/setup-id";

export interface SetupScoringContext {
  pTp1?: number | null;
  pTp2?: number | null;
  correlationScore?: number | null;
  vixLevel?: number | null;
  modelVersion?: string | null;
}

function toDate(epochSeconds?: number): Date | null {
  return epochSeconds == null ? null : new Date(epochSeconds * 1000);
}

/**
 * Persist live TRIGGERED setups (GO_FIRED phase in DB) so chart/card emissions
 * are durably recorded even when scoring is unavailable.
 */
export async function recordTriggeredSetups(
  setups: WarbirdSetup[],
  scoringBySetupId?: Map<string, SetupScoringContext>,
): Promise<number> {
  const triggered = setups.filter(
    (setup) =>
      setup.phase === "TRIGGERED" &&
      setup.goTime != null &&
      setup.entry != null &&
      setup.stopLoss != null &&
      setup.tp1 != null,
  );

  if (triggered.length === 0) return 0;

  let persisted = 0;

  for (const setup of triggered) {
    const setupId = canonicalSetupId(setup);
    const scoring = scoringBySetupId?.get(setupId);

    await prisma.warbirdSetup.upsert({
      where: { setupId },
      create: {
        setupId,
        direction: setup.direction,
        timeframe: "M15",
        phase: "GO_FIRED",
        fibLevel: setup.fibLevel,
        fibRatio: setup.fibRatio,
        touchTime: toDate(setup.touchTime),
        hookTime: toDate(setup.hookTime),
        hookLow: setup.hookLow ?? null,
        hookHigh: setup.hookHigh ?? null,
        hookClose: setup.hookClose ?? null,
        goTime: toDate(setup.goTime),
        goType: setup.goType ?? null,
        entry: setup.entry,
        stopLoss: setup.stopLoss,
        tp1: setup.tp1,
        tp2: setup.tp2 ?? null,
        pTp1: scoring?.pTp1 ?? null,
        pTp2: scoring?.pTp2 ?? null,
        correlationScore: scoring?.correlationScore ?? null,
        vixLevel: scoring?.vixLevel ?? null,
        modelVersion: scoring?.modelVersion ?? null,
      },
      update: {
        phase: "GO_FIRED",
        touchTime: toDate(setup.touchTime),
        hookTime: toDate(setup.hookTime),
        hookLow: setup.hookLow ?? null,
        hookHigh: setup.hookHigh ?? null,
        hookClose: setup.hookClose ?? null,
        goTime: toDate(setup.goTime),
        goType: setup.goType ?? null,
        entry: setup.entry,
        stopLoss: setup.stopLoss,
        tp1: setup.tp1,
        tp2: setup.tp2 ?? null,
        pTp1: scoring?.pTp1 ?? null,
        pTp2: scoring?.pTp2 ?? null,
        correlationScore: scoring?.correlationScore ?? null,
        vixLevel: scoring?.vixLevel ?? null,
        modelVersion: scoring?.modelVersion ?? null,
      },
    });

    persisted++;
  }

  return persisted;
}
