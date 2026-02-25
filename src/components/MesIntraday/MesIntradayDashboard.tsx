'use client'

import { useRef, useMemo } from 'react'
import LiveMesChart, { LiveMesChartHandle } from '../LiveMesChart'
import { useMesSetups } from '@/hooks/useMesSetups'
import StatusTile from './StatusTile'
import CorrelationTile from './CorrelationTile'
import SignalTile from './SignalTile'
import RiskTile from './RiskTile'
import MLForecastTile from './MLForecastTile'

export default function MesIntradayDashboard() {
  const chartRef = useRef<LiveMesChartHandle>(null)
  const { data: setupsData, loading, error } = useMesSetups()

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
    <div className="min-h-screen bg-[#0d1117]">
      {error && (
        <div className="mx-4 lg:mx-6 mt-2 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Chart — flush at top, full width, no sidebar */}
      <div className="px-4 lg:px-6 pt-3">
        <LiveMesChart ref={chartRef} setups={setupsData?.setups} />
      </div>

      {/* Dashboard below chart */}
      <div className="px-4 lg:px-6 py-6 space-y-6">
        {/* ML Forecast — full width */}
        <MLForecastTile setupsData={setupsData} />

        {/* Market Pressure tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatusTile
            activeCount={activeCount}
            currentPrice={setupsData?.currentPrice ?? null}
          />
          <CorrelationTile />
          <SignalTile leadSetup={leadSetup} />
          <RiskTile leadSetup={leadSetup} />
        </div>
      </div>
    </div>
  )
}
