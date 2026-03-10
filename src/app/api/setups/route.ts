import { NextResponse } from 'next/server'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacciMultiPeriod } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { computeRisk, MES_DEFAULTS } from '@/lib/risk-engine'
import { toNum } from '@/lib/decimal'
import { withCanonicalSetupIds } from '@/lib/setup-id'
import type { CandleData } from '@/lib/types'
import { getEventContext, loadTodayEvents } from '@/lib/event-awareness'
import { intradayCache } from '@/lib/tiered-cache'
import { readLatestMes15mRowsPrefer1m } from '@/lib/mes-15m-derivation'
import {
  generateTriggerCandidates,
  type TriggerCandidate,
} from '@/lib/trigger-candidates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type SetupResponseItem = TriggerCandidate & {
  risk?: ReturnType<typeof computeRisk>
}

interface SetupsResponseBody {
  setups: SetupResponseItem[]
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod> | null
  currentPrice: number | null
  measuredMoves?: ReturnType<typeof detectMeasuredMoves>
  eventContext?: ReturnType<typeof getEventContext>
  timestamp: string
  error?: string
}

const CACHE_KEY = 'mes-setups'
const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=90',
}

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
  // 1. Fetch MES 15m candles (derive from 1m first, fallback to shared 15m table)
  const rows = await readLatestMes15mRowsPrefer1m(200, 195)

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

  // 2. Run existing modules: swings → fib (multi-period confluence) → measured moves
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

  // 3. Generate current trigger candidates via the neutral contract seam
  const setups = withCanonicalSetupIds(
    generateTriggerCandidates(candles, fibResult, measuredMoves),
    'M15',
  )

  // 4. Attach risk computations for TRIGGERED setups
  const enrichedSetups = setups.map((s) => {
    if (s.phase !== 'TRIGGERED' || !s.entry || !s.stopLoss || !s.tp1) {
      return s
    }
    const risk = computeRisk(s.entry, s.stopLoss, s.tp1, MES_DEFAULTS)
    return { ...s, risk }
  })

  // Event awareness
  const todayEvents = await loadTodayEvents()
  const eventContext = getEventContext(new Date(), todayEvents)

  return {
    setups: enrichedSetups,
    fibResult,
    currentPrice,
    measuredMoves,
    eventContext,
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
