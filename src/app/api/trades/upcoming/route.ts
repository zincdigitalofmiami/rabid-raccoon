/**
 * /api/trades/upcoming — Unified Trade Intelligence Endpoint
 *
 * Orchestrates the full pipeline:
 *   1. Refresh MES data
 *   2. Run BHG engine (swings → fibs → measured moves → state machine)
 *   3. Compute risk per TRIGGERED setup
 *   4. Load event context
 *   5. Compute trade features + ML baseline + composite score
 *   6. AI reasoning for qualifying setups (score ≥ 50)
 *
 * Returns scored, reasoned trade cards ready for display.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { detectSwings } from "@/lib/swing-detection";
import { calculateFibonacciMultiPeriod } from "@/lib/fibonacci";
import { detectMeasuredMoves } from "@/lib/measured-move";
import { advanceBhgSetups } from "@/lib/bhg-engine";
import { computeRisk, MES_DEFAULTS } from "@/lib/risk-engine";
import { refreshMes15mFromDatabento } from "@/lib/mes15m-refresh";
import { toNum } from "@/lib/decimal";
import { getEventContext, loadTodayEvents } from "@/lib/event-awareness";
import { computeTradeFeatures } from "@/lib/trade-features";
import { getMlBaseline } from "@/lib/ml-baseline";
import { computeCompositeScore } from "@/lib/composite-score";
import { getTradeReasoning } from "@/lib/trade-reasoning";
import { fetchDailyCandlesForSymbol } from "@/lib/fetch-candles";
import { getSymbolsByRole } from "@/lib/symbol-registry";
import { buildMarketContext } from "@/lib/market-context";
import { computeAlignmentScore } from "@/lib/correlation-filter";
import type { Decimal } from "@prisma/client/runtime/client";
import type { CandleData } from "@/lib/types";
import type { BhgSetup } from "@/lib/bhg-engine";
import type { RiskResult } from "@/lib/risk-engine";
import type { EventContext } from "@/lib/event-awareness";
import type { TradeFeatureVector } from "@/lib/trade-features";
import type { MlBaseline } from "@/lib/ml-baseline";
import type { TradeScore } from "@/lib/composite-score";
import type { TradeReasoning } from "@/lib/trade-reasoning";
import type { MarketContext } from "@/lib/market-context";
import type { CorrelationAlignment } from "@/lib/correlation-filter";
import { recordScoredTrades } from "@/lib/trade-recorder";
import { checkTradeOutcomes } from "@/lib/outcome-tracker";
import { withCanonicalSetupIds } from "@/lib/setup-id";
import { recordTriggeredSetups, type SetupScoringContext } from "@/lib/bhg-setup-recorder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MIN_DISPLAY_COMPOSITE_SCORE = 50;

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ScoredTrade {
  setup: BhgSetup;
  risk: RiskResult | null;
  features: TradeFeatureVector;
  mlBaseline: MlBaseline;
  score: TradeScore;
  reasoning: TradeReasoning;
}

export interface UpcomingTradesResponse {
  trades: ScoredTrade[];
  eventContext: EventContext;
  currentPrice: number | null;
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>;
  timestamp: string;
  error?: string;
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function rowToCandle(row: {
  eventTime: Date;
  open: Decimal | number;
  high: Decimal | number;
  low: Decimal | number;
  close: Decimal | number;
  volume: bigint | null;
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  };
}

/**
 * Fallback market context used if upstream market context wiring fails.
 */
function fallbackMarketContext(reason: string): MarketContext {
  return {
    regime: "MIXED" as const,
    regimeFactors: [reason],
    correlations: [],
    headlines: [],
    goldContext: null,
    oilContext: null,
    yieldContext: null,
    techLeaders: [],
    themeScores: {
      tariffs: 0,
      rates: 0,
      trump: 0,
      analysts: 0,
      aiTech: 0,
      eventRisk: 0,
    },
    shockReactions: {
      vixSpikeSample: 0,
      vixSpikeAvgNextDayMesPct: null,
      vixSpikeMedianNextDayMesPct: null,
      yieldSpikeSample: 0,
      yieldSpikeAvgNextDayMesPct: null,
      yieldSpikeMedianNextDayMesPct: null,
    },
    breakout7000: null,
    intermarketNarrative: "",
  };
}

