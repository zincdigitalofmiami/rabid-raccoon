'use client'

import { useState } from 'react'
import { InstantAnalysisResult, InstantSymbolResult } from '@/lib/instant-analysis'

export default function AnalysePanel() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<InstantAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleAnalyse() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/analyse', { method: 'POST' })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const data: InstantAnalysisResult = await res.json()
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setLoading(false)
    }
  }

  const isBuy = result?.overallVerdict === 'BUY'
  const accentColor = isBuy ? '#26a69a' : '#ef5350'

  return (
    <div className="space-y-5">
      {/* Analyse Button */}
      <button
        onClick={handleAnalyse}
        disabled={loading}
        className="w-full relative overflow-hidden rounded-2xl border-2 py-5 px-6 text-lg font-black uppercase tracking-wider transition-all duration-300 disabled:opacity-50"
        style={{
          borderColor: loading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.15)',
          background: loading
            ? 'linear-gradient(135deg, #131722, #1e222d)'
            : 'linear-gradient(135deg, #131722, #1a1f2e)',
          color: loading ? 'rgba(255,255,255,0.3)' : '#fff',
        }}
      >
        {loading ? (
          <span className="flex items-center justify-center gap-3">
            <span className="w-5 h-5 border-2 border-white/20 border-t-white/70 rounded-full animate-spin" />
            Analysing 200+ signals across 15M / 1H / 1D...
          </span>
        ) : (
          <span className="flex items-center justify-center gap-2">
            <span className="text-2xl">⚡</span>
            Analyse Charts Now
          </span>
        )}
      </button>

      {/* Error */}
      {error && (
        <div className="p-4 rounded-xl border border-red-500/20 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="space-y-5">
          {/* Verdict Banner */}
          <div
            className="rounded-2xl border-2 overflow-hidden"
            style={{
              borderColor: `${accentColor}30`,
              background: `linear-gradient(135deg, ${accentColor}08, transparent)`,
            }}
          >
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                  <span className="text-5xl font-black" style={{ color: accentColor }}>
                    {isBuy ? '▲' : '▼'}
                  </span>
                  <div>
                    <div className="text-3xl font-black tracking-tight" style={{ color: accentColor }}>
                      {result.overallVerdict}
                    </div>
                    <div className="text-sm text-white/30 font-medium">
                      {result.totalSignalsAnalysed} signals analysed
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-4xl font-black tabular-nums" style={{ color: accentColor }}>
                    {result.overallConfidence}%
                  </div>
                  <div className="text-xs text-white/20">confidence</div>
                </div>
              </div>

              {/* Narrative */}
              <p className="text-base text-white/80 leading-relaxed font-medium">
                {result.narrative}
              </p>
            </div>
          </div>

          {/* Symbol Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {result.symbols.map((sym) => (
              <SymbolCard key={sym.symbol} data={sym} />
            ))}
          </div>

          {/* Timestamp */}
          <div className="text-center">
            <span className="text-[10px] text-white/15">
              Generated {new Date(result.timestamp).toLocaleTimeString('en-US', {
                timeZone: 'America/Chicago',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                hour12: true,
              })} CT
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function SymbolCard({ data }: { data: InstantSymbolResult }) {
  const isBuy = data.verdict === 'BUY'
  const color = isBuy ? '#26a69a' : '#ef5350'

  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{
        borderColor: `${color}15`,
        background: 'linear-gradient(180deg, #131722, #0d1117)',
      }}
    >
      <div className="h-[2px] w-full" style={{ background: `linear-gradient(90deg, transparent, ${color}40, transparent)` }} />
      <div className="p-5">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl font-black text-white">{data.symbol}</span>
            <span
              className="px-2.5 py-0.5 rounded-md text-xs font-black uppercase"
              style={{ backgroundColor: `${color}15`, color }}
            >
              {data.verdict}
            </span>
          </div>
          <span className="text-lg font-black tabular-nums" style={{ color }}>
            {data.confidence}%
          </span>
        </div>

        {/* Levels */}
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
            <span className="text-[10px] text-white/20 uppercase tracking-wider block">Target 1 (15m)</span>
            <span className="text-sm font-bold text-[#26a69a] tabular-nums">{data.target1.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-[10px] text-white/20 uppercase tracking-wider block">Target 2 (1h)</span>
            <span className="text-sm font-bold text-[#26a69a] tabular-nums">{data.target2.toFixed(2)}</span>
          </div>
        </div>

        {/* Risk/Reward */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] text-white/20 uppercase">R:R</span>
          <span className="text-sm font-bold text-white tabular-nums">1:{data.riskReward.toFixed(1)}</span>
        </div>

        {/* Reasoning */}
        <p className="text-xs text-white/50 leading-relaxed">{data.reasoning}</p>

        {/* Signal breakdown bars */}
        {data.signalBreakdown.length > 0 && (
          <div className="mt-3 pt-3 border-t border-white/5 space-y-1.5">
            {data.signalBreakdown.map((tf) => {
              const total = tf.buy + tf.sell + tf.neutral
              const buyW = total > 0 ? (tf.buy / total) * 100 : 0
              const sellW = total > 0 ? (tf.sell / total) * 100 : 0
              return (
                <div key={tf.tf} className="flex items-center gap-2">
                  <span className="text-[10px] text-white/25 font-mono w-6">{tf.tf}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5 overflow-hidden flex">
                    <div className="h-full bg-[#26a69a]" style={{ width: `${buyW}%` }} />
                    <div className="h-full bg-white/10" style={{ width: `${100 - buyW - sellW}%` }} />
                    <div className="h-full bg-[#ef5350]" style={{ width: `${sellW}%` }} />
                  </div>
                  <span className="text-[9px] text-white/20 tabular-nums w-16 text-right">
                    {tf.buy}B {tf.sell}S
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
