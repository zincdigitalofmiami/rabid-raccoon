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

const SETUPS_PAUSED = process.env.PAUSE_SETUPS === '1'
const SETUPS_PAUSE_REASON =
  process.env.PAUSE_SETUPS_REASON || 'temporarily paused'

type SetupsRouteStatus =
  | 'full-success'
  | 'empty-success'
  | 'insufficient-source-data'
  | 'derivation-failure'
  | 'trigger-generation-failure'
  | 'paused'
  | 'runtime-failure'

const ENGINE_META = {
  seam: 'trigger-candidates-adapter',
  generator: 'generateTriggerCandidates',
  backing: 'legacy-bhg-adapter',
  handoffPhases: ['0C', '0D', '4'] as const,
} as const

const DERIVATION_LIMIT = 200
const DERIVATION_MIN_BARS = 195
const ANALYSIS_MIN_BARS = 10

type SetupResponseItem = TriggerCandidate & {
  risk?: ReturnType<typeof computeRisk>
}

interface SetupsResponseMeta {
  status: SetupsRouteStatus
  reason?: string
  engine: typeof ENGINE_META
  data: {
    derivedBars: number
    minBarsForAnalysis: number
    derivationRequest: {
      limit: number
      minimumDerivedBars: number
    }
  }
  updatedAt: string
}

interface SetupsResponseBody {
  setups: SetupResponseItem[]
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod> | null
  currentPrice: number | null
  measuredMoves?: ReturnType<typeof detectMeasuredMoves>
  eventContext?: ReturnType<typeof getEventContext>
  timestamp: string
  error?: string
  meta: SetupsResponseMeta
}

interface BuildSetupsResult {
  body: SetupsResponseBody
  statusCode: 200 | 500 | 503
  cacheable: boolean
}

const CACHE_KEY = 'mes-setups'
const CACHE_HEADERS = {
  'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=90',
}
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store',
}

let inFlightBody: Promise<BuildSetupsResult> | null = null

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