function fallbackAlignment(
  direction: BhgSetup["direction"],
  reason: string,
): CorrelationAlignment {
  return {
    vix: 0,
    dxy: 0,
    nq: 0,
    composite: 0,
    isAligned: true,
    details: `${direction} neutral fallback: ${reason}`,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function percentChange(series: CandleData[]): number {
  if (series.length < 2) return 0;
  const first = series[0]?.close;
  const last = series[series.length - 1]?.close;
  if (
    first == null ||
    last == null ||
    !Number.isFinite(first) ||
    !Number.isFinite(last) ||
    first === 0
  ) {
    return 0;
  }
  return ((last - first) / first) * 100;
}

function buildPriceChanges(
  symbolBars: Map<string, CandleData[]>,
): Map<string, number> {
  const changes = new Map<string, number>();
  for (const [symbolCode, bars] of symbolBars.entries()) {
    changes.set(symbolCode, percentChange(bars));
  }
  return changes;
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    await refreshMes15mFromDatabento({ force: false });

    // 1. Fetch MES 15m candles (last 200 bars for chart/card parity)
    const rows = await prisma.mktFuturesMes15m.findMany({
      orderBy: { eventTime: "desc" },
      take: 200,
    });

    if (rows.length < 10) {
      return NextResponse.json({
        trades: [],
        eventContext: {
          phase: "CLEAR",
          event: null,
          minutesToEvent: null,
          minutesSinceEvent: null,
          surprise: null,
          confidenceAdjustment: 1,
          label: "Insufficient data",
        },
        currentPrice: null,
        fibResult: null,
        timestamp: new Date().toISOString(),
        error: "Insufficient MES 15m data",
      } satisfies UpcomingTradesResponse);
    }

    const candles = [...rows].reverse().map(rowToCandle);
    const currentPrice = candles[candles.length - 1].close;

    // 2. BHG pipeline: swings → fibs → measured moves → state machine
    const swings = detectSwings(candles, 5, 5, 20);
    const fibResult = calculateFibonacciMultiPeriod(candles);

    if (!fibResult) {
      return NextResponse.json({
        trades: [],
        eventContext: {
          phase: "CLEAR",
          event: null,
          minutesToEvent: null,
          minutesSinceEvent: null,
          surprise: null,
          confidenceAdjustment: 1,
          label: "No fib structure",
        },
        currentPrice,
        fibResult: null,
        timestamp: new Date().toISOString(),
      } satisfies UpcomingTradesResponse);
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

    // 3. Event context
    const todayEvents = await loadTodayEvents();
    const eventContext = getEventContext(new Date(), todayEvents);

    // 4. Market context and alignment (symbol-registry + daily cross-asset bars)
    const symbolBars = new Map<string, CandleData[]>();
    let marketContext = fallbackMarketContext(
      "Cross-asset context unavailable; using fallback",
    );

    try {
      const analysisSymbols = await getSymbolsByRole("ANALYSIS_DEFAULT");
      const loadResults = await Promise.allSettled(
        analysisSymbols.map(async (symbol) => {
          const bars = await fetchDailyCandlesForSymbol(symbol.code);
          return { symbolCode: symbol.code, bars };
        }),
      );

      for (const result of loadResults) {
        if (result.status === "rejected") {
          console.warn(
            "[trades/upcoming] Symbol bar load failed:",
            toErrorMessage(result.reason),
          );
          continue;
        }

        const { symbolCode, bars } = result.value;
        if (bars.length < 2) continue;
        symbolBars.set(symbolCode, bars);
      }

      if (symbolBars.size > 0) {
        const priceChanges = buildPriceChanges(symbolBars);
        marketContext = await buildMarketContext(symbolBars, priceChanges);
      } else {
        console.warn(
          "[trades/upcoming] No usable symbol bars loaded; keeping fallback market context",
        );
      }
    } catch (error) {
      console.warn(
        "[trades/upcoming] Market context wiring failed; keeping fallback market context:",
        toErrorMessage(error),
      );
    }

    const alignmentByDirection = new Map<
      BhgSetup["direction"],
      CorrelationAlignment
    >();

    const getAlignmentForDirection = (
      direction: BhgSetup["direction"],
    ): CorrelationAlignment => {
      const cached = alignmentByDirection.get(direction);
      if (cached) return cached;

      const mesSeries = symbolBars.get("MES");
      if (!mesSeries || mesSeries.length < 20) {
        const fallback = fallbackAlignment(
          direction,
          "insufficient MES daily bars for directional correlation",
        );
        alignmentByDirection.set(direction, fallback);
        return fallback;
      }

      try {
        const computed = computeAlignmentScore(symbolBars, direction);
        alignmentByDirection.set(direction, computed);
        return computed;
      } catch (error) {
        const fallback = fallbackAlignment(direction, toErrorMessage(error));
        alignmentByDirection.set(direction, fallback);
        return fallback;
      }
    };

    // 5. Score each TRIGGERED setup
    const triggeredSetups = setups.filter((s) => s.phase === "TRIGGERED");

    const scoredTrades: ScoredTrade[] = await Promise.all(
      triggeredSetups.map(async (setup) => {
        // Risk
        const risk =
          setup.entry && setup.stopLoss && setup.tp1
            ? computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)
            : null;

        if (!risk) {
          // No risk = can't score. Return a minimal card.
          const emptyFeatures: TradeFeatureVector = {
            fibRatio: setup.fibRatio,
            goType: setup.goType ?? "BREAK",
            hookQuality: 0.5,
            measuredMoveAligned: false,
            measuredMoveQuality: null,
            stopDistancePts: 0,
            rrRatio: 0,
            riskGrade: "D",
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
          };
          const baseline = getMlBaseline(emptyFeatures);
          const score = computeCompositeScore(emptyFeatures, baseline);
          return {
            setup,
            risk: null,
            features: emptyFeatures,
            mlBaseline: baseline,
            score,
            reasoning: {
              adjustedPTp1: 0,
              adjustedPTp2: 0,
              rationale: "No risk data",
              keyRisks: [],
              tradeQuality: "D" as const,
              catalysts: [],
              source: "deterministic" as const,
            },
          };
        }

        const alignment = getAlignmentForDirection(setup.direction);

        // Feature vector
        const features = await computeTradeFeatures(
          setup,
          candles,
          risk,
          eventContext,
          marketContext,
          alignment,
          measuredMoves,
        );

        // ML baseline
        const mlBaseline = getMlBaseline(features);

        // Composite score
        const score = computeCompositeScore(features, mlBaseline);

        // AI reasoning (only for qualifying setups)
        const reasoning = await getTradeReasoning(
          setup,
          score,
          features,
          eventContext,
          marketContext,
        );

        return { setup, risk, features, mlBaseline, score, reasoning };
      }),
    );

    // Sort by composite score descending
    scoredTrades.sort((a, b) => b.score.composite - a.score.composite);

    const scoringBySetupId = new Map<string, SetupScoringContext>(
      scoredTrades.map((trade) => [
        trade.setup.id,
        {
          pTp1: trade.score.pTp1,
          pTp2: trade.score.pTp2,
          correlationScore: trade.features.compositeAlignment,
          vixLevel: trade.features.vixLevel,
          modelVersion: "warbird-live-v1",
        },
      ]),
    );

    // 6. Record canonical setup lifecycle rows for chart/card sync (fire-and-forget)
    recordTriggeredSetups(triggeredSetups, scoringBySetupId).catch((err) =>
      console.warn("[trades/upcoming] Setup persistence failed:", err),
    );

    // 7. Record trade-feature snapshots for model training (fire-and-forget)
    recordScoredTrades(scoredTrades, currentPrice, eventContext).catch((err) =>
      console.warn("[trades/upcoming] Recording failed:", err),
    );

    // 8. Check outcomes for older trades (fire-and-forget)
    checkTradeOutcomes().catch((err) =>
      console.warn("[trades/upcoming] Outcome check failed:", err),
    );

    const displayTrades = scoredTrades.filter(
      (trade) =>
        trade.score.composite >= MIN_DISPLAY_COMPOSITE_SCORE &&
        trade.features.isAligned,
    );

    return NextResponse.json({
      trades: displayTrades,
      eventContext,
      currentPrice,
      fibResult,
      timestamp: new Date().toISOString(),
    } satisfies UpcomingTradesResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[trades/upcoming] GET failed:", message);
    return NextResponse.json(
      {
        trades: [],
        eventContext: {
          phase: "CLEAR",
          event: null,
          minutesToEvent: null,
          minutesSinceEvent: null,
          surprise: null,
          confidenceAdjustment: 1,
          label: "Error",
        },
        currentPrice: null,
        fibResult: null,
        timestamp: new Date().toISOString(),
        error: "Internal server error",
      } satisfies UpcomingTradesResponse,
      { status: 500 },
    );
  }
}
