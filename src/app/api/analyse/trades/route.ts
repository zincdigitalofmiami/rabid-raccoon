import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { detectSwings } from '@/lib/swing-detection'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { toNum } from '@/lib/decimal'
import type { Decimal } from '@prisma/client/runtime/client'
import type { CandleData, MeasuredMove } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

interface TradeCard {
  direction: 'BULLISH' | 'BEARISH'
  timeframe: '15M' | '1H'
  entry: number
  stop: number
  target: number
  quality: number
  status: MeasuredMove['status']
  retracementRatio: number
  pointA: number
  pointB: number
  pointC: number
  projectedD: number
  riskReward: number
}

function prismaRowToCandle(row: {
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

function moveToCard(
  move: MeasuredMove,
  timeframe: '15M' | '1H'
): TradeCard {
  const risk = Math.abs(move.entry - move.stop)
  const reward = Math.abs(move.target - move.entry)
  return {
    direction: move.direction,
    timeframe,
    entry: Number(move.entry.toFixed(2)),
    stop: Number(move.stop.toFixed(2)),
    target: Number(move.target.toFixed(2)),
    quality: move.quality,
    status: move.status,
    retracementRatio: Number(move.retracementRatio.toFixed(3)),
    pointA: Number(move.pointA.price.toFixed(2)),
    pointB: Number(move.pointB.price.toFixed(2)),
    pointC: Number(move.pointC.price.toFixed(2)),
    projectedD: Number(move.projectedD.toFixed(2)),
    riskReward: risk > 0 ? Number((reward / risk).toFixed(1)) : 0,
  }
}

function detectMovesForCandles(
  candles: CandleData[],
  timeframe: '15M' | '1H'
): TradeCard[] {
  if (candles.length < 15) return []

  const currentPrice = candles[candles.length - 1].close
  const swings = detectSwings(candles)
  const moves = detectMeasuredMoves(swings.highs, swings.lows, currentPrice)
  return moves.map((m) => moveToCard(m, timeframe))
}

export async function POST(): Promise<Response> {
  try {
    const [rows15m, rows1h] = await Promise.all([
      prisma.mktFuturesMes15m.findMany({
        orderBy: { eventTime: 'desc' },
        take: 96,
      }),
      prisma.mktFuturesMes1h.findMany({
        orderBy: { eventTime: 'desc' },
        take: 96,
      }),
    ])

    const candles15m = rows15m.reverse().map(prismaRowToCandle)
    const candles1h = rows1h.reverse().map(prismaRowToCandle)

    const cards15m = detectMovesForCandles(candles15m, '15M')
    const cards1h = detectMovesForCandles(candles1h, '1H')

    // Current trade: first ACTIVE move (15m priority, then 1h)
    const allCards = [...cards15m, ...cards1h]
    const currentTrade = allCards.find((c) => c.status === 'ACTIVE') || null

    // Upcoming: FORMING moves, sorted by quality
    const upcoming15m = cards15m
      .filter((c) => c.status === 'FORMING')
      .sort((a, b) => b.quality - a.quality)
    const upcoming1h = cards1h
      .filter((c) => c.status === 'FORMING')
      .sort((a, b) => b.quality - a.quality)

    return NextResponse.json({
      currentTrade,
      upcoming15m,
      upcoming1h,
      meta: {
        candles15mCount: candles15m.length,
        candles1hCount: candles1h.length,
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[analyse/trades]', msg)
    return NextResponse.json(
      { error: `Trade analysis failed: ${msg}` },
      { status: 500 }
    )
  }
}
