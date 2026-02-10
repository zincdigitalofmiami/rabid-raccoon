import { NextRequest, NextResponse } from 'next/server'
import { fetchCandlesForSymbol } from '@/lib/fetch-candles'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import { SYMBOLS } from '@/lib/symbols'
import { MarketDataResponse } from '@/lib/types'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbol, start, end } = body as {
      symbol: string
      start?: string
      end?: string
    }

    const config = SYMBOLS[symbol]
    if (!config) {
      return NextResponse.json(
        { error: `Unknown symbol: ${symbol}. Valid symbols: ${Object.keys(SYMBOLS).join(', ')}` },
        { status: 400 }
      )
    }

    const candles = await fetchCandlesForSymbol(symbol, start, end)

    const { highs, lows } = detectSwings(candles)
    const allSwings = [...highs, ...lows].sort((a, b) => a.barIndex - b.barIndex)

    const fibLevels = calculateFibonacci(highs, lows)

    let latestPrice: number | null = null
    let percentChange: number | null = null
    if (candles.length > 0) {
      latestPrice = candles[candles.length - 1].close
      if (candles.length > 1) {
        const firstClose = candles[0].close
        percentChange = ((latestPrice - firstClose) / firstClose) * 100
      }
    }

    const response: MarketDataResponse = {
      symbol,
      candles,
      fibLevels: fibLevels ? fibLevels.levels : null,
      swingPoints: allSwings,
      latestPrice,
      percentChange,
      meta: {
        lastUpdated: new Date().toISOString(),
        candleCount: candles.length,
        dataset: config.dataSource === 'fred' ? 'FRED' : config.dataset!,
      },
    }

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: `Failed to fetch market data: ${message}` },
      { status: 500 }
    )
  }
}
