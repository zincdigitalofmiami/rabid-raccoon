/**
 * compute-signal — 15m compute cycle for trade signals.
 *
 * Triggers:
 *   1. Cron: :13, :28, :43, :58 (2 min before each 15m bar, weekdays)
 *   2. Event: 'econ/event.approaching' — fired by econ-event-watcher when a
 *      high-impact release is imminent or just dropped
 *
 * Runs the FULL pipeline once:
 *   1. Refresh MES 15m from Databento
 *   2. Run Python volume features script → volume JSON
 *   3. BHG engine (swings → fibs → measured moves → setups)
 *   4. Event context from econ_calendar
 *   5. Market context (cached morning-stable via tiered cache)
 *   6. Trade features (with volume + macro — ONE call, not per-setup)
 *   7. ML baseline scoring
 *   8. Composite scoring
 *   9. AI reasoning (full model, 10s timeout)
 *  10. Cache result in signal tier (15m TTL)
 *
 * The /api/trades/upcoming route becomes a thin cache reader (<50ms).
 */

import { inngest } from '../client'
import { prisma } from '@/lib/prisma'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacciMultiPeriod } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { advanceBhgSetups } from '@/lib/bhg-engine'
import { computeRisk, MES_DEFAULTS } from '@/lib/risk-engine'
import { refreshMes15mFromDatabento } from '@/lib/mes15m-refresh'
import { toNum } from '@/lib/decimal'
import {
  getEventContext,
  loadTodayEvents,
  fetchSurpriseHistory,
} from '@/lib/event-awareness'
import {
  computeTradeFeatures,
  getWarbirdMacroFeatures,
  type VolumeFeatures,
  DEFAULT_VOLUME_FEATURES,
} from '@/lib/trade-features'
import { getMlBaseline } from '@/lib/ml-baseline'
import { computeCompositeScore } from '@/lib/composite-score'
import { getTradeReasoning } from '@/lib/trade-reasoning'
import { fetchDailyCandlesForSymbol } from '@/lib/fetch-candles'
import { getSymbolsByRole } from '@/lib/symbol-registry'
import { buildMarketContext } from '@/lib/market-context'
import { computeAlignmentScore } from '@/lib/correlation-filter'
import { signalCache } from '@/lib/tiered-cache'
import { recordScoredTrades } from '@/lib/trade-recorder'
import { withCanonicalSetupIds } from '@/lib/setup-id'
import { recordTriggeredSetups, type SetupScoringContext } from '@/lib/bhg-setup-recorder'
import type { Decimal } from '@prisma/client/runtime/client'
import type { CandleData } from '@/lib/types'
import type { BhgSetup } from '@/lib/bhg-engine'
import type { CorrelationAlignment } from '@/lib/correlation-filter'
import type { MarketContext } from '@/lib/market-context'
import type { EventContext } from '@/lib/event-awareness'
import type { TradeFeatureVector } from '@/lib/trade-features'
import type { MlBaseline } from '@/lib/ml-baseline'
import type { TradeScore } from '@/lib/composite-score'
import type { TradeReasoning } from '@/lib/trade-reasoning'
import type { RiskResult } from '@/lib/risk-engine'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'

const execAsync = promisify(exec)

const MIN_DISPLAY_COMPOSITE_SCORE = 45

// ── Helpers ─────────────────────────────────────────────────────────

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
    volume: row.volume ? Number(row.volume) : undefined,
  }
}

function percentChange(bars: CandleData[]): number {
  if (bars.length < 2) return 0
  const first = bars[0].close
  const last = bars[bars.length - 1].close
  return first === 0 ? 0 : ((last - first) / first) * 100
}

function buildPriceChanges(symbolBars: Map<string, CandleData[]>): Map<string, number> {
  const changes = new Map<string, number>()
  for (const [symbolCode, bars] of symbolBars.entries()) {
    changes.set(symbolCode, percentChange(bars))
  }
  return changes
}

function fallbackMarketContext(reason: string): MarketContext {
  return {
    regime: 'MIXED' as const,
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
    intermarketNarrative: reason,
  }
}

function fallbackAlignment(
  direction: BhgSetup['direction'],
  reason: string,
): CorrelationAlignment {
  return {
    vix: 0,
    dxy: 0,
    nq: 0,
    composite: 0,
    isAligned: true,
    details: `${direction} neutral fallback: ${reason}`,
  }
}

