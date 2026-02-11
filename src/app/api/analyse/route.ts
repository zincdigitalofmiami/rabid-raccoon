import { NextResponse } from 'next/server'
import { fetchOhlcv, toCandles, getCurrentSessionTimes } from '@/lib/databento'
import { fetchVixCandles, fetchDollarCandles, getFredDateRange } from '@/lib/fred'
import { runInstantAnalysis } from '@/lib/instant-analysis'
import { buildMarketContext } from '@/lib/market-context'
import { SYMBOLS } from '@/lib/symbols'
import { CandleData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// All instruments for full macro analysis — equities, vol, bonds, dollar, gold, oil
const ANALYSE_SYMBOLS = ['MES', 'NQ', 'VX', 'DX', 'GC', 'CL']

async function fetchMultiTimeframe(symbol: string): Promise<{
  candles15m: CandleData[]
  candles1h: CandleData[]
  candles4h: CandleData[]
  price: number
}> {
  const config = SYMBOLS[symbol]

  if (config.dataSource === 'fred') {
    const fredRange = getFredDateRange()
    let candles: CandleData[]
    if (symbol === 'VX') candles = await fetchVixCandles(fredRange.start, fredRange.end)
    else candles = await fetchDollarCandles(fredRange.start, fredRange.end)
    const price = candles.length > 0 ? candles[candles.length - 1].close : 0
    return { candles15m: [], candles1h: [], candles4h: candles, price }
  }

  // Databento: fetch 1-min bars, aggregate to 15m, 1h, 4h
  const session = getCurrentSessionTimes()

  const records1m = await fetchOhlcv({
    dataset: config.dataset!,
    symbol: config.databentoSymbol!,
    stypeIn: config.stypeIn!,
    start: session.start,
    end: session.end,
  })
  const candles1m = toCandles(records1m)
  const price = candles1m.length > 0 ? candles1m[candles1m.length - 1].close : 0

  const candles15m = aggregateCandles(candles1m, 15)
  const candles1h = aggregateCandles(candles1m, 60)
  const candles4h = aggregateCandles(candles1m, 240)

  return { candles15m, candles1h, candles4h, price }
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

export async function POST() {
  try {
    // Fetch all symbols in parallel
    const fetchResults = await Promise.allSettled(
      ANALYSE_SYMBOLS.map(async (symbol) => ({
        symbol,
        data: await fetchMultiTimeframe(symbol),
      }))
    )

    const allData = new Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles4h: CandleData[]; price: number }>()
    const symbolNames = new Map<string, string>()

    for (const result of fetchResults) {
      if (result.status === 'fulfilled') {
        allData.set(result.value.symbol, result.value.data)
        symbolNames.set(result.value.symbol, SYMBOLS[result.value.symbol]?.displayName || result.value.symbol)
      }
    }

    if (allData.size === 0) {
      return NextResponse.json({ error: 'No market data available' }, { status: 503 })
    }

    // Build candle map for correlations + price changes for regime detection
    const candles15mMap = new Map<string, CandleData[]>()
    const priceChanges = new Map<string, number>()

    for (const [symbol, data] of allData.entries()) {
      const candles = data.candles15m.length > 0 ? data.candles15m : data.candles4h
      if (candles.length > 0) {
        candles15mMap.set(symbol, candles)
        const first = candles[0].close
        const last = candles[candles.length - 1].close
        priceChanges.set(symbol, first > 0 ? ((last - first) / first) * 100 : 0)
      }
    }

    // Build full market context: correlations, regime, headlines, commodities
    const marketContext = await buildMarketContext(candles15mMap, priceChanges)

    // Run the full macro analysis
    const analysis = await runInstantAnalysis(allData, symbolNames, marketContext)

    return NextResponse.json(analysis)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: `Analysis failed: ${msg}` }, { status: 500 })
  }
}
