'use client'

import { useState, useEffect, useCallback } from 'react'
import { MarketSummary } from '@/lib/types'

interface BatchResponse {
  symbols: MarketSummary[]
  timestamp: string
}

interface UseMarketBatchResult {
  symbols: MarketSummary[]
  loading: boolean
  error: string | null
}

export function useMarketBatch(pollInterval = 60000): UseMarketBatchResult {
  const [symbols, setSymbols] = useState<MarketSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchBatch = useCallback(async () => {
    try {
      const res = await fetch('/api/market-data/batch')
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }
      const data: BatchResponse = await res.json()
      setSymbols(data.symbols)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBatch()
    const interval = setInterval(fetchBatch, pollInterval)
    return () => clearInterval(interval)
  }, [fetchBatch, pollInterval])

  return { symbols, loading, error }
}
