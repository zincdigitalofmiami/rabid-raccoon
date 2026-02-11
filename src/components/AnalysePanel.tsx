'use client'

import { useState } from 'react'
import { InstantAnalysisResult, TimeframeGauge, InstantSymbolResult } from '@/lib/instant-analysis'
import TechChart from './TechChart'

const INDEX_NAMES: Record<string, string> = {
  MES: 'S&P 500 E-mini',
  NQ: 'Nasdaq 100',
  YM: 'Dow Jones',
  RTY: 'Russell 2000',
  VX: 'VIX',
  DX: 'US Dollar Index',
  GC: 'Gold',
  CL: 'Crude Oil',
  US10Y: 'US 10-Year Yield',
  ZN: '10-Year T-Note',
  ZB: '30-Year T-Bond',
}

interface AnalysePanelProps {
  onResult?: (result: InstantAnalysisResult) => void
}

export default function AnalysePanel({ onResult }: AnalysePanelProps) {
  const [loading, setLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [result, setResult] = useState<InstantAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedGauge, setExpandedGauge] = useState<string | null>(null)

  async function handleAnalyse() {
    setLoading(true)
    setAiLoading(false)
    setError(null)
    try {
      // Step 1: deterministic-only analysis (always available if data is available)
      const detRes = await fetch('/api/analyse/deterministic', { method: 'POST' })
      if (!detRes.ok) {
        const err = await detRes.json().catch(() => ({ error: detRes.statusText }))
        throw new Error(err.error || `HTTP ${detRes.status}`)
      }
      const deterministic: InstantAnalysisResult = await detRes.json()
      setResult(deterministic)
      onResult?.(deterministic)

      setLoading(false)
      setAiLoading(true)

      // Step 2: AI overlay (narrative + levels). If this fails, keep deterministic output.
      try {
        const aiRes = await fetch('/api/analyse/ai', { method: 'POST' })
        if (!aiRes.ok) {
          const err = await aiRes.json().catch(() => ({ error: aiRes.statusText }))
          throw new Error(err.error || `HTTP ${aiRes.status}`)
        }

        const aiOverlay: Pick<
          InstantAnalysisResult,
          'timestamp' | 'overallVerdict' | 'overallConfidence' | 'narrative' | 'timeframeGauges' | 'symbols'
        > = await aiRes.json()

        const merged: InstantAnalysisResult = {
          ...deterministic,
          timestamp: aiOverlay.timestamp || deterministic.timestamp,
          overallVerdict: aiOverlay.overallVerdict || deterministic.overallVerdict,
          overallConfidence: aiOverlay.overallConfidence || deterministic.overallConfidence,
          narrative: aiOverlay.narrative || deterministic.narrative,
          timeframeGauges: aiOverlay.timeframeGauges?.length
            ? aiOverlay.timeframeGauges
            : deterministic.timeframeGauges,
          symbols: aiOverlay.symbols?.length ? aiOverlay.symbols : deterministic.symbols,
        }

        setResult(merged)
        onResult?.(merged)
      } catch (aiErr) {
        const msg = aiErr instanceof Error ? aiErr.message : 'AI overlay failed'
        setError(`Deterministic analysis loaded. AI overlay unavailable: ${msg}`)
      } finally {
        setAiLoading(false)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
      setLoading(false)
      setAiLoading(false)
    }
  }

  const gauge15m = result?.timeframeGauges.find(g => g.timeframe === '15M')

  return (
    <div className="space-y-6">
      {/* Analyse Button */}
      <button
        onClick={handleAnalyse}
        disabled={loading || aiLoading}
        className="w-full relative overflow-hidden rounded-2xl border-2 py-5 px-6 text-lg font-black uppercase tracking-wider transition-all duration-300 disabled:opacity-50"
        style={{
          borderColor: loading || aiLoading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.15)',
          background: loading || aiLoading
            ? 'linear-gradient(135deg, #131722, #1e222d)'
            : 'linear-gradient(135deg, #131722, #1a1f2e)',
          color: loading || aiLoading ? 'rgba(255,255,255,0.3)' : '#fff',
        }}
      >
        {loading || aiLoading ? (
          <span className="flex items-center justify-center gap-3">
            <span className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
            {loading
              ? 'Computing deterministic signals...'
              : 'Adding AI narrative and trade levels...'}
          </span>
        ) : (
          <span className="flex items-center justify-center gap-2">
            <span className="text-2xl">&#9889;</span>
            {result ? 'Re-analyse Now' : 'Analyse Now'}
          </span>
        )}
      </button>

      {error && (
        <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {result && (
        <>
          {/* 3 Timeframe Gauges */}
          {result.timeframeGauges.length > 0 && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {result.timeframeGauges.map((gauge) => (
                <GaugeCard
                  key={gauge.timeframe}
                  gauge={gauge}
                  expanded={expandedGauge === gauge.timeframe}
                  onToggle={() =>
                    setExpandedGauge(
                      expandedGauge === gauge.timeframe ? null : gauge.timeframe
                    )
                  }
                />
              ))}
            </div>
          )}

          {/* FULL WIDTH CHART */}
          {result.chartData && result.chartData.candles.length > 3 && (
            <TechChart
              candles={result.chartData.candles}
              fibLevels={result.chartData.fibLevels}
              swingHighs={result.chartData.swingHighs}
              swingLows={result.chartData.swingLows}
              measuredMoves={result.chartData.measuredMoves}
              entry={gauge15m?.entry || 0}
              stop={gauge15m?.stop || 0}
              target={gauge15m?.target || 0}
            />
          )}

          {/* Narrative — concise */}
          <div className="rounded-xl border border-white/5 bg-[#131722] p-5">
            <p className="text-sm text-white/60 leading-relaxed">{result.narrative}</p>
          </div>

          {/* Market Context Row */}
          {result.marketContext && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Regime + Commodities */}
              <div className="space-y-4">
                <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
                  <div className="px-5 py-3 border-b border-white/5 flex items-center gap-3">
                    <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Market Regime</h3>
                    <RegimeBadge regime={result.marketContext.regime} />
                  </div>
                  <div className="p-5 space-y-1.5">
                    {result.marketContext.regimeFactors.map((factor, i) => (
                      <div key={i} className="flex items-start gap-2">
                        <span className="text-white/15 mt-0.5">&bull;</span>
                        <span className="text-xs text-white/50">{factor}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {result.marketContext.breakout7000 && (
                  <Breakout7000Card breakout={result.marketContext.breakout7000} />
                )}

                {(result.marketContext.goldContext || result.marketContext.oilContext) && (
                  <div className="rounded-xl border border-white/5 bg-[#131722] p-5 space-y-3">
                    {result.marketContext.goldContext && (
                      <CommodityRow label="GOLD" price={result.marketContext.goldContext.price} changePercent={result.marketContext.goldContext.changePercent} signal={result.marketContext.goldContext.signal} />
                    )}
                    {result.marketContext.oilContext && (
                      <CommodityRow label="OIL" price={result.marketContext.oilContext.price} changePercent={result.marketContext.oilContext.changePercent} signal={result.marketContext.oilContext.signal} />
                    )}
                  </div>
                )}

                {result.marketContext.yieldContext && (
                  <div className="rounded-xl border border-white/5 bg-[#131722] p-5 space-y-2">
                    <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Rates</h3>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40">US10Y</span>
                      <span className="text-sm font-black text-white">
                        {result.marketContext.yieldContext.tenYearYield.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40">1D Change</span>
                      <span
                        className="text-xs font-black"
                        style={{ color: result.marketContext.yieldContext.tenYearChangeBp >= 0 ? '#ef5350' : '#26a69a' }}
                      >
                        {result.marketContext.yieldContext.tenYearChangeBp >= 0 ? '+' : ''}
                        {result.marketContext.yieldContext.tenYearChangeBp.toFixed(1)} bp
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40">Fed Funds</span>
                      <span className="text-xs text-white/70">
                        {result.marketContext.yieldContext.fedFundsRate == null
                          ? 'n/a'
                          : `${result.marketContext.yieldContext.fedFundsRate.toFixed(2)}%`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-white/40">10Y - Fed</span>
                      <span className="text-xs text-white/70">
                        {result.marketContext.yieldContext.spread10yMinusFedBp == null
                          ? 'n/a'
                          : `${result.marketContext.yieldContext.spread10yMinusFedBp.toFixed(1)} bp`}
                      </span>
                    </div>
                    <p className="text-[11px] text-white/35">{result.marketContext.yieldContext.signal}</p>
                  </div>
                )}
              </div>

              {/* Correlations + Headlines */}
              <div className="space-y-4">
                {result.marketContext.correlations.length > 0 && (
                  <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
                    <div className="px-5 py-3 border-b border-white/5">
                      <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Cross-Asset Correlations</h3>
                    </div>
                    <div className="p-5 space-y-3">
                      {result.marketContext.correlations.map((c, i) => (
                        <CorrelationRow key={i} pair={c.pair} value={c.value} interpretation={c.interpretation} />
                      ))}
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
                  <div className="px-5 py-3 border-b border-white/5">
                    <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">News Theme Scores</h3>
                  </div>
                  <div className="p-5 space-y-2">
                    <ThemeScoreRow label="Tariffs" value={result.marketContext.themeScores.tariffs} />
                    <ThemeScoreRow label="Rates" value={result.marketContext.themeScores.rates} />
                    <ThemeScoreRow label="Trump Policy" value={result.marketContext.themeScores.trump} />
                    <ThemeScoreRow label="Analyst Tone" value={result.marketContext.themeScores.analysts} />
                    <ThemeScoreRow label="AI/Tech" value={result.marketContext.themeScores.aiTech} />
                    <ThemeScoreRow label="Event Risk" value={result.marketContext.themeScores.eventRisk} />
                  </div>
                </div>

                <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
                  <div className="px-5 py-3 border-b border-white/5">
                    <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Shock Reactions</h3>
                  </div>
                  <div className="p-5 space-y-2">
                    <ShockRow
                      label="VIX > +8%"
                      sample={result.marketContext.shockReactions.vixSpikeSample}
                      avg={result.marketContext.shockReactions.vixSpikeAvgNextDayMesPct}
                      med={result.marketContext.shockReactions.vixSpikeMedianNextDayMesPct}
                    />
                    <ShockRow
                      label="US10Y > +8bp"
                      sample={result.marketContext.shockReactions.yieldSpikeSample}
                      avg={result.marketContext.shockReactions.yieldSpikeAvgNextDayMesPct}
                      med={result.marketContext.shockReactions.yieldSpikeMedianNextDayMesPct}
                    />
                  </div>
                </div>

                {result.marketContext.techLeaders.length > 0 && (
                  <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
                    <div className="px-5 py-3 border-b border-white/5">
                      <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Top AI/Tech Breadth</h3>
                    </div>
                    <div className="p-5 space-y-2">
                      {result.marketContext.techLeaders.map((leader) => (
                        <TechLeaderRow
                          key={leader.symbol}
                          symbol={leader.symbol}
                          dayChangePercent={leader.dayChangePercent}
                          weekChangePercent={leader.weekChangePercent}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {result.marketContext.headlines.length > 0 && (
                  <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
                    <div className="px-5 py-3 border-b border-white/5">
                      <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Headlines</h3>
                    </div>
                    <div className="p-5 space-y-1.5">
                      {result.marketContext.headlines.slice(0, 6).map((h, i) => (
                        <span key={i} className="block text-xs text-white/40">{h}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Per-Symbol Detail — real index names */}
          {result.symbols.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {result.symbols.map((sym) => (
                <SymbolDetail key={sym.symbol} data={sym} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── REGIME BADGE ────────────────────────────────────────────

function RegimeBadge({ regime }: { regime: string }) {
  const colors: Record<string, { bg: string; text: string; border: string }> = {
    'RISK-ON': { bg: '#26a69a15', text: '#26a69a', border: '#26a69a30' },
    'RISK-OFF': { bg: '#ef535015', text: '#ef5350', border: '#ef535030' },
    'MIXED': { bg: '#ffa72615', text: '#ffa726', border: '#ffa72630' },
  }
  const c = colors[regime] || colors['MIXED']
  return (
    <span className="px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider" style={{ backgroundColor: c.bg, color: c.text, border: `1px solid ${c.border}` }}>
      {regime}
    </span>
  )
}

// ─── COMMODITY ROW ───────────────────────────────────────────

function CommodityRow({ label, price, changePercent, signal }: { label: string; price: number; changePercent: number; signal: string }) {
  const isUp = changePercent >= 0
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="text-sm font-black text-white">{label}</span>
        <span className="text-sm font-bold tabular-nums text-white/70">{price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        <span className="text-xs font-bold tabular-nums" style={{ color: isUp ? '#26a69a' : '#ef5350' }}>{isUp ? '+' : ''}{changePercent.toFixed(2)}%</span>
      </div>
      <span className="text-[10px] text-white/30 max-w-[150px] text-right">{signal}</span>
    </div>
  )
}

// ─── CORRELATION ROW ─────────────────────────────────────────

function CorrelationRow({ pair, value, interpretation }: { pair: string; value: number; interpretation: string }) {
  const barColor = value > 0 ? '#26a69a' : '#ef5350'
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-bold text-white/50">{pair}</span>
        <span className="text-xs font-black tabular-nums" style={{ color: barColor }}>{value > 0 ? '+' : ''}{value.toFixed(3)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-white/5 overflow-hidden mb-1">
        <div className="h-full rounded-full" style={{ width: `${Math.abs(value) * 100}%`, backgroundColor: barColor }} />
      </div>
      <span className="text-[10px] text-white/25">{interpretation}</span>
    </div>
  )
}

function ThemeScoreRow({ label, value }: { label: string; value: number }) {
  const positive = value >= 0
  const color = positive ? '#26a69a' : '#ef5350'
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-white/45">{label}</span>
      <span className="text-xs font-black tabular-nums" style={{ color }}>
        {positive ? '+' : ''}{value}
      </span>
    </div>
  )
}

function ShockRow({
  label,
  sample,
  avg,
  med,
}: {
  label: string
  sample: number
  avg: number | null
  med: number | null
}) {
  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02] p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/45">{label}</span>
        <span className="text-[11px] text-white/60">n={sample}</span>
      </div>
      <div className="mt-1 text-[11px] text-white/40">
        avg next MES: {avg == null ? 'n/a' : `${avg >= 0 ? '+' : ''}${avg.toFixed(2)}%`} | median: {med == null ? 'n/a' : `${med >= 0 ? '+' : ''}${med.toFixed(2)}%`}
      </div>
    </div>
  )
}

function TechLeaderRow({
  symbol,
  dayChangePercent,
  weekChangePercent,
}: {
  symbol: string
  dayChangePercent: number
  weekChangePercent: number
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs font-bold text-white/50">{symbol}</span>
      <span
        className="text-[11px] font-black tabular-nums"
        style={{ color: dayChangePercent >= 0 ? '#26a69a' : '#ef5350' }}
      >
        {dayChangePercent >= 0 ? '+' : ''}{dayChangePercent.toFixed(2)}% 1D
      </span>
      <span
        className="text-[11px] font-black tabular-nums"
        style={{ color: weekChangePercent >= 0 ? '#26a69a' : '#ef5350' }}
      >
        {weekChangePercent >= 0 ? '+' : ''}{weekChangePercent.toFixed(2)}% 1W
      </span>
    </div>
  )
}

function Breakout7000Card({
  breakout,
}: {
  breakout: {
    level: number
    status:
      | 'CONFIRMED_BREAKOUT'
      | 'UNCONFIRMED_BREAKOUT'
      | 'REJECTED_AT_LEVEL'
      | 'TESTING_7000'
      | 'BELOW_7000'
    latestClose: number
    latestHigh: number
    distanceFromLevel: number
    lastTwoCloses: [number, number]
    closesAboveLevelLast2: number
    closesBelowLevelLast2: number
    consecutiveClosesAboveLevel: number
    consecutiveClosesBelowLevel: number
    twoCloseConfirmation: boolean
    signal: string
    tradePlan: string
  }
}) {
  const statusColor: Record<typeof breakout.status, string> = {
    CONFIRMED_BREAKOUT: '#26a69a',
    UNCONFIRMED_BREAKOUT: '#ffa726',
    REJECTED_AT_LEVEL: '#ef5350',
    TESTING_7000: '#90a4ae',
    BELOW_7000: '#78909c',
  }
  const color = statusColor[breakout.status]

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
      <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
        <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">7,000 Detector</h3>
        <span
          className="px-2 py-1 rounded-md text-[10px] font-black uppercase tracking-wider"
          style={{ color, backgroundColor: `${color}20` }}
        >
          {breakout.status.replaceAll('_', ' ')}
        </span>
      </div>

      <div className="p-5 space-y-3">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <span className="block text-white/30">Latest Close</span>
            <span className="font-black text-white">{breakout.latestClose.toFixed(2)}</span>
          </div>
          <div className="rounded-lg bg-white/[0.03] p-2.5">
            <span className="block text-white/30">Distance vs 7,000</span>
            <span className="font-black" style={{ color: breakout.distanceFromLevel >= 0 ? '#26a69a' : '#ef5350' }}>
              {breakout.distanceFromLevel >= 0 ? '+' : ''}{breakout.distanceFromLevel.toFixed(2)}
            </span>
          </div>
        </div>

        <div className="text-[11px] text-white/45">
          Last 2 closes: {breakout.lastTwoCloses[0].toFixed(2)} / {breakout.lastTwoCloses[1].toFixed(2)} | Above 7,000: {breakout.closesAboveLevelLast2}/2
        </div>
        <div className="text-[11px] text-white/45">
          Consecutive closes above 7,000: {breakout.consecutiveClosesAboveLevel} | Two-close confirmed: {breakout.twoCloseConfirmation ? 'YES' : 'NO'}
        </div>

        <p className="text-xs text-white/60">{breakout.signal}</p>
        <p className="text-xs text-white/40">{breakout.tradePlan}</p>
      </div>
    </div>
  )
}

// ─── GAUGE CARD ──────────────────────────────────────────────

function GaugeCard({ gauge, expanded, onToggle }: { gauge: TimeframeGauge; expanded: boolean; onToggle: () => void }) {
  const isBuy = gauge.direction === 'BUY'
  const color = isBuy ? '#26a69a' : '#ef5350'
  const totalVoting = gauge.buyCount + gauge.sellCount
  const buyPct = totalVoting > 0 ? (gauge.buyCount / totalVoting) * 100 : 50
  const sellPct = totalVoting > 0 ? (gauge.sellCount / totalVoting) * 100 : 50

  return (
    <div className="rounded-2xl border-2 overflow-hidden" style={{ borderColor: `${color}25`, background: `linear-gradient(180deg, ${color}06 0%, #0d1117 40%)` }}>
      <div className="h-1.5 w-full" style={{ backgroundColor: `${color}50` }} />
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-bold text-white/25 uppercase tracking-[0.2em]">{gauge.timeframe}</span>
          <span className="text-sm font-black tabular-nums" style={{ color: `${color}cc` }}>{gauge.confidence}%</span>
        </div>

        <div className="flex items-center gap-3 mb-5">
          <span className="text-5xl font-black leading-none" style={{ color }}>{isBuy ? '\u25B2' : '\u25BC'}</span>
          <span className="text-4xl font-black tracking-tight leading-none" style={{ color }}>{gauge.direction}</span>
        </div>

        <div className="mb-5">
          <div className="h-3 rounded-full bg-white/5 overflow-hidden flex mb-2">
            <div className="h-full bg-[#26a69a]" style={{ width: `${buyPct}%`, borderRadius: sellPct > 0 ? '9999px 0 0 9999px' : '9999px' }} />
            <div className="h-full bg-[#ef5350]" style={{ width: `${sellPct}%`, borderRadius: buyPct > 0 ? '0 9999px 9999px 0' : '9999px' }} />
          </div>
          <div className="flex justify-between text-[11px] font-bold tabular-nums">
            <span className="text-[#26a69a]">{gauge.buyCount} BUY</span>
            {gauge.neutralCount > 0 && <span className="text-white/15">{gauge.neutralCount} N</span>}
            <span className="text-[#ef5350]">{gauge.sellCount} SELL</span>
          </div>
        </div>

        {gauge.entry > 0 && (
          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="rounded-lg bg-white/[0.03] p-2.5 text-center">
              <span className="block text-[9px] text-white/25 uppercase tracking-wider mb-1">Entry</span>
              <span className="text-base font-black text-white tabular-nums">{gauge.entry.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div className="rounded-lg bg-[#ef5350]/[0.05] p-2.5 text-center">
              <span className="block text-[9px] text-[#ef5350]/50 uppercase tracking-wider mb-1">Stop</span>
              <span className="text-base font-black text-[#ef5350] tabular-nums">{gauge.stop.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
            <div className="rounded-lg bg-[#26a69a]/[0.05] p-2.5 text-center">
              <span className="block text-[9px] text-[#26a69a]/50 uppercase tracking-wider mb-1">Target</span>
              <span className="text-base font-black text-[#26a69a] tabular-nums">{gauge.target.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            </div>
          </div>
        )}

        {gauge.reasoning && (
          <div className="mb-4 p-3 rounded-lg border border-white/5 bg-white/[0.02]">
            <span className="block text-[9px] font-bold text-white/20 uppercase tracking-wider mb-1.5">Why</span>
            <p className="text-xs text-white/60 leading-relaxed">{gauge.reasoning}</p>
          </div>
        )}

        <button onClick={onToggle} className="w-full py-2 rounded-lg border border-white/5 text-[11px] font-bold text-white/25 uppercase tracking-wider hover:bg-white/[0.03] hover:text-white/40 transition-all">
          {expanded ? '\u25B2 Hide Signals' : `\u25BC Show ${gauge.totalSignals} Signals`}
        </button>
      </div>

      {expanded && (
        <div className="border-t border-white/5 px-5 py-4 space-y-4">
          <div>
            <h4 className="text-[10px] font-bold text-[#26a69a]/80 uppercase tracking-wider mb-2">Buy Signals ({gauge.buyCount})</h4>
            <div className="space-y-1">
              {gauge.buySignals.map((s, i) => (
                <div key={i} className="px-2.5 py-1 rounded text-[11px] font-medium bg-[#26a69a]/[0.06] text-[#26a69a]/90 border border-[#26a69a]/10">{s}</div>
              ))}
              {gauge.buySignals.length === 0 && <span className="text-[10px] text-white/15">None</span>}
            </div>
          </div>
          <div>
            <h4 className="text-[10px] font-bold text-[#ef5350]/80 uppercase tracking-wider mb-2">Sell Signals ({gauge.sellCount})</h4>
            <div className="space-y-1">
              {gauge.sellSignals.map((s, i) => (
                <div key={i} className="px-2.5 py-1 rounded text-[11px] font-medium bg-[#ef5350]/[0.06] text-[#ef5350]/90 border border-[#ef5350]/10">{s}</div>
              ))}
              {gauge.sellSignals.length === 0 && <span className="text-[10px] text-white/15">None</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── SYMBOL DETAIL ───────────────────────────────────────────

function SymbolDetail({ data }: { data: InstantSymbolResult }) {
  const inverseSymbols = new Set(['VX', 'DX', 'US10Y', 'ZN', 'ZB'])
  const isBuy = data.verdict === 'BUY'
  const pressureUp = inverseSymbols.has(data.symbol) ? !isBuy : isBuy
  const color = pressureUp ? '#26a69a' : '#ef5350'
  const name = INDEX_NAMES[data.symbol] || data.symbol

  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: `${color}15`, background: 'linear-gradient(180deg, #131722, #0d1117)' }}>
      <div className="h-[2px] w-full" style={{ background: `linear-gradient(90deg, transparent, ${color}40, transparent)` }} />
      <div className="p-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <span className="block text-lg font-black text-white">{name}</span>
            <span className="text-[10px] text-white/25 font-bold uppercase">{data.symbol}</span>
          </div>
          <div className="text-right">
            <span className="px-2.5 py-0.5 rounded-md text-xs font-black uppercase" style={{ backgroundColor: `${color}15`, color }}>
              SPX PRESSURE {pressureUp ? 'UP' : 'DOWN'}
            </span>
            <span className="block text-lg font-black tabular-nums mt-1" style={{ color }}>{data.confidence}%</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-3">
          <div>
            <span className="text-[10px] text-white/20 uppercase tracking-wider block">Entry</span>
            <span className="text-sm font-bold text-white tabular-nums">{data.entry.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[10px] text-white/20 uppercase tracking-wider block">Stop</span>
            <span className="text-sm font-bold text-[#ef5350] tabular-nums">{data.stop.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[10px] text-white/20 uppercase tracking-wider block">Target 1</span>
            <span className="text-sm font-bold text-[#26a69a] tabular-nums">{data.target1.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[10px] text-white/20 uppercase tracking-wider block">Target 2</span>
            <span className="text-sm font-bold text-[#26a69a] tabular-nums">{data.target2.toFixed(2)}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] text-white/20 uppercase">R:R</span>
          <span className="text-sm font-bold text-white tabular-nums">1:{data.riskReward.toFixed(1)}</span>
        </div>

        <p className="text-xs text-white/50 leading-relaxed">{data.reasoning}</p>

        {data.signalBreakdown.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
            {data.signalBreakdown.map((tf) => {
              const total = tf.buy + tf.sell
              const buyW = total > 0 ? (tf.buy / total) * 100 : 50
              const sellW = total > 0 ? (tf.sell / total) * 100 : 50
              return (
                <div key={tf.tf} className="flex items-center gap-2">
                  <span className="text-[10px] text-white/25 font-mono w-8 uppercase">{tf.tf}</span>
                  <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden flex">
                    <div className="h-full bg-[#26a69a]" style={{ width: `${buyW}%` }} />
                    <div className="h-full bg-[#ef5350]" style={{ width: `${sellW}%` }} />
                  </div>
                  <span className="text-[10px] text-white/20 tabular-nums w-16 text-right font-medium">{tf.buy}B/{tf.sell}S</span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
