'use client'

import { useEffect, useState } from 'react'
import type { EnrichedSetup, MesSetupsResponse } from '@/hooks/useMesSetups'

// ── ML prediction types (from predict.py v2 output) ──────────────────────────

interface MLPrediction {
  timestamp: string
  price: number | null
  prob_up_1h: number | null
  prob_up_4h: number | null
  prob_up_1d: number | null
  prob_up_1w: number | null
  direction_1h: string | null
  direction_4h: string | null
  direction_1d: string | null
  direction_1w: string | null
  confidence_1h: number | null
  confidence_4h: number | null
  confidence_1d: number | null
  confidence_1w: number | null
  model_agreement_1h: number | null
  model_agreement_4h: number | null
  model_agreement_1d: number | null
  model_agreement_1w: number | null
  calibrated?: boolean
  cal_methods?: Record<string, string>
}

interface MLForecastData {
  latest: MLPrediction
  meta: {
    folds_loaded: Record<string, number>
    calibrated?: Record<string, boolean>
    generated_at: string
  }
  stale: boolean
  age_minutes: number
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface MLForecastTileProps {
  setupsData?: MesSetupsResponse | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'text-emerald-400 bg-emerald-400/10'
    case 'B': return 'text-blue-400 bg-blue-400/10'
    case 'C': return 'text-amber-400 bg-amber-400/10'
    default: return 'text-white/30 bg-white/5'
  }
}

function ProbBar({ value, label, color }: { value: number; label: string; color: string }) {
  const pct = Math.min(100, Math.max(0, value * 100))
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-white/30 w-10 shrink-0">{label}</span>
      <div className="flex-1 h-2 rounded-full bg-white/5 relative overflow-hidden">
        <div
          className="absolute top-0 left-0 h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.7 }}
        />
      </div>
      <span className="text-[10px] font-mono w-10 text-right" style={{ color }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  )
}

