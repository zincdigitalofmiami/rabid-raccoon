import { NextResponse } from 'next/server'
import { fetchCandlesForSymbol } from '@/lib/fetch-candles'

export const dynamic = 'force-dynamic'
import { computeSignals, SignalSummary } from '@/lib/instant-analysis'
import { SYMBOLS, SYMBOL_KEYS } from '@/lib/symbols'
import { MarketSummary, CandleData } from '@/lib/types'

interface SymbolProcessResult {
  symbol: string
  candles: CandleData[]
  signals15m: SignalSummary | null
  currentPrice: number
  percentChange: number
}

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

export async function GET() {
  try {
    // Fetch all symbols in parallel
    const results = await Promise.allSettled(
      SYMBOL_KEYS.map(async (symbol): Promise<SymbolProcessResult> => {
        const candles = await fetchCandlesForSymbol(symbol)

        // Aggregate to 15m and compute REAL signals (45+ per symbol)
        const candles15m = aggregateCandles(candles, 15)
        const signals15m = candles15m.length >= 5 ? computeSignals(candles15m) : null

        const currentPrice = candles.length > 0 ? candles[candles.length - 1].close : 0
        const firstClose = candles.length > 1 ? candles[0].close : currentPrice
        const percentChange = firstClose > 0
          ? ((currentPrice - firstClose) / firstClose) * 100
          : 0

        return {
          symbol,
          candles,
          signals15m,
          currentPrice,
          percentChange,
        }
      })
    )

    const summaries: MarketSummary[] = []

    for (const result of results) {
      if (result.status === 'rejected') continue
      const data = result.value
      const config = SYMBOLS[data.symbol]
      if (!config) continue

      // Build sparkline data: last 50 close prices
      const sparklineData = data.candles
        .slice(-50)
        .map((c) => c.close)

      // Use REAL 45+ signal computation — not a 5-factor toy
      const sig = data.signals15m
      const direction = sig
        ? (sig.buy > sig.sell ? 'BULLISH' as const : 'BEARISH' as const)
        : (data.percentChange >= 0 ? 'BULLISH' as const : 'BEARISH' as const)

      const confidence = sig
        ? (sig.buy + sig.sell > 0
          ? Math.round((Math.max(sig.buy, sig.sell) / (sig.buy + sig.sell)) * 100)
          : 50)
        : 50

      // Show the actual signal counts + top signals as factors
      const confluenceFactors: string[] = []
      if (sig) {
        confluenceFactors.push(`${sig.buy}B/${sig.sell}S/${sig.neutral}N (${sig.total} signals)`)
        // Top 3 buy or sell signals depending on direction
        const topSignals = direction === 'BULLISH'
          ? sig.buySignals.slice(0, 3)
          : sig.sellSignals.slice(0, 3)
        confluenceFactors.push(...topSignals)
      }

      summaries.push({
        symbol: data.symbol,
        displayName: config.description || config.displayName,
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
          confluenceFactors,
        },
      })
    }

    return NextResponse.json(
      {
        symbols: summaries,
        timestamp: new Date().toISOString(),
      },
      {
        headers: {
          'Cache-Control': 's-maxage=15, stale-while-revalidate=30',
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
