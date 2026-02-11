'use client'

import Sparkline from './Sparkline'
import { MarketSummary } from '@/lib/types'

interface MarketTileProps {
  data: MarketSummary
}

export default function MarketTile({ data }: MarketTileProps) {
  const isBull = data.changePercent >= 0
  const dirColor = data.direction === 'BULLISH' ? '#26a69a' : '#ef5350'

  return (
    <div
      className="relative rounded-2xl border overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-2xl"
      style={{
        borderColor: `${dirColor}15`,
        background: 'linear-gradient(180deg, #131722 0%, #0d1117 100%)',
      }}
    >
      {/* Top accent line */}
      <div className="h-[2px] w-full" style={{ background: `linear-gradient(90deg, transparent, ${dirColor}40, transparent)` }} />

      {/* Content */}
      <div className="p-6 pb-2">
        {/* Symbol row */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-black text-white tracking-tight">
              {data.displayName}
            </span>
            <span
              className="px-2 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wide"
              style={{
                backgroundColor: `${dirColor}15`,
                color: dirColor,
              }}
            >
              {data.direction === 'BULLISH' ? '▲ BULL' : '▼ BEAR'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-12 h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: `${dirColor}15` }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${data.signal.confidence}%`, backgroundColor: dirColor }}
              />
            </div>
            <span className="text-xs font-bold tabular-nums" style={{ color: `${dirColor}aa` }}>
              {data.signal.confidence}%
            </span>
          </div>
        </div>

        {/* Price */}
        <div className="mb-1">
          <span className="text-4xl font-black text-white tabular-nums tracking-tight">
            {data.price.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          </span>
        </div>

        {/* Change */}
        <div className="mb-4">
          <span
            className="text-base font-semibold tabular-nums"
            style={{ color: isBull ? '#26a69a' : '#ef5350' }}
          >
            {isBull ? '+' : ''}
            {data.change.toFixed(2)}{' '}
            <span className="text-sm">
              ({isBull ? '+' : ''}
              {data.changePercent.toFixed(2)}%)
            </span>
          </span>
        </div>
      </div>

      {/* Sparkline — full width, generous height */}
      <div className="w-full" style={{ height: 100 }}>
        <Sparkline data={data.sparklineData} width={400} height={100} strokeWidth={2.5} />
      </div>

      {/* Bottom: confluence factors */}
      {data.signal.confluenceFactors.length > 0 && (
        <div className="px-6 py-3 border-t" style={{ borderColor: `${dirColor}10` }}>
          <div className="flex flex-wrap gap-1.5">
            {data.signal.confluenceFactors.slice(0, 3).map((factor, i) => (
              <span
                key={i}
                className="px-2 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.03)',
                  color: 'rgba(255,255,255,0.35)',
                }}
              >
                {factor}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
