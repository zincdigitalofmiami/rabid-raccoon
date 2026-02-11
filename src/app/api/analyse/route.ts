import { NextResponse } from 'next/server'
import { fetchOhlcv, toCandles, getCurrentSessionTimes } from '@/lib/databento'
import { fetchVixCandles, fetchDollarCandles, getFredDateRange } from '@/lib/fred'
import { runInstantAnalysis } from '@/lib/instant-analysis'
import { SYMBOLS } from '@/lib/symbols'
import { CandleData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Key symbols to analyse: MES, NQ, VIX, DXY
const ANALYSE_SYMBOLS = ['MES', 'NQ', 'VX', 'DX']

async function fetchMultiTimeframe(symbol: string): Promise<{
  candles15m: CandleData[]
  candles1h: CandleData[]
  candles1d: CandleData[]
  price: number
}> {
  const config = SYMBOLS[symbol]

  if (config.dataSource === 'fred') {
    const fredRange = getFredDateRange()
    let candles: CandleData[]
    if (symbol === 'VX') candles = await fetchVixCandles(fredRange.start, fredRange.end)
    else candles = await fetchDollarCandles(fredRange.start, fredRange.end)
    const price = candles.length > 0 ? candles[candles.length - 1].close : 0
    // FRED only has 1D data
    return { candles15m: [], candles1h: [], candles1d: candles, price }
  }

  // Databento: fetch 15m (using 1m and aggregating), 1h (using 1m), 1d
  const session = getCurrentSessionTimes()
  const now = new Date()

  // 15-minute view: last 18 hours of 1-min bars (already what we have)
  const records1m = await fetchOhlcv({
    dataset: config.dataset!,
    symbol: config.databentoSymbol!,
    stypeIn: config.stypeIn!,
    start: session.start,
    end: session.end,
  })
  const candles1m = toCandles(records1m)
  const price = candles1m.length > 0 ? candles1m[candles1m.length - 1].close : 0

  // Aggregate 1m → 15m
  const candles15m = aggregateCandles(candles1m, 15)

  // Aggregate 1m → 1h
  const candles1h = aggregateCandles(candles1m, 60)

  // 1D: fetch daily bars (last 90 days)
  const start1d = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString()
  const end1d = new Date(now.getTime() - 30 * 60 * 1000).toISOString()
  let candles1d: CandleData[] = []
  try {
    const records1d = await fetchOhlcv({
      dataset: config.dataset!,
      symbol: config.databentoSymbol!,
      stypeIn: config.stypeIn!,
      start: start1d,
      end: end1d,
      schema: 'ohlcv-1d',
    })
    candles1d = toCandles(records1d)
  } catch {
    // If daily fails, aggregate from 1m (limited to session)
    candles1d = aggregateCandles(candles1m, 1440)
  }

  return { candles15m, candles1h, candles1d, price }
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

    const allData = new Map<string, { candles15m: CandleData[]; candles1h: CandleData[]; candles1d: CandleData[]; price: number }>()
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

    const analysis = await runInstantAnalysis(allData, symbolNames)

    return NextResponse.json(analysis)
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: `Analysis failed: ${msg}` }, { status: 500 })
  }
}
