'use client'

import { useRef, useMemo } from 'react'
import LiveMesChart, { LiveMesChartHandle } from '../LiveMesChart'
import { useMesSetups } from '@/hooks/useMesSetups'
import StatusTile from './StatusTile'
import CorrelationTile from './CorrelationTile'
import SignalTile from './SignalTile'
import RiskTile from './RiskTile'
import SetupLog from './SetupLog'

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
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {error && (
          <div className="mb-4 p-3 rounded-lg border border-red-500/20 bg-red-500/5">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        {/* Top Row: 4 Status Tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
          <StatusTile
            activeCount={activeCount}
            currentPrice={setupsData?.currentPrice ?? null}
          />
          <CorrelationTile />
          <SignalTile leadSetup={leadSetup} />
          <RiskTile leadSetup={leadSetup} />
        </div>

        {/* Main: Hero Chart + Right Rail */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          <div>
            <LiveMesChart ref={chartRef} setups={setupsData?.setups} />
          </div>
          <SetupLog setups={setupsData?.setups ?? []} />
        </div>
      </div>
    </div>
  )
}
