'use client'

import dynamic from 'next/dynamic'
import { useMarketData } from '@/hooks/useMarketData'
import { SYMBOLS } from '@/lib/symbols'

const CandlestickChart = dynamic(() => import('./CandlestickChart'), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-full">
      <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
    </div>
  ),
})

interface SymbolCardProps {
  symbol: string
  chartHeight: number
  isPrimary?: boolean
}

export default function SymbolCard({ symbol, chartHeight, isPrimary = false }: SymbolCardProps) {
  const config = SYMBOLS[symbol]
  const { data, loading, error } = useMarketData(symbol)

  if (!config) return null

  return (
    <div
      className="relative w-full rounded-2xl overflow-hidden border border-white/5"
      style={{ background: 'linear-gradient(180deg, #131722 0%, #0d1117 100%)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${
                error ? 'bg-red-400' : loading ? 'bg-yellow-400 animate-pulse' : 'bg-cyan-400 animate-pulse shadow-lg shadow-cyan-400/50'
              }`}
            />
            <span className={`font-semibold text-white tracking-tight ${isPrimary ? 'text-base' : 'text-sm'}`}>
              {config.displayName}
            </span>
          </div>
          <span className="text-xs text-white/30 font-medium">{config.description} &bull; {config.dataSource === 'fred' ? '1D' : '1m'}</span>
        </div>
        <div className="flex items-center gap-3">
          {data?.latestPrice != null && (
            <>
              <span className={`font-semibold text-white tabular-nums ${isPrimary ? 'text-2xl' : 'text-lg'}`}>
                {data.latestPrice.toFixed(2)}
              </span>
              {data.percentChange != null && (
                <span
                  className={`text-sm font-medium tabular-nums ${
                    data.percentChange >= 0 ? 'text-cyan-400' : 'text-pink-400'
                  }`}
                >
                  {data.percentChange >= 0 ? '+' : ''}{data.percentChange.toFixed(2)}%
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Chart area */}
      <div className="relative w-full" style={{ height: chartHeight }}>
        {error ? (
          <div className="flex items-center justify-center h-full px-4">
            <p className="text-sm text-red-400/80 text-center">Failed to load &mdash; {error}</p>
          </div>
        ) : loading && !data ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        ) : data ? (
          <CandlestickChart
            candles={data.candles}
            fibLevels={data.fibLevels}
            swingPoints={data.swingPoints}
            height={chartHeight}
          />
        ) : null}
      </div>

      {/* Legend */}
      <div className="flex items-center justify-center gap-6 px-4 py-2 border-t border-white/5 bg-black/20">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-3 rounded-sm" style={{ backgroundColor: '#26a69a' }} />
          <span className="text-[9px] text-white/40 uppercase tracking-wider">Bull</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-3 rounded-sm" style={{ backgroundColor: '#ef5350' }} />
          <span className="text-[9px] text-white/40 uppercase tracking-wider">Bear</span>
        </div>
        {data?.fibLevels && (
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 rounded-full" style={{ backgroundColor: '#009688' }} />
            <span className="text-[9px] text-white/40 uppercase tracking-wider">Fib</span>
          </div>
        )}
      </div>
    </div>
  )
}
