import { ForecastResponse } from './types'

type ForecastWindow = 'morning' | 'premarket' | 'midday' | 'afterhours'

const cache = new Map<string, ForecastResponse>()
const WINDOW_TTL_MINUTES: Record<ForecastWindow, number> = {
  morning: 90,
  premarket: 20,
  midday: 20,
  afterhours: 45,
}

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

  // Morning: before 6:00 AM CT
  if (totalMinutes < 360) return 'morning'
  // Premarket: 6:00 AM - 8:30 AM CT
  if (totalMinutes < 510) return 'premarket'
  // Midday/session: 8:30 AM - 3:00 PM CT
  if (totalMinutes < 900) return 'midday'
  // After hours: 3:00 PM CT onward
  return 'afterhours'
}

function isForecastFresh(forecast: ForecastResponse, window: ForecastWindow): boolean {
  const ttlMin = WINDOW_TTL_MINUTES[window]
  const ts = Date.parse(forecast.generatedAt)
  if (Number.isNaN(ts)) return false
  const ageMs = Date.now() - ts
  return ageMs >= 0 && ageMs <= ttlMin * 60 * 1000
}

function getCacheKey(window: ForecastWindow): string {
  return `${getDateKey()}_${window}`
}

export function getCachedForecast(window?: ForecastWindow): ForecastResponse | null {
  const w = window || getCurrentWindow()
  const key = getCacheKey(w)
  const cached = cache.get(key)
  if (!cached) return null

  if (!isForecastFresh(cached, w)) {
    cache.delete(key)
    return null
  }

  return cached
}

export function setCachedForecast(forecast: ForecastResponse): void {
  const key = getCacheKey(forecast.window)
  cache.set(key, forecast)

  // Keep only recent entries to bound memory.
  const recentPrefix = getDateKey()
  for (const k of cache.keys()) {
    if (!k.startsWith(recentPrefix)) {
      cache.delete(k)
    }
  }
}

// Backward-compatible export for route type narrowing
export type { ForecastWindow }
