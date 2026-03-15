import {
  WARBIRD_ENGINE_MODE,
  advanceWarbirdSetups,
  advanceWarbirdSetupsPure,
  toLegacyBhgSetup,
  type WarbirdSetup,
} from "../src/lib/warbird-engine";
import {
  advanceBhgSetups,
  type BhgSetup,
} from "../src/lib/bhg-engine";
import type { CandleData, FibResult, MeasuredMove } from "../src/lib/types";

type ComparableSetup = {
  id: string;
  direction: string;
  phase: string;
  fibLevel: number;
  fibRatio: number;
  touchTime: number | null;
  touchBarIndex: number | null;
  touchPrice: number | null;
  hookTime: number | null;
  hookBarIndex: number | null;
  hookLow: number | null;
  hookHigh: number | null;
  hookClose: number | null;
  goTime: number | null;
  goBarIndex: number | null;
  goType: string | null;
  entry: number | null;
  stopLoss: number | null;
  tp1: number | null;
  tp2: number | null;
  createdAt: number;
  expiryBars: number;
};

type FieldDiff = {
  setupId: string;
  field: keyof ComparableSetup;
  legacy: ComparableSetup[keyof ComparableSetup] | null;
  candidate: ComparableSetup[keyof ComparableSetup] | null;
  classification: "bug";
};

function makeFibResult(isBullish: boolean): FibResult {
  const anchorHigh = 7000;
  const anchorLow = 6900;
  const range = anchorHigh - anchorLow;
  const ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.236, 1.618];

  return {
    levels: ratios.map((ratio) => ({
      ratio,
      price: isBullish ? anchorLow + range * ratio : anchorHigh - range * ratio,
      label: String(ratio),
      color: "#fff",
      isExtension: ratio > 1,
    })),
    anchorHigh,
    anchorLow,
    isBullish,
    anchorHighBarIndex: 1,
    anchorLowBarIndex: 2,
  };
}

function makeFixedCandles(): CandleData[] {
  return [
    { time: 1, open: 6998, high: 7000, low: 6994, close: 6996, volume: 1100 },
    { time: 2, open: 6996, high: 6998, low: 6992, close: 6994, volume: 1080 },
    { time: 3, open: 6994, high: 6995, low: 6948, close: 6954, volume: 1700 },
    { time: 4, open: 6954, high: 6962, low: 6952, close: 6961, volume: 1650 },
    { time: 5, open: 6961, high: 6963, low: 6958, close: 6960, volume: 980 },
    { time: 6, open: 6960, high: 6964, low: 6957, close: 6962, volume: 1020 },
    { time: 7, open: 6962, high: 6965, low: 6960, close: 6963, volume: 1030 },
    { time: 8, open: 6963, high: 6966, low: 6961, close: 6964, volume: 1040 },
    { time: 9, open: 6964, high: 6967, low: 6962, close: 6965, volume: 1050 },
    { time: 10, open: 6965, high: 6968, low: 6963, close: 6966, volume: 1060 },
    { time: 11, open: 6966, high: 6969, low: 6964, close: 6967, volume: 1070 },
    { time: 12, open: 6967, high: 6970, low: 6965, close: 6968, volume: 1080 },
  ];
}

function toNumber(value: number | undefined): number | null {
  return value == null ? null : Number(value);
}

function normalizeSetup(setup: BhgSetup): ComparableSetup {
  return {
    id: setup.id,
    direction: setup.direction,
    phase: setup.phase,
    fibLevel: Number(setup.fibLevel),
    fibRatio: Number(setup.fibRatio),
    touchTime: toNumber(setup.touchTime),
    touchBarIndex: toNumber(setup.touchBarIndex),
    touchPrice: toNumber(setup.touchPrice),
    hookTime: toNumber(setup.hookTime),
    hookBarIndex: toNumber(setup.hookBarIndex),
    hookLow: toNumber(setup.hookLow),
    hookHigh: toNumber(setup.hookHigh),
    hookClose: toNumber(setup.hookClose),
    goTime: toNumber(setup.goTime),
    goBarIndex: toNumber(setup.goBarIndex),
    goType: setup.goType ?? null,
    entry: toNumber(setup.entry),
    stopLoss: toNumber(setup.stopLoss),
    tp1: toNumber(setup.tp1),
    tp2: toNumber(setup.tp2),
    createdAt: Number(setup.createdAt),
    expiryBars: Number(setup.expiryBars),
  };
}

