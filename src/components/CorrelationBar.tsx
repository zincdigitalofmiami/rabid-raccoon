'use client'

import { useEffect, useState } from 'react'
import { SYMBOL_KEYS, SYMBOLS } from '@/lib/symbols'
import { MarketDataResponse } from '@/lib/types'

interface SymbolSummary {
  symbol: string
  price: number | null
  change: number | null
  loading: boolean
  error: boolean
}

export default function CorrelationBar() {
  const [summaries, setSummaries] = useState<SymbolSummary[]>(
    SYMBOL_KEYS.map((s) => ({ symbol: s, price: null, change: null, loading: true, error: false }))
  )

  useEffect(() => {
    async function fetchAll() {
      const results = await Promise.allSettled(
        SYMBOL_KEYS.map(async (symbol) => {
          const res = await fetch('/api/market-data', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol }),
          })
          if (!res.ok) throw new Error('Failed')
          return (await res.json()) as MarketDataResponse
        })
      )

      setSummaries(
        SYMBOL_KEYS.map((symbol, i) => {
          const result = results[i]
          if (result.status === 'fulfilled') {
            return {
              symbol,
              price: result.value.latestPrice,
              change: result.value.percentChange,
              loading: false,
              error: false,
            }
          }
          return { symbol, price: null, change: null, loading: false, error: true }
        })
      )
    }

    fetchAll()
    const interval = setInterval(fetchAll, 60_000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="flex items-center gap-1 overflow-x-auto px-4 py-2 bg-black/30 rounded-xl border border-white/5">
      {summaries.map((s) => {
        const config = SYMBOLS[s.symbol]
        return (
          <div
            key={s.symbol}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] shrink-0"
          >
            <span className="text-xs font-semibold text-white/70">{config?.displayName || s.symbol}</span>
            {s.loading ? (
              <span className="text-xs text-white/20">...</span>
            ) : s.error ? (
              <span className="text-xs text-red-400/60">err</span>
            ) : (
              <>
                {s.price != null && (
                  <span className="text-xs text-white/50 tabular-nums">{s.price.toFixed(2)}</span>
                )}
                {s.change != null && (
                  <span
                    className={`text-xs font-medium tabular-nums ${
                      s.change >= 0 ? 'text-cyan-400' : 'text-pink-400'
                    }`}
                  >
                    {s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}%
                  </span>
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
