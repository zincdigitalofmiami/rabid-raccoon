import { fetchOhlcv, toCandles, getCurrentSessionTimes } from './databento'
import { fetchVixCandles, fetchDollarCandles, getFredDateRange } from './fred'
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
