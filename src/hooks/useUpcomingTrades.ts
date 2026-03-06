'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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

const DEFAULT_INTERVAL = 60_000    // 60s — signal only updates every 15m
const BACKOFF_INTERVAL = 180_000   // 3m on error
const MAX_INTERVAL = 300_000       // 5m after 3 consecutive errors
const CONSECUTIVE_ERROR_THRESHOLD = 3

export function useUpcomingTrades(intervalMs = DEFAULT_INTERVAL) {
  const [data, setData] = useState<UpcomingTradesData>({
    trades: [],
    eventContext: null,
    currentPrice: null,
    fibResult: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const consecutiveErrors = useRef(0)
  const currentInterval = useRef(intervalMs)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleNext = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      fetchTrades()
    }, currentInterval.current)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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

      // Success — reset backoff
      consecutiveErrors.current = 0
      currentInterval.current = intervalMs

      setData({
        trades: json.trades ?? [],
        eventContext: json.eventContext ?? null,
        currentPrice: json.currentPrice ?? null,
        fibResult: json.fibResult ?? null,
      })
    } catch (err) {
      consecutiveErrors.current++
      setError(err instanceof Error ? err.message : String(err))

      // Backoff on errors
      if (consecutiveErrors.current >= CONSECUTIVE_ERROR_THRESHOLD) {
        currentInterval.current = MAX_INTERVAL
      } else {
        currentInterval.current = BACKOFF_INTERVAL
      }
    } finally {
      setLoading(false)
      scheduleNext()
    }
  }, [intervalMs, scheduleNext])

  useEffect(() => {
    fetchTrades()
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [fetchTrades])

  return { data, loading, error, refetch: fetchTrades }
}
