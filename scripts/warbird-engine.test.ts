import test from "node:test";
import assert from "node:assert/strict";
import {
  WARBIRD_ENGINE_MODE,
  advanceWarbirdSetups,
  advanceWarbirdSetupsPure,
  computeWarbirdTargets,
  detectWarbirdGo,
  detectWarbirdHook,
  detectWarbirdTouch,
  findWarbirdTouchableFibLevels,
  type WarbirdSetup,
  toLegacyBhgSetup,
} from "../src/lib/warbird-engine";
import {
  advanceBhgSetups,
  computeTargets,
  detectGo,
  detectHook,
  detectTouch,
  findTouchableFibLevels,
  type BhgSetup,
} from "../src/lib/bhg-engine";
import type { CandleData, FibResult, MeasuredMove } from "../src/lib/types";

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
    // Touch + hook zone near 0.5 and 0.618 retracement bands.
    { time: 3, open: 6994, high: 6995, low: 6948, close: 6954, volume: 1700 },
    // Go-style follow-through bar.
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

function makeBaseGoSetup(direction: "BULLISH" | "BEARISH") {
  return {
    id: `${direction}-0.5-1`,
    direction,
    phase: "TRIGGERED" as const,
    fibLevel: 6950,
    fibRatio: 0.5,
    hookTime: 1,
    hookBarIndex: 1,
    hookLow: 6940,
    hookHigh: 6960,
    hookClose: 6950,
    goTime: 2,
    goBarIndex: 2,
    goType: "BREAK" as const,
    createdAt: 1,
    expiryBars: 20,
  };
}

function makeWarbirdGoSetup(direction: "BULLISH" | "BEARISH"): WarbirdSetup {
  return makeBaseGoSetup(direction);
}

function makeBhgGoSetup(direction: "BULLISH" | "BEARISH"): BhgSetup {
  return makeBaseGoSetup(direction);
}

test("warbird bootstrap mode is explicit", () => {
  assert.equal(WARBIRD_ENGINE_MODE, "legacy-bhg-delegation");
});

test("findWarbirdTouchableFibLevels exists and matches intended bootstrap semantics", () => {
  const fib = makeFibResult(true);
  const warbirdFirst = findWarbirdTouchableFibLevels(fib);
  const warbirdSecond = findWarbirdTouchableFibLevels(fib);
  const legacy = findTouchableFibLevels(fib);

  assert.deepEqual(warbirdSecond, warbirdFirst);
  assert.deepEqual(warbirdFirst, legacy);
});

test("detectWarbirdTouch exists and matches intended bootstrap semantics", () => {
  const candle: CandleData = {
    time: 100,
    open: 6952,
    high: 6956,
    low: 6948,
    close: 6954,
    volume: 1000,
  };
  const fibLevel = 6950;
  const fibRatio = 0.5;

  const warbird = detectWarbirdTouch(candle, 3, fibLevel, fibRatio, true);
  const warbirdRepeat = detectWarbirdTouch(candle, 3, fibLevel, fibRatio, true);
  const legacy = detectTouch(candle, 3, fibLevel, fibRatio, true);

  assert.deepEqual(warbirdRepeat, warbird);
  assert.deepEqual(warbird, legacy);
});

test("detectWarbirdHook exists and matches intended bootstrap semantics", () => {
  const touchCandle: CandleData = {
    time: 100,
    open: 6952,
    high: 6956,
    low: 6948,
    close: 6954,
    volume: 1000,
  };
  const hookCandle: CandleData = {
    time: 101,
    open: 6953,
    high: 6958,
    low: 6949,
    close: 6956,
    volume: 1005,
  };

  const warbirdTouched = detectWarbirdTouch(touchCandle, 3, 6950, 0.5, true);
  const legacyTouched = detectTouch(touchCandle, 3, 6950, 0.5, true);
  assert.ok(warbirdTouched);
  assert.ok(legacyTouched);

  const warbirdHook = detectWarbirdHook(hookCandle, 4, warbirdTouched);
  const warbirdHookRepeat = detectWarbirdHook(hookCandle, 4, warbirdTouched);
  const legacyHook = detectHook(hookCandle, 4, legacyTouched);

  assert.deepEqual(warbirdHookRepeat, warbirdHook);
  assert.deepEqual(warbirdHook, legacyHook);
});

