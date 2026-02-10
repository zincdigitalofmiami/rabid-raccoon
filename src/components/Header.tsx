'use client'

import { useState, useEffect } from 'react'

export default function Header() {
  const [time, setTime] = useState<string>('')

  useEffect(() => {
    const update = () => {
      setTime(new Date().toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [])

  return (
    <header className="flex items-center justify-between px-6 py-4">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-white tracking-tight">Rabid Raccoon</h1>
        <span className="text-xs text-white/30 uppercase tracking-wider font-medium">Intraday Dashboard</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-white/5 border border-white/5">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          <span className="text-xs text-white/50 font-mono tabular-nums">{time}</span>
        </div>
        <span className="text-[10px] text-white/20 uppercase tracking-wider">Auto-refresh 60s</span>
      </div>
    </header>
  )
}
