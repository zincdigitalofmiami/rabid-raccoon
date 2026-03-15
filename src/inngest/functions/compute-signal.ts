/**
 * compute-signal — 15m compute cycle for trade signals.
 *
 * Triggers:
 *   1. Cron: :13, :28, :43, :58 (2 min before each 15m bar, weekdays)
 *   2. Event: 'econ/event.approaching' — fired by econ-event-watcher when a
 *      high-impact release is imminent or just dropped
 *
 * Runs the FULL pipeline once:
 *   1. Read MES 1m from DB (freshness owned by ingest-mkt-mes-1m)
 *   2. Run Python volume features script → volume JSON
 *   3. Trigger candidate engine (currently backed by legacy BHG logic)
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
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacciMultiPeriod } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { computeRisk, MES_DEFAULTS } from '@/lib/risk-engine'
import { readLatestMes1mRows } from '@/lib/mes-live-queries'
import {
  getEventContext,
  loadTodayEvents,
  fetchSurpriseHistory,
} from '@/lib/event-awareness'
import {
  computeTradeFeatures,
  getWarbirdMacroFeatures,
  type VolumeFeatures,
  type VolumeState,
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
import {
  recordTriggeredCandidates,
  type TriggerScoringContext,
} from '@/lib/trigger-candidate-recorder'
import type { CandleData } from '@/lib/types'
import {
  generateTriggerCandidates,
  getTriggeredCandidates,
  type TriggerCandidate,
  type TriggerDirection,
} from '@/lib/trigger-candidates'
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
const SIGNAL_15M_LOOKBACK = 200
const SIGNAL_1M_LOOKBACK = SIGNAL_15M_LOOKBACK * 15 + 60
const MARKET_CONTEXT_ROLE = 'ANALYSIS_DEFAULT'
const TRIGGER_CORRELATION_ROLE = 'CORRELATION_SET'

// ── Helpers ─────────────────────────────────────────────────────────

function aggregateCandles(candles: CandleData[], periodMinutes: number): CandleData[] {
  if (candles.length === 0) return []
  const periodSec = periodMinutes * 60
  const result: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const candle of candles) {
    const aligned = Math.floor(candle.time / periodSec) * periodSec
    if (bucket === null || aligned !== bucketStart) {
      if (bucket) result.push(bucket)
      bucket = {
        time: aligned,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      }
      bucketStart = aligned
    } else {
      bucket.high = Math.max(bucket.high, candle.high)
      bucket.low = Math.min(bucket.low, candle.low)
      bucket.close = candle.close
      bucket.volume = (bucket.volume || 0) + (candle.volume || 0)
    }
  }

  if (bucket) result.push(bucket)
  return result
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

async function loadDailySymbolBarsByRole(roleKey: string): Promise<Map<string, CandleData[]>> {
  const symbols = await getSymbolsByRole(roleKey)
  const symbolBars = new Map<string, CandleData[]>()

  const results = await Promise.allSettled(
    symbols.map(async (symbol) => ({
      code: symbol.code,
      bars: await fetchDailyCandlesForSymbol(symbol.code),
    })),
  )

  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    if (result.value.bars.length < 2) continue
    symbolBars.set(result.value.code, result.value.bars)
  }

  return symbolBars
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

function toFiniteNumber(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new Error(`Invalid volume feature: ${label}`)
}

function toBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === 'true') return true
    if (normalized === 'false') return false
  }
  throw new Error(`Invalid volume feature: ${label}`)
}

function toVolumeState(value: unknown, label: string): VolumeState {
  if (typeof value !== 'string') {
    throw new Error(`Invalid volume feature: ${label}`)
  }
  const normalized = value.trim().toUpperCase()
  switch (normalized) {
    case 'THIN':
    case 'BALANCED':
    case 'EXPANSION':
    case 'EXHAUSTION':
    case 'ABSORPTION':
      return normalized
    default:
      throw new Error(`Invalid volume feature: ${label}`)
  }
}

function parseVolumeScriptPayload(payload: unknown): VolumeFeatures {
  const root = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>)
    : {}
  const source = root.features && typeof root.features === 'object'
    ? (root.features as Record<string, unknown>)
    : root

  if (typeof root.error === 'string' && root.error.trim().length > 0) {
    throw new Error(`Volume script error: ${root.error.trim()}`)
  }

  return {
    rvol: toFiniteNumber(source.rvol, 'rvol'),
    rvolSession: toFiniteNumber(source.rvol_session, 'rvol_session'),
    volumeState: toVolumeState(source.volume_state, 'volume_state'),
    vwap: toFiniteNumber(source.vwap, 'vwap'),
    priceVsVwap: toFiniteNumber(source.price_vs_vwap, 'price_vs_vwap'),
    vwapBand: Math.trunc(toFiniteNumber(source.vwap_band, 'vwap_band')),
    poc: toFiniteNumber(source.poc, 'poc'),
    priceVsPoc: toFiniteNumber(source.price_vs_poc, 'price_vs_poc'),
    inValueArea: toBoolean(source.in_value_area, 'in_value_area'),
    volumeConfirmation: toBoolean(source.volume_confirmation, 'volume_confirmation'),
    pocSlope: toFiniteNumber(source.poc_slope, 'poc_slope'),
    paceAcceleration: toFiniteNumber(source.pace_acceleration, 'pace_acceleration'),
  }
}

async function computeVolumeFeatures(): Promise<VolumeFeatures> {
  try {
    const scriptPath = path.resolve(process.cwd(), 'scripts/compute-volume-features.py')
    const { stdout } = await execAsync(
      `python3 "${scriptPath}"`,
      { timeout: 30_000, cwd: process.cwd() },
    )

    return parseVolumeScriptPayload(JSON.parse(stdout.trim()))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Volume features failed: ${message}`)
  }
}

// ── Scored trade type (matches route.ts) ────────────────────────────

export interface ScoredTrade {
  setup: TriggerCandidate
  risk: RiskResult
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
    // PAUSED: { cron: '13,28,43,58 * * * 1-5' }
    { event: "manual/paused" },
    { event: 'econ/event.approaching' },
  ],
  async ({ step }) => {
    // Step 1: Load 1m candles from DB and derive the local 15m working set.
    // Authoritative 1m ingestion/freshness is owned by ingest-mkt-mes-1m.
    const candles = await step.run('load-1m-and-derive-15m-candles', async () => {
      const rows = await readLatestMes1mRows(SIGNAL_1M_LOOKBACK)
      const candles1m = [...rows].reverse().map((row) => ({
        time: Math.floor(row.eventTime.getTime() / 1000),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
      }))
      const candles15m = aggregateCandles(candles1m, 15).slice(-SIGNAL_15M_LOOKBACK)

      if (candles15m.length < 10) {
        return { candles: [] as CandleData[], error: 'Insufficient data' }
      }

      return {
        candles: candles15m,
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
      return { status: 'no-data' }
    }

    const candleData = candles.candles
    const currentPrice = candleData[candleData.length - 1].close

    // Step 2: Run volume features, event context, market context in parallel
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
          const symbolBars = await loadDailySymbolBarsByRole(MARKET_CONTEXT_ROLE)

          if (symbolBars.size === 0) {
            throw new Error('No usable symbol bars for market context')
          }
          const priceChanges = buildPriceChanges(symbolBars)
          return await buildMarketContext(symbolBars, priceChanges)
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

    // Step 3: Trigger candidate pipeline (currently backed by legacy BHG logic)
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
        generateTriggerCandidates(candleData, fibResult, measuredMoves),
        'M15',
      )

      // Pre-fetch macro features ONCE for all setups
      const macroFeatures = await getWarbirdMacroFeatures(candleData)

      // Build symbol bars for alignment
      const symbolBars = new Map<string, CandleData[]>()
      const correlationBars = await loadDailySymbolBarsByRole(TRIGGER_CORRELATION_ROLE)
      for (const [code, bars] of correlationBars.entries()) {
        symbolBars.set(code, bars)
      }

      const alignmentByDirection = new Map<TriggerDirection, CorrelationAlignment>()
      const getAlignment = (direction: TriggerDirection): CorrelationAlignment => {
        const cached = alignmentByDirection.get(direction)
        if (cached) return cached
        const mesSeries = symbolBars.get('MES')
        if (!mesSeries || mesSeries.length < 20) {
          throw new Error(`Insufficient daily bars for correlation alignment (${direction}).`)
        }

        const computed = computeAlignmentScore(symbolBars, direction)
        alignmentByDirection.set(direction, computed)
        return computed
      }

      // Score TRIGGERED setups
      const triggered = getTriggeredCandidates(setups)

      const scoredTradeCandidates = await Promise.all(
        triggered.map(async (setup) => {
          const risk =
            setup.entry && setup.stopLoss && setup.tp1
              ? computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)
              : null

          if (!risk) {
            console.warn('[compute-signal] Skipping setup without risk tuple:', setup.id)
            return null
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
            fibResult.levels.map((level) => level.price),
          )

          let mlBaseline: MlBaseline
          let score: TradeScore
          try {
            mlBaseline = getMlBaseline(features)
            score = computeCompositeScore(features, mlBaseline)
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            console.warn('[compute-signal] Skipping setup due ML baseline failure:', message)
            return null
          }

          const reasoning = await getTradeReasoning(
            setup,
            score,
            features,
            evCtx,
            marketContextResult,
          ).catch((err) => {
            const message = err instanceof Error ? err.message : String(err)
            console.warn('[compute-signal] Skipping setup due AI reasoning failure:', message)
            return null
          })

          if (!reasoning) return null
          return { setup, risk, features, mlBaseline, score, reasoning }
        }),
      )

      const scoredTrades: ScoredTrade[] = scoredTradeCandidates.filter(
        (trade): trade is ScoredTrade => trade != null,
      )

      scoredTrades.sort((a, b) => b.score.composite - a.score.composite)

      // Record triggered candidates + scored trade snapshots (fire-and-forget)
      const scoringBySetupId = new Map<string, TriggerScoringContext>(
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

      recordTriggeredCandidates(triggered, scoringBySetupId).catch((err) =>
        console.warn('[compute-signal] Trigger candidate persistence failed:', err),
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
