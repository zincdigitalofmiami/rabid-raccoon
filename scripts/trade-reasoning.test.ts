import test from "node:test";
import assert from "node:assert/strict";

import { getTradeReasoning } from "../src/lib/trade-reasoning";
import type { TradeFeatureVector } from "../src/lib/trade-features";
import type { TradeScore } from "../src/lib/composite-score";
import type { TriggerCandidate } from "../src/lib/trigger-candidates";
import type { EventContext } from "../src/lib/event-awareness";
import type { MarketContext } from "../src/lib/market-context";

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

const baseSetup = {
  id: "test-setup",
  direction: "BULLISH",
  fibRatio: 0.618,
  goType: "BREAK",
  entry: 6800,
  stopLoss: 6792,
  tp1: 6810,
  tp2: 6818,
} as unknown as TriggerCandidate;

const baseEventContext = {
  phase: "CLEAR",
  label: "No nearby events",
} as unknown as EventContext;

const baseMarketContext = {
  regime: "MIXED",
  themeScores: { tariffs: 0, rates: 0, trump: 0 },
} as unknown as MarketContext;

test("getTradeReasoning hard-fails during BLACKOUT", async () => {
  await assert.rejects(
    getTradeReasoning(
      baseSetup,
      baseScore,
      { ...baseFeatures, eventPhase: "BLACKOUT" },
      baseEventContext,
      baseMarketContext,
    ),
    /BLACKOUT phase/i,
  );
});

test("getTradeReasoning hard-fails below score threshold", async () => {
  const lowScore: TradeScore = {
    ...baseScore,
    composite: 35,
    grade: "D",
  };

  await assert.rejects(
    getTradeReasoning(
      baseSetup,
      lowScore,
      baseFeatures,
      baseEventContext,
      baseMarketContext,
    ),
    /score below threshold/i,
  );
});
