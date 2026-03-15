/**
 * Warbird engine bootstrap surface (Phase 0C, slice 1).
 *
 * IMPORTANT:
 * This module is intentionally additive and does NOT flip any production caller.
 * For this first slice, Warbird setup advancement delegates to the legacy BHG
 * engine so we can establish a compile-safe seam before parity/refactor work.
 */

import {
  advanceBhgSetups,
  type BhgSetup,
} from "./bhg-engine";
import type { CandleData, FibResult, MeasuredMove } from "./types";

export type WarbirdGoType = "BREAK" | "CLOSE";
export type WarbirdPhase =
  | "AWAITING_CONTACT"
  | "CONTACT"
  | "CONFIRMED"
  | "TRIGGERED"
  | "EXPIRED"
  | "INVALIDATED";
export type WarbirdDirection = "BULLISH" | "BEARISH";
export interface WarbirdTouchableFibLevel {
  level: number;
  ratio: number;
}

const WARBIRD_TOUCH_FIB_RATIOS = [0.5, 0.618] as const;
const WARBIRD_DEFAULT_EXPIRY_BARS = 20;
const WARBIRD_MES_TICK_SIZE = 0.25;
const WARBIRD_PRICE_BUFFER_RATIO = 0.02;

export interface WarbirdSetup extends Omit<BhgSetup, "direction" | "phase" | "goType"> {
  direction: WarbirdDirection;
  phase: WarbirdPhase;
  goType?: WarbirdGoType;
  legacyBridge?: {
    delegated: true;
    sourceEngine: "bhg-engine";
    sourceId: string;
  };
}

export function findWarbirdTouchableFibLevels(
  fibResult: FibResult,
): WarbirdTouchableFibLevel[] {
  const result: WarbirdTouchableFibLevel[] = [];
  for (const level of fibResult.levels) {
    if (WARBIRD_TOUCH_FIB_RATIOS.includes(level.ratio as 0.5 | 0.618)) {
      result.push({ level: level.price, ratio: level.ratio });
    }
  }
  return result;
}

function roundToWarbirdTick(
  price: number,
  tickSize: number = WARBIRD_MES_TICK_SIZE,
): number {
  return Math.round(price / tickSize) * tickSize;
}

function findWarbirdFibLevelPrice(fibResult: FibResult, ratio: number): number | null {
  const level = fibResult.levels.find((item) => Math.abs(item.ratio - ratio) <= 0.002);
  return level ? level.price : null;
}

/**
 * TOUCH: candle range tags fib level.
 */
export function detectWarbirdTouch(
  candle: CandleData,
  barIndex: number,
  fibLevel: number,
  fibRatio: number,
  isBullish: boolean,
): WarbirdSetup | null {
  const isTagged = candle.low <= fibLevel && candle.high >= fibLevel;
  if (!isTagged) return null;

  const direction: WarbirdDirection = isBullish ? "BULLISH" : "BEARISH";
  return {
    id: `${direction}-${fibRatio}-${barIndex}`,
    direction,
    phase: "CONTACT",
    fibLevel,
    fibRatio,
    touchTime: candle.time,
    touchBarIndex: barIndex,
    touchPrice: fibLevel,
    createdAt: candle.time,
    expiryBars: WARBIRD_DEFAULT_EXPIRY_BARS,
  };
}

/**
 * HOOK: wick rejection at fib level.
 */
