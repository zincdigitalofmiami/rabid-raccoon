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
    title: 'MACRO',
    keys: ['VX', 'ZN', 'ZB', 'DX'],
  },
]

export default function MarketsGrid({ symbols }: MarketsGridProps) {
  const symbolMap = new Map(symbols.map((s) => [s.symbol, s]))

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
