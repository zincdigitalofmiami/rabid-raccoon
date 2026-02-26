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
    const interval = setInterval(fetchCorrelation, 60_000)
    return () => clearInterval(interval)
  }, [])

  const alignment = data?.bullish

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60">
          Correlation
        </span>
        {alignment && (
          <span
            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${
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
        <div className="space-y-3 mt-1">
          {(
            [
              { label: 'VIX', value: alignment.vix },
              { label: 'NQ', value: alignment.nq },
              { label: 'DXY', value: alignment.dxy },
            ] as { label: string; value: number }[]
          ).map(({ label, value }) => {
            const abs = Math.abs(value)
            const color =
              abs < 0.3
                ? 'text-white/25'
                : value > 0
                  ? 'text-emerald-400'
                  : 'text-red-400'
            return (
              <div key={label} className="flex items-center justify-between">
                <span className="text-[11px] font-mono text-white/35">{label}</span>
                <span className={`text-base font-bold font-mono tabular-nums ${color}`}>
                  {value > 0 ? '+' : ''}
                  {value.toFixed(2)}
                </span>
              </div>
            )
          })}
        </div>
      ) : error ? (
        <div className="text-xs text-red-400/70 mt-1">{error}</div>
      ) : (
        <div className="flex items-center gap-2 mt-2">
          <div className="w-3 h-3 border border-white/[0.08] border-t-amber-500/40 rounded-full animate-spin" />
          <span className="text-xs text-white/20">Loading...</span>
        </div>
      )}

      {alignment && (
        <div className="mt-auto pt-3 text-[10px] font-mono text-white/20 border-t border-white/[0.05] mt-4">
          composite {alignment.composite.toFixed(3)} · n={data?.meta.observations ?? 0}
        </div>
      )}
    </div>
  )
}
