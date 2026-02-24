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

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacciMultiPeriod } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { advanceBhgSetups } from '@/lib/bhg-engine'
import { computeRisk, MES_DEFAULTS } from '@/lib/risk-engine'
import { refreshMes15mFromDatabento } from '@/lib/mes15m-refresh'
import { toNum } from '@/lib/decimal'
import { getEventContext, loadTodayEvents } from '@/lib/event-awareness'
import { computeTradeFeatures } from '@/lib/trade-features'
import { getMlBaseline } from '@/lib/ml-baseline'
import { computeCompositeScore } from '@/lib/composite-score'
import { getTradeReasoning } from '@/lib/trade-reasoning'
import type { Decimal } from '@prisma/client/runtime/client'
import type { CandleData } from '@/lib/types'
import type { BhgSetup } from '@/lib/bhg-engine'
import type { RiskResult } from '@/lib/risk-engine'
import type { EventContext } from '@/lib/event-awareness'
import type { TradeFeatureVector } from '@/lib/trade-features'
import type { MlBaseline } from '@/lib/ml-baseline'
import type { TradeScore } from '@/lib/composite-score'
import type { TradeReasoning } from '@/lib/trade-reasoning'
import type { MarketContext } from '@/lib/market-context'
import type { CorrelationAlignment } from '@/lib/correlation-filter'
import { recordScoredTrades } from '@/lib/trade-recorder'
import { checkTradeOutcomes } from '@/lib/outcome-tracker'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface ScoredTrade {
  setup: BhgSetup
  risk: RiskResult | null
  features: TradeFeatureVector
  mlBaseline: MlBaseline
  score: TradeScore
  reasoning: TradeReasoning
}

