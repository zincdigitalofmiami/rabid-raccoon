import test from "node:test";
import assert from "node:assert/strict";

import { buildDeterministicTradeReasoning } from "../src/lib/trade-reasoning";
import type { TradeFeatureVector } from "../src/lib/trade-features";
import type { TradeScore } from "../src/lib/composite-score";

const baseFeatures: TradeFeatureVector = {
  fibRatio: 0.618,
  goType: "BREAK",
  hookQuality: 0.8,
  measuredMoveAligned: true,
  measuredMoveQuality: 0.75,
  stopDistancePts: 4,
  rrRatio: 2.1,
  riskGrade: "B",
  eventPhase: "APPROACHING",
  minutesToNextEvent: 8,
  minutesSinceEvent: null,
  confidenceAdjustment: 0.85,
  vixLevel: null,
  vixPercentile: null,
  vixIntradayRange: null,
  gprLevel: null,
  gprChange1d: null,
  trumpEoCount7d: 0,
  trumpTariffFlag: false,
  trumpPolicyVelocity7d: 0,
  federalRegisterVelocity7d: 0,
  epuTrumpPremium: null,
  regime: "MIXED",
  themeScores: {},
  compositeAlignment: 0.3,
  isAligned: true,
  correlationDetails: "Aligned: NQ confirming",
  activeCorrelationSymbols: ["NQ", "RTY", "ZN"],
  alignedCorrelationSymbols: ["NQ", "RTY"],
  divergingCorrelationSymbols: [],
  ignoredCorrelationSymbols: ["ZN"],
  acceptanceState: "ACCEPTED",
  acceptanceScore: 0.8,
  sweepFlag: false,
  bullTrapFlag: false,
  bearTrapFlag: false,
  whipsawFlag: false,
  fakeoutFlag: false,
  blockerDensity: "CLEAN",
  openSpaceRatio: 0.7,
  wickQuality: 1.2,
  bodyQuality: 0.3,
  sqzMom: 1.4,
  sqzState: 4,
  wvfValue: null,
  wvfPercentile: null,
  macdAboveZero: true,
  macdAboveSignal: true,
  macdHistAboveZero: true,
  newsVolume24h: 0,
  policyNewsVolume24h: 0,
  newsVolume1h: 0,
  newsVelocity: 0,
  breakingNewsFlag: false,
  rvol: 1.2,
  rvolSession: 1.1,
  volumeState: "BALANCED",
  vwap: 0,
  priceVsVwap: 0,
  vwapBand: 0,
  poc: 0,
  priceVsPoc: 0,
  inValueArea: true,
  volumeConfirmation: true,
  pocSlope: 0,
  paceAcceleration: 0.2,
};

const baseScore: TradeScore = {
  composite: 68,
  grade: "B",
  pTp1: 0.63,
  pTp2: 0.37,
  subScores: {
    fib: 70,
    risk: 70,
    event: 85,
    correlation: 70,
    technical: 70,
    mlBaseline: 68,
  },
  flags: [],
};

test("buildDeterministicTradeReasoning degrades cleanly for trigger runtime", () => {
  const reasoning = buildDeterministicTradeReasoning(
    baseScore,
    baseFeatures,
    "AI reasoning degraded: unavailable",
  );

  assert.equal(reasoning.source, "deterministic");
  assert.equal(reasoning.adjustedPTp1, baseScore.pTp1);
  assert.equal(reasoning.adjustedPTp2, baseScore.pTp2);
  assert.ok(reasoning.rationale.includes("AI reasoning degraded"));
  assert.ok(reasoning.keyRisks.includes("Event approaching — require stronger confirmation"));
  assert.ok(reasoning.catalysts.includes("Measured move confirms direction"));
});
