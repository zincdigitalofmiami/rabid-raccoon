'use client'

import type { EnrichedSetup } from '@/hooks/useMesSetups'

interface SignalTileProps {
  leadSetup: EnrichedSetup | null
}

export default function SignalTile({ leadSetup }: SignalTileProps) {
  if (!leadSetup) {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5 flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60 mb-4">
          Signal
        </span>
        <div className="text-2xl font-bold font-mono text-white/10 mb-2">——</div>
        <div className="text-xs text-white/20">No active trigger</div>
      </div>
    )
  }

  const grade = leadSetup.risk?.grade ?? '--'
  const isBullish = leadSetup.direction === 'BULLISH'

  const gradeColors: Record<string, string> = {
    A: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20',
    B: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
    C: 'text-amber-400 bg-amber-400/10 border-amber-400/20',
    D: 'text-white/30 bg-white/5 border-white/10',
  }

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60">
          Signal
        </span>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded border font-mono ${
            gradeColors[grade] ?? 'text-white/30 bg-white/5 border-white/10'
          }`}
        >
          {grade}
        </span>
      </div>

      <div
        className={`text-2xl font-bold mb-4 ${isBullish ? 'text-emerald-400' : 'text-red-400'}`}
      >
        {isBullish ? '▲' : '▼'} {leadSetup.direction}
      </div>

      <div className="space-y-2.5 mt-auto">
        {(
          [
            { label: 'P(TP1)', value: leadSetup.pTp1 },
            { label: 'P(TP2)', value: leadSetup.pTp2 },
          ] as { label: string; value: number | null | undefined }[]
        ).map(({ label, value }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-[10px] text-white/30 w-12 font-mono">{label}</span>
            <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${isBullish ? 'bg-emerald-500/70' : 'bg-red-500/70'}`}
                style={{ width: `${((value ?? 0) * 100).toFixed(0)}%` }}
              />
            </div>
            <span className="text-xs font-mono text-white/60 w-9 text-right tabular-nums">
              {value != null ? `${(value * 100).toFixed(0)}%` : '--'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
