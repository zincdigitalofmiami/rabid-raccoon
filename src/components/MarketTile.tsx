'use client'

import Sparkline from './Sparkline'
import { MarketSummary } from '@/lib/types'

interface MarketTileProps {
  data: MarketSummary
}

export default function MarketTile({ data }: MarketTileProps) {
  const isBull = data.changePercent >= 0
  const inverseSymbols = new Set(['VX', 'DX', 'US10Y', 'ZN', 'ZB'])
  const isInverse = inverseSymbols.has(data.symbol)
  const assetTrendBullish = data.direction === 'BULLISH'
  const spxPressureUp = isInverse ? !assetTrendBullish : assetTrendBullish
  const pressureColor = spxPressureUp ? '#26a69a' : '#ef5350'

  return (
    <div
      className="relative rounded-2xl border overflow-hidden transition-all duration-200 hover:scale-[1.01] hover:shadow-2xl"
      style={{
        borderColor: `${pressureColor}15`,
        background: 'linear-gradient(180deg, #131722 0%, #0d1117 100%)',
      }}
    >
      {/* Top accent line */}
      <div className="h-[2px] w-full" style={{ background: `linear-gradient(90deg, transparent, ${pressureColor}40, transparent)` }} />

      {/* Content */}
      <div className="p-6 pb-2">
        {/* Symbol row */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-3">
            <div>
              <span className="block text-2xl font-black text-white tracking-tight">
                {data.displayName}
              </span>
              <span className="text-[10px] text-white/25 font-bold uppercase">{data.symbol}</span>
            </div>
            <span
              className="px-2 py-0.5 rounded-md text-[11px] font-bold uppercase tracking-wide"
              style={{
                backgroundColor: `${pressureColor}15`,
                color: pressureColor,
              }}
            >
              {spxPressureUp ? '\u25B2 SPX PRESSURE UP' : '\u25BC SPX PRESSURE DOWN'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div
              className="w-12 h-1.5 rounded-full overflow-hidden"
              style={{ backgroundColor: `${pressureColor}15` }}
            >
              <div
                className="h-full rounded-full"
                style={{ width: `${data.signal.confidence}%`, backgroundColor: pressureColor }}
              />
            </div>
            <span className="text-xs font-bold tabular-nums" style={{ color: `${pressureColor}aa` }}>
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

      {/* Bottom: confluence factors — now showing real signal data */}
      {data.signal.confluenceFactors.length > 0 && (
        <div className="px-6 py-3 border-t" style={{ borderColor: `${pressureColor}10` }}>
          <div className="flex flex-wrap gap-1.5">
            <span
              className="px-2 py-0.5 rounded text-[10px] font-medium"
              style={{
                backgroundColor: `${pressureColor}12`,
                color: pressureColor,
                border: `1px solid ${pressureColor}20`,
              }}
            >
              {spxPressureUp ? 'SPX IMPACT: UP' : 'SPX IMPACT: DOWN'}
            </span>
            {data.signal.confluenceFactors.map((factor, i) => (
              <span
                key={i}
                className="px-2 py-0.5 rounded text-[10px] font-medium"
                style={{
                  backgroundColor: i === 0 ? `${pressureColor}12` : 'rgba(255,255,255,0.03)',
                  color: i === 0 ? pressureColor : 'rgba(255,255,255,0.4)',
                  border: i === 0 ? `1px solid ${pressureColor}20` : '1px solid rgba(255,255,255,0.04)',
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
