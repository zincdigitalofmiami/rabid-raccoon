'use client'

import type { EnrichedSetup } from '@/hooks/useMesSetups'

interface RiskTileProps {
  leadSetup: EnrichedSetup | null
}

export default function RiskTile({ leadSetup }: RiskTileProps) {
  const risk = leadSetup?.risk

  if (!risk) {
    return (
      <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
        <div className="mb-3">
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Risk
          </span>
        </div>
        <div className="text-lg font-semibold text-white/20">--</div>
        <div className="text-xs text-white/20 mt-1">No active trade</div>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Risk
        </span>
        <span className="text-[10px] font-mono text-white/30">
          {risk.rr.toFixed(1)}R
        </span>
      </div>

      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-white/40">Contracts</span>
          <span className="text-white font-medium tabular-nums">{risk.contracts}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-white/40">Stop dist</span>
          <span className="text-white/70 font-mono tabular-nums">
            {risk.stopDistance.toFixed(2)} pts ({risk.stopTicks} ticks)
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-white/40">$ Risk</span>
          <span className="text-red-400/80 font-mono tabular-nums">
            ${risk.dollarRisk.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  )
}
