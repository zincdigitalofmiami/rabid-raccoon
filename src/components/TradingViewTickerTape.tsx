'use client'

import { useEffect, useRef, memo } from 'react'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'tv-ticker-tape': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        theme?: string
        'item-size'?: string
        'show-hover'?: string | boolean
      }
    }
  }
}

function TradingViewTickerTape() {
  const ref = useRef<HTMLDivElement>(null)
  const loaded = useRef(false)

  useEffect(() => {
    if (loaded.current || !ref.current) return
    loaded.current = true

    const script = document.createElement('script')
    script.src = 'https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js'
    script.async = true
    ref.current.appendChild(script)
  }, [])

  return (
    <div
      ref={ref}
      className="w-full border-b border-amber-500/20 bg-transparent"
      style={{ height: '40px', overflow: 'hidden' }}
    >
      <tv-ticker-tape
        theme="dark"
        item-size="compact"
        show-hover="true"
      >
        <div slot="promolink"></div>
        <div slot="items">
          CME_MINI:MES1!|MES
          FOREXCOM:SPXUSD|S&amp;P 500
          INDEX:VIX|VIX
          TVC:DXY|DXY
          TVC:TNX|10Y
        </div>
      </tv-ticker-tape>
    </div>
  )
}

export default memo(TradingViewTickerTape)
