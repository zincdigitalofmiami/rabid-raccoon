'use client'

import { useState, useEffect, useCallback } from 'react'
import { MarketDataResponse } from '@/lib/types'

const REFRESH_INTERVAL = 60_000 // 60 seconds

interface UseMarketDataReturn {
  data: MarketDataResponse | null
  loading: boolean
  error: string | null
  lastUpdated: Date | null
  refresh: () => void
}

export function useMarketData(symbol: string): UseMarketDataReturn {
  const [data, setData] = useState<MarketDataResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const fetchData = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const res = await fetch('/api/market-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol }),
      })

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(errBody.error || `HTTP ${res.status}`)
      }

      const json: MarketDataResponse = await res.json()
      setData(json)
      setLastUpdated(new Date())
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load'
      setError(msg)
    } finally {
      setLoading(false)
    }
  }, [symbol])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [fetchData])

  return { data, loading, error, lastUpdated, refresh: fetchData }
}
