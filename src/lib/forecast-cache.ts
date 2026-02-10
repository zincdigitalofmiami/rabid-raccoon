import { ForecastResponse } from './types'

type ForecastWindow = 'morning' | 'premarket' | 'midday'

const cache = new Map<string, ForecastResponse>()

function getDateKey(): string {
  // Use Central Time date
  const now = new Date()
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  return ct.toISOString().slice(0, 10)
}

export function getCurrentWindow(): ForecastWindow {
  const now = new Date()
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const hour = ct.getHours()
  const minute = ct.getMinutes()
  const totalMinutes = hour * 60 + minute

  // Morning: before 6:00 AM CT (or overnight)
  if (totalMinutes < 360) return 'morning'
  // Premarket: 6:00 AM - 9:15 AM CT
  if (totalMinutes < 555) return 'premarket'
  // Midday: after 9:15 AM CT
  return 'midday'
}

function getCacheKey(window: ForecastWindow): string {
  return `${getDateKey()}_${window}`
}

export function getCachedForecast(window?: ForecastWindow): ForecastResponse | null {
  const w = window || getCurrentWindow()
  const key = getCacheKey(w)
  return cache.get(key) || null
}

export function setCachedForecast(forecast: ForecastResponse): void {
  const key = getCacheKey(forecast.window)
  cache.set(key, forecast)

  // Clean up old entries (keep only today's)
  const todayPrefix = getDateKey()
  for (const k of cache.keys()) {
    if (!k.startsWith(todayPrefix)) {
      cache.delete(k)
    }
  }
}
