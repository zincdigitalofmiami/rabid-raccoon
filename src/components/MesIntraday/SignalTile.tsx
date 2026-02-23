'use client'

import type { EnrichedSetup } from '@/hooks/useMesSetups'

interface SignalTileProps {
  leadSetup: EnrichedSetup | null
}

export default function SignalTile({ leadSetup }: SignalTileProps) {
  if (!leadSetup) {
    return (
      <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
        <div className="mb-3">
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Signal
          </span>
        </div>
        <div className="text-lg font-semibold text-white/20">--</div>
        <div className="text-xs text-white/20 mt-1">No active TRIGGER signal</div>
      </div>
    )
  }

  const grade = leadSetup.risk?.grade ?? '--'
  const isBullish = leadSetup.direction === 'BULLISH'

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Signal
        </span>
        <span
          className={`text-xs font-bold px-2 py-0.5 rounded ${
            grade === 'A'
              ? 'text-emerald-400 bg-emerald-400/10'
              : grade === 'B'
                ? 'text-blue-400 bg-blue-400/10'
                : grade === 'C'
                  ? 'text-amber-400 bg-amber-400/10'
                  : 'text-white/30 bg-white/5'
          }`}
        >
          {grade}
        </span>
      </div>

      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-lg font-bold ${
            isBullish ? 'text-emerald-400' : 'text-red-400'
          }`}
        >
          {isBullish ? '▲' : '▼'} {leadSetup.direction}
        </span>
      </div>

      <div className="flex gap-3 text-xs">
        <div>
          <span className="text-white/30">p(TP1) </span>
          <span className="text-white/60 font-mono">
            {leadSetup.pTp1 != null ? `${(leadSetup.pTp1 * 100).toFixed(0)}%` : '--'}
          </span>
        </div>
        <div>
          <span className="text-white/30">p(TP2) </span>
          <span className="text-white/60 font-mono">
            {leadSetup.pTp2 != null ? `${(leadSetup.pTp2 * 100).toFixed(0)}%` : '--'}
          </span>
        </div>
      </div>

      <div className="mt-2 text-[10px] text-white/20">
        {leadSetup.goType} TRIGGER @ .{leadSetup.fibRatio === 0.5 ? '500' : '618'}
      </div>
    </div>
  )
}