const EMPTY_EVENT_CONTEXT: EventContext = {
  phase: 'CLEAR',
  event: null,
  minutesToEvent: null,
  minutesSinceEvent: null,
  surprise: null,
  confidenceAdjustment: 1,
  label: 'No nearby events',
  eventName: null,
  expectedImpact: null,
  forecast: null,
  previous: null,
  surpriseHistory: null,
  marketTemperature: null,
}

// ── Volume features from Python ─────────────────────────────────────

async function computeVolumeFeatures(): Promise<VolumeFeatures> {
  try {
    const scriptPath = path.resolve(process.cwd(), 'scripts/compute-volume-features.py')
    const { stdout } = await execAsync(
      `python3 "${scriptPath}"`,
      { timeout: 30_000, cwd: process.cwd() },
    )

    const json = JSON.parse(stdout.trim())
    return {
      rvol: json.rvol ?? 1,
      rvolSession: json.rvol_session ?? 1,
      vwap: json.vwap ?? 0,
      priceVsVwap: json.price_vs_vwap ?? 0,
      vwapBand: json.vwap_band ?? 0,
      poc: json.poc ?? 0,
      priceVsPoc: json.price_vs_poc ?? 0,
      inValueArea: json.in_value_area ?? true,
      volumeConfirmation: json.volume_confirmation ?? false,
      pocSlope: json.poc_slope ?? 0,
    }
  } catch (err) {
    console.warn('[compute-signal] Volume features failed:', err instanceof Error ? err.message : err)
    return { ...DEFAULT_VOLUME_FEATURES }
  }
}

// ── Scored trade type (matches route.ts) ────────────────────────────

export interface ScoredTrade {
  setup: BhgSetup
  risk: RiskResult | null
  features: TradeFeatureVector
  mlBaseline: MlBaseline
  score: TradeScore
  reasoning: TradeReasoning
}

export interface SignalPayload {
  trades: ScoredTrade[]
  eventContext: EventContext
  currentPrice: number | null
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod>
  timestamp: string
  computedAt: string
  source: 'inngest-compute-signal'
}

// ── Main Inngest function ───────────────────────────────────────────

