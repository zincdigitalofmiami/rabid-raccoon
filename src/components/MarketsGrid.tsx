'use client'

import MarketTile from './MarketTile'
import { MarketSummary } from '@/lib/types'

interface MarketsGridProps {
  symbols: MarketSummary[]
}

const SECTIONS = [
  {
    title: 'EQUITY FUTURES',
    keys: ['MES', 'NQ', 'YM', 'RTY'],
  },
  {
    title: 'VOLATILITY',
    keys: ['VX'],
  },
  {
    title: 'TREASURIES',
    keys: ['ZN', 'ZB'],
  },
  {
    title: 'DOLLAR',
    keys: ['DX'],
  },
]

export default function MarketsGrid({ symbols }: MarketsGridProps) {
  const symbolMap = new Map(symbols.map((s) => [s.symbol, s]))

  return (
    <div className="space-y-6">
      {SECTIONS.map((section) => {
        const sectionSymbols = section.keys
          .map((k) => symbolMap.get(k))
          .filter((s): s is MarketSummary => s != null)

        if (sectionSymbols.length === 0) return null

        return (
          <div key={section.title}>
            <h3 className="text-[10px] font-bold text-white/30 uppercase tracking-[0.15em] mb-3 px-1">
              {section.title}
            </h3>
            <div
              className={`grid gap-3 ${
                section.keys.length === 4
                  ? 'grid-cols-2 lg:grid-cols-4'
                  : section.keys.length === 2
                  ? 'grid-cols-2'
                  : 'grid-cols-1 max-w-xs'
              }`}
            >
              {sectionSymbols.map((s) => (
                <MarketTile key={s.symbol} data={s} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