export interface UpcomingTradesResponse {
  trades: ScoredTrade[]
  eventContext: EventContext
  currentPrice: number | null
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>
  timestamp: string
  error?: string
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function rowToCandle(row: {
  eventTime: Date
  open: Decimal | number
  high: Decimal | number
  low: Decimal | number
  close: Decimal | number
  volume: bigint | null
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

/**
 * Lightweight market context stub for when full context is unavailable.
 * The full buildMarketContext() requires cross-asset candle data which
 * we'll wire in Task 17. For now, provide a minimal context.
 */
function minimalMarketContext(): MarketContext {
  return {
    regime: 'MIXED' as const,
    regimeFactors: [],
    correlations: [],
    headlines: [],
    goldContext: null,
    oilContext: null,
    yieldContext: null,
    techLeaders: [],
    themeScores: { tariffs: 0, rates: 0, trump: 0, analysts: 0, aiTech: 0, eventRisk: 0 },
    shockReactions: {
      vixSpikeSample: 0, vixSpikeAvgNextDayMesPct: null, vixSpikeMedianNextDayMesPct: null,
      yieldSpikeSample: 0, yieldSpikeAvgNextDayMesPct: null, yieldSpikeMedianNextDayMesPct: null,
    },
    breakout7000: null,
    intermarketNarrative: '',
  }
}

/** Minimal alignment stub — wire full computation in Task 17. */
function minimalAlignment(): CorrelationAlignment {
  return {
    vix: 0, dxy: 0, nq: 0,
    composite: 0, isAligned: true,
    details: 'Alignment pending — cross-asset data not loaded',
  }
}

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

export async function GET(): Promise<Response> {
  try {
    await refreshMes15mFromDatabento({ force: false })

    // 1. Fetch MES 15m candles (last 96 bars = 24h)
    const rows = await prisma.mktFuturesMes15m.findMany({
      orderBy: { eventTime: 'desc' },
      take: 96,
    })

    if (rows.length < 10) {
      return NextResponse.json({
        trades: [],
        eventContext: { phase: 'CLEAR', event: null, minutesToEvent: null, minutesSinceEvent: null, surprise: null, confidenceAdjustment: 1, label: 'Insufficient data' },
        currentPrice: null,
        fibResult: null,
        timestamp: new Date().toISOString(),
        error: 'Insufficient MES 15m data',
      } satisfies UpcomingTradesResponse)
    }

    const candles = [...rows].reverse().map(rowToCandle)
    const currentPrice = candles[candles.length - 1].close

    // 2. BHG pipeline: swings → fibs → measured moves → state machine
    const swings = detectSwings(candles, 5, 5, 20)
    const fibResult = calculateFibonacciMultiPeriod(candles)

    if (!fibResult) {
      return NextResponse.json({
        trades: [],
        eventContext: { phase: 'CLEAR', event: null, minutesToEvent: null, minutesSinceEvent: null, surprise: null, confidenceAdjustment: 1, label: 'No fib structure' },
        currentPrice,
        fibResult: null,
        timestamp: new Date().toISOString(),
      } satisfies UpcomingTradesResponse)
    }

    const measuredMoves = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)
    const setups = advanceBhgSetups(candles, fibResult, measuredMoves)

    // 3. Event context
    const todayEvents = await loadTodayEvents()
    const eventContext = getEventContext(new Date(), todayEvents)

    // 4. Market context and alignment (minimal stubs — full wiring in Task 17)
    const marketContext = minimalMarketContext()
    const alignment = minimalAlignment()

    // 5. Score each TRIGGERED setup
    const triggeredSetups = setups.filter(s => s.phase === 'TRIGGERED')

    const scoredTrades: ScoredTrade[] = await Promise.all(
      triggeredSetups.map(async (setup) => {
        // Risk
        const risk = (setup.entry && setup.stopLoss && setup.tp1)
          ? computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)
          : null

        if (!risk) {
          // No risk = can't score. Return a minimal card.
          const emptyFeatures: TradeFeatureVector = {
            fibRatio: setup.fibRatio, goType: setup.goType ?? 'BREAK',
            hookQuality: 0.5, measuredMoveAligned: false, measuredMoveQuality: null,
            stopDistancePts: 0, rrRatio: 0, riskGrade: 'D',
            eventPhase: eventContext.phase, minutesToNextEvent: eventContext.minutesToEvent,
            minutesSinceEvent: eventContext.minutesSinceEvent,
            confidenceAdjustment: eventContext.confidenceAdjustment,
            vixLevel: null, vixPercentile: null, regime: 'MIXED',
            themeScores: {}, compositeAlignment: 0, isAligned: true,
            sqzMom: null, sqzState: null, wvfValue: null, wvfPercentile: null,
            macdHist: null, macdHistColor: null,
            newsVolume24h: 0, policyNewsVolume24h: 0,
          }
          const baseline = getMlBaseline(emptyFeatures)
          const score = computeCompositeScore(emptyFeatures, baseline)
          return {
            setup, risk: null, features: emptyFeatures,
            mlBaseline: baseline, score,
            reasoning: { adjustedPTp1: 0, adjustedPTp2: 0, rationale: 'No risk data', keyRisks: [], tradeQuality: 'D' as const, catalysts: [], source: 'deterministic' as const },
          }
        }

        // Feature vector
        const features = await computeTradeFeatures(
          setup, candles, risk, eventContext, marketContext, alignment, measuredMoves,
        )

        // ML baseline
        const mlBaseline = getMlBaseline(features)

        // Composite score
        const score = computeCompositeScore(features, mlBaseline)

        // AI reasoning (only for qualifying setups)
        const reasoning = await getTradeReasoning(
          setup, score, features, eventContext, marketContext,
        )

        return { setup, risk, features, mlBaseline, score, reasoning }
      }),
    )

    // Sort by composite score descending
    scoredTrades.sort((a, b) => b.score.composite - a.score.composite)

    // 6. Record trades to DB for training (fire-and-forget)
    recordScoredTrades(scoredTrades, currentPrice, eventContext).catch(err =>
      console.warn('[trades/upcoming] Recording failed:', err),
    )

    // 7. Check outcomes for older trades (fire-and-forget)
    checkTradeOutcomes().catch(err =>
      console.warn('[trades/upcoming] Outcome check failed:', err),
    )

    return NextResponse.json({
      trades: scoredTrades,
      eventContext,
      currentPrice,
      fibResult,
      timestamp: new Date().toISOString(),
    } satisfies UpcomingTradesResponse)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      {
        trades: [],
        eventContext: { phase: 'CLEAR', event: null, minutesToEvent: null, minutesSinceEvent: null, surprise: null, confidenceAdjustment: 1, label: 'Error' },
        currentPrice: null,
        fibResult: null,
        timestamp: new Date().toISOString(),
        error: message,
      } satisfies UpcomingTradesResponse,
      { status: 500 },
    )
  }
}
