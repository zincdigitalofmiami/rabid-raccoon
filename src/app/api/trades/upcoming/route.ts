/**
 * /api/trades/upcoming — Thin cache reader
 *
 * Reads the pre-computed signal from the 15m Inngest compute cycle.
 * If the cache is fresh (<15m old), returns instantly (<50ms).
 * If stale/missing, runs a lightweight deterministic fallback (no AI, no external calls).
 *
 * The heavy pipeline (volume, market context, AI reasoning, outcomes) lives in
 * src/inngest/functions/compute-signal.ts and fires at :13, :28, :43, :58.
 */

import { NextResponse } from "next/server";
import { detectSwings } from "@/lib/swing-detection";
import { calculateFibonacciMultiPeriod } from "@/lib/fibonacci";
import { detectMeasuredMoves } from "@/lib/measured-move";
import { advanceBhgSetups } from "@/lib/bhg-engine";
import { computeRisk, MES_DEFAULTS } from "@/lib/risk-engine";
import { readLatestMes15mRows } from "@/lib/mes-live-queries";
import { getEventContext, loadTodayEvents } from "@/lib/event-awareness";
import { getMlBaseline } from "@/lib/ml-baseline";
import { computeCompositeScore } from "@/lib/composite-score";
import { signalCache } from "@/lib/tiered-cache";
import { withCanonicalSetupIds } from "@/lib/setup-id";
import type { CandleData } from "@/lib/types";
import type { EventContext } from "@/lib/event-awareness";
import type { TradeFeatureVector } from "@/lib/trade-features";
import type { MlBaseline } from "@/lib/ml-baseline";
import type { TradeScore } from "@/lib/composite-score";
import type { TradeReasoning } from "@/lib/trade-reasoning";
import type { RiskResult } from "@/lib/risk-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MIN_DISPLAY_COMPOSITE_SCORE = 45;
const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
};

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ScoredTrade {
  setup: ReturnType<typeof advanceBhgSetups>[number];
  risk: RiskResult | null;
  features: TradeFeatureVector;
  mlBaseline: MlBaseline;
  score: TradeScore;
  reasoning: TradeReasoning;
}

interface SignalCachePayload {
  trades: ScoredTrade[];
  eventContext: EventContext;
  currentPrice: number | null;
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>;
  computedAt: string;
}

