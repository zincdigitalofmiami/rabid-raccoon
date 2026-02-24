import { fetchOhlcv, toCandles, getCurrentSessionTimes } from './databento'
import {
  fetchVixCandles,
  fetchDollarCandles,
  fetchTenYearYieldCandles,
  getFredDateRange,
} from './fred'
import { fetchDailyCandlesForSymbol } from './fetch-candles'
import { buildMarketContext, MarketContext } from './market-context'
import { SYMBOLS } from './symbols'
import { CandleData } from './types'

export const ANALYSE_SYMBOLS = [
  'MES',
  'NQ',
  'YM',
  'RTY',
  'VX',
  'US10Y',
  'ZN',
  'DX',
  'GC',
  'CL',
] as const

export interface MultiTimeframeData {
  candles15m: CandleData[]
  candles1h: CandleData[]
  candles4h: CandleData[]
  price: number
}

export function aggregateCandles(candles: CandleData[], periodMinutes: number): CandleData[] {
  if (candles.length === 0) return []
  const periodSec = periodMinutes * 60
  const result: CandleData[] = []
  let bucket: CandleData | null = null
  let bucketStart = 0

  for (const c of candles) {
    const aligned = Math.floor(c.time / periodSec) * periodSec
    if (bucket === null || aligned !== bucketStart) {
      if (bucket) result.push(bucket)
      bucket = {
        time: aligned,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume || 0,
      }
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

export async function fetchMultiTimeframe(symbol: string): Promise<MultiTimeframeData> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  if (config.dataSource === 'fred') {
    const fredRange = getFredDateRange()
    let candles: CandleData[]
    if (symbol === 'VX') {
      candles = await fetchVixCandles(fredRange.start, fredRange.end)
    } else if (symbol === 'DX' || symbol === 'DXY') {
      candles = await fetchDollarCandles(fredRange.start, fredRange.end)
    } else {
      candles = await fetchTenYearYieldCandles(fredRange.start, fredRange.end)
    }
    const price = candles.length > 0 ? candles[candles.length - 1].close : 0
    return { candles15m: [], candles1h: [], candles4h: candles, price }
  }

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

  return {
    candles15m: aggregateCandles(candles1m, 15),
    candles1h: aggregateCandles(candles1m, 60),
    candles4h: aggregateCandles(candles1m, 240),
    price,
  }
}

export async function loadAnalysisInputs(
  symbols: readonly string[] = ANALYSE_SYMBOLS
): Promise<{
  allData: Map<string, MultiTimeframeData>
  symbolNames: Map<string, string>
  marketContext: MarketContext
}> {
  const fetchResults = await Promise.allSettled(
    symbols.map(async (symbol) => ({
      symbol,
      data: await fetchMultiTimeframe(symbol),
    }))
  )

  const allData = new Map<string, MultiTimeframeData>()
  const symbolNames = new Map<string, string>()

  for (const result of fetchResults) {
    if (result.status !== 'fulfilled') continue
    allData.set(result.value.symbol, result.value.data)
    symbolNames.set(result.value.symbol, SYMBOLS[result.value.symbol]?.displayName || result.value.symbol)
  }

  if (allData.size === 0) {
    throw new Error('No market data available')
  }

  // Build a macro context map from DAILY candles where possible.
  // This keeps daily macro series (e.g. VX/US10Y) aligned with futures symbols for regime/correlation math.
  const macroSymbols = [...allData.keys()]
  const macroCandlesMap = new Map<string, CandleData[]>()

  const macroResults = await Promise.allSettled(
    macroSymbols.map(async (symbol) => ({
      symbol,
      candles: await fetchDailyCandlesForSymbol(symbol, 90),
    }))
  )

  for (const result of macroResults) {
    if (result.status !== 'fulfilled') continue
    const candles = result.value.candles
    if (candles.length > 0) {
      macroCandlesMap.set(result.value.symbol, candles)
    }
  }

  // Fallback to available intraday/4h data only if daily pull failed.
  for (const [symbol, data] of allData.entries()) {
    if (macroCandlesMap.has(symbol)) continue
    const fallback = data.candles4h.length > 0 ? data.candles4h : data.candles15m
    if (fallback.length > 0) macroCandlesMap.set(symbol, fallback)
  }

  const priceChanges = new Map<string, number>()
  for (const [symbol, candles] of macroCandlesMap.entries()) {
    if (candles.length < 2) continue
    const first = candles[0].close
    const last = candles[candles.length - 1].close
    priceChanges.set(symbol, first > 0 ? ((last - first) / first) * 100 : 0)
  }

  const marketContext = await buildMarketContext(macroCandlesMap, priceChanges)

  return { allData, symbolNames, marketContext }
}
