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

/**
 * Fetch VIX candles from FRED using VIXCLS (daily close).
 * Only close values available — open/high/low set to close.
 */
export async function fetchVixCandles(startDate: string, endDate?: string): Promise<CandleData[]> {
  const observations = await fetchFredSeries('VIXCLS', startDate, endDate)

  const candles: CandleData[] = []
  for (const obs of observations) {
    const value = Number(obs.value)
    if (isNaN(value) || value <= 0) continue

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
 * Fetch Dollar Index candles from FRED.
 * Uses DTWEXBGS (Trade Weighted US Dollar Index: Broad).
 * Only close values available — open/high/low set to close.
 */
export async function fetchDollarCandles(
  startDate: string,
  endDate?: string
): Promise<CandleData[]> {
  const observations = await fetchFredSeries('DTWEXBGS', startDate, endDate)

  const candles: CandleData[] = []
  for (const obs of observations) {
    const value = Number(obs.value)
    if (isNaN(value) || value <= 0) continue

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
