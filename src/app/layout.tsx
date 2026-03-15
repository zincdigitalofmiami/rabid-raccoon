import type { Metadata } from 'next'
import { VercelToolbar } from '@vercel/toolbar/next'
import Header from '@/components/Header'
import './globals.css'

export const metadata: Metadata = {
  title: 'Rabid Raccoon — Intraday Dashboard',
  description: 'Real-time futures trading dashboard with Auto-Fibonacci',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <Header />
        </div>
        {children}
        {process.env.NODE_ENV === 'production' ? <VercelToolbar /> : null}
      </body>
    </html>
  )
}