export function detectWarbirdHook(
  candle: CandleData,
  barIndex: number,
  setup: WarbirdSetup,
): WarbirdSetup | null {
  if (setup.phase !== "CONTACT") return null;

  const body = Math.abs(candle.close - candle.open);

  if (setup.direction === "BULLISH") {
    const rejectionWick = candle.close - candle.low;
    if (
      candle.low <= setup.fibLevel &&
      candle.close > setup.fibLevel &&
      rejectionWick >= body
    ) {
      return {
        ...setup,
        phase: "CONFIRMED",
        hookTime: candle.time,
        hookBarIndex: barIndex,
        hookLow: candle.low,
        hookHigh: candle.high,
        hookClose: candle.close,
      };
    }
  }

  if (setup.direction === "BEARISH") {
    const rejectionWick = candle.high - candle.close;
    if (
      candle.high >= setup.fibLevel &&
      candle.close < setup.fibLevel &&
      rejectionWick >= body
    ) {
      return {
        ...setup,
        phase: "CONFIRMED",
        hookTime: candle.time,
        hookBarIndex: barIndex,
        hookLow: candle.low,
        hookHigh: candle.high,
        hookClose: candle.close,
      };
    }
  }

  return null;
}

/**
 * GO: break/close through hook extreme with strict break checks and expiry.
 */
export function detectWarbirdGo(
  candle: CandleData,
  barIndex: number,
  setup: WarbirdSetup,
): WarbirdSetup | null {
  if (setup.phase !== "CONFIRMED") return null;

  if (barIndex - (setup.hookBarIndex ?? 0) > setup.expiryBars) {
    return { ...setup, phase: "EXPIRED" };
  }

  if (setup.direction === "BULLISH") {
    const hookHigh = setup.hookHigh!;
    if (candle.high > hookHigh) {
      return {
        ...setup,
        phase: "TRIGGERED",
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: candle.close > hookHigh ? "CLOSE" : "BREAK",
      };
    }
    if (candle.close > hookHigh) {
      return {
        ...setup,
        phase: "TRIGGERED",
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: "CLOSE",
      };
    }
  }

  if (setup.direction === "BEARISH") {
    const hookLow = setup.hookLow!;
    if (candle.low < hookLow) {
      return {
        ...setup,
        phase: "TRIGGERED",
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: candle.close < hookLow ? "CLOSE" : "BREAK",
      };
    }
    if (candle.close < hookLow) {
      return {
        ...setup,
        phase: "TRIGGERED",
        goTime: candle.time,
        goBarIndex: barIndex,
        goType: "CLOSE",
      };
    }
  }

  return null;
}

/**
 * Compute Warbird entry/SL/TP1/TP2 for TRIGGERED setups.
 *
 * Phase 0C behavior intentionally matches current legacy semantics while this
 * logic is being brought under Warbird ownership.
 */
