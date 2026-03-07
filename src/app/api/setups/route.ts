import { NextResponse } from 'next/server'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacciMultiPeriod } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { computeRisk, MES_DEFAULTS } from '@/lib/risk-engine'
import { toNum } from '@/lib/decimal'
import { withCanonicalSetupIds } from '@/lib/setup-id'
import { recordTriggeredSetups } from '@/lib/bhg-setup-recorder'
import type { CandleData } from '@/lib/types'
import { getEventContext, loadTodayEvents } from '@/lib/event-awareness'
import { intradayCache } from '@/lib/tiered-cache'
import { readLatestMes15mRows } from '@/lib/mes-live-queries'
import { computeSqueezeProHistory } from '@/lib/trade-features'
import type { SqueezeHistoryBar } from '@/lib/trade-features'
import { detectFibSignals, loadWarbirdPrediction } from '@/lib/fib-signal-engine'
import type { BhgSetup } from '@/lib/bhg-engine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type SetupResponseItem = BhgSetup & {
  risk?: ReturnType<typeof computeRisk>
  pTp1?: number
  pTp2?: number
}

interface SetupsResponseBody {
  setups: SetupResponseItem[]
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod> | null
  currentPrice: number | null
  measuredMoves?: ReturnType<typeof detectMeasuredMoves>
  eventContext?: ReturnType<typeof getEventContext>
  sqzHistory?: SqueezeHistoryBar[]
  timestamp: string
  error?: string
}

/**
 * pTp2 discount factors by R:R tier.
 * Deeper target (TP2) is harder to reach; discounted from pTp1.
 */
const TP2_DISCOUNT_BY_RR: { min: number; factor: number }[] = [
  { min: 2.5, factor: 0.65 },
  { min: 1.8, factor: 0.55 },
  { min: 0,   factor: 0.45 },
]

/**
 * Baseline TP1 probability by risk grade when ML predictions are unavailable.
 * Derived from historical MES fib-level hit rates at these grades.
 */
const FALLBACK_PTp1_BY_GRADE: Record<string, number> = {
  A: 0.65,
  B: 0.58,
  C: 0.50,
  D: 0.40,
}


const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=90',
}

const CACHE_KEY = 'mes-setups'

let inFlightBody: Promise<SetupsResponseBody> | null = null

function rowToCandle(row: {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: number | null
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

async function buildResponseBody(): Promise<SetupsResponseBody> {
  // 1. Fetch MES 15m candles (last 200 bars for chart/card parity)
  const rows = await readLatestMes15mRows(200)

  if (rows.length < 10) {
    return {
      setups: [],
      fibResult: null,
      currentPrice: null,
      timestamp: new Date().toISOString(),
      error: 'Insufficient MES 15m data',
    }
  }

  const candles = [...rows].reverse().map(rowToCandle)
  const currentPrice = candles[candles.length - 1].close

  // 2. Multi-period fib confluence + measured moves
  const swings = detectSwings(candles, 5, 5, 20)
  const fibResult = calculateFibonacciMultiPeriod(candles)

  if (!fibResult) {
    return {
      setups: [],
      fibResult: null,
      currentPrice,
      timestamp: new Date().toISOString(),
    }
  }

  const measuredMoves = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)

  // 3. Load Warbird ML prediction for direction confirmation
  const ml = await loadWarbirdPrediction()

  // 4. Fib-retracement signal engine (replaces BHG hook-and-go)
  const rawSignals = detectFibSignals(candles, fibResult, ml)
  const setups = withCanonicalSetupIds(rawSignals, 'M15')

  // 5. Attach risk + Warbird probabilities to TRIGGERED setups.
  //    pTp1/pTp2 come directly from the trained Warbird model predictions.
  //    Monte Carlo Pinball is a training-time model (scripts/monte-carlo.ts),
  //    not a runtime component.
  const mlProbUp = ml?.prob_up_1h ?? ml?.prob_up_4h ?? null
  const enrichedSetups: SetupResponseItem[] = setups.map((s) => {
    if (s.phase !== 'TRIGGERED' || !s.entry || !s.stopLoss || !s.tp1 || !s.tp2) {
      return s
    }
    const risk = computeRisk(s.entry, s.stopLoss, s.tp1, MES_DEFAULTS)

    // pTp1 = Warbird probability aligned to setup direction (or risk-grade fallback)
    let pTp1: number
    let pTp2: number
    if (mlProbUp != null) {
      pTp1 = s.direction === 'BULLISH' ? mlProbUp : 1 - mlProbUp
      // pTp2 = pTp1 discounted by R:R tier (deeper target = lower probability)
      const tier = TP2_DISCOUNT_BY_RR.find((t) => risk.rr >= t.min) ?? TP2_DISCOUNT_BY_RR[TP2_DISCOUNT_BY_RR.length - 1]
      pTp2 = pTp1 * tier.factor
    } else {
      // No ML predictions available — use historical base rates per risk grade
      pTp1 = FALLBACK_PTp1_BY_GRADE[risk.grade] ?? 0.50
      pTp2 = pTp1 * 0.55
    }

    return {
      ...s,
      risk,
      pTp1: Math.round(pTp1 * 10000) / 10000,
      pTp2: Math.round(pTp2 * 10000) / 10000,
    }
  })

  // 6. Event awareness
  const todayEvents = await loadTodayEvents()
  const eventContext = getEventContext(new Date(), todayEvents)

  // 7. Squeeze Pro history for the momentum histogram (last 60 bars = 15h)
  const sqzHistory = computeSqueezeProHistory(candles.slice(-60))

  // Persist triggered signals (fire-and-forget, non-blocking)
  recordTriggeredSetups(setups).catch((err) =>
    console.warn('[setups] Setup persistence failed:', err),
  )

  return {
    setups: enrichedSetups,
    fibResult,
    currentPrice,
    measuredMoves,
    eventContext,
    sqzHistory,
    timestamp: new Date().toISOString(),
  }
}

export async function GET(): Promise<Response> {
  try {
    const cached = intradayCache.get<SetupsResponseBody>(CACHE_KEY)
    if (cached) {
      return NextResponse.json(cached, { headers: CACHE_HEADERS })
    }

    if (!inFlightBody) {
      inFlightBody = buildResponseBody()
        .then((body) => {
          intradayCache.set(CACHE_KEY, body)
          return body
        })
        .finally(() => {
          inFlightBody = null
        })
    }

    return NextResponse.json(await inFlightBody, { headers: CACHE_HEADERS })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { error: message, setups: [], fibResult: null, currentPrice: null },
      { status: 500 }
    )
  }
}
