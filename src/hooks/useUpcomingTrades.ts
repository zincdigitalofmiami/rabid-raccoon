'use client'

import { useState, useEffect, useCallback } from 'react'
import type { ScoredTrade, UpcomingTradesResponse } from '@/app/api/trades/upcoming/route'
import type { EventContext } from '@/lib/event-awareness'
import type { FibResult } from '@/lib/types'

export type { ScoredTrade }

export interface UpcomingTradesData {
  trades: ScoredTrade[]
  eventContext: EventContext | null
  currentPrice: number | null
  fibResult: FibResult | null
}

export function useUpcomingTrades(intervalMs = 15_000) {
  const [data, setData] = useState<UpcomingTradesData>({
    trades: [],
    eventContext: null,
    currentPrice: null,
    fibResult: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/trades/upcoming')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: UpcomingTradesResponse = await res.json()

      if (json.error) {
        setError(json.error)
      } else {
        setError(null)
      }

      setData({
        trades: json.trades ?? [],
        eventContext: json.eventContext ?? null,
        currentPrice: json.currentPrice ?? null,
        fibResult: json.fibResult ?? null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTrades()
    const id = setInterval(fetchTrades, intervalMs)
    return () => clearInterval(id)
  }, [fetchTrades, intervalMs])

  return { data, loading, error, refetch: fetchTrades }
}
