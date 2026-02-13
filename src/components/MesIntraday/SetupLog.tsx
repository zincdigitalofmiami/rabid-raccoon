'use client'

import type { EnrichedSetup } from '@/hooks/useMesSetups'

interface SetupLogProps {
  setups: EnrichedSetup[]
}

function formatTime(unixSeconds?: number): string {
  if (!unixSeconds) return '--'
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Chicago',
  })
}

function PhaseBadge({ phase }: { phase: string }) {
  const config: Record<string, { text: string; className: string }> = {
    GO_FIRED: { text: 'GO', className: 'text-emerald-400 bg-emerald-400/10' },
    HOOKED: { text: 'HOOK', className: 'text-amber-400 bg-amber-400/10' },
    TOUCHED: { text: 'TOUCH', className: 'text-white/40 bg-white/5' },
    EXPIRED: { text: 'EXPIRED', className: 'text-white/20 bg-white/5' },
    INVALIDATED: { text: 'INVALID', className: 'text-red-400/40 bg-red-400/5' },
  }
  const { text, className } = config[phase] ?? { text: phase, className: 'text-white/20 bg-white/5' }
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${className}`}>
      {text}
    </span>
  )
}

export default function SetupLog({ setups }: SetupLogProps) {
  // Show most relevant setups: GO_FIRED first, then HOOKED, then recent
  const sorted = [...setups].sort((a, b) => {
    const phaseOrder: Record<string, number> = {
      GO_FIRED: 0,
      HOOKED: 1,
      TOUCHED: 2,
      EXPIRED: 3,
      INVALIDATED: 4,
    }
    const pa = phaseOrder[a.phase] ?? 5
    const pb = phaseOrder[b.phase] ?? 5
    if (pa !== pb) return pa - pb
    return (b.goTime ?? b.createdAt) - (a.goTime ?? a.createdAt)
  })

  const display = sorted.slice(0, 20)

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] p-4 h-fit max-h-[600px] overflow-y-auto">
      <div className="flex items-center justify-between mb-4">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Setup Log
        </span>
        <span className="text-[10px] text-white/20">{setups.length} total</span>
      </div>

      {display.length === 0 ? (
        <div className="text-xs text-white/20 text-center py-8">
          No setups detected
        </div>
      ) : (
        <div className="space-y-2">
          {display.map((setup) => (
            <div
              key={setup.id}
              className="flex items-center gap-2 p-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.04] transition-colors"
            >
              {/* Direction arrow */}
              <span
                className={`text-sm ${
                  setup.direction === 'BULLISH' ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {setup.direction === 'BULLISH' ? '▲' : '▼'}
              </span>

              {/* Time */}
              <span className="text-[10px] font-mono text-white/30 w-10 shrink-0">
                {formatTime(setup.goTime ?? setup.hookTime ?? setup.touchTime)}
              </span>

              {/* Phase badge */}
              <PhaseBadge phase={setup.phase} />

              {/* Fib ratio */}
              <span className="text-[10px] font-mono text-white/30">
                .{setup.fibRatio === 0.5 ? '500' : '618'}
              </span>

              {/* Grade (only for GO) */}
              {setup.phase === 'GO_FIRED' && setup.risk && (
                <span
                  className={`text-[10px] font-bold ml-auto ${
                    setup.risk.grade === 'A'
                      ? 'text-emerald-400'
                      : setup.risk.grade === 'B'
                        ? 'text-blue-400'
                        : setup.risk.grade === 'C'
                          ? 'text-amber-400'
                          : 'text-white/30'
                  }`}
                >
                  {setup.risk.grade}
                </span>
              )}

              {/* Entry price for GO setups */}
              {setup.phase === 'GO_FIRED' && setup.entry && (
                <span className="text-[10px] font-mono text-white/40 ml-auto tabular-nums">
                  {setup.entry.toFixed(2)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
