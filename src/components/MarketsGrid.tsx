'use client'

import MarketTile from './MarketTile'
import { MarketSummary } from '@/lib/types'
import { InstantAnalysisResult } from '@/lib/instant-analysis'

const INDEX_NAMES: Record<string, string> = {
  MES: 'S&P 500 E-mini',
  NQ: 'Nasdaq 100',
  YM: 'Dow Jones',
  RTY: 'Russell 2000',
  VX: 'VIX',
  DX: 'US Dollar Index',
  US10Y: 'US 10Y Yield',
  GC: 'Gold',
  CL: 'Crude Oil',
  ZN: '10-Year T-Note',
  ZB: '30-Year T-Bond',
}

interface MarketsGridProps {
  symbols: MarketSummary[]
  analysisResult?: InstantAnalysisResult | null
}

const SECTIONS = [
  {
    title: 'EQUITY FUTURES',
    keys: ['MES', 'NQ', 'YM', 'RTY'],
  },
  {
    title: 'COMMODITIES',
    keys: ['GC', 'CL'],
  },
  {
    title: 'MACRO',
    keys: ['VX', 'US10Y', 'ZN', 'ZB', 'DX'],
  },
]

export default function MarketsGrid({ symbols, analysisResult }: MarketsGridProps) {
  const symbolMap = new Map(symbols.map((s) => [s.symbol, s]))

  // Build a map of real analysis data per symbol
  const analysisMap = new Map<string, { verdict: string; confidence: number; reasoning: string; factors: string[] }>()
  if (analysisResult) {
    for (const sym of analysisResult.symbols) {
      analysisMap.set(sym.symbol, {
        verdict: sym.verdict,
        confidence: sym.confidence,
        reasoning: sym.reasoning,
        factors: sym.signalBreakdown.map(
          (b) => `${b.tf}: ${b.buy}B/${b.sell}S`
        ),
      })
    }
  }

  return (
    <div className="space-y-10">
      {SECTIONS.map((section) => {
        const sectionSymbols = section.keys
          .map((k) => symbolMap.get(k))
          .filter((s): s is MarketSummary => s != null)

        if (sectionSymbols.length === 0) return null

        return (
          <div key={section.title}>
            <h3 className="text-xs font-bold text-white/25 uppercase tracking-[0.2em] mb-4 px-1">
              {section.title}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {sectionSymbols.map((s) => {
                const analysis = analysisMap.get(s.symbol)
                return (
                  <MarketTile
                    key={s.symbol}
                    data={{
                      ...s,
                      displayName: INDEX_NAMES[s.symbol] || s.displayName,
                      // Override direction + signal when real analysis is available
                      ...(analysis ? {
                        direction: analysis.verdict === 'BUY' ? 'BULLISH' as const : 'BEARISH' as const,
                        signal: {
                          ...s.signal,
                          direction: analysis.verdict === 'BUY' ? 'BULLISH' as const : 'BEARISH' as const,
                          confidence: analysis.confidence,
                          confluenceFactors: analysis.factors.length > 0
                            ? analysis.factors
                            : s.signal.confluenceFactors,
                        },
                      } : {}),
                    }}
                  />
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
