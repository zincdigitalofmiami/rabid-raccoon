import { CandleData } from './types'

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

interface FredObservation {
  date: string
  value: string
}

interface FredResponse {
  observations: FredObservation[]
}

async function fetchFredSeries(
  seriesId: string,
  startDate: string,
  endDate?: string
): Promise<FredObservation[]> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) {
    throw new Error('FRED_API_KEY environment variable is not set')
  }

  const url = new URL(FRED_BASE)
  url.searchParams.set('series_id', seriesId)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('observation_start', startDate)
  url.searchParams.set('sort_order', 'asc')
  if (endDate) {
    url.searchParams.set('observation_end', endDate)
  }

  const response = await fetch(url.toString(), {
    headers: { 'User-Agent': 'RabidRaccoon/1.0' },
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(
      `FRED API error ${response.status}: ${response.statusText}. ${errorText.slice(0, 500)}`
    )
  }

  const data: FredResponse = await response.json()
  return data.observations.filter((obs) => obs.value !== '.')
}

async function fetchSeriesCandles(
  seriesId: string,
  startDate: string,
  endDate?: string
): Promise<CandleData[]> {
  const observations = await fetchFredSeries(seriesId, startDate, endDate)
  const candles: CandleData[] = []

  for (const obs of observations) {
    const value = Number(obs.value)
    if (!Number.isFinite(value) || value <= 0) continue

    candles.push({
      time: Math.floor(new Date(`${obs.date}T16:00:00Z`).getTime() / 1000),
      open: value,
      high: value,
      low: value,
      close: value,
    })
  }

  return candles.sort((a, b) => a.time - b.time)
}

/**
 * Fetch VIX candles from FRED using VIXCLS (daily close).
 * Only close values available — open/high/low set to close.
 */
export async function fetchVixCandles(startDate: string, endDate?: string): Promise<CandleData[]> {
  return fetchSeriesCandles('VIXCLS', startDate, endDate)
}

/**
 * Fetch Dollar Index candles from FRED.
 * Uses DTWEXBGS (Trade Weighted US Dollar Index: Broad).
 * Only close values available — open/high/low set to close.
 */
export async function fetchDollarCandles(
  startDate: string,
  endDate?: string
): Promise<CandleData[]> {
  return fetchSeriesCandles('DTWEXBGS', startDate, endDate)
}

/**
 * Fetch US 10Y Treasury yield from FRED (DGS10).
 * Values are in percent (e.g. 4.23).
 */
export async function fetchTenYearYieldCandles(
  startDate: string,
  endDate?: string
): Promise<CandleData[]> {
  return fetchSeriesCandles('DGS10', startDate, endDate)
}

/**
 * Fetch Effective Federal Funds Rate (DFF) from FRED.
 * Values are in percent.
 */
export async function fetchFedFundsCandles(
  startDate: string,
  endDate?: string
): Promise<CandleData[]> {
  return fetchSeriesCandles('DFF', startDate, endDate)
}

/**
 * Get the FRED date range — last 90 days of daily data.
 */
export function getFredDateRange(): { start: string; end: string } {
  const now = new Date()
  const start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000)

  return {
    start: start.toISOString().slice(0, 10),
    end: now.toISOString().slice(0, 10),
  }
}
