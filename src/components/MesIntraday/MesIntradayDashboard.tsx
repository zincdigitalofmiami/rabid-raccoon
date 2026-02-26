'use client'

import { useRef } from 'react'
import LiveMesChart, { LiveMesChartHandle } from '../LiveMesChart'
import { useMesSetups } from '@/hooks/useMesSetups'

export default function MesIntradayDashboard() {
  const chartRef = useRef<LiveMesChartHandle>(null)
  const { data: setupsData, error } = useMesSetups()

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

    </div>
  )
}
