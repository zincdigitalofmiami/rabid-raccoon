'use client'

import { useState } from 'react'
import Header from './Header'
import AnalysePanel from './AnalysePanel'
import MarketsGrid from './MarketsGrid'
import ForecastPanel from './ForecastPanel'
import { useMarketBatch } from '@/hooks/useMarketBatch'
import { useForecast } from '@/hooks/useForecast'
import { InstantAnalysisResult } from '@/lib/instant-analysis'

export default function MarketsPage() {
  const { symbols, loading: marketsLoading, error: marketsError } = useMarketBatch()
  const { forecast, loading: forecastLoading, error: forecastError } = useForecast()
  const [analysisResult, setAnalysisResult] = useState<InstantAnalysisResult | null>(null)

  return (
    <div className="min-h-screen bg-[#0d1117]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <Header />

        {marketsError && (
          <div className="mb-4 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
            <p className="text-sm text-red-400">Market data error: {marketsError}</p>
          </div>
        )}

        {/* Analyse — 3 Timeframe Gauges at the top */}
        <div className="mb-10">
          <AnalysePanel onResult={setAnalysisResult} />
        </div>

        {/* Markets Grid */}
        <div className="mb-10">
          {marketsLoading && symbols.length === 0 ? (
            <div className="flex items-center justify-center py-20">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                <span className="text-sm text-white/30">Loading markets...</span>
              </div>
            </div>
          ) : (
            <MarketsGrid symbols={symbols} analysisResult={analysisResult} />
          )}
        </div>

        {/* AI Forecast */}
        <div className="mb-10">
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
