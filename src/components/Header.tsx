'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export default function Header() {
  const [time, setTime] = useState('')
  const [window, setWindow] = useState('')
  const pathname = usePathname()

  useEffect(() => {
    function update() {
      const now = new Date()
      const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
      const hours = ct.getHours()
      const minutes = ct.getMinutes()
      const totalMinutes = hours * 60 + minutes

      setTime(
        ct.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }) + ' CT'
      )

      if (totalMinutes < 360) setWindow('Morning')
      else if (totalMinutes < 510) setWindow('Premarket')
      else if (totalMinutes < 900) setWindow('Session')
      else setWindow('After Hours')
    }

    update()
    const interval = setInterval(update, 30000)
    return () => clearInterval(interval)
  }, [])

  const navItems = [
    { href: '/', label: 'Markets' },
    { href: '/mes', label: 'MES Intraday' },
  ]

  return (
    <header className="flex items-center justify-between px-1 py-4">
      <div className="flex items-center gap-4">
        <Link href="/" className="text-sm font-bold text-white tracking-tight hover:text-white/80 transition-colors">
          RABID RACCOON
        </Link>
        <nav className="flex items-center gap-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${
                pathname === item.href
                  ? 'bg-white/10 text-white/70'
                  : 'text-white/30 hover:text-white/50 hover:bg-white/5'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        {window && (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-white/5 text-white/40">
            {window}
          </span>
        )}
        <span className="text-xs text-white/30 tabular-nums font-medium">{time}</span>
      </div>
    </header>
  )
}