function DirectionBadge({ direction, prob, label }: { direction: string | null; prob: number | null; label: string }) {
  if (!direction || prob == null) return null
  const isBull = direction === 'BULLISH'
  const pct = (prob * 100).toFixed(0)
  return (
    <div className="flex items-center gap-1">
      <span className="text-white/30">{label}</span>
      <span className={isBull ? 'text-emerald-400/60' : 'text-red-400/60'}>
        {isBull ? '\u25B2' : '\u25BC'}
        {' '}{pct}%
      </span>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MLForecastTile({ setupsData }: MLForecastTileProps) {
  const [mlData, setMlData] = useState<MLForecastData | null>(null)

  useEffect(() => {
    let cancelled = false
    async function fetchForecast() {
      try {
        const res = await fetch('/api/ml-forecast?rows=1')
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) setMlData(json)
      } catch { /* ML predictions optional */ }
    }
    fetchForecast()
    const interval = setInterval(fetchForecast, 5 * 60 * 1000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const leadSetup: EnrichedSetup | null = setupsData?.setups?.find(
    (s) => s.phase === 'TRIGGERED'
  ) ?? null

  const fibResult = setupsData?.fibResult ?? null
  const currentPrice = setupsData?.currentPrice ?? null
  const hasSetup = leadSetup != null
  const hasML = mlData?.latest != null && !mlData.stale

  if (!hasSetup && !hasML) {
    return (
      <div className="rounded-xl border border-white/5 bg-[#131722] p-4 col-span-2">
        <div className="mb-3">
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Forecast
          </span>
        </div>
        <div className="text-sm text-white/20">No active setups or ML predictions</div>
      </div>
    )
  }

  const grade = leadSetup?.risk?.grade ?? '--'
  const rr = leadSetup?.risk?.rr ?? 0
  const direction = leadSetup?.direction ?? (mlData?.latest?.direction_4h === 'BULLISH' ? 'BULLISH' : mlData?.latest?.direction_1d === 'BULLISH' ? 'BULLISH' : 'BEARISH')
  const isBull = direction === 'BULLISH'

  const fibStrength = fibResult ? (fibResult.levels.length > 7 ? 'STRONG' : 'MODERATE') : null

  const pTp1 = leadSetup?.pTp1 ?? (rr >= 2.5 ? 0.65 : rr >= 1.8 ? 0.55 : rr >= 1.2 ? 0.42 : 0.30)
  const pTp2 = leadSetup?.pTp2 ?? (rr >= 2.5 ? 0.45 : rr >= 1.8 ? 0.35 : rr >= 1.2 ? 0.22 : 0.12)

  // ML directional alignment — check short-term horizons (1h + 4h)
  const mlAligned = mlData?.latest
    ? (isBull && (mlData.latest.direction_1h === 'BULLISH' || mlData.latest.direction_4h === 'BULLISH')) ||
      (!isBull && (mlData.latest.direction_1h === 'BEARISH' || mlData.latest.direction_4h === 'BEARISH'))
    : null

  const isCalibrated = mlData?.latest?.calibrated === true

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] p-4 col-span-2">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Forecast
          </span>
          {hasSetup && (
            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${gradeColor(grade)}`}>
              {grade}
            </span>
          )}
          {fibStrength && (
            <span className="text-[8px] font-mono text-white/15">
              FIB {fibStrength}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {hasML && mlAligned != null && (
            <span className={`text-[8px] font-mono ${mlAligned ? 'text-emerald-400/50' : 'text-red-400/50'}`}>
              ML {mlAligned ? '\u2713' : '\u2717'}
            </span>
          )}
          {isCalibrated && (
            <span className="text-[8px] font-mono text-blue-400/30">CAL</span>
          )}
          {hasML && (
            <span className="text-[8px] font-mono text-white/15">
              {mlData!.age_minutes < 60 ? `${mlData!.age_minutes}m` : `${Math.round(mlData!.age_minutes / 60)}h`}
            </span>
          )}
        </div>
      </div>

      {/* Direction + R:R */}
      <div className="flex items-center gap-3 mb-3">
        <span className={`text-lg font-bold ${isBull ? 'text-emerald-400' : 'text-red-400'}`}>
          {isBull ? '\u25B2' : '\u25BC'} {direction}
        </span>
        {hasSetup && rr > 0 && (
          <span className="text-xs text-white/40 font-mono">
            R:R {rr.toFixed(1)}
          </span>
        )}
        {hasSetup && leadSetup?.goType && (
          <span className="text-[10px] text-white/20 font-mono">
            {leadSetup.goType} @ .{leadSetup.fibRatio === 0.5 ? '500' : '618'}
          </span>
        )}
      </div>

      {/* Win Rate Bars */}
      {hasSetup && (
        <div className="space-y-1.5 mb-3">
          <ProbBar
            value={pTp1}
            label="P(TP1)"
            color={isBull ? '#26a69a' : '#ef5350'}
          />
          <ProbBar
            value={pTp2}
            label="P(TP2)"
            color={isBull ? '#22ab94' : '#f23645'}
          />
        </div>
      )}

      {/* Price Levels */}
      {hasSetup && leadSetup?.entry != null && (
        <div className="grid grid-cols-4 gap-2 text-[10px] font-mono mb-2">
          <div>
            <span className="text-white/25 block">Entry</span>
            <span className="text-blue-400">{leadSetup.entry.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-white/25 block">SL</span>
            <span className="text-red-400">{leadSetup.stopLoss?.toFixed(2) ?? '--'}</span>
          </div>
          <div>
            <span className="text-white/25 block">TP1</span>
            <span className="text-emerald-400">{leadSetup.tp1?.toFixed(2) ?? '--'}</span>
          </div>
          <div>
            <span className="text-white/25 block">TP2</span>
            <span className="text-emerald-400">{leadSetup.tp2?.toFixed(2) ?? '--'}</span>
          </div>
        </div>
      )}

      {/* ML Directional Probability — all 4 horizons */}
      {hasML && mlData?.latest && (
        <div className="border-t border-white/5 pt-2 mt-1">
          <div className="flex items-center gap-3 text-[10px] flex-wrap">
            <span className="text-white/20">ML</span>
            <DirectionBadge
              direction={mlData.latest.direction_1h}
              prob={mlData.latest.prob_up_1h}
              label="1H"
            />
            <DirectionBadge
              direction={mlData.latest.direction_4h}
              prob={mlData.latest.prob_up_4h}
              label="4H"
            />
            <DirectionBadge
              direction={mlData.latest.direction_1d}
              prob={mlData.latest.prob_up_1d}
              label="1D"
            />
            <DirectionBadge
              direction={mlData.latest.direction_1w}
              prob={mlData.latest.prob_up_1w}
              label="1W"
            />
            {mlData.latest.model_agreement_1h != null && mlData.latest.model_agreement_1h >= 0.8 && (
              <span className="text-amber-400/40 text-[8px]">high agreement</span>
            )}
          </div>
        </div>
      )}

      {/* Source attribution */}
      <div className="mt-2 text-[8px] text-white/10">
        {hasSetup ? 'BHG engine · Fib confluence · Risk-graded' : `AutoGluon ensemble${isCalibrated ? ' · Calibrated' : ''}`}
        {currentPrice != null && <span className="ml-2">@ {currentPrice.toFixed(2)}</span>}
      </div>
    </div>
  )
}
