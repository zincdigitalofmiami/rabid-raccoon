'use client'

import { useRef, useMemo } from 'react'
import Link from 'next/link'
import LiveMesChart, { LiveMesChartHandle } from '../LiveMesChart'
import { useMesSetups } from '@/hooks/useMesSetups'
import { useForecast } from '@/hooks/useForecast'
import StatusTile from './StatusTile'
import CorrelationTile from './CorrelationTile'
import SignalTile from './SignalTile'
import RiskTile from './RiskTile'
import SetupLog from './SetupLog'

export default function MesIntradayDashboard() {
  const chartRef = useRef<LiveMesChartHandle>(null)
  const { forecast } = useForecast()
  const { data: setupsData, loading, error } = useMesSetups()

  const leadSetup = useMemo(() => {
    if (!setupsData?.setups) return null
    return setupsData.setups.find((s) => s.phase === 'GO_FIRED') ?? null
  }, [setupsData])

  const activeCount = useMemo(() => {
    if (!setupsData?.setups) return { touched: 0, hooked: 0, goFired: 0 }
    const setups = setupsData.setups
    return {
      touched: setups.filter((s) => s.phase === 'TOUCHED').length,
      hooked: setups.filter((s) => s.phase === 'HOOKED').length,
      goFired: setups.filter((s) => s.phase === 'GO_FIRED').length,
    }
  }, [setupsData])

  return (
    <div className="min-h-screen bg-[#0d1117]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-white tracking-tight">
              MES Intraday
            </h1>
            <span className="text-[10px] font-mono text-white/20 bg-white/5 px-2 py-0.5 rounded">
              Touch-Hook-Go
            </span>
          </div>
          <div className="flex items-center gap-2">
            {loading && (
              <div className="w-3 h-3 border border-white/20 border-t-white/60 rounded-full animate-spin" />
            )}
            <Link href="/" className="text-xs text-white/30 hover:text-white/50 transition-colors">
              Markets
            </Link>
          </div>
        </div>

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
            <LiveMesChart ref={chartRef} forecast={forecast} setups={setupsData?.setups} />
          </div>
          <SetupLog setups={setupsData?.setups ?? []} />
        </div>
      </div>
    </div>
  )
}
