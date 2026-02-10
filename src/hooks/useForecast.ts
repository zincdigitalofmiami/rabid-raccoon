'use client'

import { useState, useEffect, useCallback } from 'react'
import { ForecastResponse } from '@/lib/types'

interface UseForecastResult {
  forecast: ForecastResponse | null
  loading: boolean
  error: string | null
}

export function useForecast(pollInterval = 300000): UseForecastResult {
  const [forecast, setForecast] = useState<ForecastResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchForecast = useCallback(async () => {
    try {
      const res = await fetch('/api/forecast')
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }
      const data: ForecastResponse = await res.json()
      setForecast(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchForecast()
    const interval = setInterval(fetchForecast, pollInterval)
    return () => clearInterval(interval)
  }, [fetchForecast, pollInterval])

  return { forecast, loading, error }
}
