'use client'

import { useEffect, useRef } from 'react'
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  ColorType,
  IChartApi,
  CandlestickData,
  Time,
  LineStyle,
} from 'lightweight-charts'
import { CandleData, FibLevel, SwingPoint } from '@/lib/types'

interface CandlestickChartProps {
  candles: CandleData[]
  fibLevels: FibLevel[] | null
  swingPoints: SwingPoint[]
  height: number
}

export default function CandlestickChart({
  candles,
  fibLevels,
  swingPoints,
  height,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return

    // Destroy previous chart (V15 pattern: recreate from scratch each render)
    if (chartRef.current) {
      chartRef.current.remove()
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255, 255, 255, 0.35)',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      crosshair: {
        vertLine: { color: 'rgba(255, 255, 255, 0.3)', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#1e222d' },
        horzLine: { color: 'rgba(255, 255, 255, 0.3)', width: 1, style: LineStyle.Solid, labelBackgroundColor: '#1e222d' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255, 255, 255, 0.05)',
      },
      timeScale: {
        borderColor: 'rgba(255, 255, 255, 0.05)',
        timeVisible: true,
        secondsVisible: false,
      },
    })

    chartRef.current = chart

    // Add candlestick series
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      borderVisible: false,
    })

    // Set candle data
    const chartData: CandlestickData<Time>[] = candles.map((c) => ({
      time: c.time as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
    series.setData(chartData)

    // Draw Fibonacci levels as price lines
    if (fibLevels) {
      for (const level of fibLevels) {
        const isTarget = level.ratio === 0.236 || level.ratio === 0.618
        series.createPriceLine({
          price: level.price,
          color: level.color,
          lineWidth: isTarget ? 2 : 1,
          lineStyle: level.isExtension ? LineStyle.Dashed : (isTarget ? LineStyle.Solid : LineStyle.Dotted),
          axisLabelVisible: true,
          title: `${level.label} (${level.price.toFixed(2)})`,
        })
      }
    }

    // Draw swing markers
    if (swingPoints.length > 0) {
      const markers = swingPoints
        .map((sp) => ({
          time: sp.time as Time,
          position: sp.isHigh ? ('aboveBar' as const) : ('belowBar' as const),
          color: sp.isHigh ? '#ef5350' : '#26a69a',
          shape: sp.isHigh ? ('arrowDown' as const) : ('arrowUp' as const),
          size: 0.5,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number))
      createSeriesMarkers(series, markers)
    }

    // Fit content
    chart.timeScale().fitContent()

    // Resize observer
    const resizeObserver = new ResizeObserver((entries) => {
      if (entries.length === 0 || !entries[0].target) return
      chart.applyOptions({ width: entries[0].contentRect.width })
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
    }
  }, [candles, fibLevels, swingPoints, height])

  return <div ref={containerRef} className="w-full" />
}
