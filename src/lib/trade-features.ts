/**
 * trade-features.ts — Live Trade Feature Vector Assembly
 *
 * Ports indicator computations from build-lean-dataset.ts into real-time
 * pure functions that operate on a candle window. Assembles the full
 * TradeFeatureVector consumed by the composite score and AI reasoning layers.
 *
 * All indicator functions are pure (no DB calls). The only async function
 * is computeTradeFeatures() which queries news_signals for 24h volume.
 */

import { prisma } from "@/lib/prisma";
import { toNum } from "@/lib/decimal";
import type { BhgSetup } from "@/lib/bhg-engine";
import type { RiskResult } from "@/lib/risk-engine";
import type { EventContext } from "@/lib/event-awareness";
import type { MarketContext } from "@/lib/market-context";
import type { CorrelationAlignment } from "@/lib/correlation-filter";
import type { CandleData, MeasuredMove } from "@/lib/types";

// ─────────────────────────────────────────────
// Exported interfaces
// ─────────────────────────────────────────────

export interface TradeFeatureVector {
  // BHG features
  fibRatio: number;
  goType: string;
  hookQuality: number;
  measuredMoveAligned: boolean;
  measuredMoveQuality: number | null;
  stopDistancePts: number;
  rrRatio: number;
  riskGrade: string;

  // Event features
  eventPhase: string;
  minutesToNextEvent: number | null;
  minutesSinceEvent: number | null;
  confidenceAdjustment: number;

  // Market context
  vixLevel: number | null;
  vixPercentile: number | null;
  vixIntradayRange: number | null;
  gprLevel: number | null;
  gprChange1d: number | null;
  trumpEoCount7d: number;
  trumpTariffFlag: boolean;
  trumpPolicyVelocity7d: number;
  federalRegisterVelocity7d: number;
  epuTrumpPremium: number | null;
  regime: string;
  themeScores: Record<string, number>;

  // Correlation
  compositeAlignment: number;
  isAligned: boolean;

  // Price-action acceptance / failure
  acceptanceState: AcceptanceState;
  acceptanceScore: number;
  sweepFlag: boolean;
  bullTrapFlag: boolean;
  bearTrapFlag: boolean;
  whipsawFlag: boolean;
  fakeoutFlag: boolean;
  blockerDensity: BlockerDensity;
  openSpaceRatio: number | null;
  wickQuality: number | null;
  bodyQuality: number | null;

  // Technical (from current candles)
  sqzMom: number | null;
  sqzState: number | null;
  wvfValue: number | null;
  wvfPercentile: number | null;
  macdAboveZero: boolean | null;
  macdAboveSignal: boolean | null;
  macdHistAboveZero: boolean | null;

  // News
  newsVolume24h: number;
  policyNewsVolume24h: number;
  newsVolume1h: number;
  newsVelocity: number;
  breakingNewsFlag: boolean;

  // Volume & Liquidity
  rvol: number;
  rvolSession: number;
  volumeState: VolumeState;
  vwap: number;
  priceVsVwap: number;
  vwapBand: number;
  poc: number;
  priceVsPoc: number;
  inValueArea: boolean;
  volumeConfirmation: boolean;
  pocSlope: number;
  paceAcceleration: number;
}

// ─────────────────────────────────────────────
// Pure helper functions (ported from build-lean-dataset.ts)
// ─────────────────────────────────────────────

/** Simple moving average — returns null until window is filled. */
function computeSMA(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) result[i] = sum / window;
  }
  return result;
}

/** Rolling highest value in window. */
function rollingHighest(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] > max) max = values[j];
    }
    result[i] = max;
  }
  return result;
}

/** Rolling lowest value in window. */
function rollingLowest(values: number[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - window + 1; j <= i; j++) {
      if (values[j] < min) min = values[j];
    }
    result[i] = min;
  }
  return result;
}