function nowIso(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseInsufficientDerivation(message: string): {
  derivedBars: number
  minimumBars: number
} | null {
  if (!message.includes('Insufficient derived MES 15m bars')) return null
  const match = message.match(/\((\d+)\s*<\s*(\d+)\)/)
  if (!match) return { derivedBars: 0, minimumBars: DERIVATION_MIN_BARS }
  return {
    derivedBars: Number(match[1]),
    minimumBars: Number(match[2]),
  }
}

function buildMeta(
  status: SetupsRouteStatus,
  derivedBars: number,
  reason?: string,
): SetupsResponseMeta {
  return {
    status,
    reason,
    engine: ENGINE_META,
    data: {
      derivedBars,
      minBarsForAnalysis: ANALYSIS_MIN_BARS,
      derivationRequest: {
        limit: DERIVATION_LIMIT,
        minimumDerivedBars: DERIVATION_MIN_BARS,
      },
    },
    updatedAt: nowIso(),
  }
}

function buildBody(params: {
  status: SetupsRouteStatus
  derivedBars: number
  setups: SetupResponseItem[]
  fibResult: ReturnType<typeof calculateFibonacciMultiPeriod> | null
  currentPrice: number | null
  measuredMoves?: ReturnType<typeof detectMeasuredMoves>
  eventContext?: ReturnType<typeof getEventContext>
  error?: string
  reason?: string
}): SetupsResponseBody {
  const body: SetupsResponseBody = {
    setups: params.setups,
    fibResult: params.fibResult,
    currentPrice: params.currentPrice,
    measuredMoves: params.measuredMoves,
    eventContext: params.eventContext,
    timestamp: nowIso(),
    meta: buildMeta(params.status, params.derivedBars, params.reason),
  }

  if (params.error) body.error = params.error
  return body
}

async function buildResponseBody(): Promise<BuildSetupsResult> {
  // 1. Fetch MES 15m candles derived from the 1m source of truth
  let rows: Awaited<ReturnType<typeof readLatestMes15mRowsPrefer1m>>
  try {
    rows = await readLatestMes15mRowsPrefer1m(
      DERIVATION_LIMIT,
      DERIVATION_MIN_BARS,
    )
  } catch (error) {
    const message = errorMessage(error)
    const insufficient = parseInsufficientDerivation(message)
    if (insufficient) {
      return {
        statusCode: 503,
        cacheable: false,
        body: buildBody({
          status: 'insufficient-source-data',
          reason: `derived-bars-below-threshold(${insufficient.derivedBars}<${insufficient.minimumBars})`,
          derivedBars: insufficient.derivedBars,
          setups: [],
          fibResult: null,
          currentPrice: null,
          error: 'Insufficient MES 15m data',
        }),
      }
    }

    return {
      statusCode: 500,
      cacheable: false,
      body: buildBody({
        status: 'derivation-failure',
        reason: 'mes-15m-derivation-threw',
        derivedBars: 0,
        setups: [],
        fibResult: null,
        currentPrice: null,
        error: `MES 15m derivation failed: ${message}`,
      }),
    }
  }

  if (rows.length < ANALYSIS_MIN_BARS) {
    const currentPrice = rows.length > 0 ? toNum(rows[0].close) : null
    return {
      statusCode: 503,
      cacheable: false,
      body: buildBody({
        status: 'insufficient-source-data',
        reason: `analysis-bars-below-min(${rows.length}<${ANALYSIS_MIN_BARS})`,
        derivedBars: rows.length,
        setups: [],
        fibResult: null,
        currentPrice,
        error: 'Insufficient MES 15m data',
      }),
    }
  }

  const derivedBars = rows.length
  const candles = [...rows].reverse().map(rowToCandle)
  const currentPrice = candles[candles.length - 1].close

  // 2. Run existing modules: swings → fib (multi-period confluence) → measured moves
  const swings = detectSwings(candles, 5, 5, 20)
  const fibResult = calculateFibonacciMultiPeriod(candles)

  if (!fibResult) {
    return {
      statusCode: 200,
      cacheable: true,
      body: buildBody({
        status: 'empty-success',
        reason: 'no-fib-confluence',
        derivedBars,
        setups: [],
        fibResult: null,
        currentPrice,
      }),
    }
  }

  const measuredMoves = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)

  // 3. Generate current trigger candidates via the neutral contract seam
  let setups: SetupResponseItem[]
  try {
    setups = withCanonicalSetupIds(
      generateTriggerCandidates(candles, fibResult, measuredMoves),
      'M15',
    )
  } catch (error) {
    return {
      statusCode: 500,
      cacheable: false,
      body: buildBody({
        status: 'trigger-generation-failure',
        reason: 'generate-trigger-candidates-threw',
        derivedBars,
        setups: [],
        fibResult,
        currentPrice,
        measuredMoves,
        error: `Trigger generation failed: ${errorMessage(error)}`,
      }),
    }
  }

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

  const status: SetupsRouteStatus =
    enrichedSetups.length > 0 ? 'full-success' : 'empty-success'
  const reason =
    enrichedSetups.length > 0 ? undefined : 'no-trigger-candidates'

  return {
    statusCode: 200,
    cacheable: true,
    body: buildBody({
      status,
      reason,
      derivedBars,
      setups: enrichedSetups,
      fibResult,
      currentPrice,
      measuredMoves,
      eventContext,
    }),
  }
}

export async function GET(): Promise<Response> {
  try {
    if (SETUPS_PAUSED) {
      const body = buildBody({
        status: 'paused',
        reason: 'pause-flag-enabled',
        derivedBars: 0,
        setups: [],
        fibResult: null,
        currentPrice: null,
        error: `Setups endpoint paused: ${SETUPS_PAUSE_REASON}`,
      })
      return NextResponse.json(body, {
        status: 503,
        headers: NO_STORE_HEADERS,
      })
    }

    const cached = intradayCache.get<SetupsResponseBody>(CACHE_KEY)
    if (cached) {
      return NextResponse.json(cached, { headers: CACHE_HEADERS })
    }

    if (!inFlightBody) {
      inFlightBody = buildResponseBody()
        .then((result) => {
          if (result.cacheable) intradayCache.set(CACHE_KEY, result.body)
          return result
        })
        .finally(() => {
          inFlightBody = null
        })
    }

    const result = await inFlightBody
    return NextResponse.json(result.body, {
      status: result.statusCode,
      headers: result.cacheable ? CACHE_HEADERS : NO_STORE_HEADERS,
    })
  } catch (error) {
    const message = errorMessage(error)
    const body = buildBody({
      status: 'runtime-failure',
      reason: 'unexpected-route-runtime-failure',
      derivedBars: 0,
      setups: [],
      fibResult: null,
      currentPrice: null,
      error: message,
    })
    return NextResponse.json(body, {
      status: 500,
      headers: NO_STORE_HEADERS,
    })
  }
}
