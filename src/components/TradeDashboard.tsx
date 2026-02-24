'use client'

import { useRef, useMemo } from 'react'
import LiveMesChart, { LiveMesChartHandle } from './LiveMesChart'
import { useUpcomingTrades, ScoredTrade } from '@/hooks/useUpcomingTrades'
import { useMesSetups } from '@/hooks/useMesSetups'
import StatusTile from './MesIntraday/StatusTile'
import CorrelationTile from './MesIntraday/CorrelationTile'
import SignalTile from './MesIntraday/SignalTile'
import RiskTile from './MesIntraday/RiskTile'

// ─────────────────────────────────────────────
// Human-readable labels
// ─────────────────────────────────────────────

function setupLabel(goType: string | null | undefined, fibRatio: number): string {
  const fib = fibRatio <= 0.55 ? '50%' : '61.8%'
  if (goType === 'CLOSE') return `${fib} Bounce`
  return `${fib} Break`
}

function gradeLabel(grade: string): string {
  const labels: Record<string, string> = {
    A: 'Strong', B: 'Good', C: 'Fair', D: 'Weak',
  }
  return labels[grade] ?? grade
}

function eventPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    CLEAR: 'Clear Skies',
    APPROACHING: 'Event Approaching',
    IMMINENT: 'Event Imminent',
    BLACKOUT: 'Blackout Zone',
    DIGESTING: 'Digesting Data',
    SETTLED: 'Post-Event',
  }
  return labels[phase] ?? phase
}

// ─────────────────────────────────────────────
// Section Header (zinc-fusion yellow accent bar)
// ─────────────────────────────────────────────