/** Rolling linear regression — returns endpoint value (offset=0). */
function linreg(values: (number | null)[], window: number): (number | null)[] {
  const result: (number | null)[] = new Array(values.length).fill(null);
  for (let i = window - 1; i < values.length; i++) {
    let sumX = 0,
      sumY = 0,
      sumXY = 0,
      sumX2 = 0,
      count = 0;
    for (let j = 0; j < window; j++) {
      const v = values[i - window + 1 + j];
      if (v == null) continue;
      sumX += j;
      sumY += v;
      sumXY += j * v;
      sumX2 += j * j;
      count++;
    }
    if (count < window * 0.8) continue;
    const denom = count * sumX2 - sumX * sumX;
    if (denom === 0) continue;
    const slope = (count * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / count;
    result[i] = intercept + slope * (window - 1);
  }
  return result;
}

/** Population standard deviation. */
function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ─────────────────────────────────────────────
// Squeeze Pro (from build-lean-dataset.ts:264-391)
// ─────────────────────────────────────────────

export interface SqueezeProResult {
  mom: number | null;
  state: number | null; // 0=none, 1=wide, 2=normal, 3=narrow, 4=fired
}

export type AcceptanceState =
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED_BREAK"
  | "TRAP_RISK"
  | "WHIPSAW_RISK"
  | "UNRESOLVED";

export type BlockerDensity = "CLEAN" | "MODERATE" | "CROWDED";

interface AcceptanceContext {
  state: AcceptanceState;
  acceptanceScore: number;
  sweepFlag: boolean;
  bullTrapFlag: boolean;
  bearTrapFlag: boolean;
  whipsawFlag: boolean;
  fakeoutFlag: boolean;
  blockerDensity: BlockerDensity;
  openSpaceRatio: number | null;
  wickQuality: number | null;
  bodyQuality: number | null;
}

/**
 * Compute Squeeze Pro for the latest bar in the candle window.
 * Requires at least `length` candles.
 */
export function computeSqueezeProLatest(
  candles: CandleData[],
  length = 20,
): SqueezeProResult {
  if (candles.length < length + 1) return { mom: null, state: null };

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  // SMA of closes
  const sma = computeSMA(closes, length);

  // True Range
  const tr: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < candles.length; i++) {
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }

  // Keltner Channel deviation (SMA of TR)
  const kcDev = computeSMA(tr, length);

  // Bollinger Band deviation (population stdev of closes)
  const bbDev: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = length - 1; i < candles.length; i++) {
    const window = closes.slice(i - length + 1, i + 1);
    bbDev[i] = stdDev(window);
  }

  // Momentum: linreg(close - midline, length)
  const highest = rollingHighest(highs, length);
  const lowest = rollingLowest(lows, length);
  const delta: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    if (highest[i] == null || lowest[i] == null || sma[i] == null) continue;
    const midline = ((highest[i]! + lowest[i]!) / 2 + sma[i]!) / 2;
    delta[i] = closes[i] - midline;
  }
  const mom = linreg(delta, length);

  // Squeeze state at last bar
  const last = candles.length - 1;
  if (bbDev[last] == null || kcDev[last] == null || kcDev[last] === 0) {
    return { mom: mom[last] ?? null, state: null };
  }

  const bb = bbDev[last]! * 2; // BB uses 2x stdev
  const kc1 = kcDev[last]! * 1.0;
  const kc15 = kcDev[last]! * 1.5;
  const kc2 = kcDev[last]! * 2.0;

  let state: number;
  if (bb < kc1)
    state = 3; // narrow (yellow)
  else if (bb < kc15)
    state = 2; // normal (red)
  else if (bb < kc2)
    state = 1; // wide (orange)
  else state = 4; // fired (green)

  return { mom: mom[last] ?? null, state };
}

// ─────────────────────────────────────────────
// Williams Vix Fix (from build-lean-dataset.ts:393-450)
// ─────────────────────────────────────────────

export interface WvfResult {
  value: number | null;
  percentile: number | null; // 0–2 scale
  signal: boolean; // true = fear spike
}

/**
 * Compute WVF for the latest bar.
 * Requires at least `pd + lb` candles.
 */
