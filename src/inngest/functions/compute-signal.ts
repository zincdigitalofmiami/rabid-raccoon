/**
 * compute-signal.ts — BHG + AI Signal Pipeline (runs every 15 minutes)
 *
 * Pipeline:
 *   1. Fetch latest MES 15m candles from DB (direct pool)
 *   2. Run BHG state machine → detect TRIGGERED setups
 *   3. Load event context from DB
 *   4. For each triggered setup:
 *      a. Compute risk (position sizing, R:R)
 *      b. Assemble trade feature vector (DB queries for VIX, GPR, Trump, news)
 *      c. Get ML baseline from regime lookup table
 *      d. Compute composite score (0-100)
 *      e. Get Claude AI reasoning (Layer 2, with 3s timeout + deterministic fallback)
 *   5. Persist scored trades to scored_trades table (upsert by window hash)
 *
 * Fires at :13, :28, :43, :58 to align with 15m bar closes (:00, :15, :30, :45).
 * Offset from MES ingest at :05 ensures fresh candles are available.
 *
 * Auth path for Claude:
 *   All environments: CLAUDE_PROXY_URL → CLIProxyAPI → Claude Code Max subscription ($0.00)
 *   No Vercel AI Gateway. No direct API key. No per-token cost.
 */

import { createHash } from 'node:crypto'
import { inngest } from '../client'
import { prisma } from '../../lib/prisma'
import { readLatestMes15mRows } from '../../lib/mes-live-queries'
import { detectSwings } from '../../lib/swing-detection'
import { calculateFibonacciMultiPeriod } from '../../lib/fibonacci'
import { detectMeasuredMoves } from '../../lib/measured-move'
import { computeRisk, MES_DEFAULTS } from '../../lib/risk-engine'
import { withCanonicalSetupIds } from '../../lib/setup-id'
import { getEventContext, loadTodayEvents } from '../../lib/event-awareness'
import { computeTradeFeatures } from '../../lib/trade-features'
import { getMlBaseline } from '../../lib/ml-baseline'
import { computeCompositeScore } from '../../lib/composite-score'
import { getTradeReasoning } from '../../lib/trade-reasoning'
import { computeAlignmentScore } from '../../lib/correlation-filter'
import { detectFibSignals, loadWarbirdPrediction } from '../../lib/fib-signal-engine'
import type { CandleData } from '../../lib/types'
import type { MarketContext } from '../../lib/market-context'
import type { BhgSetup } from '../../lib/bhg-engine'
import type { RiskResult } from '../../lib/risk-engine'

import type { EventContext } from '../../lib/event-awareness'

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToCandle(row: {
  eventTime: Date | string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}): CandleData {
  const ts =
    typeof row.eventTime === 'string'
      ? new Date(row.eventTime).getTime()
      : row.eventTime.getTime()
  return {
    time: Math.floor(ts / 1000),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume ?? 0,
  }
}

/**
 * Repair an EventContext that came back from Inngest step serialization.
 * step.run JSON-serializes return values, turning Date objects into ISO strings.
 * This function converts event.time back to a Date so downstream code works correctly.
 */
function deserializeEventContext(raw: unknown): EventContext {
  const ctx = raw as EventContext
  if (ctx.event?.time && typeof (ctx.event.time as unknown) === 'string') {
    ;(ctx.event as { time: Date }).time = new Date(ctx.event.time as unknown as string)
  }
  return ctx
}


function windowHash(setupId: string): string {
  const windowStart = Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000)
  return createHash('sha256')
    .update(`${setupId}:${windowStart}`)
    .digest('hex')
    .slice(0, 128)
}

/**
 * Build a minimal MarketContext from DB macro data.
 * Full context (tech leaders, live FRED headlines) is skipped — those require
 * external HTTP calls not suitable for a 15-minute background cron.
 */
