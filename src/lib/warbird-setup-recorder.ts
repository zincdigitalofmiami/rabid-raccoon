import type { WarbirdSetup } from "@/lib/warbird-engine";
import { prisma } from "@/lib/prisma";
import { canonicalSetupId } from "@/lib/setup-id";

export interface WarbirdSetupScoringContext {
  pTp1?: number | null;
  pTp2?: number | null;
  correlationScore?: number | null;
  vixLevel?: number | null;
  modelVersion?: string | null;
}

export interface LegacyBhgSetupWritePayload {
  setupId: string;
  create: {
    setupId: string;
    direction: "BULLISH" | "BEARISH";
    timeframe: "M15";
    phase: "GO_FIRED";
    fibLevel: number;
    fibRatio: number;
    touchTime: Date | null;
    hookTime: Date | null;
    hookLow: number | null;
    hookHigh: number | null;
    hookClose: number | null;
    goTime: Date | null;
    goType: string | null;
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number | null;
    pTp1: number | null;
    pTp2: number | null;
    correlationScore: number | null;
    vixLevel: number | null;
    modelVersion: string | null;
  };
  update: {
    phase: "GO_FIRED";
    touchTime: Date | null;
    hookTime: Date | null;
    hookLow: number | null;
    hookHigh: number | null;
    hookClose: number | null;
    goTime: Date | null;
    goType: string | null;
    entry: number;
    stopLoss: number;
    tp1: number;
    tp2: number | null;
    pTp1: number | null;
    pTp2: number | null;
    correlationScore: number | null;
    vixLevel: number | null;
    modelVersion: string | null;
  };
  mappingMeta: {
    physicalTable: "bhg_setups";
    physicalPhaseEnum: "BhgPhase";
    mappedPhase: "GO_FIRED";
    strategy: "warbird-input-mapped-to-legacy-bhg-model";
  };
}

function toDate(epochSeconds?: number): Date | null {
  return epochSeconds == null ? null : new Date(epochSeconds * 1000);
}

/**
 * Build the legacy persistence payload from a Warbird setup.
 *
 * Physical DB truth (intentional for Phase 0C):
 * - Table is still `bhg_setups`
 * - Phase enum is still `BhgPhase`
 * - TRIGGERED Warbird setups map to legacy `GO_FIRED` rows
 */
export function mapTriggeredWarbirdSetupToLegacyBhgWrite(
  setup: WarbirdSetup,
  scoring?: WarbirdSetupScoringContext,
): LegacyBhgSetupWritePayload {
  const setupId = canonicalSetupId(setup);

  const shared = {
    touchTime: toDate(setup.touchTime),
    hookTime: toDate(setup.hookTime),
    hookLow: setup.hookLow ?? null,
    hookHigh: setup.hookHigh ?? null,
    hookClose: setup.hookClose ?? null,
    goTime: toDate(setup.goTime),
    goType: setup.goType ?? null,
    entry: setup.entry!,
    stopLoss: setup.stopLoss!,
    tp1: setup.tp1!,
    tp2: setup.tp2 ?? null,
    pTp1: scoring?.pTp1 ?? null,
    pTp2: scoring?.pTp2 ?? null,
    correlationScore: scoring?.correlationScore ?? null,
    vixLevel: scoring?.vixLevel ?? null,
    modelVersion: scoring?.modelVersion ?? null,
  };

  return {
    setupId,
    create: {
      setupId,
      direction: setup.direction,
      timeframe: "M15",
      phase: "GO_FIRED",
      fibLevel: setup.fibLevel,
      fibRatio: setup.fibRatio,
      ...shared,
    },
    update: {
      phase: "GO_FIRED",
      ...shared,
    },
    mappingMeta: {
      physicalTable: "bhg_setups",
      physicalPhaseEnum: "BhgPhase",
      mappedPhase: "GO_FIRED",
      strategy: "warbird-input-mapped-to-legacy-bhg-model",
    },
  };
}

/**
 * Persist live TRIGGERED Warbird setups through the current physical legacy model.
 *
 * This is an additive seam: callers are not flipped in this slice.
 */
export async function recordTriggeredWarbirdSetups(
  setups: WarbirdSetup[],
  scoringBySetupId?: Map<string, WarbirdSetupScoringContext>,
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
    const write = mapTriggeredWarbirdSetupToLegacyBhgWrite(setup, scoring);

    await prisma.bhgSetup.upsert({
      where: { setupId: write.setupId },
      create: write.create,
      update: write.update,
    });

    persisted++;
  }

  return persisted;
}
