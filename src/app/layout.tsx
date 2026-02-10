import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Rabid Raccoon — Intraday Dashboard',
  description: 'Real-time futures trading dashboard with Auto-Fibonacci',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  )
}