export function computeWvfLatest(
  candles: CandleData[],
  pd = 22,
  bbl = 20,
  mult = 2.0,
  lb = 50,
  ph = 0.85,
): WvfResult {
  const minBars = Math.max(pd, bbl, lb) + 10;
  if (candles.length < minBars)
    return { value: null, percentile: null, signal: false };

  const closes = candles.map((c) => c.close);
  const lows = candles.map((c) => c.low);

  // Highest close over pd bars
  const hc = rollingHighest(closes, pd);

  // Raw WVF
  const wvf: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = pd - 1; i < candles.length; i++) {
    if (hc[i] == null || hc[i] === 0) continue;
    wvf[i] = ((hc[i]! - lows[i]) / hc[i]!) * 100;
  }

  // BB on WVF
  const wvfNums = wvf.map((v) => v ?? 0);
  const wvfSma = computeSMA(wvfNums, bbl);

  // Range percentile
  const rangeHigh = rollingHighest(wvfNums, lb);

  const last = candles.length - 1;
  const wvfVal = wvf[last];
  if (wvfVal == null) return { value: null, percentile: null, signal: false };

  // BB upper band
  let upperBand: number | null = null;
  if (last >= bbl - 1) {
    const window = wvfNums.slice(last - bbl + 1, last + 1);
    const sd = stdDev(window);
    if (sd != null && wvfSma[last] != null) {
      upperBand = wvfSma[last]! + mult * sd;
    }
  }

  const rh = rangeHigh[last];
  const pct = rh != null && rh > 0 ? Math.min(wvfVal / rh, 2.0) : null;
  const sig =
    (upperBand != null && wvfVal >= upperBand) ||
    (rh != null && wvfVal >= rh * ph);

  return { value: wvfVal, percentile: pct, signal: sig };
}

// ─────────────────────────────────────────────
// CM Ultimate MACD (from build-lean-dataset.ts:452-526)
// ─────────────────────────────────────────────

export interface MacdResult {
  aboveZero: boolean | null;
  aboveSignal: boolean | null;
  histAboveZero: boolean | null;
}

/**
 * Compute simplified MACD sign-state features for the latest bar.
 * Requires at least slowLength + signalLength candles.
 */
export function computeMacdLatest(
  candles: CandleData[],
  fastLength = 12,
  slowLength = 26,
  signalLength = 9,
): MacdResult {
  const warmup = slowLength + signalLength - 1;
  if (candles.length < warmup + 2) {
    return { aboveZero: null, aboveSignal: null, histAboveZero: null };
  }

  const closes = candles.map((c) => c.close);
  const computeEmaSeries = (
    values: number[],
    period: number,
  ): (number | null)[] => {
    const emaSeries: (number | null)[] = new Array(values.length).fill(null);
    if (values.length < period) return emaSeries;

    const mult = 2 / (period + 1);
    let emaVal =
      values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    emaSeries[period - 1] = emaVal;

    for (let i = period; i < values.length; i++) {
      emaVal = (values[i] - emaVal) * mult + emaVal;
      emaSeries[i] = emaVal;
    }
    return emaSeries;
  };

  // EMA computation (SMA-seeded, matching repo convention)
  const fastEma = computeEmaSeries(closes, fastLength);
  const slowEma = computeEmaSeries(closes, slowLength);
  const macdLine: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (fastEma[i] == null || slowEma[i] == null) continue;
    macdLine.push(fastEma[i]! - slowEma[i]!);
  }

  // Signal = EMA of MACD line (SMA-seeded)
  const signal: (number | null)[] = new Array(macdLine.length).fill(null);
  const signalMult = 2 / (signalLength + 1);
  let signalEma =
    macdLine.slice(0, signalLength).reduce((sum, v) => sum + v, 0) /
    signalLength;
  signal[signalLength - 1] = signalEma;
  for (let i = signalLength; i < macdLine.length; i++) {
    signalEma = (macdLine[i] - signalEma) * signalMult + signalEma;
    signal[i] = signalEma;
  }

  const last = macdLine.length - 1;
  const prev = last - 1;
  if (signal[last] == null || signal[prev] == null)
    return { aboveZero: null, aboveSignal: null, histAboveZero: null };

  const line = macdLine[last];
  const sig = signal[last]!;
  const hist = line - sig;

  return {
    aboveZero: line > 0,
    aboveSignal: line > sig,
    histAboveZero: hist > 0,
  };
}

// ─────────────────────────────────────────────
// Hook quality scorer
// ─────────────────────────────────────────────

/**
 * Score the quality of a hook (CONFIRMED phase).
 * Higher = better hook.
 *  - Tight range hook (small body) = better
 *  - Hook in direction of setup = better
 *  - Multiple hook bars = better confirmation
 */
