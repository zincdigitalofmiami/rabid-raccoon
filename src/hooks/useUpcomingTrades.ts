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

const DEFAULT_INTERVAL = 300_000   // 5m default polling
const BACKOFF_INTERVAL = 300_000   // 5m on error
const MAX_INTERVAL = 600_000       // 10m after 3 consecutive errors
const CONSECUTIVE_ERROR_THRESHOLD = 3
const RESUME_FETCH_DEDUPE_MS = 1_000

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
  const inFlightRef = useRef<Promise<void> | null>(null)
  const lastResumeFetchAtRef = useRef(0)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const scheduleNext = useCallback(() => {
    clearTimer()
    if (document.visibilityState === 'hidden') return
    timerRef.current = setTimeout(() => {
      fetchTrades()
    }, currentInterval.current)
  }, [clearTimer]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchTrades = useCallback(async () => {
    if (inFlightRef.current) {
      return inFlightRef.current
    }

    const request = (async () => {
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
    })().finally(() => {
      inFlightRef.current = null
    })

    inFlightRef.current = request
    return request
  }, [intervalMs, scheduleNext])

  const refetchOnResume = useCallback(() => {
    const now = Date.now()
    if (now - lastResumeFetchAtRef.current < RESUME_FETCH_DEDUPE_MS) return
    lastResumeFetchAtRef.current = now
    currentInterval.current = intervalMs
    fetchTrades()
  }, [fetchTrades, intervalMs])

  useEffect(() => {
    fetchTrades()

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        clearTimer()
        return
      }
      refetchOnResume()
    }

    const handleFocus = () => {
      if (document.visibilityState !== 'visible') return
      refetchOnResume()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      clearTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [clearTimer, fetchTrades, refetchOnResume])

  return { data, loading, error, refetch: fetchTrades }
}
