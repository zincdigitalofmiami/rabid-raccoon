'use client'

import type { EnrichedSetup } from '@/hooks/useMesSetups'

interface RiskTileProps {
  leadSetup: EnrichedSetup | null
}

export default function RiskTile({ leadSetup }: RiskTileProps) {
  const risk = leadSetup?.risk

  if (!risk) {
    return (
      <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5 flex flex-col">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60 mb-4">
          Risk
        </span>
        <div className="text-2xl font-bold font-mono text-white/10 mb-2">——</div>
        <div className="text-xs text-white/20">No active trade</div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5 flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60">
          Risk
        </span>
        <span className="text-[10px] font-mono text-white/25">
          {risk.contracts}c
        </span>
      </div>

      {/* R:R — hero number */}
      <div className="text-3xl font-bold font-mono tabular-nums text-amber-400 mb-1 tracking-tight">
        {risk.rr.toFixed(1)}×
      </div>
      <div className="text-[11px] font-mono text-white/25 mb-5">reward/risk</div>

      <div className="space-y-2 mt-auto text-xs font-mono">
        <div className="flex justify-between">
          <span className="text-white/30">Stop</span>
          <span className="text-white/60 tabular-nums">
            {risk.stopDistance.toFixed(2)} pts
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-white/30">$ Risk</span>
          <span className="text-red-400 tabular-nums">${risk.dollarRisk.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}