export function scoreHookQuality(
  setup: BhgSetup,
  candles: CandleData[],
): number {
  if (!setup.hookBarIndex || !setup.touchBarIndex) return 0.5;

  const hookBars = setup.hookBarIndex - setup.touchBarIndex;
  if (hookBars <= 0) return 0.5;

  let score = 0.5;

  // Tighter hooks are better (fewer bars between touch and hook)
  if (hookBars <= 3) score += 0.2;
  else if (hookBars <= 5) score += 0.1;

  // Check hook candle body size vs average
  const hookCandle = candles[setup.hookBarIndex];
  if (hookCandle) {
    const bodySize = Math.abs(hookCandle.close - hookCandle.open);
    const rangeSize = hookCandle.high - hookCandle.low;
    if (rangeSize > 0 && bodySize / rangeSize < 0.3) {
      score += 0.15; // small body = indecision = good hook
    }
  }

  // Hook direction alignment
  if (hookCandle) {
    const bullishCandle = hookCandle.close > hookCandle.open;
    if (setup.direction === "BULLISH" && bullishCandle) score += 0.15;
    if (setup.direction === "BEARISH" && !bullishCandle) score += 0.15;
  }

  return Math.min(score, 1.0);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function countReferenceCrosses(closes: number[], referenceLevel: number): number {
  if (closes.length < 2) return 0;
  let crosses = 0;
  for (let i = 1; i < closes.length; i++) {
    const prevSign = closes[i - 1] >= referenceLevel ? 1 : -1;
    const nextSign = closes[i] >= referenceLevel ? 1 : -1;
    if (prevSign !== nextSign) crosses++;
  }
  return crosses;
}

function computeAcceptanceContext(
  setup: BhgSetup,
  candles: CandleData[],
  fibPrices?: number[],
): AcceptanceContext {
  const barIndex = setup.goBarIndex ?? candles.length - 1;
  const evalCandle = candles[barIndex];

  if (!evalCandle) {
    return {
      state: "UNRESOLVED",
      acceptanceScore: 0.5,
      sweepFlag: false,
      bullTrapFlag: false,
      bearTrapFlag: false,
      whipsawFlag: false,
      fakeoutFlag: false,
      blockerDensity: "MODERATE",
      openSpaceRatio: null,
      wickQuality: null,
      bodyQuality: null,
    };
  }

  const referenceLevel =
    setup.direction === "BULLISH"
      ? (setup.hookHigh ?? setup.entry ?? evalCandle.close)
      : (setup.hookLow ?? setup.entry ?? evalCandle.close);

  const lookback = candles.slice(Math.max(0, barIndex - 9), barIndex + 1);
  const trailing = candles.slice(Math.max(0, barIndex - 4), barIndex + 1);
  const closes = trailing.map((c) => c.close);
  const recentLows = lookback.map((c) => c.low);
  const recentHighs = lookback.map((c) => c.high);

  let sweepFlag = false;
  if (lookback.length >= 5) {
    const priorLow = Math.min(...recentLows.slice(0, -2));
    const priorHigh = Math.max(...recentHighs.slice(0, -2));
    if (setup.direction === "BULLISH") {
      sweepFlag = evalCandle.low < priorLow && evalCandle.close > priorLow;
    } else {
      sweepFlag = evalCandle.high > priorHigh && evalCandle.close < priorHigh;
    }
  }

  const closesAccepted =
    closes.length >= 2 &&
    (setup.direction === "BULLISH"
      ? closes.slice(-2).every((close) => close > referenceLevel)
      : closes.slice(-2).every((close) => close < referenceLevel));

  const fakeoutFlag =
    setup.direction === "BULLISH"
      ? evalCandle.high > referenceLevel && evalCandle.close <= referenceLevel
      : evalCandle.low < referenceLevel && evalCandle.close >= referenceLevel;

  const bullTrapFlag =
    setup.direction === "BULLISH" &&
    trailing.some((c) => c.high > referenceLevel) &&
    evalCandle.close < referenceLevel;

  const bearTrapFlag =
    setup.direction === "BEARISH" &&
    trailing.some((c) => c.low < referenceLevel) &&
    evalCandle.close > referenceLevel;

  const whipsawFlag = countReferenceCrosses(closes, referenceLevel) >= 2;

  let openSpaceRatio: number | null = null;
  let blockerDensity: BlockerDensity = "MODERATE";
  if (setup.entry != null && setup.tp1 != null && fibPrices && fibPrices.length > 0) {
    const entryToTarget = Math.abs(setup.tp1 - setup.entry);
    let nearestBlockerDist = Infinity;

    for (const fibPrice of fibPrices) {
      const isBetween =
        setup.direction === "BULLISH"
          ? fibPrice > setup.entry && fibPrice < setup.tp1
          : fibPrice < setup.entry && fibPrice > setup.tp1;
      if (!isBetween) continue;
      nearestBlockerDist = Math.min(nearestBlockerDist, Math.abs(fibPrice - setup.entry));
    }

    if (entryToTarget > 0) {
      openSpaceRatio = nearestBlockerDist === Infinity ? 1 : nearestBlockerDist / entryToTarget;
      blockerDensity =
        openSpaceRatio >= 0.7 ? "CLEAN" : openSpaceRatio >= 0.35 ? "MODERATE" : "CROWDED";
    }
  }

  const wickCandle =
    setup.hookBarIndex != null && candles[setup.hookBarIndex]
      ? candles[setup.hookBarIndex]
      : evalCandle;
  const body = Math.abs(wickCandle.close - wickCandle.open);
  const range = wickCandle.high - wickCandle.low;
  const rejectionWick =
    setup.direction === "BULLISH"
      ? wickCandle.close - wickCandle.low
      : wickCandle.high - wickCandle.close;
  const wickQuality = body > 0 ? rejectionWick / body : rejectionWick > 0 ? 10 : 0;
  const bodyQuality = range > 0 ? body / range : 0;

  let state: AcceptanceState;
  if (fakeoutFlag) state = "FAILED_BREAK";
  else if (bullTrapFlag || bearTrapFlag) state = "TRAP_RISK";
  else if (whipsawFlag) state = "WHIPSAW_RISK";
  else if (closesAccepted) state = "ACCEPTED";
  else if (
    setup.direction === "BULLISH"
      ? evalCandle.close < referenceLevel
      : evalCandle.close > referenceLevel
  ) state = "REJECTED";
  else state = "UNRESOLVED";

  let acceptanceScore = 0.5;
  if (state === "ACCEPTED") acceptanceScore += 0.25;
  if (state === "UNRESOLVED") acceptanceScore -= 0.05;
  if (state === "REJECTED") acceptanceScore -= 0.15;
  if (state === "FAILED_BREAK") acceptanceScore -= 0.25;
  if (state === "TRAP_RISK") acceptanceScore -= 0.2;
  if (state === "WHIPSAW_RISK") acceptanceScore -= 0.15;
  if (sweepFlag) acceptanceScore += 0.08;
  if (blockerDensity === "CLEAN") acceptanceScore += 0.08;
  if (blockerDensity === "CROWDED") acceptanceScore -= 0.08;

  return {
    state,
    acceptanceScore: Math.round(clamp01(acceptanceScore) * 10000) / 10000,
    sweepFlag,
    bullTrapFlag,
    bearTrapFlag,
    whipsawFlag,
    fakeoutFlag,
    blockerDensity,
    openSpaceRatio: openSpaceRatio == null ? null : Math.round(openSpaceRatio * 10000) / 10000,
    wickQuality: Math.round(wickQuality * 10000) / 10000,
    bodyQuality: Math.round(bodyQuality * 10000) / 10000,
  };
}

// ─────────────────────────────────────────────
// Measured move alignment
// ─────────────────────────────────────────────

/**
 * Check if a measured move supports the setup direction and score quality.
 */
export function checkMeasuredMoveAlignment(
  setup: BhgSetup,
  measuredMoves: MeasuredMove[],
): { aligned: boolean; quality: number | null } {
  if (!measuredMoves || measuredMoves.length === 0) {
    return { aligned: false, quality: null };
  }

  // Find the best active measured move matching setup direction
  const matching = measuredMoves.filter(
    (mm) => mm.direction === setup.direction && mm.status === "ACTIVE",
  );

  if (matching.length === 0) return { aligned: false, quality: null };

  // Pick the highest quality one
  const best = matching.reduce((a, b) => (a.quality > b.quality ? a : b));
  return { aligned: true, quality: best.quality };
}

// ─────────────────────────────────────────────
// VIX percentile (rolling 252-day)
// ─────────────────────────────────────────────

/**
 * Compute VIX percentile from market context correlations.
 * We approximate from the VIX level using historical distribution.
 */
export function vixPercentile(vixLevel: number | null): number | null {
  if (vixLevel == null) return null;
  // Approximate historical VIX percentiles (based on 1990-2024 data)
  // These are rough bucket boundaries — BACKTEST-TBD
  if (vixLevel <= 12) return 0.1;
  if (vixLevel <= 14) return 0.25;
  if (vixLevel <= 16) return 0.4;
  if (vixLevel <= 18) return 0.5;
  if (vixLevel <= 20) return 0.6;
  if (vixLevel <= 25) return 0.75;
  if (vixLevel <= 30) return 0.85;
  if (vixLevel <= 40) return 0.93;
  return 0.98;
}

// ─────────────────────────────────────────────
// News volume query (24h)
// ─────────────────────────────────────────────

interface NewsVolume {
  total: number;
  policy: number;
}

export interface WarbirdMacroFeatures {
  vixLevel: number | null;
  vixIntradayRange: number | null;
  gprLevel: number | null;
  gprChange1d: number | null;
  trumpEoCount7d: number;
  trumpTariffFlag: boolean;
  trumpPolicyVelocity7d: number;
  federalRegisterVelocity7d: number;
  epuTrumpPremium: number | null;
}

export type VolumeState =
  | "THIN"
  | "BALANCED"
  | "EXPANSION"
  | "EXHAUSTION"
  | "ABSORPTION";

export interface VolumeFeatures {
  rvol: number;
  rvolSession: number;
  volumeState: VolumeState;
  vwap: number;
  priceVsVwap: number;
  vwapBand: number;
  poc: number;
  priceVsPoc: number;
  inValueArea: boolean;
  volumeConfirmation: boolean;
  pocSlope: number;
  paceAcceleration: number;
}

/** Default volume features when none are available (pre-market, no data). */
export const DEFAULT_VOLUME_FEATURES: VolumeFeatures = {
  rvol: 1.0,
  rvolSession: 1.0,
  volumeState: "BALANCED",
  vwap: 0,
  priceVsVwap: 0,
  vwapBand: 0,
  poc: 0,
  priceVsPoc: 0,
  inValueArea: true,
  volumeConfirmation: false,
  pocSlope: 0,
  paceAcceleration: 0,
};

/**
 * Count news signals in the last 24 hours. Cached per minute.
 */
let newsVolumeCache: { time: number; data: NewsVolume } | null = null;

async function getNewsVolume24h(): Promise<NewsVolume> {
  const now = Date.now();
  if (newsVolumeCache && now - newsVolumeCache.time < 60_000) {
    return newsVolumeCache.data;
  }

  const since = new Date(now - 24 * 60 * 60 * 1000);

  const [total, policy] = await Promise.all([
    prisma.newsSignal.count({
      where: { pubDate: { gte: since } },
    }),
    prisma.newsSignal.count({
      where: {
        pubDate: { gte: since },
        layer: "trump_policy",
      },
    }),
  ]);

  const data = { total, policy };
  newsVolumeCache = { time: now, data };
  return data;
}

/** Reset cache — for testing. */
export function resetNewsVolumeCache(): void {
  newsVolumeCache = null;
}

interface NewsVelocity {
  total: number;
  velocity: number;      // articles per minute in last 15 min
  avgVelocity: number;   // baseline articles per minute (24h average)
}

let newsVelocityCache: { time: number; data: NewsVelocity } | null = null;

/**
 * News volume in the last 1 hour + velocity (articles/min in last 15 min).
 * Cached per minute.
 */
async function getNewsVolume1h(): Promise<NewsVelocity> {
  const now = Date.now();
  if (newsVelocityCache && now - newsVelocityCache.time < 60_000) {
    return newsVelocityCache.data;
  }

  const since1h = new Date(now - 60 * 60 * 1000);
  const since15m = new Date(now - 15 * 60 * 1000);
  const since24h = new Date(now - 24 * 60 * 60 * 1000);

  const [total1h, count15m, count24h] = await Promise.all([
    prisma.newsSignal.count({ where: { pubDate: { gte: since1h } } }),
    prisma.newsSignal.count({ where: { pubDate: { gte: since15m } } }),
    prisma.newsSignal.count({ where: { pubDate: { gte: since24h } } }),
  ]);

  const velocity = count15m / 15;          // articles per minute, last 15 min
  const avgVelocity = count24h / (24 * 60); // articles per minute, 24h baseline

  const data: NewsVelocity = { total: total1h, velocity, avgVelocity };
  newsVelocityCache = { time: now, data };
  return data;
}

function getUtcDayStart(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

export async function getWarbirdMacroFeatures(
  candles: CandleData[],
): Promise<WarbirdMacroFeatures> {
  const latest = candles[candles.length - 1];
  const now = latest ? new Date(latest.time * 1000) : new Date();
  const dayStart = getUtcDayStart(now);
  const priorDayStart = new Date(dayStart.getTime() - 24 * 60 * 60 * 1000);
  const weekStart = new Date(dayStart.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    vixLatest,
    epuDailyLatest,
    epuOverallLatest,
    gprLatest,
    gprPrev,
    trump7d,
    trumpTariff7d,
  ] = await Promise.all([
    prisma.econVolIndices1d.findFirst({
      where: {
        seriesId: "VIXCLS",
        eventDate: { lte: dayStart },
      },
      orderBy: { eventDate: "desc" },
      select: { value: true },
    }),
    prisma.econVolIndices1d.findFirst({
      where: {
        seriesId: "USEPUINDXD",
        eventDate: { lte: dayStart },
      },
      orderBy: { eventDate: "desc" },
      select: { value: true },
    }),
    prisma.econVolIndices1d.findFirst({
      where: {
        seriesId: "USEPUINDXM",
        eventDate: { lte: dayStart },
      },
      orderBy: { eventDate: "desc" },
      select: { value: true },
    }),
    prisma.$queryRaw<Array<{ value: number }>>`
        SELECT value::double precision as value
        FROM "geopolitical_risk_1d"
        WHERE "indexName" = ${"GPR"}
          AND "eventDate" <= ${dayStart}
        ORDER BY "eventDate" DESC
        LIMIT 1
      `,
    prisma.$queryRaw<Array<{ value: number }>>`
        SELECT value::double precision as value
        FROM "geopolitical_risk_1d"
        WHERE "indexName" = ${"GPR"}
          AND "eventDate" <= ${priorDayStart}
        ORDER BY "eventDate" DESC
        LIMIT 1
      `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint as count
        FROM "trump_effect_1d"
        WHERE "eventDate" >= ${weekStart}
          AND "eventDate" <= ${dayStart}
          AND "eventType" = ${"executive_order"}
      `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint as count
        FROM "trump_effect_1d"
        WHERE "eventDate" >= ${weekStart}
          AND "eventDate" <= ${dayStart}
          AND (
            "eventType" = ${"tariff"}
            OR title ILIKE ${"%tariff%"}
            OR COALESCE(summary, '') ILIKE ${"%tariff%"}
          )
      `,
  ]);

  const vixLevel = vixLatest?.value != null ? toNum(vixLatest.value) : null;
  const epuDailyLevel =
    epuDailyLatest?.value != null ? toNum(epuDailyLatest.value) : null;
  const epuOverallLevel =
    epuOverallLatest?.value != null ? toNum(epuOverallLatest.value) : null;
  const epuTrumpPremium =
    epuDailyLevel != null && epuOverallLevel != null
      ? epuDailyLevel - epuOverallLevel
      : null;

  const gprLevel = gprLatest[0]?.value ?? null;
  const gprPrevValue = gprPrev[0]?.value ?? null;
  const gprChange1d =
    gprLevel != null && gprPrevValue != null ? gprLevel - gprPrevValue : null;

  let vixIntradayRange: number | null = null;
  const latestCandle = candles[candles.length - 1];
  if (latestCandle && vixLevel != null && vixLevel > 0) {
    vixIntradayRange = (latestCandle.high - latestCandle.low) / vixLevel;
  }

  const trumpEoCount7d = Number(trump7d[0]?.count ?? 0n);

  return {
    vixLevel,
    vixIntradayRange,
    gprLevel,
    gprChange1d,
    trumpEoCount7d,
    trumpTariffFlag: Number(trumpTariff7d[0]?.count ?? 0n) > 0,
    trumpPolicyVelocity7d: trumpEoCount7d,
    federalRegisterVelocity7d: trumpEoCount7d,
    epuTrumpPremium,
  };
}

// ─────────────────────────────────────────────
// Main assembly function
// ─────────────────────────────────────────────

/**
 * Assemble the complete trade feature vector for a single BHG setup.
 *
 * All indicator computations are pure. The only async call is the
 * news_signals count query (cached per minute).
 *
 * @param setup - The BHG setup (must be TRIGGERED phase for scoring)
 * @param candles - Recent candle window (at least 60 bars recommended)
 * @param risk - Pre-computed risk result for this setup
 * @param eventContext - Current event awareness context
 * @param marketContext - Current market context (regime, correlations, etc.)
 * @param alignment - Pre-computed correlation alignment
 * @param measuredMoves - Active measured moves (if any)
 */
export async function computeTradeFeatures(
  setup: BhgSetup,
  candles: CandleData[],
  risk: RiskResult,
  eventContext: EventContext,
  marketContext: MarketContext,
  alignment: CorrelationAlignment,
  measuredMoves: MeasuredMove[],
  prefetchedMacro?: WarbirdMacroFeatures,
  prefetchedVolume?: VolumeFeatures,
  fibPrices?: number[],
): Promise<TradeFeatureVector> {
  // Technical indicators (pure, computed from candle window)
  const squeeze = computeSqueezeProLatest(candles);
  const wvf = computeWvfLatest(candles);
  const macd = computeMacdLatest(candles);

  // Hook quality (pure)
  const hookQuality = scoreHookQuality(setup, candles);

  // Measured move alignment (pure)
  const mmAlign = checkMeasuredMoveAlignment(setup, measuredMoves);

  // Price-action acceptance / failure (pure)
  const acceptance = computeAcceptanceContext(setup, candles, fibPrices);

  // Macro features — use pre-fetched if available (avoids 7 duplicate queries per setup)
  const macro = prefetchedMacro ?? await getWarbirdMacroFeatures(candles);

  // Volume features — use pre-fetched from Python compute script
  const vol = prefetchedVolume ?? DEFAULT_VOLUME_FEATURES;

  // News volume (async, cached)
  const newsVol = await getNewsVolume24h();

  // Enhanced news features
  const newsVol1h = await getNewsVolume1h();

  return {
    // BHG
    fibRatio: setup.fibRatio,
    goType: setup.goType ?? "BREAK",
    hookQuality,
    measuredMoveAligned: mmAlign.aligned,
    measuredMoveQuality: mmAlign.quality,
    stopDistancePts: risk.stopDistance,
    rrRatio: risk.rr,
    riskGrade: risk.grade,

    // Event
    eventPhase: eventContext.phase,
    minutesToNextEvent: eventContext.minutesToEvent,
    minutesSinceEvent: eventContext.minutesSinceEvent,
    confidenceAdjustment: eventContext.confidenceAdjustment,

    // Market
    vixLevel: macro.vixLevel,
    vixPercentile: vixPercentile(macro.vixLevel),
    vixIntradayRange: macro.vixIntradayRange,
    gprLevel: macro.gprLevel,
    gprChange1d: macro.gprChange1d,
    trumpEoCount7d: macro.trumpEoCount7d,
    trumpTariffFlag: macro.trumpTariffFlag,
    trumpPolicyVelocity7d: macro.trumpPolicyVelocity7d,
    federalRegisterVelocity7d: macro.federalRegisterVelocity7d,
    epuTrumpPremium: macro.epuTrumpPremium,
    regime: marketContext.regime,
    themeScores: marketContext.themeScores as unknown as Record<string, number>,

    // Correlation
    compositeAlignment: alignment.composite,
    isAligned: alignment.isAligned,

    // Acceptance / failure
    acceptanceState: acceptance.state,
    acceptanceScore: acceptance.acceptanceScore,
    sweepFlag: acceptance.sweepFlag,
    bullTrapFlag: acceptance.bullTrapFlag,
    bearTrapFlag: acceptance.bearTrapFlag,
    whipsawFlag: acceptance.whipsawFlag,
    fakeoutFlag: acceptance.fakeoutFlag,
    blockerDensity: acceptance.blockerDensity,
    openSpaceRatio: acceptance.openSpaceRatio,
    wickQuality: acceptance.wickQuality,
    bodyQuality: acceptance.bodyQuality,

    // Technical
    sqzMom: squeeze.mom,
    sqzState: squeeze.state,
    wvfValue: wvf.value,
    wvfPercentile: wvf.percentile,
    macdAboveZero: macd.aboveZero,
    macdAboveSignal: macd.aboveSignal,
    macdHistAboveZero: macd.histAboveZero,

    // News
    newsVolume24h: newsVol.total,
    policyNewsVolume24h: newsVol.policy,
    newsVolume1h: newsVol1h.total,
    newsVelocity: newsVol1h.velocity,
    breakingNewsFlag: newsVol1h.velocity > 3 * newsVol1h.avgVelocity,

    // Volume & Liquidity
    rvol: vol.rvol,
    rvolSession: vol.rvolSession,
    volumeState: vol.volumeState,
    vwap: vol.vwap,
    priceVsVwap: vol.priceVsVwap,
    vwapBand: vol.vwapBand,
    poc: vol.poc,
    priceVsPoc: vol.priceVsPoc,
    inValueArea: vol.inValueArea,
    volumeConfirmation: vol.volumeConfirmation,
    pocSlope: vol.pocSlope,
    paceAcceleration: vol.paceAcceleration,
  };
}