export const computeSignal = inngest.createFunction(
  {
    id: 'compute-signal',
    retries: 1,

    // ── Flow Control ─────────────────────────────────────────────────
    // Concurrency: only 1 run executing at a time (steps sleeping/waiting don't count)
    concurrency: [{ limit: 1 }],

    // Throttle: max 1 run start per 10 minutes. Excess queued FIFO, not dropped.
    // Prevents back-to-back runs when cron + econ event overlap.
    throttle: { limit: 1, period: '10m' },

    // Priority: econ-triggered runs jump ahead of scheduled cron runs.
    // Range -600 to 600; econ events get +200 priority.
    priority: {
      run: "event.name == 'econ/event.approaching' ? 200 : 0",
    },

    // Cancel: if a new econ event arrives while a (stale) cron run is executing,
    // cancel the in-progress run so the fresh econ-triggered run starts immediately.
    cancelOn: [{ event: 'econ/event.approaching' }],

    // Failure handler: log + alert so we never silently lose a 15m window.
    onFailure: async ({ error, event }) => {
      console.error(
        '[compute-signal] FAILED after all retries:',
        error?.message ?? error,
        'trigger:',
        event?.name ?? 'cron',
      )
      // Future: fire alert event or write to monitoring table
    },
  },
  [
    { cron: '13,28,43,58 * * * 1-5' },
    { event: 'econ/event.approaching' },
  ],
  async ({ step }) => {
    // Step 1: Refresh MES 15m data from Databento
    const refreshResult = await step.run('refresh-mes-15m', async () =>
      refreshMes15mFromDatabento({ force: true, lookbackMinutes: 120 }),
    )

    // Step 2: Load 15m candles from DB
    const candles = await step.run('load-15m-candles', async () => {
      const rows = await prisma.mktFuturesMes15m.findMany({
        orderBy: { eventTime: 'desc' },
        take: 200,
      })

      if (rows.length < 10) {
        return { candles: [] as CandleData[], error: 'Insufficient data' }
      }

      return {
        candles: [...rows].reverse().map(rowToCandle),
        error: null,
      }
    })

    if (candles.error || candles.candles.length < 10) {
      const payload: SignalPayload = {
        trades: [],
        eventContext: EMPTY_EVENT_CONTEXT,
        currentPrice: null,
        fibResult: null,
        timestamp: new Date().toISOString(),
        computedAt: new Date().toISOString(),
        source: 'inngest-compute-signal',
      }
      signalCache.set('upcoming-trades', payload)
      return { status: 'no-data', refreshResult }
    }

    const candleData = candles.candles
    const currentPrice = candleData[candleData.length - 1].close

    // Step 3: Run volume features, event context, market context in parallel
    const parallelResult = await step.run('parallel-compute', async () => {
      const [vol, events, mktCtx] = await Promise.all([
        computeVolumeFeatures(),
        (async () => {
          const todayEvents = await loadTodayEvents()
          const nearest = todayEvents.find(
            (e) => e.impactRating?.toLowerCase() === 'high' || e.impactRating?.toLowerCase() === 'medium',
          )
          const surpriseHist = nearest ? await fetchSurpriseHistory(nearest.eventName) : null
          return getEventContext(new Date(), todayEvents, {
            surpriseHistory: surpriseHist,
            marketTemperature: null,
          })
        })(),
        (async (): Promise<MarketContext> => {
          try {
            const analysisSymbols = await getSymbolsByRole('ANALYSIS_DEFAULT')
            const symbolBars = new Map<string, CandleData[]>()

            const loadResults = await Promise.allSettled(
              analysisSymbols.map(async (symbol) => {
                const bars = await fetchDailyCandlesForSymbol(symbol.code)
                return { symbolCode: symbol.code, bars }
              }),
            )

            for (const result of loadResults) {
              if (result.status === 'rejected') continue
              const { symbolCode, bars } = result.value
              if (bars.length < 2) continue
              symbolBars.set(symbolCode, bars)
            }

            if (symbolBars.size > 0) {
              const priceChanges = buildPriceChanges(symbolBars)
              return await buildMarketContext(symbolBars, priceChanges)
            }
            return fallbackMarketContext('No usable symbol bars')
          } catch {
            return fallbackMarketContext('Market context wiring failed')
          }
        })(),
      ])

      return { vol, events, mktCtx }
    })

    const volumeFeatures = parallelResult.vol
    const marketContextResult = parallelResult.mktCtx

    // Reconstitute EventContext (Inngest serializes Date → string in step returns)
    const rawEvents = parallelResult.events
    const evCtx: EventContext = {
      ...rawEvents,
      event: rawEvents.event
        ? { ...rawEvents.event, time: new Date(rawEvents.event.time) }
        : null,
      marketTemperature:
        marketContextResult.regime === 'RISK-ON'
          ? 'risk-on'
          : marketContextResult.regime === 'RISK-OFF'
            ? 'risk-off'
            : 'neutral',
    }

    // Step 4: BHG pipeline
    const signal = await step.run('score-setups', async () => {
      const swings = detectSwings(candleData, 5, 5, 20)
      const fibResult = calculateFibonacciMultiPeriod(candleData)

      if (!fibResult) {
        return {
          trades: [] as ScoredTrade[],
          fibResult: null,
        }
      }

      const measuredMoves = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)
      const setups = withCanonicalSetupIds(
        advanceBhgSetups(candleData, fibResult, measuredMoves),
        'M15',
      )

      // Pre-fetch macro features ONCE for all setups
      const macroFeatures = await getWarbirdMacroFeatures(candleData)

      // Build symbol bars for alignment
      const symbolBars = new Map<string, CandleData[]>()
      try {
        const analysisSymbols = await getSymbolsByRole('ANALYSIS_DEFAULT')
        const results = await Promise.allSettled(
          analysisSymbols.map(async (sym) => ({
            code: sym.code,
            bars: await fetchDailyCandlesForSymbol(sym.code),
          })),
        )
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.bars.length >= 2) {
            symbolBars.set(r.value.code, r.value.bars)
          }
        }
      } catch {
        // fallback alignment will handle
      }

      const alignmentByDirection = new Map<BhgSetup['direction'], CorrelationAlignment>()
      const getAlignment = (direction: BhgSetup['direction']): CorrelationAlignment => {
        const cached = alignmentByDirection.get(direction)
        if (cached) return cached
        const mesSeries = symbolBars.get('MES')
        if (!mesSeries || mesSeries.length < 20) {
          const fb = fallbackAlignment(direction, 'insufficient daily bars')
          alignmentByDirection.set(direction, fb)
          return fb
        }
        try {
          const computed = computeAlignmentScore(symbolBars, direction)
          alignmentByDirection.set(direction, computed)
          return computed
        } catch {
          const fb = fallbackAlignment(direction, 'computation failed')
          alignmentByDirection.set(direction, fb)
          return fb
        }
      }

      // Score TRIGGERED setups
      const triggered = setups.filter((s) => s.phase === 'TRIGGERED')

      const scoredTrades: ScoredTrade[] = await Promise.all(
        triggered.map(async (setup) => {
          const risk =
            setup.entry && setup.stopLoss && setup.tp1
              ? computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)
              : null

          if (!risk) {
            const emptyFeatures: TradeFeatureVector = {
              fibRatio: setup.fibRatio,
              goType: setup.goType ?? 'BREAK',
              hookQuality: 0.5,
              measuredMoveAligned: false,
              measuredMoveQuality: null,
              stopDistancePts: 0,
              rrRatio: 0,
              riskGrade: 'D',
              eventPhase: evCtx.phase,
              minutesToNextEvent: evCtx.minutesToEvent,
              minutesSinceEvent: evCtx.minutesSinceEvent,
              confidenceAdjustment: evCtx.confidenceAdjustment,
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
              regime: 'MIXED',
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
            }
            const baseline = getMlBaseline(emptyFeatures)
            const score = computeCompositeScore(emptyFeatures, baseline)
            return {
              setup,
              risk: null,
              features: emptyFeatures,
              mlBaseline: baseline,
              score,
              reasoning: {
                adjustedPTp1: 0,
                adjustedPTp2: 0,
                rationale: 'No risk data',
                keyRisks: [],
                tradeQuality: 'D' as const,
                catalysts: [],
                source: 'deterministic' as const,
              },
            }
          }

          const alignment = getAlignment(setup.direction)

          const features = await computeTradeFeatures(
            setup,
            candleData,
            risk,
            evCtx,
            marketContextResult,
            alignment,
            measuredMoves,
            macroFeatures,
            volumeFeatures,
          )

          const mlBaseline = getMlBaseline(features)
          const score = computeCompositeScore(features, mlBaseline)

          const reasoning = await getTradeReasoning(
            setup,
            score,
            features,
            evCtx,
            marketContextResult,
          )

          return { setup, risk, features, mlBaseline, score, reasoning }
        }),
      )

      scoredTrades.sort((a, b) => b.score.composite - a.score.composite)

      // Record setups + outcomes (fire-and-forget within Inngest step)
      const scoringBySetupId = new Map<string, SetupScoringContext>(
        scoredTrades.map((trade) => [
          trade.setup.id,
          {
            pTp1: trade.score.pTp1,
            pTp2: trade.score.pTp2,
            correlationScore: trade.features.compositeAlignment,
            vixLevel: trade.features.vixLevel,
            modelVersion: 'warbird-live-v1',
          },
        ]),
      )

      recordTriggeredSetups(triggered, scoringBySetupId).catch((err) =>
        console.warn('[compute-signal] Setup persistence failed:', err),
      )
      recordScoredTrades(scoredTrades, currentPrice, evCtx).catch((err) =>
        console.warn('[compute-signal] Recording failed:', err),
      )

      return {
        trades: scoredTrades.filter(
          (t) => t.score.composite >= MIN_DISPLAY_COMPOSITE_SCORE && t.features.isAligned,
        ),
        fibResult,
      }
    })

    // Step 5: Cache the signal
    const payload: SignalPayload = {
      trades: signal.trades,
      eventContext: evCtx,
      currentPrice,
      fibResult: signal.fibResult,
      timestamp: new Date().toISOString(),
      computedAt: new Date().toISOString(),
      source: 'inngest-compute-signal',
    }

    signalCache.set('upcoming-trades', payload)

    return {
      status: 'ok',
      tradesCount: signal.trades.length,
      currentPrice,
      phase: evCtx.phase,
      eventName: evCtx.eventName,
      computedAt: payload.computedAt,
    }
  },
)