export function computeWarbirdTargets(
  setup: WarbirdSetup,
  fibResult: FibResult,
  measuredMoves: MeasuredMove[],
): WarbirdSetup {
  if (setup.phase !== "TRIGGERED") return setup;

  const range = fibResult.anchorHigh - fibResult.anchorLow;
  if (range <= 0) return setup;

  const entry = roundToWarbirdTick(setup.hookClose ?? setup.fibLevel);
  const buffer = Math.max(WARBIRD_MES_TICK_SIZE, range * WARBIRD_PRICE_BUFFER_RATIO);
  const minDistance = Math.max(buffer * 1.5, WARBIRD_MES_TICK_SIZE * 4);

  const stopRatio = setup.fibRatio === 0.5 ? 0.618 : 0.786;
  const stopCandidate = findWarbirdFibLevelPrice(fibResult, stopRatio);
  let stopLoss = 0;

  if (setup.direction === "BULLISH") {
    const belowEntry = [stopCandidate, setup.fibLevel, fibResult.anchorLow]
      .filter((value): value is number => value != null && Number.isFinite(value) && value < entry);
    const stopBase = belowEntry.length > 0 ? Math.max(...belowEntry) : entry - minDistance;
    stopLoss = roundToWarbirdTick(stopBase - buffer);
    if (stopLoss >= entry) stopLoss = roundToWarbirdTick(entry - minDistance);
  } else {
    const aboveEntry = [stopCandidate, setup.fibLevel, fibResult.anchorHigh]
      .filter((value): value is number => value != null && Number.isFinite(value) && value > entry);
    const stopBase = aboveEntry.length > 0 ? Math.min(...aboveEntry) : entry + minDistance;
    stopLoss = roundToWarbirdTick(stopBase + buffer);
    if (stopLoss <= entry) stopLoss = roundToWarbirdTick(entry + minDistance);
  }

  const ext1236 = findWarbirdFibLevelPrice(fibResult, 1.236);
  const ext1618 = findWarbirdFibLevelPrice(fibResult, 1.618);

  let tp1 = 0;
  let tp2 = 0;
  if (setup.direction === "BULLISH") {
    const tp1Candidates = [ext1236, fibResult.anchorHigh + range * 0.236]
      .filter((value): value is number => value != null && Number.isFinite(value) && value > entry);
    const tp1Base = tp1Candidates.length > 0 ? Math.min(...tp1Candidates) : entry + minDistance;
    tp1 = roundToWarbirdTick(tp1Base);

    const tp2Candidates = [ext1618, fibResult.anchorHigh + range * 0.618]
      .filter((value): value is number => value != null && Number.isFinite(value) && value > tp1);
    const tp2Base = tp2Candidates.length > 0 ? Math.min(...tp2Candidates) : tp1 + minDistance;
    tp2 = roundToWarbirdTick(tp2Base);
    if (tp2 <= tp1) tp2 = roundToWarbirdTick(tp1 + minDistance);
  } else {
    const tp1Candidates = [ext1236, fibResult.anchorLow - range * 0.236]
      .filter((value): value is number => value != null && Number.isFinite(value) && value < entry);
    const tp1Base = tp1Candidates.length > 0 ? Math.max(...tp1Candidates) : entry - minDistance;
    tp1 = roundToWarbirdTick(tp1Base);

    const tp2Candidates = [ext1618, fibResult.anchorLow - range * 0.618]
      .filter((value): value is number => value != null && Number.isFinite(value) && value < tp1);
    const tp2Base = tp2Candidates.length > 0 ? Math.max(...tp2Candidates) : tp1 - minDistance;
    tp2 = roundToWarbirdTick(tp2Base);
    if (tp2 >= tp1) tp2 = roundToWarbirdTick(tp1 - minDistance);
  }

  const alignedMove = measuredMoves.find(
    (move) =>
      move.direction === setup.direction &&
      (move.status === "ACTIVE" || move.status === "FORMING"),
  );
  if (alignedMove) {
    const mmTarget = roundToWarbirdTick(alignedMove.target);
    const validDirectionalTarget =
      (setup.direction === "BULLISH" && mmTarget > entry) ||
      (setup.direction === "BEARISH" && mmTarget < entry);

    if (validDirectionalTarget) {
      tp1 = mmTarget;
      if (setup.direction === "BULLISH" && tp2 <= tp1) tp2 = roundToWarbirdTick(tp1 + minDistance);
      if (setup.direction === "BEARISH" && tp2 >= tp1) tp2 = roundToWarbirdTick(tp1 - minDistance);
    }
  }

  return { ...setup, entry, stopLoss, tp1, tp2 };
}

/**
 * Source-of-truth for the current bootstrap mode.
 * 0D parity work should stay anchored to this explicit contract.
 */
export const WARBIRD_ENGINE_MODE = "legacy-bhg-delegation" as const;

export function fromLegacyBhgSetup(setup: BhgSetup): WarbirdSetup {
  return {
    ...setup,
    legacyBridge: {
      delegated: true,
      sourceEngine: "bhg-engine",
      sourceId: setup.id,
    },
  };
}

export function toLegacyBhgSetup(setup: WarbirdSetup): BhgSetup {
  const { legacyBridge: _bridge, ...legacyCompatible } = setup;
  return legacyCompatible;
}

/**
 * Full non-delegating Warbird advancement path.
 *
 * Phase 0C behavior intentionally mirrors legacy advancement semantics while the
 * exported/public route still delegates for production safety.
 */
