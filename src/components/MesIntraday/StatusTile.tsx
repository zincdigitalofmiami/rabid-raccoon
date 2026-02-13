'use client'

interface StatusTileProps {
  activeCount: { touched: number; hooked: number; goFired: number }
  currentPrice: number | null
}

export default function StatusTile({ activeCount, currentPrice }: StatusTileProps) {
  const total = activeCount.touched + activeCount.hooked + activeCount.goFired
  const hasActivity = total > 0

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Status
        </span>
        <span
          className={`w-2 h-2 rounded-full ${
            hasActivity ? 'bg-emerald-400 animate-pulse' : 'bg-white/10'
          }`}
        />
      </div>

      {currentPrice != null && (
        <div className="text-2xl font-semibold text-white mb-3 tabular-nums">
          {currentPrice.toFixed(2)}
        </div>
      )}

      <div className="flex gap-3 text-xs">
        {activeCount.goFired > 0 && (
          <span className="text-emerald-400 font-medium">
            {activeCount.goFired} GO
          </span>
        )}
        {activeCount.hooked > 0 && (
          <span className="text-amber-400">
            {activeCount.hooked} HOOK
          </span>
        )}
        {activeCount.touched > 0 && (
          <span className="text-white/40">
            {activeCount.touched} TOUCH
          </span>
        )}
        {total === 0 && (
          <span className="text-white/20">No active setups</span>
        )}
      </div>
    </div>
  )
}
