'use client'

import Header from './Header'
import CorrelationBar from './CorrelationBar'
import SymbolCard from './SymbolCard'

export default function Dashboard() {
  return (
    <div className="min-h-screen" style={{ background: '#0a0a0a' }}>
      <Header />

      <div className="px-4 pb-6 space-y-4">
        {/* Correlation bar */}
        <CorrelationBar />

        {/* Primary: MES (full width, tall) */}
        <SymbolCard symbol="MES" chartHeight={400} isPrimary />

        {/* Secondary: 2-column grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SymbolCard symbol="NQ" chartHeight={250} />
          <SymbolCard symbol="YM" chartHeight={250} />
          <SymbolCard symbol="RTY" chartHeight={250} />
          <SymbolCard symbol="VX" chartHeight={250} />
          <SymbolCard symbol="ZN" chartHeight={250} />
          <SymbolCard symbol="DX" chartHeight={250} />
        </div>

        {/* ZB: full width, shorter */}
        <SymbolCard symbol="ZB" chartHeight={200} />
      </div>
    </div>
  )
}