function buildMinimalMarketContext(
  vixLevel: number | null,
  trumpTariffFlag: boolean,
  trumpEoCount7d: number,
  eventPhase: string,
): MarketContext {
  const regime =
    vixLevel == null
      ? 'MIXED'
      : vixLevel > 25
        ? 'RISK-OFF'
        : vixLevel < 15
          ? 'RISK-ON'
          : 'MIXED'

  return {
    regime,
    regimeFactors: vixLevel != null ? [`VIX=${vixLevel.toFixed(1)}`] : [],
    correlations: [],
    headlines: [],
    goldContext: null,
    oilContext: null,
    yieldContext: null,
    techLeaders: [],
    themeScores: {
      tariffs: trumpTariffFlag ? 1 : 0,
      rates: 0,
      trump: Math.min(trumpEoCount7d / 5, 1),
      analysts: 0,
      aiTech: 0,
      eventRisk:
        eventPhase === 'APPROACHING' || eventPhase === 'IMMINENT' ? 1 : 0,
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
    intermarketNarrative: '',
  }
}

// ── Inngest function ──────────────────────────────────────────────────────────

export const computeSignal = inngest.createFunction(
  { id: 'compute-signal', retries: 1 },
  { cron: '13,28,43,58 * * * *' }, // :13, :28, :43, :58 — aligns with 15m bar closes
  async ({ step }) => {
    // ─── Step 1: Fetch MES 15m candles ──────────────────────────────────────
    const rawRows = await step.run('fetch-mes-candles', () =>
      readLatestMes15mRows(200),
    )

    // step.run serializes through JSON → dates become strings; cast explicitly
    const rows = rawRows as Array<{
      eventTime: Date | string
      open: number
      high: number
      low: number
      close: number
      volume: number | null
    }>

    if (rows.length < 10) {
      return { ranAt: new Date().toISOString(), skipped: 'insufficient-data', persisted: 0 }
    }

    const candles = rows.map(rowToCandle).reverse()
    const currentPrice = candles[candles.length - 1].close

    // ─── Step 2: Fib retracement signal engine ──────────────────────────────
    const { setups, measuredMoves } = await step.run('run-fib-signal-pipeline', async () => {
      const swings = detectSwings(candles, 5, 5, 20)
      const fibResult = calculateFibonacciMultiPeriod(candles)
      if (!fibResult) return { setups: [] as BhgSetup[], measuredMoves: [] }

      const mm = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)

      // Load Warbird ML prediction for direction confirmation
      const ml = await loadWarbirdPrediction()

      const raw = withCanonicalSetupIds(
        detectFibSignals(candles, fibResult, ml),
        'M15',
      )
      return {
        setups: raw.filter((s) => s.phase === 'TRIGGERED'),
        measuredMoves: mm,
      }
    })

    if (setups.length === 0) {
      return { ranAt: new Date().toISOString(), skipped: 'no-triggered-setups', persisted: 0 }
    }

    // ─── Step 3: Event context ───────────────────────────────────────────────
    const rawEventContext = await step.run('load-event-context', async () => {
      const todayEvents = await loadTodayEvents()
      return getEventContext(new Date(), todayEvents)
    })

    // step.run serializes through JSON → EventInfo.time becomes string; restore Date
    const eventContext = deserializeEventContext(rawEventContext)

    // ─── Step 4: Cross-asset candles for correlation alignment ───────────────
    // Fetch 1h candles for NQ and DX from mkt_futures_1h (last 5 days)
    const rawCrossAsset = await step.run('fetch-cross-asset', async () => {
      const since = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      const [nqRows, dxRows] = await Promise.all([
        prisma.mktFutures1h.findMany({
          where: { symbolCode: 'NQ', eventTime: { gte: since } },
          orderBy: { eventTime: 'asc' },
          take: 120,
          select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
        }),
        prisma.mktFutures1h.findMany({
          where: { symbolCode: 'DX', eventTime: { gte: since } },
          orderBy: { eventTime: 'asc' },
          take: 120,
          select: { eventTime: true, open: true, high: true, low: true, close: true, volume: true },
        }),
      ])

      return { nqRows, dxRows }
    })

    type CrossAssetRow = {
      eventTime: Date | string
      open: number | string | null
      high: number | string | null
      low: number | string | null
      close: number | string | null
      volume: number | string | null
    }
    type CrossAssetResult = {
      nqRows: CrossAssetRow[]
      dxRows: CrossAssetRow[]
    }
    const crossAsset = (rawCrossAsset as unknown) as CrossAssetResult

    // Build symbol candle map for correlation computation
    const symbolCandleMap = new Map<string, CandleData[]>([
      ['MES', candles],
    ])
    if (crossAsset.nqRows.length > 0) {
      symbolCandleMap.set('NQ', crossAsset.nqRows.map((r) => ({
        time: Math.floor(
          (typeof r.eventTime === 'string' ? new Date(r.eventTime) : r.eventTime as Date).getTime() / 1000,
        ),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume == null ? 0 : Number(r.volume),
      })))
    }
    if (crossAsset.dxRows.length > 0) {
      symbolCandleMap.set('DX', crossAsset.dxRows.map((r) => ({
        time: Math.floor(
          (typeof r.eventTime === 'string' ? new Date(r.eventTime) : r.eventTime as Date).getTime() / 1000,
        ),
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: r.volume == null ? 0 : Number(r.volume),
      })))
    }

    // ─── Step 5: Score each setup + get AI reasoning ─────────────────────────
    const scoredResults = await step.run('score-and-reason', async () => {
      const results: Array<{
        setup: BhgSetup
        risk: RiskResult | null
        compositeScore: number
        grade: string
        pTp1: number
        pTp2: number
        adjustedPTp1: number
        adjustedPTp2: number
        rationale: string
        reasoningSource: string
        rr: number | null
        dollarRisk: number | null
        eventPhase: string
        confidenceAdj: number
        mlSource: string
        features: Record<string, unknown>
        scoreBreakdown: Record<string, unknown>
        flags: string[]
        vixLevel: number | null
        trumpTariffFlag: boolean
        trumpEoCount7d: number
      }> = []

      for (const setup of setups) {
        const risk =
          setup.entry && setup.stopLoss && setup.tp1
            ? computeRisk(setup.entry, setup.stopLoss, setup.tp1, MES_DEFAULTS)
            : null

        if (!risk) continue

        const alignment = computeAlignmentScore(symbolCandleMap, setup.direction)

        const features = await computeTradeFeatures(
          setup,
          candles,
          risk,
          eventContext,
          buildMinimalMarketContext(
            null, // vixLevel fetched inside computeTradeFeatures via getWarbirdMacroFeatures
            false,
            0,
            eventContext.phase,
          ),
          alignment,
          measuredMoves,
        )

        // Patch market context regime into features now that macro is resolved
        const marketContext = buildMinimalMarketContext(
          features.vixLevel,
          features.trumpTariffFlag,
          features.trumpEoCount7d,
          eventContext.phase,
        )

        const mlBaseline = getMlBaseline(features)
        const score = computeCompositeScore(features, mlBaseline)

        const reasoning = await getTradeReasoning(
          setup,
          score,
          features,
          eventContext,
          marketContext,
        )

        results.push({
          setup,
          risk,
          compositeScore: score.composite,
          grade: score.grade,
          pTp1: score.pTp1,
          pTp2: score.pTp2,
          adjustedPTp1: reasoning.adjustedPTp1,
          adjustedPTp2: reasoning.adjustedPTp2,
          rationale: reasoning.rationale,
          reasoningSource: reasoning.source,
          rr: risk.rr,
          dollarRisk: risk.dollarRisk,
          eventPhase: eventContext.phase,
          confidenceAdj: eventContext.confidenceAdjustment,
          mlSource: mlBaseline.source,
          features: {
            ...features,
            // Include full setup + risk so the API can reconstruct ScoredTrade
            _setup: setup,
            _risk: risk,
          } as Record<string, unknown>,
          scoreBreakdown: score.subScores as unknown as Record<string, unknown>,
          flags: score.flags,
          vixLevel: features.vixLevel,
          trumpTariffFlag: features.trumpTariffFlag,
          trumpEoCount7d: features.trumpEoCount7d,
        })
      }

      return results
    })

    if (scoredResults.length === 0) {
      return { ranAt: new Date().toISOString(), skipped: 'no-risk-data', persisted: 0 }
    }

    // ─── Step 6: Persist to scored_trades ───────────────────────────────────
    const persisted = await step.run('persist-scored-trades', async () => {
      const windowStart = new Date(
        Math.floor(Date.now() / (15 * 60 * 1000)) * (15 * 60 * 1000),
      )
      let count = 0

      for (const t of scoredResults) {
        const hash = windowHash(
          t.setup.id ??
          `${t.setup.fibLevel}:${t.setup.direction}:${t.setup.entry ?? 0}:${t.setup.createdAt}`,
        )

        await prisma.scoredTrade.upsert({
          where: {
            setupHash_scoredAt: {
              setupHash: hash,
              scoredAt: windowStart,
            },
          },
          create: {
            setupHash: hash,
            direction: t.setup.direction,
            fibRatio: t.setup.fibRatio,
            goType: t.setup.goType ?? null,
            entryPrice: t.setup.entry ?? null,
            stopLoss: t.setup.stopLoss ?? null,
            tp1: t.setup.tp1 ?? null,
            tp2: t.setup.tp2 ?? null,
            currentPrice,
            compositeScore: t.compositeScore,
            grade: t.grade,
            pTp1: t.pTp1,
            pTp2: t.pTp2,
            mlSource: t.mlSource,
            rr: t.rr,
            dollarRisk: t.dollarRisk,
            eventPhase: t.eventPhase,
            confidenceAdj: t.confidenceAdj,
            rationale: t.rationale,
            reasoningSource: t.reasoningSource,
            adjustedPTp1: t.adjustedPTp1,
            adjustedPTp2: t.adjustedPTp2,
            features: t.features as never,
            scoreBreakdown: t.scoreBreakdown as never,
            flags: t.flags,
            scoredAt: windowStart,
          },
          update: {
            direction: t.setup.direction,
            fibRatio: t.setup.fibRatio,
            goType: t.setup.goType ?? null,
            entryPrice: t.setup.entry ?? null,
            stopLoss: t.setup.stopLoss ?? null,
            tp1: t.setup.tp1 ?? null,
            tp2: t.setup.tp2 ?? null,
            currentPrice,
            compositeScore: t.compositeScore,
            grade: t.grade,
            pTp1: t.pTp1,
            pTp2: t.pTp2,
            mlSource: t.mlSource,
            rr: t.rr,
            dollarRisk: t.dollarRisk,
            eventPhase: t.eventPhase,
            confidenceAdj: t.confidenceAdj,
            rationale: t.rationale,
            reasoningSource: t.reasoningSource,
            adjustedPTp1: t.adjustedPTp1,
            adjustedPTp2: t.adjustedPTp2,
            features: t.features as never,
            scoreBreakdown: t.scoreBreakdown as never,
            flags: t.flags,
          },
        })

        count++
      }

      return count
    })

    return {
      ranAt: new Date().toISOString(),
      persisted,
      setups: scoredResults.map((t) => ({
        direction: t.setup.direction,
        grade: t.grade,
        compositeScore: t.compositeScore,
        reasoningSource: t.reasoningSource,
      })),
    }
  },
)
