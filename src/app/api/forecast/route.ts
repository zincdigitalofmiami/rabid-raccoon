import { NextRequest, NextResponse } from 'next/server'
import { fetchCandlesForSymbol } from '@/lib/fetch-candles'
import { fetchDailyCandlesForSymbol } from '@/lib/fetch-candles'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import { detectMeasuredMoves } from '@/lib/measured-move'
import { generateCompositeSignal } from '@/lib/signals'
import { generateForecast } from '@/lib/forecast'
import { buildMarketContext } from '@/lib/market-context'
import { computeSignals } from '@/lib/instant-analysis'
import {
  getCachedForecast,
  setCachedForecast,
  getCurrentWindow,
  ForecastWindow,
} from '@/lib/forecast-cache'
import { SYMBOLS, SYMBOL_KEYS } from '@/lib/symbols'
import { MarketSummary, CandleData, FibResult, MeasuredMove } from '@/lib/types'

function aggregateCandles(candles: CandleData[], periodMinutes: number): CandleData[] {
  if (candles.length === 0) return []
  const periodSec = periodMinutes * 60
  const result: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const c of candles) {
    const aligned = Math.floor(c.time / periodSec) * periodSec
    if (bucket === null || aligned !== bucketStart) {
      if (bucket) result.push(bucket)
      bucket = { time: aligned, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 }
      bucketStart = aligned
    } else {
      bucket.high = Math.max(bucket.high, c.high)
      bucket.low = Math.min(bucket.low, c.low)
      bucket.close = c.close
      bucket.volume = (bucket.volume || 0) + (c.volume || 0)
    }
  }
  if (bucket) result.push(bucket)
  return result
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const windowParam = (searchParams.get('window') || '').toLowerCase()
    const requestedWindow = ['morning', 'premarket', 'midday', 'afterhours'].includes(windowParam)
      ? (windowParam as ForecastWindow)
      : null
    const window = requestedWindow || getCurrentWindow()
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

    // Build macro context from daily candles for stable cross-asset/news/rates inputs
    const macroCandlesMap = new Map<string, CandleData[]>()
    const macroResults = await Promise.allSettled(
      SYMBOL_KEYS.map(async (symbol) => ({
        symbol,
        candles: await fetchDailyCandlesForSymbol(symbol, 90),
      }))
    )
    for (const res of macroResults) {
      if (res.status !== 'fulfilled') continue
      if (res.value.candles.length > 0) {
        macroCandlesMap.set(res.value.symbol, res.value.candles)
      }
    }
    // Fallback to intraday candles for any symbols missing daily data.
    for (const data of processedSymbols) {
      if (macroCandlesMap.has(data.symbol)) continue
      if (data.candles.length > 0) {
        macroCandlesMap.set(data.symbol, data.candles)
      }
    }
    const priceChanges = new Map<string, number>()
    for (const [symbol, candles] of macroCandlesMap.entries()) {
      if (candles.length < 2) continue
      const first = candles[0].close
      const last = candles[candles.length - 1].close
      if (first > 0) {
        priceChanges.set(symbol, ((last - first) / first) * 100)
      }
    }
    const marketContext = await buildMarketContext(macroCandlesMap, priceChanges)

    // Build MarketSummary for forecast
    const summaries: MarketSummary[] = processedSymbols.map((data) => {
      const config = SYMBOLS[data.symbol]
      const signal = compositeSignal.symbolSignals.find((s) => s.symbol === data.symbol)
      const candles15m = aggregateCandles(data.candles, 15)
      const signalSummary = candles15m.length >= 5 ? computeSignals(candles15m) : null
      const direction = signalSummary
        ? (signalSummary.buy > signalSummary.sell ? 'BULLISH' as const : 'BEARISH' as const)
        : (signal?.direction || 'BULLISH')
      const confidence = signalSummary
        ? (signalSummary.buy + signalSummary.sell > 0
          ? Math.round((Math.max(signalSummary.buy, signalSummary.sell) / (signalSummary.buy + signalSummary.sell)) * 100)
          : 50)
        : (signal?.confidence || 50)
      const sparklineData = data.candles.slice(-50).map((c) => c.close)
      const factors: string[] = []
      if (signalSummary) {
        factors.push(`${signalSummary.buy}B/${signalSummary.sell}S/${signalSummary.neutral}N (${signalSummary.total} signals)`)
        const top = direction === 'BULLISH'
          ? signalSummary.buySignals.slice(0, 3)
          : signalSummary.sellSignals.slice(0, 3)
        factors.push(...top)
      } else if (signal?.confluenceFactors?.length) {
        factors.push(...signal.confluenceFactors.slice(0, 4))
      }

      return {
        symbol: data.symbol,
        displayName: config?.displayName || data.symbol,
        price: data.currentPrice,
        change: data.candles.length > 1
          ? data.currentPrice - data.candles[0].close
          : 0,
        changePercent: data.percentChange,
        sparklineData,
        direction,
        signal: {
          symbol: data.symbol,
          direction,
          confidence,
          confluenceFactors: factors,
          entry: signal?.entry,
          stop: signal?.stop,
          target: signal?.target,
          measuredMove: signal?.measuredMove,
        },
      }
    })

    // Generate AI forecast via OpenAI
    const forecast = await generateForecast({
      symbols: summaries,
      compositeSignal,
      window,
      marketContext,
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
