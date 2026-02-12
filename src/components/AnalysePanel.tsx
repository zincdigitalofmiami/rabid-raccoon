'use client'

import { useState } from 'react'
import type { InstantAnalysisResult } from '@/lib/instant-analysis'
import type { MarketContext } from '@/lib/market-context'

// ─── Chart Analysis Types ───────────────────────────────────

interface PatternResult {
  name: string
  type: string
  bias: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  keyLevels: number[]
  description: string
}

interface TimeframeAnalysis {
  tf: '15M' | '1H' | '4H'
  patterns: PatternResult[]
  bias: 'bullish' | 'bearish' | 'neutral'
  summary: string
}

interface ChartAnalysisResult {
  timeframes: TimeframeAnalysis[]
  overallBias: 'bullish' | 'bearish' | 'neutral'
  overallSummary: string
}

// ─── Trades Types ───────────────────────────────────────────

interface TradeCard {
  direction: 'BULLISH' | 'BEARISH'
  timeframe: '15M' | '1H'
  entry: number
  stop: number
  target: number
  quality: number
  status: string
  retracementRatio: number
  pointA: number
  pointB: number
  pointC: number
  projectedD: number
  riskReward: number
}

interface TradesResult {
  currentTrade: TradeCard | null
  upcoming15m: TradeCard[]
  upcoming1h: TradeCard[]
}

// ─── Props ──────────────────────────────────────────────────

interface AnalysePanelProps {
  onResult?: (result: InstantAnalysisResult) => void
  onCaptureChart?: () => string | null
}

type ActiveTab = 'chart' | 'market' | 'trades' | null

