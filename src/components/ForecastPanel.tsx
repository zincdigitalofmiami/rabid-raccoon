'use client'

import { ForecastResponse } from '@/lib/types'

interface ForecastPanelProps {
  forecast: ForecastResponse | null
  loading: boolean
  error: string | null
}

const INVERSE_SYMBOLS = new Set(['VX', 'DX', 'US10Y', 'ZN', 'ZB'])

function spxPressureForSymbol(symbol: string, direction: 'BULLISH' | 'BEARISH'): 'UP' | 'DOWN' {
  const assetUp = direction === 'BULLISH'
  if (INVERSE_SYMBOLS.has(symbol)) {
    return assetUp ? 'DOWN' : 'UP'
  }
  return assetUp ? 'UP' : 'DOWN'
}

function pressureColor(pressure: 'UP' | 'DOWN'): string {
  return pressure === 'UP' ? '#26a69a' : '#ef5350'
}

export default function ForecastPanel({ forecast, loading, error }: ForecastPanelProps) {
  if (error) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#131722] p-8">
        <p className="text-base text-red-400/90">Forecast unavailable: {error}</p>
      </div>
    )
  }

  if (loading || !forecast) {
    return (
      <div className="rounded-2xl border border-white/10 bg-[#131722] p-8">
        <div className="flex items-center gap-3">
          <div className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
          <span className="text-base text-white/40">Generating forecast from live signals...</span>
        </div>
      </div>
    )
  }

  const windowLabels: Record<string, string> = {
    morning: 'Morning Analysis',
    premarket: 'Premarket Signal',
    midday: 'Midday Update',
    afterhours: 'After Hours Snapshot',
  }

  const generatedTime = new Date(forecast.generatedAt).toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  const overallPressure = spxPressureForSymbol('MES', forecast.direction)
  const overallColor = pressureColor(overallPressure)

  return (
    <div className="rounded-2xl border border-white/10 bg-[#131722] overflow-hidden">
      <div className="px-7 py-5 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-black text-white tracking-wide">AI FORECAST</span>
          <span className="px-3 py-1 rounded-md text-xs font-bold uppercase bg-white/5 text-white/60">
            {windowLabels[forecast.window] || forecast.window}
          </span>
          <span
            className="px-3 py-1 rounded-md text-xs font-black uppercase"
            style={{ backgroundColor: `${overallColor}20`, color: overallColor }}
          >
            SPX PRESSURE {overallPressure}
          </span>
        </div>
        <span className="text-sm text-white/35">{generatedTime} CT</span>
      </div>

      <div className="px-7 py-6 border-b border-white/10">
        <p className="text-base text-white/78 leading-7 whitespace-pre-line">
          {forecast.analysis}
        </p>
      </div>

      <div className="px-7 py-6 border-b border-white/10">
        <h4 className="text-xs font-bold text-white/35 uppercase tracking-[0.2em] mb-4">
          Symbol Pressure Map
        </h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {forecast.symbolForecasts.map((sf) => {
            const pressure = spxPressureForSymbol(sf.symbol, sf.direction)
            const color = pressureColor(pressure)
            return (
              <div key={sf.symbol} className="rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-black text-white">{sf.symbol}</span>
                  <span className="text-sm font-black tabular-nums" style={{ color }}>
                    {pressure === 'UP' ? '▲' : '▼'} {sf.confidence}%
                  </span>
                </div>
                <div className="mt-1 text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
                  S&P 500 Pressure {pressure}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div className="px-7 py-6 border-b border-white/10 grid grid-cols-1 lg:grid-cols-3 gap-7">
        <div>
          <h4 className="text-xs font-bold text-white/35 uppercase tracking-[0.2em] mb-3">Support</h4>
          <div className="space-y-1.5">
            {forecast.keyLevels.support.map((level, i) => (
              <div key={i} className="text-lg font-black text-[#26a69a] tabular-nums">
                {level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </div>
            ))}
            {forecast.keyLevels.support.length === 0 && (
              <div className="text-sm text-white/35">No support levels</div>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold text-white/35 uppercase tracking-[0.2em] mb-3">Resistance</h4>
          <div className="space-y-1.5">
            {forecast.keyLevels.resistance.map((level, i) => (
              <div key={i} className="text-lg font-black text-[#ef5350] tabular-nums">
                {level.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </div>
            ))}
            {forecast.keyLevels.resistance.length === 0 && (
              <div className="text-sm text-white/35">No resistance levels</div>
            )}
          </div>
        </div>

        <div>
          <h4 className="text-xs font-bold text-white/35 uppercase tracking-[0.2em] mb-3">Measured Moves</h4>
          <div className="space-y-2">
            {forecast.measuredMoves.map((mm, i) => (
              <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <div className="text-xs text-white/55">
                  Entry <span className="tabular-nums text-white/85">{mm.entry.toFixed(2)}</span> · Stop{' '}
                  <span className="tabular-nums text-white/85">{mm.stop.toFixed(2)}</span> · Target{' '}
                  <span className="tabular-nums text-white/85">{mm.target.toFixed(2)}</span>
                </div>
              </div>
            ))}
            {forecast.measuredMoves.length === 0 && (
              <div className="text-sm text-white/35">No active measured move</div>
            )}
          </div>
        </div>
      </div>

      {forecast.intermarketNotes.length > 0 && (
        <div className="px-7 py-5 border-b border-white/10">
          <h4 className="text-xs font-bold text-white/35 uppercase tracking-[0.2em] mb-3">Intermarket</h4>
          <div className="flex flex-wrap gap-2.5">
            {forecast.intermarketNotes.map((note, i) => (
              <span
                key={i}
                className="px-3 py-1 rounded-md text-xs font-semibold text-white/65 bg-white/[0.04] border border-white/10"
              >
                {note}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="px-7 py-3 bg-white/[0.02]">
        <p className="text-[11px] text-white/30">
          Real-time deterministic signals drive symbol pressure, support/resistance, and measured moves.
          AI is used for concise narrative only.
        </p>
      </div>
    </div>
  )
}
