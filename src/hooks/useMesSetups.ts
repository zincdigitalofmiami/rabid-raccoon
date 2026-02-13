'use client'

import { useState, useEffect, useCallback } from 'react'
import type { BhgSetup } from '@/lib/bhg-engine'
import type { FibResult, MeasuredMove } from '@/lib/types'
import type { RiskResult } from '@/lib/risk-engine'

export interface EnrichedSetup extends BhgSetup {
  risk?: RiskResult
  pTp1?: number | null
  pTp2?: number | null
}

export interface MesSetupsResponse {
  setups: EnrichedSetup[]
  fibResult: FibResult | null
  currentPrice: number | null
  measuredMoves?: MeasuredMove[]
  timestamp: string
  error?: string
}

export function useMesSetups(pollInterval = 30000) {
  const [data, setData] = useState<MesSetupsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchSetups = useCallback(async () => {
    try {
      const res = await fetch('/api/mes/setups')
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }
      const json: MesSetupsResponse = await res.json()
      setData(json)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSetups()
    const interval = setInterval(fetchSetups, pollInterval)
    return () => clearInterval(interval)
  }, [fetchSetups, pollInterval])

  return { data, loading, error, refetch: fetchSetups }
}
