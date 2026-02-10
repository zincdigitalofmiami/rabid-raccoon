import { NextRequest, NextResponse } from 'next/server'
import { fetchCandlesForSymbol } from '@/lib/fetch-candles'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { generateCompositeSignal } from '@/lib/signals'
import { generateForecast } from '@/lib/forecast'
import { getCachedForecast, setCachedForecast, getCurrentWindow } from '@/lib/forecast-cache'
import { SYMBOLS, SYMBOL_KEYS } from '@/lib/symbols'
import { MarketSummary, CandleData, FibResult, MeasuredMove } from '@/lib/types'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const windowParam = searchParams.get('window') as 'morning' | 'premarket' | 'midday' | null
    const window = windowParam || getCurrentWindow()
    const forceRefresh = searchParams.get('refresh') === 'true'

    // Check cache first
    if (!forceRefresh) {
      const cached = getCachedForecast(window)
      if (cached) {
        return NextResponse.json(cached, {
          headers: {
            'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
            'X-Forecast-Cache': 'HIT',
          },
        })
      }
    }

    // Fetch all symbols for forecast context
    const results = await Promise.allSettled(
      SYMBOL_KEYS.map(async (symbol) => {
        const candles = await fetchCandlesForSymbol(symbol)
        const { highs, lows } = detectSwings(candles)
        const fibResult = calculateFibonacci(highs, lows)
        const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0
        const firstClose = candles.length > 1 ? candles[0].close : currentPrice
        const percentChange = firstClose > 0
          ? ((currentPrice - firstClose) / firstClose) * 100
          : 0
        const measuredMoves = detectMeasuredMoves(highs, lows, currentPrice)

        return {
          symbol,
          candles,
          fibResult,
          measuredMoves,
          currentPrice,
          percentChange,
        }
      })
    )

    const processedSymbols: {
      symbol: string
      candles: CandleData[]
      fibResult: FibResult | null
      measuredMoves: MeasuredMove[]
      currentPrice: number
      percentChange: number
    }[] = []

    for (const result of results) {
      if (result.status === 'fulfilled') {
        processedSymbols.push(result.value)
      }
    }

    if (processedSymbols.length === 0) {
      return NextResponse.json(
        { error: 'No market data available for forecast generation' },
        { status: 503 }
      )
    }

    // Generate composite signal
    const compositeSignal = generateCompositeSignal(processedSymbols)

    // Build MarketSummary for forecast
    const summaries: MarketSummary[] = processedSymbols.map((data) => {
      const config = SYMBOLS[data.symbol]
      const signal = compositeSignal.symbolSignals.find((s) => s.symbol === data.symbol)
      const sparklineData = data.candles.slice(-50).map((c) => c.close)

      return {
        symbol: data.symbol,
        displayName: config?.displayName || data.symbol,
        price: data.currentPrice,
        change: data.candles.length > 1
          ? data.currentPrice - data.candles[0].close
          : 0,
        changePercent: data.percentChange,
        sparklineData,
        direction: signal?.direction || 'BULLISH',
        signal: signal || {
          symbol: data.symbol,
          direction: 'BULLISH' as const,
          confidence: 50,
          confluenceFactors: [],
        },
      }
    })

    // Generate AI forecast via Claude
    const forecast = await generateForecast({
      symbols: summaries,
      compositeSignal,
      window,
    })

    // Cache the result
    setCachedForecast(forecast)

    return NextResponse.json(forecast, {
      headers: {
        'Cache-Control': 's-maxage=300, stale-while-revalidate=600',
        'X-Forecast-Cache': 'MISS',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: `Failed to generate forecast: ${message}` },
      { status: 500 }
    )
  }
}