function SectionHeader({ title, badge }: { title: string; badge?: string }) {
  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="flex items-center gap-3">
        <div className="w-1 h-6 bg-amber-500 rounded-full" />
        <h2 className="text-sm font-bold uppercase tracking-wider text-white/90">{title}</h2>
      </div>
      {badge && (
        <span className="text-[11px] font-semibold uppercase tracking-wider px-3 py-1 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
          {badge}
        </span>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// Trade Card — BIG, clean, zinc-fusion style
// ─────────────────────────────────────────────

function TradeCard({ trade }: { trade: ScoredTrade }) {
  const { setup, risk, score, reasoning } = trade
  const isBullish = setup.direction === 'BULLISH'

  const dirColor = isBullish ? 'text-emerald-400' : 'text-red-400'
  const dirBg = isBullish ? 'bg-emerald-400/10 border-emerald-400/20' : 'bg-red-400/10 border-red-400/20'

  const gradeColors: Record<string, string> = {
    A: 'text-emerald-400',
    B: 'text-blue-400',
    C: 'text-yellow-400',
    D: 'text-red-400',
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#131722] p-6 hover:border-white/[0.12] transition-colors">

      {/* Direction + Score header */}
      <div className="flex items-start justify-between mb-5">
        <div>
          <span className={`inline-flex items-center gap-2 px-3 py-1 rounded-lg border text-sm font-bold ${dirBg} ${dirColor}`}>
            {isBullish ? '▲' : '▼'} {setup.direction}
          </span>
          <div className="mt-2 text-white/40 text-sm">
            {setupLabel(setup.goType, setup.fibRatio)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-3xl font-bold text-white/90 tabular-nums">{score.composite}</div>
          <div className={`text-sm font-semibold ${gradeColors[score.grade] ?? 'text-white/50'}`}>
            {gradeLabel(score.grade)}
          </div>
        </div>
      </div>

      {/* Price Levels — big, clean grid */}
      <div className="grid grid-cols-4 gap-4 mb-5">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Entry</div>
          <div className="text-lg font-bold text-white/90 tabular-nums">{setup.entry?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Stop</div>
          <div className="text-lg font-bold text-red-400/80 tabular-nums">{setup.stopLoss?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Target 1</div>
          <div className="text-lg font-bold text-emerald-400/90 tabular-nums">{setup.tp1?.toFixed(2) ?? '—'}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Target 2</div>
          <div className="text-lg font-bold text-emerald-400/60 tabular-nums">{setup.tp2?.toFixed(2) ?? '—'}</div>
        </div>
      </div>

      {/* Probability + Risk bar */}
      <div className="flex items-center gap-6 py-4 border-t border-white/[0.06] mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Win Rate</div>
          <div className="text-xl font-bold text-emerald-400 tabular-nums">{(score.pTp1 * 100).toFixed(0)}%</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Extended</div>
          <div className="text-xl font-bold text-emerald-400/60 tabular-nums">{(score.pTp2 * 100).toFixed(0)}%</div>
        </div>
        {risk && (
          <>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Reward</div>
              <div className="text-xl font-bold text-white/80 tabular-nums">{risk.rr.toFixed(1)}x</div>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-white/30 mb-1">Risk</div>
              <div className="text-xl font-bold text-amber-400 tabular-nums">${risk.dollarRisk.toFixed(0)}</div>
            </div>
          </>
        )}
      </div>

      {/* AI Rationale */}
      {reasoning.rationale && reasoning.rationale !== 'No risk data' && (
        <div className="rounded-lg bg-white/[0.02] border border-white/[0.04] p-4">
          <div className="text-[11px] uppercase tracking-wider text-white/30 mb-2">Analysis</div>
          <p className="text-sm text-white/60 leading-relaxed">
            {reasoning.rationale}
          </p>
        </div>
      )}

      {/* Flags — only show meaningful ones */}
      {score.flags.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-4">
          {score.flags.map((flag, i) => (
            <span key={i} className="text-xs px-2.5 py-1 rounded-lg bg-white/[0.04] text-white/40 border border-white/[0.06]">
              {flag.replace(/_/g, ' ').replace(/--/g, ' ')}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────
// Event Phase Card
// ─────────────────────────────────────────────

function EventCard({ phase, label }: { phase: string; label: string }) {
  const colors: Record<string, { bg: string; text: string; border: string; dot: string }> = {
    CLEAR: { bg: 'bg-emerald-500/5', text: 'text-emerald-400', border: 'border-emerald-500/10', dot: 'bg-emerald-400' },
    APPROACHING: { bg: 'bg-yellow-500/5', text: 'text-yellow-400', border: 'border-yellow-500/10', dot: 'bg-yellow-400' },
    IMMINENT: { bg: 'bg-orange-500/5', text: 'text-orange-400', border: 'border-orange-500/10', dot: 'bg-orange-400' },
    BLACKOUT: { bg: 'bg-red-500/5', text: 'text-red-400', border: 'border-red-500/10', dot: 'bg-red-400' },
    DIGESTING: { bg: 'bg-blue-500/5', text: 'text-blue-400', border: 'border-blue-500/10', dot: 'bg-blue-400' },
    SETTLED: { bg: 'bg-white/[0.02]', text: 'text-white/50', border: 'border-white/[0.06]', dot: 'bg-white/40' },
  }

  const c = colors[phase] ?? colors.CLEAR

  return (
    <div className={`rounded-xl border ${c.border} ${c.bg} p-5`}>
      <div className="flex items-center gap-3 mb-2">
        <div className={`w-2.5 h-2.5 rounded-full ${c.dot}`} />
        <span className={`text-lg font-bold ${c.text}`}>{eventPhaseLabel(phase)}</span>
      </div>
      <p className="text-sm text-white/40 pl-[22px]">{label}</p>
    </div>
  )
}

// ─────────────────────────────────────────────
// Main Dashboard
// ─────────────────────────────────────────────

export default function TradeDashboard() {
  const chartRef = useRef<LiveMesChartHandle>(null)

  const { data: tradesData, loading: tradesLoading } = useUpcomingTrades(15_000)
  const { data: setupsData } = useMesSetups()

  const tradeCount = tradesData.trades.length
  const currentPrice = tradesData.currentPrice

  // Pressure card data (same pattern as MesIntradayDashboard)
  const leadSetup = useMemo(() => {
    if (!setupsData?.setups) return null
    return setupsData.setups.find((s) => s.phase === 'TRIGGERED') ?? null
  }, [setupsData])

  const activeCount = useMemo(() => {
    if (!setupsData?.setups) return { touched: 0, hooked: 0, goFired: 0 }
    const setups = setupsData.setups
    return {
      touched: setups.filter((s) => s.phase === 'CONTACT').length,
      hooked: setups.filter((s) => s.phase === 'CONFIRMED').length,
      goFired: setups.filter((s) => s.phase === 'TRIGGERED').length,
    }
  }, [setupsData])

  return (
    <div className="min-h-screen bg-[#0a0a0f]">

      {/* Chart — very top, flush under site header */}
      <div className="px-4 lg:px-6 pt-4">
        <div className="rounded-xl border border-white/[0.06] bg-[#131722] overflow-hidden">
          <LiveMesChart
            ref={chartRef}
            setups={setupsData?.setups}
            eventPhase={tradesData.eventContext?.phase}
            eventLabel={tradesData.eventContext?.label}
          />
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 lg:px-10 py-8">

        {/* Market Pressure Cards */}
        <div className="mb-8">
          <SectionHeader title="Market Pressure" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatusTile
              activeCount={activeCount}
              currentPrice={setupsData?.currentPrice ?? null}
            />
            <CorrelationTile />
            <SignalTile leadSetup={leadSetup} />
            <RiskTile leadSetup={leadSetup} />
          </div>
        </div>

        {/* Active Trades Section */}
        <div className="mb-10">
          <SectionHeader
            title="Active Trades"
            badge={tradeCount > 0 ? `${tradeCount} SETUP${tradeCount !== 1 ? 'S' : ''}` : undefined}
          />

          {tradesLoading && tradeCount === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-[#131722] p-12 text-center">
              <div className="text-lg text-white/30">Loading trades...</div>
            </div>
          ) : tradeCount === 0 ? (
            <div className="rounded-xl border border-white/[0.06] bg-[#131722] p-12 text-center">
              <div className="text-lg text-white/40 mb-2">No Active Setups</div>
              <p className="text-sm text-white/20">
                Waiting for price to trigger a fib level. Trades appear automatically.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {tradesData.trades.map((trade, i) => (
                <TradeCard key={trade.setup.id || i} trade={trade} />
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
