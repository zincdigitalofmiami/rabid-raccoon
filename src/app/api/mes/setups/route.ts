import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { advanceBhgSetups } from '@/lib/bhg-engine'
import { computeRisk, MES_DEFAULTS } from '@/lib/risk-engine'
import { toNum } from '@/lib/decimal'
import type { Decimal } from '@prisma/client/runtime/client'
import type { CandleData } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

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

export async function GET(): Promise<Response> {
  try {
    // 1. Fetch MES 15m candles (last 96 bars = 24 hours)
    const rows = await prisma.mktFuturesMes15m.findMany({
      orderBy: { eventTime: 'desc' },
      take: 96,
    })

    if (rows.length < 10) {
      return NextResponse.json({
        setups: [],
        fibResult: null,
        currentPrice: null,
        timestamp: new Date().toISOString(),
        error: 'Insufficient MES 15m data',
      })
    }

    const candles = [...rows].reverse().map(rowToCandle)
    const currentPrice = candles[candles.length - 1].close

    // 2. Run existing modules: swings → fib → measured moves
    const swings = detectSwings(candles, 5, 5, 20)
    const fibResult = calculateFibonacci(swings.highs, swings.lows)

    if (!fibResult) {
      return NextResponse.json({
        setups: [],
        fibResult: null,
        currentPrice,
        timestamp: new Date().toISOString(),
      })
    }

    const measuredMoves = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)

    // 3. Run BHG state machine
    const setups = advanceBhgSetups(candles, fibResult, measuredMoves)

    // 4. Attach risk computations for GO_FIRED setups
    const enrichedSetups = setups.map((s) => {
      if (s.phase !== 'GO_FIRED' || !s.entry || !s.stopLoss || !s.tp1) {
        return s
      }
      const risk = computeRisk(s.entry, s.stopLoss, s.tp1, MES_DEFAULTS)
      return { ...s, risk }
    })

    return NextResponse.json({
      setups: enrichedSetups,
      fibResult,
      currentPrice,
      measuredMoves,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json(
      { error: message, setups: [], fibResult: null, currentPrice: null },
      { status: 500 }
    )
  }
}