test("detectWarbirdGo exists and matches intended bootstrap semantics", () => {
  const touchCandle: CandleData = {
    time: 100,
    open: 6952,
    high: 6956,
    low: 6948,
    close: 6954,
    volume: 1000,
  };
  const hookCandle: CandleData = {
    time: 101,
    open: 6953,
    high: 6958,
    low: 6949,
    close: 6956,
    volume: 1005,
  };
  const goCandle: CandleData = {
    time: 102,
    open: 6957,
    high: 6962,
    low: 6955,
    close: 6961,
    volume: 1010,
  };

  const warbirdTouched = detectWarbirdTouch(touchCandle, 3, 6950, 0.5, true);
  const legacyTouched = detectTouch(touchCandle, 3, 6950, 0.5, true);
  assert.ok(warbirdTouched);
  assert.ok(legacyTouched);

  const warbirdHook = detectWarbirdHook(hookCandle, 4, warbirdTouched);
  const legacyHook = detectHook(hookCandle, 4, legacyTouched);
  assert.ok(warbirdHook);
  assert.ok(legacyHook);

  const warbirdGo = detectWarbirdGo(goCandle, 5, warbirdHook);
  const warbirdGoRepeat = detectWarbirdGo(goCandle, 5, warbirdHook);
  const legacyGo = detectGo(goCandle, 5, legacyHook);

  assert.deepEqual(warbirdGoRepeat, warbirdGo);
  assert.deepEqual(warbirdGo, legacyGo);
});

test("computeWarbirdTargets exists and is stable for fixed inputs", () => {
  const fib = makeFibResult(true);
  const setup = makeWarbirdGoSetup("BEARISH");
  const first = computeWarbirdTargets(setup, fib, []);
  const second = computeWarbirdTargets(setup, fib, []);

  assert.deepEqual(second, first);
  assert.ok(first.entry != null);
  assert.ok(first.stopLoss != null && first.stopLoss > first.entry!);
  assert.ok(first.tp1 != null && first.tp1 < first.entry!);
});

test("computeWarbirdTargets matches legacy computeTargets semantics for this phase", () => {
  const fib = makeFibResult(true);
  const warbirdSetup = makeWarbirdGoSetup("BEARISH");
  const legacySetup = makeBhgGoSetup("BEARISH");
  const badMove: MeasuredMove = {
    direction: "BEARISH",
    pointA: { price: 7000, barIndex: 1, isHigh: true, time: 1 },
    pointB: { price: 6900, barIndex: 2, isHigh: false, time: 2 },
    pointC: { price: 6960, barIndex: 3, isHigh: true, time: 3 },
    projectedD: 7050,
    retracementRatio: 0.6,
    entry: 6960,
    stop: 7070,
    target: 7050,
    target1236: 7074,
    quality: 75,
    status: "ACTIVE",
  };

  const warbird = computeWarbirdTargets(warbirdSetup, fib, [badMove]);
  const legacy = computeTargets(legacySetup, fib, [badMove]);

  assert.deepEqual(toLegacyBhgSetup(warbird), legacy);
});

test("advanceWarbirdSetups returns stable output for fixed inputs", () => {
  const candles = makeFixedCandles();
  const fib = makeFibResult(true);

  const first = advanceWarbirdSetups(candles, fib, []);
  const second = advanceWarbirdSetups(candles, fib, []);

  assert.deepEqual(second, first);
  assert.ok(first.length > 0, "expected at least one setup from fixed fixture");
});

test("advanceWarbirdSetupsPure exists and returns stable output for fixed inputs", () => {
  const candles = makeFixedCandles();
  const fib = makeFibResult(true);

  const first = advanceWarbirdSetupsPure(candles, fib, []);
  const second = advanceWarbirdSetupsPure(candles, fib, []);

  assert.deepEqual(second, first);
  assert.ok(first.length > 0, "expected at least one setup from fixed fixture");
  assert.ok(
    first.every((setup) => setup.legacyBridge == null),
    "pure path should not stamp legacy delegation metadata",
  );
});

test("warbird bootstrap delegation is parity-aligned with legacy output", () => {
  const candles = makeFixedCandles();
  const fib = makeFibResult(true);

  const legacy = advanceBhgSetups(candles, fib, []);
  const warbird = advanceWarbirdSetups(candles, fib, []);

  const warbirdAsLegacy = warbird.map(toLegacyBhgSetup);
  assert.deepEqual(warbirdAsLegacy, legacy);
  assert.ok(
    warbird.every((setup) => setup.legacyBridge?.delegated === true),
    "delegated export path should keep explicit legacy metadata",
  );
});

test("advanceWarbirdSetupsPure is parity-aligned with legacy advancement for this phase", () => {
  const candles = makeFixedCandles();
  const fib = makeFibResult(true);

  const legacy = advanceBhgSetups(candles, fib, []);
  const pure = advanceWarbirdSetupsPure(candles, fib, []);

  const pureAsLegacy = pure.map(toLegacyBhgSetup);
  assert.deepEqual(pureAsLegacy, legacy);
});

test("exported advanceWarbirdSetups remains delegated (not switched to pure path)", () => {
  const candles = makeFixedCandles();
  const fib = makeFibResult(true);

  const delegated = advanceWarbirdSetups(candles, fib, []);
  const pure = advanceWarbirdSetupsPure(candles, fib, []);

  assert.ok(
    delegated.every((setup) => setup.legacyBridge?.sourceEngine === "bhg-engine"),
    "exported path should still advertise bhg-engine delegation",
  );
  assert.deepEqual(delegated.map(toLegacyBhgSetup), pure.map(toLegacyBhgSetup));
});
