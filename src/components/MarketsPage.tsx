'use client'

import Header from './Header'
import SignalBar from './SignalBar'
import MarketsGrid from './MarketsGrid'
import ForecastPanel from './ForecastPanel'
import { useMarketBatch } from '@/hooks/useMarketBatch'
import { useForecast } from '@/hooks/useForecast'

export default function MarketsPage() {
  const { symbols, compositeSignal, loading: marketsLoading, error: marketsError } = useMarketBatch()
  const { forecast, loading: forecastLoading, error: forecastError } = useForecast()

  const mesData = symbols.find((s) => s.symbol === 'MES')

  return (
    <div className="min-h-screen bg-[#0d1117]">
      <div className="max-w-6xl mx-auto px-4 sm:px-6">
        <Header />

        {marketsError && (
          <div className="mb-4 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
            <p className="text-sm text-red-400">Market data error: {marketsError}</p>
          </div>
        )}

        {/* Signal Bar */}
        <div className="mb-6">
          <SignalBar
            signal={compositeSignal}
            mesPrice={mesData?.price}
            mesChangePercent={mesData?.changePercent}
          />
        </div>

        {/* Markets Grid */}
        <div className="mb-8">
          {marketsLoading && symbols.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                <span className="text-sm text-white/30">Loading markets...</span>
              </div>
            </div>
          ) : (
            <MarketsGrid symbols={symbols} />
          )}
        </div>

        {/* AI Forecast */}
        <div className="mb-8">
          <ForecastPanel
            forecast={forecast}
            loading={forecastLoading}
            error={forecastError}
          />
        </div>
      </div>
    </div>
  )
}
