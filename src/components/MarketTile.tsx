'use client'

import Sparkline from './Sparkline'
import { MarketSummary } from '@/lib/types'

interface MarketTileProps {
  data: MarketSummary
}

export default function MarketTile({ data }: MarketTileProps) {
  const isBull = data.changePercent >= 0
  const dirArrow = data.direction === 'BULLISH' ? '▲' : '▼'
  const dirColor = data.direction === 'BULLISH' ? 'text-[#26a69a]' : 'text-[#ef5350]'

  return (
    <div className="relative rounded-xl border border-white/5 bg-[#131722] overflow-hidden hover:border-white/10 transition-colors">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-bold ${dirColor}`}>{dirArrow}</span>
          <span className="text-sm font-bold text-white tracking-tight">
            {data.displayName}
          </span>
        </div>
        <span className="text-[10px] text-white/25 font-medium">
          {data.signal.confidence}%
        </span>
      </div>

      {/* Price */}
      <div className="px-4 pb-1">
        <span className="text-lg font-semibold text-white tabular-nums">
          {data.price.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>
      </div>

      {/* Change */}
      <div className="px-4 pb-2">
        <span
          className={`text-xs font-medium tabular-nums ${
            isBull ? 'text-[#26a69a]' : 'text-[#ef5350]'
          }`}
        >
          {isBull ? '+' : ''}
          {data.change.toFixed(2)} ({isBull ? '+' : ''}
          {data.changePercent.toFixed(2)}%)
        </span>
      </div>

      {/* Sparkline */}
      <div className="px-2 pb-3">
        <Sparkline data={data.sparklineData} width={160} height={40} />
      </div>
    </div>
  )
}