export default function AnalysePanel({ onResult, onCaptureChart }: AnalysePanelProps) {
  // Chart analysis state
  const [chartLoading, setChartLoading] = useState(false)
  const [chartResult, setChartResult] = useState<ChartAnalysisResult | null>(null)
  const [chartError, setChartError] = useState<string | null>(null)

  // Market analysis state
  const [marketLoading, setMarketLoading] = useState(false)
  const [marketResult, setMarketResult] = useState<MarketContext | null>(null)
  const [marketError, setMarketError] = useState<string | null>(null)

  // Trades state
  const [tradesLoading, setTradesLoading] = useState(false)
  const [tradesResult, setTradesResult] = useState<TradesResult | null>(null)
  const [tradesError, setTradesError] = useState<string | null>(null)

  const [activeTab, setActiveTab] = useState<ActiveTab>(null)

  // ─── Handlers ───────────────────────────────────────────────

  async function handleAnalyzeChart() {
    setChartLoading(true)
    setChartError(null)
    setActiveTab('chart')
    try {
      const image = onCaptureChart?.()
      if (!image) throw new Error('Chart screenshot not available. Ensure the chart has loaded.')

      const res = await fetch('/api/analyse/chart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data: ChartAnalysisResult = await res.json()
      setChartResult(data)
    } catch (err) {
      setChartError(err instanceof Error ? err.message : 'Chart analysis failed')
    } finally {
      setChartLoading(false)
    }
  }

  async function handleAnalyzeMarket() {
    setMarketLoading(true)
    setMarketError(null)
    setActiveTab('market')
    try {
      const res = await fetch('/api/analyse/market', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data: MarketContext = await res.json()
      setMarketResult(data)
    } catch (err) {
      setMarketError(err instanceof Error ? err.message : 'Market analysis failed')
    } finally {
      setMarketLoading(false)
    }
  }

  async function handleUpcomingTrades() {
    setTradesLoading(true)
    setTradesError(null)
    setActiveTab('trades')
    try {
      const res = await fetch('/api/analyse/trades', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data: TradesResult = await res.json()
      setTradesResult(data)
    } catch (err) {
      setTradesError(err instanceof Error ? err.message : 'Trade analysis failed')
    } finally {
      setTradesLoading(false)
    }
  }

  const anyLoading = chartLoading || marketLoading || tradesLoading

  return (
    <div className="space-y-4">
      {/* 3-Button Row */}
      <div className="grid grid-cols-3 gap-3">
        <AnalyseButton
          label="Analyze Chart"
          sublabel="Claude Opus 4.6 Vision"
          loading={chartLoading}
          active={activeTab === 'chart'}
          hasResult={!!chartResult}
          disabled={anyLoading}
          onClick={handleAnalyzeChart}
          color="#2962ff"
        />
        <AnalyseButton
          label="Analyze Market"
          sublabel="Macro + Micro + News"
          loading={marketLoading}
          active={activeTab === 'market'}
          hasResult={!!marketResult}
          disabled={anyLoading}
          onClick={handleAnalyzeMarket}
          color="#ffa726"
        />
        <AnalyseButton
          label="Upcoming Trades"
          sublabel="AB=CD Measured Moves"
          loading={tradesLoading}
          active={activeTab === 'trades'}
          hasResult={!!tradesResult}
          disabled={anyLoading}
          onClick={handleUpcomingTrades}
          color="#26a69a"
        />
      </div>

      {/* Result Panels */}
      {activeTab === 'chart' && (
        <>
          {chartError && <ErrorBanner message={chartError} />}
          {chartLoading && <LoadingBar text="Analyzing chart with Claude Opus 4.6..." />}
          {chartResult && <ChartResultPanel result={chartResult} />}
        </>
      )}

      {activeTab === 'market' && (
        <>
          {marketError && <ErrorBanner message={marketError} />}
          {marketLoading && <LoadingBar text="Loading market context..." />}
          {marketResult && <MarketResultPanel ctx={marketResult} />}
        </>
      )}

      {activeTab === 'trades' && (
        <>
          {tradesError && <ErrorBanner message={tradesError} />}
          {tradesLoading && <LoadingBar text="Scanning for measured move entries..." />}
          {tradesResult && <TradesResultPanel result={tradesResult} />}
        </>
      )}
    </div>
  )
}

// ─── ANALYSE BUTTON ─────────────────────────────────────────

function AnalyseButton({
  label,
  sublabel,
  loading,
  active,
  hasResult,
  disabled,
  onClick,
  color,
}: {
  label: string
  sublabel: string
  loading: boolean
  active: boolean
  hasResult: boolean
  disabled: boolean
  onClick: () => void
  color: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="relative overflow-hidden rounded-xl border-2 py-4 px-4 text-left transition-all duration-300 disabled:opacity-40 hover:brightness-110"
      style={{
        borderColor: active ? `${color}60` : 'rgba(255,255,255,0.08)',
        background: active
          ? `linear-gradient(135deg, ${color}12, #131722)`
          : 'linear-gradient(135deg, #131722, #1a1f2e)',
      }}
    >
      {active && (
        <div
          className="absolute top-0 left-0 right-0 h-[2px]"
          style={{ backgroundColor: color }}
        />
      )}
      <div className="flex items-center gap-3">
        {loading ? (
          <div
            className="w-4 h-4 border-2 rounded-full animate-spin flex-shrink-0"
            style={{ borderColor: `${color}30`, borderTopColor: color }}
          />
        ) : (
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: hasResult ? color : 'rgba(255,255,255,0.15)' }}
          />
        )}
        <div>
          <span className="block text-sm font-bold text-white">{label}</span>
          <span className="block text-[10px] text-white/30">{sublabel}</span>
        </div>
      </div>
    </button>
  )
}

// ─── SHARED COMPONENTS ──────────────────────────────────────

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5">
      <p className="text-sm text-red-400">{message}</p>
    </div>
  )
}

