'use client'

import { useEffect, useState } from 'react'
import type { EnrichedSetup, MesSetupsResponse } from '@/hooks/useMesSetups'

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

interface MLForecastTileProps {
  setupsData?: MesSetupsResponse | null
}

function gradeColor(grade: string): string {
  switch (grade) {
    case 'A': return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20'
    case 'B': return 'text-blue-400 bg-blue-400/10 border-blue-400/20'
    case 'C': return 'text-amber-400 bg-amber-400/10 border-amber-400/20'
    default: return 'text-white/30 bg-white/5 border-white/10'
  }
}

function HorizonBar({
  label,
  prob,
  direction,
  isBull,
}: {
  label: string
  prob: number | null
  direction: string | null
  isBull: boolean
}) {
  const pct = prob != null ? Math.min(100, Math.max(0, prob * 100)) : null
  const barColor = direction === 'BULLISH' ? '#34d399' : direction === 'BEARISH' ? '#f87171' : '#4b5563'

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-white/35">{label}</span>
        <span
          className={`text-sm font-bold font-mono tabular-nums ${
            direction === 'BULLISH' ? 'text-emerald-400' : direction === 'BEARISH' ? 'text-red-400' : 'text-white/20'
          }`}
        >
          {pct != null ? `${pct.toFixed(0)}%` : '—'}
        </span>
      </div>
      <div className="h-2 bg-white/[0.05] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: pct != null ? `${pct}%` : '0%', backgroundColor: barColor, opacity: 0.75 }}
        />
      </div>
    </div>
  )
}

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

  const leadSetup: EnrichedSetup | null =
    setupsData?.setups?.find((s) => s.phase === 'TRIGGERED') ?? null
  const fibResult = setupsData?.fibResult ?? null
  const currentPrice = setupsData?.currentPrice ?? null
  const hasSetup = leadSetup != null
  const hasML = mlData?.latest != null && !mlData.stale

  if (!hasSetup && !hasML) {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60">
          Forecast
        </span>
        <div className="mt-3 text-sm text-white/20">No active setups or ML predictions</div>
      </div>
    )
  }

  const grade = leadSetup?.risk?.grade ?? '--'
  const rr = leadSetup?.risk?.rr ?? 0
  const direction =
    leadSetup?.direction ??
    (mlData?.latest?.direction_4h === 'BULLISH' ? 'BULLISH' :
     mlData?.latest?.direction_1d === 'BULLISH' ? 'BULLISH' : 'BEARISH')
  const isBull = direction === 'BULLISH'

  const fibStrength = fibResult
    ? fibResult.levels.length > 7 ? 'STRONG' : 'MODERATE'
    : null

  const pTp1 =
    leadSetup?.pTp1 ??
    (rr >= 2.5 ? 0.65 : rr >= 1.8 ? 0.55 : rr >= 1.2 ? 0.42 : 0.30)
  const pTp2 =
    leadSetup?.pTp2 ??
    (rr >= 2.5 ? 0.45 : rr >= 1.8 ? 0.35 : rr >= 1.2 ? 0.22 : 0.12)

  const mlAligned = mlData?.latest
    ? (isBull &&
        (mlData.latest.direction_1h === 'BULLISH' ||
          mlData.latest.direction_4h === 'BULLISH')) ||
      (!isBull &&
        (mlData.latest.direction_1h === 'BEARISH' ||
          mlData.latest.direction_4h === 'BEARISH'))
    : null

  const isCalibrated = mlData?.latest?.calibrated === true

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5">
      {/* ── Header ─────────────────────────────── */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60">
            Forecast
          </span>
          {hasSetup && (
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded border font-mono ${gradeColor(grade)}`}>
              {grade}
            </span>
          )}
          {fibStrength && (
            <span className="text-[10px] font-mono text-white/15">
              FIB {fibStrength}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {hasML && mlAligned != null && (
            <span className={`text-xs font-mono ${mlAligned ? 'text-emerald-400/60' : 'text-red-400/60'}`}>
              ML {mlAligned ? '✓' : '✗'}
            </span>
          )}
          {isCalibrated && (
            <span className="text-[10px] font-mono text-blue-400/40">CAL</span>
          )}
          {hasML && (
            <span className="text-[10px] font-mono text-white/20">
              {mlData!.age_minutes < 60
                ? `${mlData!.age_minutes}m ago`
                : `${Math.round(mlData!.age_minutes / 60)}h ago`}
            </span>
          )}
        </div>
      </div>

      {/* ── Two-column layout ──────────────────── */}
      <div className="grid grid-cols-2 gap-6">
        {/* Left: direction + price levels */}
        <div className="flex flex-col gap-4">
          <div className={`text-2xl font-bold ${isBull ? 'text-emerald-400' : 'text-red-400'}`}>
            {isBull ? '▲' : '▼'} {direction}
          </div>

          {hasSetup && rr > 0 && (
            <div className="text-sm font-mono text-amber-400/80 tabular-nums">
              R:R {rr.toFixed(1)}×
            </div>
          )}

          {hasSetup && leadSetup?.entry != null && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
              <div>
                <div className="text-white/25 text-[10px] mb-0.5">Entry</div>
                <div className="text-blue-400 tabular-nums">{leadSetup.entry.toFixed(2)}</div>
              </div>
              <div>
                <div className="text-white/25 text-[10px] mb-0.5">SL</div>
                <div className="text-red-400 tabular-nums">{leadSetup.stopLoss?.toFixed(2) ?? '--'}</div>
              </div>
              <div>
                <div className="text-white/25 text-[10px] mb-0.5">TP1</div>
                <div className="text-emerald-400 tabular-nums">{leadSetup.tp1?.toFixed(2) ?? '--'}</div>
              </div>
              <div>
                <div className="text-white/25 text-[10px] mb-0.5">TP2</div>
                <div className="text-emerald-400/70 tabular-nums">{leadSetup.tp2?.toFixed(2) ?? '--'}</div>
              </div>
            </div>
          )}
        </div>

        {/* Right: horizon bars */}
        <div className="flex flex-col gap-3">
          {hasSetup && (
            <>
              <HorizonBar label="P(TP1)" prob={pTp1} direction={direction} isBull={isBull} />
              <HorizonBar label="P(TP2)" prob={pTp2} direction={direction} isBull={isBull} />
            </>
          )}
          {hasML && mlData?.latest && (
            <>
              <HorizonBar label="1H" prob={mlData.latest.prob_up_1h} direction={mlData.latest.direction_1h} isBull={isBull} />
              <HorizonBar label="4H" prob={mlData.latest.prob_up_4h} direction={mlData.latest.direction_4h} isBull={isBull} />
              <HorizonBar label="1D" prob={mlData.latest.prob_up_1d} direction={mlData.latest.direction_1d} isBull={isBull} />
              <HorizonBar label="1W" prob={mlData.latest.prob_up_1w} direction={mlData.latest.direction_1w} isBull={isBull} />
            </>
          )}
        </div>
      </div>

      {/* ── Footer ────────────────────────────── */}
      <div className="mt-4 pt-3 border-t border-white/[0.05] text-[10px] font-mono text-white/15 flex justify-between">
        <span>
          {hasSetup
            ? 'BHG · Fib confluence · Risk-graded'
            : `AutoGluon ensemble${isCalibrated ? ' · Calibrated' : ''}`}
        </span>
        {currentPrice != null && (
          <span className="tabular-nums">@ {currentPrice.toFixed(2)}</span>
        )}
      </div>
    </div>
  )
}
