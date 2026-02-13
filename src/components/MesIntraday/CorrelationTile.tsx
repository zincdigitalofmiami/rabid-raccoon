'use client'

import { useState, useEffect } from 'react'
import type { CorrelationAlignment } from '@/lib/correlation-filter'

interface CorrelationMeta {
  cadence: 'intraday' | 'daily' | 'unavailable'
  lookbackBars: number
  observations: number
  availableSymbols: string[]
  missingSymbols: string[]
  reason: string | null
}

interface CorrelationResponse {
  bullish: CorrelationAlignment
  bearish: CorrelationAlignment
  meta: CorrelationMeta
  timestamp: string
}

function Badge({ label, value }: { label: string; value: number }) {
  const abs = Math.abs(value)
  const color =
    abs < 0.3
      ? 'text-white/30 bg-white/5'
      : value > 0
        ? 'text-emerald-400 bg-emerald-400/10'
        : 'text-red-400 bg-red-400/10'

  return (
    <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded ${color}`}>
      <span className="font-mono text-[10px]">{label}</span>
      <span className="font-medium tabular-nums">{value.toFixed(2)}</span>
    </div>
  )
}

export default function CorrelationTile() {
  const [data, setData] = useState<CorrelationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const fetchCorrelation = async () => {
      try {
        const res = await fetch('/api/mes/correlation')
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
          throw new Error(err.error || `HTTP ${res.status}`)
        }
        const json: CorrelationResponse = await res.json()
        setData(json)
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown correlation error')
      }
    }
    fetchCorrelation()
    const interval = setInterval(fetchCorrelation, 60000)
    return () => clearInterval(interval)
  }, [])

  const alignment = data?.bullish

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Correlation
        </span>
        {alignment && (
          <span
            className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
              alignment.isAligned
                ? 'text-emerald-400 bg-emerald-400/10'
                : 'text-red-400 bg-red-400/10'
            }`}
          >
            {alignment.isAligned ? 'ALIGNED' : 'CONFLICT'}
          </span>
        )}
      </div>

      {alignment ? (
        <div className="flex flex-wrap gap-1.5">
          <Badge label="VIX" value={alignment.vix} />
          <Badge label="NQ" value={alignment.nq} />
          <Badge label="DXY" value={alignment.dxy} />
        </div>
      ) : error ? (
        <div className="text-xs text-red-400/80">{error}</div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 border border-white/10 border-t-white/30 rounded-full animate-spin" />
          <span className="text-xs text-white/20">Loading...</span>
        </div>
      )}

      {alignment && (
        <div className="mt-2 space-y-1 text-[10px] text-white/20 font-mono">
          <div>composite {alignment.composite.toFixed(3)}</div>
          <div>
            cadence {data?.meta.cadence ?? 'unknown'} • n={data?.meta.observations ?? 0}
          </div>
          {data?.meta.reason && <div>{data.meta.reason}</div>}
        </div>
      )}
    </div>
  )
}
