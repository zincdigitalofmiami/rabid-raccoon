'use client'

import { useState, useEffect, useCallback } from 'react'

// ── Types matching /api/correlation response ─────────────────────────────────

export interface CorrelationAlignment {
  nq: number
  vix: number
  dxy: number
  cl: number
  zn: number
  gc: number
  composite: number
  isAligned: boolean
  details: string
}

export interface CorrelationSymbolDetail {
  symbol: string
  label: string
  correlation: number
  rolling30d: number | null
  rolling90d: number | null
  rolling180d: number | null
  bullishAligned: boolean
  bullishScore: number
  weight: number
  observations: number
}

interface CorrelationMeta {
  cadence: 'daily'
  lookbackDays: number
  observations: number
  dateRange: { start: string; end: string }
  availableSymbols: string[]
  missingSymbols: string[]
  generatedAt: string
}

export interface CorrelationResponse {
  bullish: CorrelationAlignment
  bearish: CorrelationAlignment
  symbols: CorrelationSymbolDetail[]
  meta: CorrelationMeta
  timestamp: string
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useCorrelation(pollInterval = 60_000) {
  const [data, setData] = useState<CorrelationResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchCorrelation = useCallback(async () => {
    try {
      const res = await fetch('/api/correlation')
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const json: CorrelationResponse = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown correlation error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchCorrelation()
    const interval = setInterval(fetchCorrelation, pollInterval)
    return () => clearInterval(interval)
  }, [fetchCorrelation, pollInterval])

  return { data, loading, error }
}