export interface UpcomingTradesResponse {
  trades: ScoredTrade[];
  eventContext: EventContext;
  currentPrice: number | null;
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>;
  timestamp: string;
  computedAt?: string; // When the signal was actually computed (may lag timestamp)
  source?: "cache" | "fallback";
  error?: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

const EMPTY_EVENT_CONTEXT: EventContext = {
  phase: "CLEAR",
  event: null,
  minutesToEvent: null,
  minutesSinceEvent: null,
  surprise: null,
  confidenceAdjustment: 1,
  label: "No nearby events",
  eventName: null,
  expectedImpact: null,
  forecast: null,
  previous: null,
  surpriseHistory: null,
  marketTemperature: null,
};

function rowToCandle(row: {
  eventTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume == null ? 0 : row.volume,
  };
}

// ─────────────────────────────────────────────
// Lightweight deterministic fallback
// (no AI, no external calls, no volume features)
// ─────────────────────────────────────────────

async function deterministicFallback(): Promise<UpcomingTradesResponse> {
  const rows = await readLatestMes15mRows(200);

  if (rows.length < 10) {
    return {
      trades: [],
      eventContext: EMPTY_EVENT_CONTEXT,
      currentPrice: null,
      fibResult: null,
      timestamp: new Date().toISOString(),
      source: "fallback",
      error: "Insufficient MES 15m data",
    };
  }

  const candles = [...rows].reverse().map(rowToCandle);
  const currentPrice = candles[candles.length - 1].close;

  const swings = detectSwings(candles, 5, 5, 20);
  const fibResult = calculateFibonacciMultiPeriod(candles);

  if (!fibResult) {
    return {
      trades: [],
      eventContext: EMPTY_EVENT_CONTEXT,
      currentPrice,
      fibResult: null,
      timestamp: new Date().toISOString(),
      source: "fallback",
    };
  }

  const measuredMoves = detectMeasuredMoves(
    swings.highs,
    swings.lows,
    currentPrice,
  );
  const setups = withCanonicalSetupIds(
    advanceBhgSetups(candles, fibResult, measuredMoves),
    "M15",
  );

  const todayEvents = await loadTodayEvents();
  const eventContext = getEventContext(new Date(), todayEvents);

  const triggered = setups.filter((s) => s.phase === "TRIGGERED");

  const scoredTrades: ScoredTrade[] = triggered.map((setup) => {
    const risk =
      setup.entry && setup.stopLoss && setup.tp1
        ? computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)
        : null;

    const emptyFeatures: TradeFeatureVector = {
      fibRatio: setup.fibRatio,
      goType: setup.goType ?? "BREAK",
      hookQuality: 0.5,
      measuredMoveAligned: false,
      measuredMoveQuality: null,
      stopDistancePts: risk?.stopDistance ?? 0,
      rrRatio: risk?.rr ?? 0,
      riskGrade: risk?.grade ?? "D",
      eventPhase: eventContext.phase,
      minutesToNextEvent: eventContext.minutesToEvent,
      minutesSinceEvent: eventContext.minutesSinceEvent,
      confidenceAdjustment: eventContext.confidenceAdjustment,
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
      compositeAlignment: 0,
      isAligned: true,
      sqzMom: null,
      sqzState: null,
      wvfValue: null,
      wvfPercentile: null,
      macdHist: null,
      macdHistColor: null,
      newsVolume24h: 0,
      policyNewsVolume24h: 0,
      newsVolume1h: 0,
      newsVelocity: 0,
      breakingNewsFlag: false,
      rvol: 1,
      rvolSession: 1,
      vwap: 0,
      priceVsVwap: 0,
      vwapBand: 0,
      poc: 0,
      priceVsPoc: 0,
      inValueArea: true,
      volumeConfirmation: false,
      pocSlope: 0,
    };

    const baseline = getMlBaseline(emptyFeatures);
    const score = computeCompositeScore(emptyFeatures, baseline);

    return {
      setup,
      risk,
      features: emptyFeatures,
      mlBaseline: baseline,
      score,
      reasoning: {
        adjustedPTp1: score.pTp1,
        adjustedPTp2: score.pTp2,
        rationale: "Deterministic fallback — awaiting next 15m compute cycle",
        keyRisks: [],
        tradeQuality: score.composite >= 70 ? ("B" as const) : ("C" as const),
        catalysts: [],
        source: "deterministic" as const,
      },
    };
  });

  scoredTrades.sort((a, b) => b.score.composite - a.score.composite);

  return {
    trades: scoredTrades.filter(
      (t) =>
        t.score.composite >= MIN_DISPLAY_COMPOSITE_SCORE && t.features.isAligned,
    ),
    eventContext,
    currentPrice,
    fibResult,
    timestamp: new Date().toISOString(),
    source: "fallback",
  };
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    // 1. Check signal cache (populated by Inngest compute-signal every 15m)
    const cached = signalCache.get<SignalCachePayload>("upcoming-trades");

    if (cached) {
      return NextResponse.json({
        trades: cached.trades,
        eventContext: cached.eventContext,
        currentPrice: cached.currentPrice,
        fibResult: cached.fibResult,
        timestamp: new Date().toISOString(),
        computedAt: cached.computedAt,
        source: "cache",
      } satisfies UpcomingTradesResponse, { headers: CACHE_HEADERS });
    }

    // 2. Cache miss — lightweight deterministic fallback
    const fallback = await deterministicFallback();
    return NextResponse.json(fallback, { headers: CACHE_HEADERS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[trades/upcoming] GET failed:", message);
    return NextResponse.json(
      {
        trades: [],
        eventContext: EMPTY_EVENT_CONTEXT,
        currentPrice: null,
        fibResult: null,
        timestamp: new Date().toISOString(),
        source: "fallback",
        error: "Internal server error",
      } satisfies UpcomingTradesResponse,
      { status: 500 },
    );
  }
}
