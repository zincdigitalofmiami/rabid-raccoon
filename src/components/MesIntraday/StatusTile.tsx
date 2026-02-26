'use client'

interface StatusTileProps {
  activeCount: { touched: number; hooked: number; goFired: number }
  currentPrice: number | null
}

export default function StatusTile({ activeCount, currentPrice }: StatusTileProps) {
  const total = activeCount.touched + activeCount.hooked + activeCount.goFired
  const hasActivity = total > 0

  return (
    <div className="rounded-xl border border-white/[0.07] bg-[#0d1117] p-5 flex flex-col">
      {/* Label row */}
      <div className="flex items-center justify-between mb-4">
        <span className="text-[11px] font-mono uppercase tracking-widest text-amber-500/60">
          Status
        </span>
        <span
          className={`w-2 h-2 rounded-full ${
            hasActivity ? 'bg-emerald-400 animate-pulse' : 'bg-white/[0.12]'
          }`}
        />
      </div>

      {/* Price — big */}
      {currentPrice != null ? (
        <div className="text-3xl font-bold font-mono tabular-nums text-white mb-5 tracking-tight">
          {currentPrice.toFixed(2)}
        </div>
      ) : (
        <div className="text-3xl font-bold font-mono text-white/10 mb-5">——</div>
      )}

      {/* Phase badges */}
      <div className="flex gap-2 flex-wrap mt-auto">
        <span
          className={`text-xs font-mono px-2.5 py-1 rounded border ${
            activeCount.goFired > 0
              ? 'text-emerald-400 border-emerald-400/25 bg-emerald-400/[0.06]'
              : 'text-white/15 border-white/[0.06]'
          }`}
        >
          {activeCount.goFired} GO
        </span>
        <span
          className={`text-xs font-mono px-2.5 py-1 rounded border ${
            activeCount.hooked > 0
              ? 'text-amber-400 border-amber-400/25 bg-amber-400/[0.06]'
              : 'text-white/15 border-white/[0.06]'
          }`}
        >
          {activeCount.hooked} HOOK
        </span>
        <span
          className={`text-xs font-mono px-2.5 py-1 rounded border ${
            activeCount.touched > 0
              ? 'text-blue-400 border-blue-400/25 bg-blue-400/[0.06]'
              : 'text-white/15 border-white/[0.06]'
          }`}
        >
          {activeCount.touched} TOUCH
        </span>
      </div>
    </div>
  )
}