function LoadingBar({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-white/5 bg-[#131722]">
      <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
      <span className="text-sm text-white/40">{text}</span>
    </div>
  )
}

// ─── CHART RESULT PANEL ─────────────────────────────────────

function ChartResultPanel({ result }: { result: ChartAnalysisResult }) {
  const biasColor = result.overallBias === 'bullish' ? '#26a69a' : result.overallBias === 'bearish' ? '#ef5350' : '#ffa726'

  return (
    <div className="space-y-4">
      {/* Overall */}
      <div className="rounded-xl border border-white/5 bg-[#131722] p-5">
        <div className="flex items-center gap-3 mb-2">
          <span className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Overall Bias</span>
          <span
            className="px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider"
            style={{ backgroundColor: `${biasColor}15`, color: biasColor, border: `1px solid ${biasColor}30` }}
          >
            {result.overallBias}
          </span>
        </div>
        <p className="text-sm text-white/60 leading-relaxed">{result.overallSummary}</p>
      </div>

      {/* Per-Timeframe Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {result.timeframes.map((tf) => (
          <TimeframePatternCard key={tf.tf} analysis={tf} />
        ))}
      </div>
    </div>
  )
}

function TimeframePatternCard({ analysis }: { analysis: TimeframeAnalysis }) {
  const biasColor = analysis.bias === 'bullish' ? '#26a69a' : analysis.bias === 'bearish' ? '#ef5350' : '#ffa726'
  const typeColors: Record<string, string> = {
    reversal: '#ef5350',
    continuation: '#26a69a',
    triangle: '#2962ff',
    line_break: '#ffa726',
    channel: '#9c27b0',
    other: '#78909c',
  }

  return (
    <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
      <div className="h-1 w-full" style={{ backgroundColor: `${biasColor}50` }} />
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-bold text-white/25 uppercase tracking-[0.2em]">{analysis.tf}</span>
          <span
            className="text-xs font-black uppercase"
            style={{ color: biasColor }}
          >
            {analysis.bias}
          </span>
        </div>

        <p className="text-xs text-white/50 mb-3 leading-relaxed">{analysis.summary}</p>

        {analysis.patterns.length === 0 ? (
          <span className="text-[10px] text-white/20">No patterns detected</span>
        ) : (
          <div className="space-y-2">
            {analysis.patterns.map((p, i) => {
              const pColor = typeColors[p.type] || typeColors.other
              const pBiasColor = p.bias === 'bullish' ? '#26a69a' : p.bias === 'bearish' ? '#ef5350' : '#ffa726'
              return (
                <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
                        style={{ backgroundColor: `${pColor}20`, color: pColor }}
                      >
                        {p.type.replace('_', ' ')}
                      </span>
                      <span className="text-xs font-bold text-white/70">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[10px] font-bold uppercase"
                        style={{ color: pBiasColor }}
                      >
                        {p.bias}
                      </span>
                      <span className="text-[10px] text-white/30 tabular-nums">{p.confidence}%</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-white/40 leading-relaxed">{p.description}</p>
                  {p.keyLevels.length > 0 && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="text-[9px] text-white/20 uppercase">Levels:</span>
                      {p.keyLevels.map((lvl, j) => (
                        <span key={j} className="text-[10px] font-mono text-white/50 tabular-nums">{lvl.toFixed(2)}</span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── MARKET RESULT PANEL ────────────────────────────────────

function MarketResultPanel({ ctx }: { ctx: MarketContext }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Left Column */}
      <div className="space-y-4">
        <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
          <div className="px-5 py-3 border-b border-white/5 flex items-center gap-3">
            <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Market Regime</h3>
            <RegimeBadge regime={ctx.regime} />
          </div>
          <div className="p-5 space-y-1.5">
            {ctx.regimeFactors.map((factor, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="text-white/15 mt-0.5">&bull;</span>
                <span className="text-xs text-white/50">{factor}</span>
              </div>
            ))}
          </div>
        </div>

        {ctx.breakout7000 && <Breakout7000Card breakout={ctx.breakout7000} />}

        {(ctx.goldContext || ctx.oilContext) && (
          <div className="rounded-xl border border-white/5 bg-[#131722] p-5 space-y-3">
            {ctx.goldContext && (
              <CommodityRow label="GOLD" price={ctx.goldContext.price} changePercent={ctx.goldContext.changePercent} signal={ctx.goldContext.signal} />
            )}
            {ctx.oilContext && (
              <CommodityRow label="OIL" price={ctx.oilContext.price} changePercent={ctx.oilContext.changePercent} signal={ctx.oilContext.signal} />
            )}
          </div>
        )}

        {ctx.yieldContext && (
          <div className="rounded-xl border border-white/5 bg-[#131722] p-5 space-y-2">
            <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Rates</h3>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">US10Y</span>
              <span className="text-sm font-black text-white">
                {ctx.yieldContext.tenYearYield.toFixed(2)}%
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">1D Change</span>
              <span
                className="text-xs font-black"
                style={{ color: ctx.yieldContext.tenYearChangeBp >= 0 ? '#ef5350' : '#26a69a' }}
              >
                {ctx.yieldContext.tenYearChangeBp >= 0 ? '+' : ''}
                {ctx.yieldContext.tenYearChangeBp.toFixed(1)} bp
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">Fed Funds</span>
              <span className="text-xs text-white/70">
                {ctx.yieldContext.fedFundsRate == null
                  ? 'n/a'
                  : `${ctx.yieldContext.fedFundsRate.toFixed(2)}%`}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-white/40">10Y - Fed</span>
              <span className="text-xs text-white/70">
                {ctx.yieldContext.spread10yMinusFedBp == null
                  ? 'n/a'
                  : `${ctx.yieldContext.spread10yMinusFedBp.toFixed(1)} bp`}
              </span>
            </div>
            <p className="text-[11px] text-white/35">{ctx.yieldContext.signal}</p>
          </div>
        )}
      </div>

      {/* Right Column */}
      <div className="space-y-4">
        {ctx.correlations.length > 0 && (
          <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
            <div className="px-5 py-3 border-b border-white/5">
              <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Cross-Asset Correlations</h3>
            </div>
            <div className="p-5 space-y-3">
              {ctx.correlations.map((c, i) => (
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
            <ThemeScoreRow label="Tariffs" value={ctx.themeScores.tariffs} />
            <ThemeScoreRow label="Rates" value={ctx.themeScores.rates} />
            <ThemeScoreRow label="Trump Policy" value={ctx.themeScores.trump} />
            <ThemeScoreRow label="Analyst Tone" value={ctx.themeScores.analysts} />
            <ThemeScoreRow label="AI/Tech" value={ctx.themeScores.aiTech} />
            <ThemeScoreRow label="Event Risk" value={ctx.themeScores.eventRisk} />
          </div>
        </div>

        <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
          <div className="px-5 py-3 border-b border-white/5">
            <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Shock Reactions</h3>
          </div>
          <div className="p-5 space-y-2">
            <ShockRow
              label="VIX > +8%"
              sample={ctx.shockReactions.vixSpikeSample}
              avg={ctx.shockReactions.vixSpikeAvgNextDayMesPct}
              med={ctx.shockReactions.vixSpikeMedianNextDayMesPct}
            />
            <ShockRow
              label="US10Y > +8bp"
              sample={ctx.shockReactions.yieldSpikeSample}
              avg={ctx.shockReactions.yieldSpikeAvgNextDayMesPct}
              med={ctx.shockReactions.yieldSpikeMedianNextDayMesPct}
            />
          </div>
        </div>

        {ctx.techLeaders.length > 0 && (
          <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
            <div className="px-5 py-3 border-b border-white/5">
              <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Top AI/Tech Breadth</h3>
            </div>
            <div className="p-5 space-y-2">
              {ctx.techLeaders.map((leader) => (
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

        {ctx.headlines.length > 0 && (
          <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
            <div className="px-5 py-3 border-b border-white/5">
              <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Headlines</h3>
            </div>
            <div className="p-5 space-y-1.5">
              {ctx.headlines.slice(0, 6).map((h, i) => (
                <span key={i} className="block text-xs text-white/40">{h}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── TRADES RESULT PANEL ────────────────────────────────────

function TradesResultPanel({ result }: { result: TradesResult }) {
  return (
    <div className="space-y-4">
      {/* Current Active Trade */}
      {result.currentTrade ? (
        <div className="rounded-xl border-2 overflow-hidden" style={{
          borderColor: result.currentTrade.direction === 'BULLISH' ? '#26a69a40' : '#ef535040',
          background: `linear-gradient(135deg, ${result.currentTrade.direction === 'BULLISH' ? '#26a69a' : '#ef5350'}08, #131722)`,
        }}>
          <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">Active Trade</h3>
              <span className="px-2 py-0.5 rounded text-[10px] font-bold text-white/50 bg-white/5">
                {result.currentTrade.timeframe}
              </span>
            </div>
            <DirectionBadge direction={result.currentTrade.direction} />
          </div>
          <div className="p-5">
            <TradeCardContent card={result.currentTrade} />
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-white/5 bg-[#131722] p-5 text-center">
          <span className="text-sm text-white/25">No active trades</span>
        </div>
      )}

      {/* 15M Upcoming */}
      <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">15M Entries</h3>
          <span className="text-[10px] text-white/20">{result.upcoming15m.length} forming</span>
        </div>
        {result.upcoming15m.length === 0 ? (
          <div className="p-5 text-center">
            <span className="text-xs text-white/20">No 15m entries forming</span>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {result.upcoming15m.map((card, i) => (
              <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
                <TradeCardContent card={card} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 1H Upcoming */}
      <div className="rounded-xl border border-white/5 bg-[#131722] overflow-hidden">
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <h3 className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">1H Entries</h3>
          <span className="text-[10px] text-white/20">{result.upcoming1h.length} forming</span>
        </div>
        {result.upcoming1h.length === 0 ? (
          <div className="p-5 text-center">
            <span className="text-xs text-white/20">No 1h entries forming</span>
          </div>
        ) : (
          <div className="p-4 space-y-3">
            {result.upcoming1h.map((card, i) => (
              <div key={i} className="rounded-lg border border-white/5 bg-white/[0.02] p-4">
                <TradeCardContent card={card} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DirectionBadge({ direction }: { direction: 'BULLISH' | 'BEARISH' }) {
  const color = direction === 'BULLISH' ? '#26a69a' : '#ef5350'
  const arrow = direction === 'BULLISH' ? '\u25B2' : '\u25BC'
  return (
    <span
      className="px-2.5 py-1 rounded-lg text-xs font-black uppercase tracking-wider flex items-center gap-1.5"
      style={{ backgroundColor: `${color}15`, color, border: `1px solid ${color}30` }}
    >
      {arrow} {direction}
    </span>
  )
}

function TradeCardContent({ card }: { card: TradeCard }) {
  const color = card.direction === 'BULLISH' ? '#26a69a' : '#ef5350'
  const qualityColor = card.quality >= 80 ? '#26a69a' : card.quality >= 60 ? '#ffa726' : '#ef5350'

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <DirectionBadge direction={card.direction} />
        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="block text-[9px] text-white/25 uppercase">Quality</span>
            <span className="text-lg font-black tabular-nums" style={{ color: qualityColor }}>
              {card.quality}
            </span>
          </div>
          <div className="text-right">
            <span className="block text-[9px] text-white/25 uppercase">R:R</span>
            <span className="text-lg font-black text-white tabular-nums">
              1:{card.riskReward}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <div className="rounded-lg bg-white/[0.03] p-2.5 text-center">
          <span className="block text-[9px] text-white/25 uppercase tracking-wider mb-1">Entry</span>
          <span className="text-base font-black text-white tabular-nums">{card.entry.toFixed(2)}</span>
        </div>
        <div className="rounded-lg bg-[#ef5350]/[0.05] p-2.5 text-center">
          <span className="block text-[9px] text-[#ef5350]/50 uppercase tracking-wider mb-1">Stop</span>
          <span className="text-base font-black text-[#ef5350] tabular-nums">{card.stop.toFixed(2)}</span>
        </div>
        <div className="rounded-lg bg-[#26a69a]/[0.05] p-2.5 text-center">
          <span className="block text-[9px] text-[#26a69a]/50 uppercase tracking-wider mb-1">Target</span>
          <span className="text-base font-black text-[#26a69a] tabular-nums">{card.target.toFixed(2)}</span>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="rounded-lg bg-white/[0.02] p-2">
          <span className="block text-[9px] text-white/20 uppercase">A</span>
          <span className="font-bold text-white/60 tabular-nums">{card.pointA.toFixed(2)}</span>
        </div>
        <div className="rounded-lg bg-white/[0.02] p-2">
          <span className="block text-[9px] text-white/20 uppercase">B</span>
          <span className="font-bold text-white/60 tabular-nums">{card.pointB.toFixed(2)}</span>
        </div>
        <div className="rounded-lg bg-white/[0.02] p-2">
          <span className="block text-[9px] text-white/20 uppercase">C</span>
          <span className="font-bold text-white/60 tabular-nums">{card.pointC.toFixed(2)}</span>
        </div>
        <div className="rounded-lg bg-white/[0.02] p-2">
          <span className="block text-[9px] text-white/20 uppercase">D (proj)</span>
          <span className="font-bold tabular-nums" style={{ color }}>{card.projectedD.toFixed(2)}</span>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-4 text-[11px] text-white/30">
        <span>Retrace: {(card.retracementRatio * 100).toFixed(1)}%</span>
        <span>{card.timeframe}</span>
        <span className="uppercase">{card.status}</span>
      </div>
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
