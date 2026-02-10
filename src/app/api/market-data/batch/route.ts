import { NextResponse } from 'next/server'
import { fetchCandlesForSymbol } from '@/lib/fetch-candles'

export const dynamic = 'force-dynamic'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { generateCompositeSignal } from '@/lib/signals'
import { SYMBOLS, SYMBOL_KEYS } from '@/lib/symbols'
import { MarketSummary, CandleData, FibResult, MeasuredMove, CompositeSignal } from '@/lib/types'

interface SymbolProcessResult {
  symbol: string
  candles: CandleData[]
  fibResult: FibResult | null
  measuredMoves: MeasuredMove[]
  currentPrice: number
  percentChange: number
}

export async function GET() {
  try {
    // Fetch all 8 symbols in parallel
    const results = await Promise.allSettled(
      SYMBOL_KEYS.map(async (symbol): Promise<SymbolProcessResult> => {
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

    const processedSymbols: SymbolProcessResult[] = []
    const summaries: MarketSummary[] = []

    for (const result of results) {
      if (result.status === 'rejected') continue
      const data = result.value
      processedSymbols.push(data)
    }

    // Generate composite signal from all available data
    let compositeSignal: CompositeSignal | null = null
    if (processedSymbols.length > 0) {
      compositeSignal = generateCompositeSignal(processedSymbols)
    }

    // Build market summaries
    for (const data of processedSymbols) {
      const config = SYMBOLS[data.symbol]
      if (!config) continue

      const signal = compositeSignal?.symbolSignals.find((s) => s.symbol === data.symbol)

      // Build sparkline data: last 50 close prices
      const sparklineData = data.candles
        .slice(-50)
        .map((c) => c.close)

      summaries.push({
        symbol: data.symbol,
        displayName: config.displayName,
        price: data.currentPrice,
        change: data.candles.length > 1
          ? data.currentPrice - data.candles[0].close
          : 0,
        changePercent: data.percentChange,
        sparklineData,
        direction: signal?.direction || 'BULLISH',
        signal: signal || {
          symbol: data.symbol,
          direction: 'BULLISH',
          confidence: 50,
          confluenceFactors: [],
        },
      })
    }

    return NextResponse.json(
      {
        symbols: summaries,
        compositeSignal,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 's-maxage=30, stale-while-revalidate=60',
        },
      }
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(
      { error: `Failed to fetch batch market data: ${message}` },
      { status: 500 }
    )
  }
}