export function advanceWarbirdSetupsPure(
  candles: CandleData[],
  fibResult: FibResult,
  measuredMoves: MeasuredMove[],
): WarbirdSetup[] {
  if (candles.length < 10 || !fibResult) return [];

  const touchLevels = findWarbirdTouchableFibLevels(fibResult);
  if (touchLevels.length === 0) return [];

  const activeSetups: Map<string, WarbirdSetup> = new Map();
  const completedSetups: WarbirdSetup[] = [];
  const firedGoKeys = new Set<string>();

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // 1) Detect new touch setups when no active setup exists for the same ratio+direction.
    for (const { level, ratio } of touchLevels) {
      for (const isBullish of [true, false] as const) {
        const direction: WarbirdDirection = isBullish ? "BULLISH" : "BEARISH";
        const dedupeKey = `${direction}-${ratio}`;

        const hasActive = [...activeSetups.values()].some(
          (setup) =>
            setup.direction === direction &&
            setup.fibRatio === ratio &&
            setup.phase !== "EXPIRED" &&
            setup.phase !== "INVALIDATED" &&
            setup.phase !== "TRIGGERED",
        );
        if (hasActive) continue;

        if (firedGoKeys.has(dedupeKey)) {
          const lastGo = completedSetups.find(
            (setup) =>
              setup.direction === direction &&
              setup.fibRatio === ratio &&
              setup.phase === "TRIGGERED",
          );
          if (lastGo && i - (lastGo.goBarIndex ?? 0) < 40) continue;
          firedGoKeys.delete(dedupeKey);
        }

        const touch = detectWarbirdTouch(candle, i, level, ratio, isBullish);
        if (touch) {
          activeSetups.set(touch.id, touch);
        }
      }
    }

    // 2) Advance active setups through hook/go/expiry transitions.
    for (const [id, setup] of activeSetups) {
      let updated: WarbirdSetup | null = null;

      if (setup.phase === "CONTACT") {
        updated = detectWarbirdHook(candle, i, setup);
      }

      if (!updated && setup.phase === "CONFIRMED") {
        updated = detectWarbirdGo(candle, i, setup);
      }

      if (updated) {
        if (updated.phase === "TRIGGERED") {
          const withTargets = computeWarbirdTargets(updated, fibResult, measuredMoves);
          completedSetups.push(withTargets);
          activeSetups.delete(id);
          firedGoKeys.add(`${updated.direction}-${updated.fibRatio}`);
        } else if (updated.phase === "EXPIRED" || updated.phase === "INVALIDATED") {
          completedSetups.push(updated);
          activeSetups.delete(id);
        } else {
          activeSetups.set(id, updated);
        }
      } else if (setup.phase === "CONTACT") {
        if (i - (setup.touchBarIndex ?? 0) > 10) {
          activeSetups.delete(id);
          completedSetups.push({ ...setup, phase: "EXPIRED" });
        }
      } else if (setup.phase === "CONFIRMED") {
        if (i - (setup.hookBarIndex ?? 0) > setup.expiryBars) {
          activeSetups.delete(id);
          completedSetups.push({ ...setup, phase: "EXPIRED" });
        }
      }
    }
  }

  return [
    ...activeSetups.values(),
    ...completedSetups.sort((a, b) => (b.goTime ?? b.createdAt) - (a.goTime ?? a.createdAt)),
  ];
}

/**
 * Warbird setup advancement seam.
 *
 * Phase 0C bootstrap behavior:
 * - delegates to advanceBhgSetups()
 * - remaps to Warbird-named surface
 * - makes delegation explicit via legacyBridge metadata
 */
export function advanceWarbirdSetups(
  candles: CandleData[],
  fibResult: FibResult,
  measuredMoves: MeasuredMove[],
): WarbirdSetup[] {
  // NOTE (Phase 0C): state-machine advancement is still delegated to legacy.
  // advanceWarbirdSetupsPure exists, but public/exported behavior remains delegated in this slice.
  const legacy = advanceBhgSetups(candles, fibResult, measuredMoves);
  return legacy.map(fromLegacyBhgSetup);
}