function normalizeWarbird(setup: WarbirdSetup): ComparableSetup {
  return normalizeSetup(toLegacyBhgSetup(setup));
}

function sortByStableKey<T extends ComparableSetup>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const leftKey = `${left.id}|${left.phase}|${left.goTime ?? left.createdAt}`;
    const rightKey = `${right.id}|${right.phase}|${right.goTime ?? right.createdAt}`;
    return leftKey.localeCompare(rightKey);
  });
}

function compareRows(
  legacyRows: ComparableSetup[],
  candidateRows: ComparableSetup[],
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const max = Math.max(legacyRows.length, candidateRows.length);

  for (let index = 0; index < max; index++) {
    const legacy = legacyRows[index] ?? null;
    const candidate = candidateRows[index] ?? null;
    const setupId = legacy?.id ?? candidate?.id ?? `missing-${index}`;

    if (!legacy || !candidate) {
      diffs.push({
        setupId,
        field: "id",
        legacy: legacy?.id ?? null,
        candidate: candidate?.id ?? null,
        classification: "bug",
      });
      continue;
    }

    for (const field of Object.keys(legacy) as Array<keyof ComparableSetup>) {
      if (legacy[field] !== candidate[field]) {
        diffs.push({
          setupId,
          field,
          legacy: legacy[field],
          candidate: candidate[field],
          classification: "bug",
        });
      }
    }
  }

  return diffs;
}

function main() {
  const fixtureName = "fixed-fixture-12-bar-touch-hook-go-window";
  const candles = makeFixedCandles();
  const fibResult = makeFibResult(true);
  const measuredMoves: MeasuredMove[] = [];

  const legacyRaw = advanceBhgSetups(candles, fibResult, measuredMoves);
  const delegatedRaw = advanceWarbirdSetups(candles, fibResult, measuredMoves);
  const pureRaw = advanceWarbirdSetupsPure(candles, fibResult, measuredMoves);

  const legacy = sortByStableKey(legacyRaw.map(normalizeSetup));
  const delegated = sortByStableKey(delegatedRaw.map(normalizeWarbird));
  const pure = sortByStableKey(pureRaw.map(normalizeWarbird));

  const delegatedDiffs = compareRows(legacy, delegated);
  const pureDiffs = compareRows(legacy, pure);

  const summary = {
    fixtureName,
    engineMode: WARBIRD_ENGINE_MODE,
    candleWindow: {
      barCount: candles.length,
      firstBarTime: candles[0]?.time ?? null,
      lastBarTime: candles[candles.length - 1]?.time ?? null,
      bars: candles,
    },
    fibInput: {
      isBullish: fibResult.isBullish,
      anchorHigh: fibResult.anchorHigh,
      anchorLow: fibResult.anchorLow,
      ratios: fibResult.levels.map((level) => ({
        ratio: level.ratio,
        price: level.price,
      })),
    },
    measuredMoveInput: measuredMoves,
    counts: {
      legacy: legacy.length,
      delegatedWarbird: delegated.length,
      pureWarbird: pure.length,
    },
    delegatedVsLegacy: {
      matches: delegatedDiffs.length === 0,
      differences: delegatedDiffs,
      normalizedSetups: delegated,
    },
    pureVsLegacy: {
      matches: pureDiffs.length === 0,
      differences: pureDiffs,
      normalizedSetups: pure,
    },
    legacyNormalizedSetups: legacy,
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
