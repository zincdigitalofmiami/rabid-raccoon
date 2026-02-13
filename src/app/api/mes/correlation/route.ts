import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { computeAlignmentScore } from '@/lib/correlation-filter'
import type { CandleData } from '@/lib/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function rowToCandle(row: {
  eventTime: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

export async function GET(): Promise<Response> {
  try {
    const symbolCandles = new Map<string, CandleData[]>()

    // Fetch MES 15m candles
    const mesRows = await prisma.mesPrice15m.findMany({
      orderBy: { eventTime: 'desc' },
      take: 96,
    })
    if (mesRows.length >= 20) {
      symbolCandles.set('MES', [...mesRows].reverse().map(rowToCandle))
    }

    // Fetch correlated symbols from futures_ex_mes_1h
    const corrSymbols = ['NQ', 'VX', 'DX'] as const
    for (const sym of corrSymbols) {
      const rows = await prisma.futuresExMes1h.findMany({
        where: { symbolCode: sym },
        orderBy: { eventTime: 'desc' },
        take: 48,
      })
      if (rows.length >= 10) {
        symbolCandles.set(
          sym,
          [...rows].reverse().map((r) => ({
            time: Math.floor(r.eventTime.getTime() / 1000),
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume == null ? 0 : Number(r.volume),
          }))
        )
      }
    }

    const bullish = computeAlignmentScore(symbolCandles, 'BULLISH')
    const bearish = computeAlignmentScore(symbolCandles, 'BEARISH')

    return NextResponse.json({
      bullish,
      bearish,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
