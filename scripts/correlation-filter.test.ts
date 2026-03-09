import test from "node:test";
import assert from "node:assert/strict";

import { computeAlignmentScore } from "../src/lib/correlation-filter";
import type { CandleData } from "../src/lib/types";

function buildCandles(closes: number[]): CandleData[] {
  return closes.map((close, idx) => ({
    time: 1_700_000_000 + idx * 86_400,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000 + idx,
  }));
}

function buildTrend(length: number, start: number, step: number): number[] {
  return Array.from({ length }, (_, idx) => start + idx * step);
}

function buildPattern(start: number, deltas: number[]): number[] {
  const values = [start];
  for (const delta of deltas) {
    values.push(values[values.length - 1] + delta);
  }
  return values;
}

test("computeAlignmentScore uses approved trigger basket for bullish setups", () => {
  const symbolCandles = new Map<string, CandleData[]>([
    ["MES", buildCandles(buildTrend(32, 100, 2))],
    ["NQ", buildCandles(buildTrend(32, 200, 4))],
    ["RTY", buildCandles(buildTrend(32, 50, 1))],
    ["ZN", buildCandles(buildTrend(32, 130, -0.5))],
    ["CL", buildCandles(buildTrend(32, 70, 1.25))],
    ["6E", buildCandles(buildTrend(32, 1.05, 0.01))],
  ]);

  const alignment = computeAlignmentScore(symbolCandles, "BULLISH");

  assert.equal(alignment.isAligned, true);
  assert.deepEqual(alignment.activeSymbols, ["NQ", "RTY", "ZN", "CL", "6E"]);
  assert.ok((alignment.composite ?? 0) > 0.5);
  assert.equal(alignment.vix, 0);
  assert.equal(alignment.dxy, 0);
  assert.ok((alignment.alignedSymbols ?? []).includes("NQ"));
  assert.ok((alignment.alignedSymbols ?? []).includes("RTY"));
  assert.ok((alignment.alignedSymbols ?? []).includes("CL"));
  assert.ok((alignment.alignedSymbols ?? []).includes("6E"));
  assert.ok((alignment.divergingSymbols ?? []).includes("ZN"));
});

test("computeAlignmentScore detects bearish structural regime from inverse peers", () => {
  const mes = buildPattern(100, Array.from({ length: 31 }, (_, idx) => (idx % 2 === 0 ? 2 : -1)));
  const inversePeer = (start: number, highStep: number, lowStep: number) =>
    buildPattern(start, Array.from({ length: 31 }, (_, idx) => (idx % 2 === 0 ? -highStep : lowStep)));
  const positivePeer = (start: number, highStep: number, lowStep: number) =>
    buildPattern(start, Array.from({ length: 31 }, (_, idx) => (idx % 2 === 0 ? highStep : -lowStep)));

  const symbolCandles = new Map<string, CandleData[]>([
    ["MES", buildCandles(mes)],
    ["NQ", buildCandles(inversePeer(200, 4, 2))],
    ["RTY", buildCandles(inversePeer(50, 1.5, 0.75))],
    ["ZN", buildCandles(positivePeer(130, 0.8, 0.4))],
    ["CL", buildCandles(inversePeer(70, 1.25, 0.6))],
    ["6E", buildCandles(inversePeer(1.2, 0.01, 0.005))],
  ]);

  const alignment = computeAlignmentScore(symbolCandles, "BEARISH");

  assert.equal(alignment.isAligned, true);
  assert.ok((alignment.composite ?? 0) < -0.4);
  assert.ok((alignment.alignedSymbols ?? []).includes("NQ"));
  assert.ok((alignment.alignedSymbols ?? []).includes("RTY"));
  assert.ok((alignment.alignedSymbols ?? []).includes("ZN"));
  assert.ok((alignment.alignedSymbols ?? []).includes("CL"));
  assert.ok((alignment.alignedSymbols ?? []).includes("6E"));
  assert.deepEqual(alignment.divergingSymbols, []);
});
