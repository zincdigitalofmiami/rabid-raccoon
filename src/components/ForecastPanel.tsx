'use client'

import { ForecastResponse } from '@/lib/types'

interface ForecastPanelProps {
  forecast: ForecastResponse | null
  loading: boolean
  error: string | null
}

export default function ForecastPanel({ forecast, loading, error }: ForecastPanelProps) {
  if (error) {
    return (
      <div className="rounded-xl border border-white/5 bg-[#131722] p-6">
        <p className="text-sm text-red-400/80">Forecast unavailable: {error}</p>
      </div>
    )
  }

  if (loading || !forecast) {
    return (
      <div className="rounded-xl border border-white/5 bg-[#131722] p-6">
        <div className="flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          <span className="text-sm text-white/30">Generating AI forecast...</span>
        </div>
      </div>
    )
  }

  const windowLabels: Record<string, string> = {
    morning: 'Morning Analysis',
    premarket: 'Premarket Signal',
    midday: 'Midday Update',
  }

  const isBull = forecast.direction === 'BULLISH'
  const accentColor = isBull ? '#26a69a' : '#ef5350'
  const generatedTime = new Date(forecast.generatedAt).toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-bold text-white">AI FORECAST</span>
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white/5 text-white/50">
            {windowLabels[forecast.window] || forecast.window}
          </span>
        </div>
        <span className="text-[11px] text-white/25">{generatedTime} CT</span>
      </div>

      {/* Analysis */}
      <div className="px-5 py-4 border-b border-white/5">
        <p className="text-sm text-white/70 leading-relaxed whitespace-pre-line">
          {forecast.analysis}
        </p>
      </div>

      {/* Per-symbol forecasts */}
      <div className="px-5 py-3 border-b border-white/5">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {forecast.symbolForecasts.map((sf) => {
            const bull = sf.direction === 'BULLISH'
            return (
              <span
                key={sf.symbol}
                className="text-xs font-medium tabular-nums"
                style={{ color: bull ? '#26a69a' : '#ef5350' }}
              >
                {sf.symbol} {bull ? '▲' : '▼'}
                {sf.confidence}%
              </span>
            )
          })}
        </div>
      </div>

      {/* Key levels + Measured moves */}
      <div className="px-5 py-3 border-b border-white/5 flex flex-wrap gap-6">
        {forecast.keyLevels.support.length > 0 && (
          <div>
            <span className="text-[10px] text-white/25 uppercase tracking-wider">Support</span>
            <div className="flex gap-2 mt-0.5">
              {forecast.keyLevels.support.map((level, i) => (
                <span key={i} className="text-xs font-medium text-[#26a69a] tabular-nums">
                  {level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              ))}
            </div>
          </div>
        )}
        {forecast.keyLevels.resistance.length > 0 && (
          <div>
            <span className="text-[10px] text-white/25 uppercase tracking-wider">Resistance</span>
            <div className="flex gap-2 mt-0.5">
              {forecast.keyLevels.resistance.map((level, i) => (
                <span key={i} className="text-xs font-medium text-[#ef5350] tabular-nums">
                  {level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </span>
              ))}
            </div>
          </div>
        )}
        {forecast.measuredMoves.length > 0 && (
          <div>
            <span className="text-[10px] text-white/25 uppercase tracking-wider">
              Measured Move
            </span>
            {forecast.measuredMoves.map((mm, i) => (
              <div key={i} className="flex gap-3 mt-0.5">
                <span
                  className="text-xs font-medium tabular-nums"
                  style={{ color: mm.direction === 'BULLISH' ? '#26a69a' : '#ef5350' }}
                >
                  Entry {mm.entry.toFixed(2)} · Stop {mm.stop.toFixed(2)} · Target{' '}
                  {mm.target.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Intermarket notes */}
      {forecast.intermarketNotes.length > 0 && (
        <div className="px-5 py-3 border-b border-white/5">
          <span className="text-[10px] text-white/25 uppercase tracking-wider block mb-1.5">
            Intermarket
          </span>
          <div className="flex flex-wrap gap-2">
            {forecast.intermarketNotes.map((note, i) => (
              <span
                key={i}
                className="px-2 py-0.5 rounded text-[11px] font-medium text-white/50 bg-white/5"
              >
                {note}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Disclaimer */}
      <div className="px-5 py-2 bg-white/[0.02]">
        <p className="text-[10px] text-white/20">
          AI-generated analysis, not financial advice. Based on David Halsey Measured Move
          methodology.
        </p>
      </div>
    </div>
  )
}
