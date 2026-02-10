import { NextRequest, NextResponse } from 'next/server'
import { fetchOhlcv, toCandles, getCurrentSessionTimes } from '@/lib/databento'
import { fetchVixCandles, fetchDollarCandles, getFredDateRange } from '@/lib/fred'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import { SYMBOLS } from '@/lib/symbols'
import { CandleData, MarketDataResponse } from '@/lib/types'

async function fetchCandlesForSymbol(
  symbol: string,
  start?: string,
  end?: string
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]

  if (config.dataSource === 'fred') {
    const fredRange = getFredDateRange()
    const fredStart = start?.slice(0, 10) || fredRange.start
    const fredEnd = end?.slice(0, 10) || fredRange.end

    if (symbol === 'VX') {
      return fetchVixCandles(fredStart, fredEnd)
    } else if (symbol === 'DX') {
      return fetchDollarCandles(fredStart, fredEnd)
    }
    throw new Error(`Unknown FRED symbol: ${symbol}`)
  }

  // Databento source
  const session = getCurrentSessionTimes()
  const queryStart = start || session.start
  const queryEnd = end || session.end

  const records = await fetchOhlcv({
    dataset: config.dataset!,
    symbol: config.databentoSymbol!,
    stypeIn: config.stypeIn!,
    start: queryStart,
    end: queryEnd,
  })

  return toCandles(records)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { symbol, start, end } = body as {
      symbol: string
      start?: string
      end?: string
    }

    // Validate symbol against whitelist
    const config = SYMBOLS[symbol]
    if (!config) {
      return NextResponse.json(
        { error: `Unknown symbol: ${symbol}. Valid symbols: ${Object.keys(SYMBOLS).join(', ')}` },
        { status: 400 }
      )
    }

    const candles = await fetchCandlesForSymbol(symbol, start, end)

    // Run swing detection
    const { highs, lows } = detectSwings(candles)
    const allSwings = [...highs, ...lows].sort((a, b) => a.barIndex - b.barIndex)

    // Calculate Fibonacci levels
    const fibLevels = calculateFibonacci(highs, lows)

    // Compute latest price and percent change
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
