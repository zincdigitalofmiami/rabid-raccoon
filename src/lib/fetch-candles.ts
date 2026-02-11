import { fetchOhlcv, toCandles, getCurrentSessionTimes } from './databento'
import {
  fetchVixCandles,
  fetchTenYearYieldCandles,
  getFredDateRange,
} from './fred'
import { SYMBOLS } from './symbols'
import { CandleData } from './types'

export async function fetchCandlesForSymbol(
  symbol: string,
  start?: string,
  end?: string
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  if (config.dataSource === 'fred') {
    const fredRange = getFredDateRange()
    const fredStart = start?.slice(0, 10) || fredRange.start
    const fredEnd = end?.slice(0, 10) || fredRange.end

    if (symbol === 'VX') {
      return fetchVixCandles(fredStart, fredEnd)
    } else if (symbol === 'US10Y') {
      return fetchTenYearYieldCandles(fredStart, fredEnd)
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

export async function fetchDailyCandlesForSymbol(
  symbol: string,
  lookbackDays: number = 90
): Promise<CandleData[]> {
  const config = SYMBOLS[symbol]
  if (!config) throw new Error(`Unknown symbol: ${symbol}`)

  if (config.dataSource === 'fred') {
    const now = new Date()
    const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
    const startDate = start.toISOString().slice(0, 10)
    const endDate = now.toISOString().slice(0, 10)

    if (symbol === 'VX') return fetchVixCandles(startDate, endDate)
    if (symbol === 'US10Y') return fetchTenYearYieldCandles(startDate, endDate)
    throw new Error(`Unknown FRED symbol: ${symbol}`)
  }

  const now = new Date()
  const start = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
  const records = await fetchOhlcv({
    dataset: config.dataset!,
    symbol: config.databentoSymbol!,
    stypeIn: config.stypeIn!,
    start: start.toISOString(),
    end: now.toISOString(),
    schema: 'ohlcv-1d',
  })

  return toCandles(records)
}
