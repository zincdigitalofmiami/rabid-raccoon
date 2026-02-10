'use client'

import { CompositeSignal } from '@/lib/types'

interface SignalBarProps {
  signal: CompositeSignal | null
  mesPrice?: number
  mesChangePercent?: number
}

export default function SignalBar({ signal, mesPrice, mesChangePercent }: SignalBarProps) {
  if (!signal) {
    return (
      <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
        <div className="flex items-center gap-3">
          <div className="w-3 h-3 rounded-full bg-white/10 animate-pulse" />
          <span className="text-sm text-white/30">Loading signal...</span>
        </div>
      </div>
    )
  }

  const isBull = signal.direction === 'BULLISH'
  const arrow = isBull ? '▲' : '▼'
  const bgGradient = isBull
    ? 'from-[#26a69a]/10 to-transparent'
    : 'from-[#ef5350]/10 to-transparent'
  const accentColor = isBull ? '#26a69a' : '#ef5350'
  const textColor = isBull ? 'text-[#26a69a]' : 'text-[#ef5350]'

  const confidenceWidth = `${signal.confidence}%`

  return (
    <div
      className={`rounded-xl border overflow-hidden bg-gradient-to-r ${bgGradient}`}
      style={{ borderColor: `${accentColor}20` }}
    >
      <div className="p-4">
        {/* Top row: direction + confidence + MES price */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <span className={`text-2xl font-bold ${textColor}`}>{arrow}</span>
            <span className={`text-lg font-bold ${textColor} tracking-tight`}>
              {signal.direction}
            </span>
            {/* Confidence bar */}
            <div className="flex items-center gap-2">
              <div className="w-24 h-2 rounded-full bg-white/5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: confidenceWidth,
                    backgroundColor: accentColor,
                  }}
                />
              </div>
              <span className="text-xs font-bold text-white/50 tabular-nums">
                {signal.confidence}%
              </span>
            </div>
          </div>

          {/* MES price */}
          {mesPrice != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/30 font-medium">MES</span>
              <span className="text-lg font-semibold text-white tabular-nums">
                {mesPrice.toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}
              </span>
              {mesChangePercent != null && (
                <span
                  className={`text-sm font-medium tabular-nums ${
                    mesChangePercent >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'
                  }`}
                >
                  {mesChangePercent >= 0 ? '+' : ''}
                  {mesChangePercent.toFixed(2)}%
                </span>
              )}
            </div>
          )}
        </div>

        {/* Confluence factors */}
        {signal.confluenceSummary.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {signal.confluenceSummary.map((factor, i) => (
              <span
                key={i}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium border"
                style={{
                  backgroundColor: `${accentColor}08`,
                  borderColor: `${accentColor}20`,
                  color: `${accentColor}cc`,
                }}
              >
                {factor}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
