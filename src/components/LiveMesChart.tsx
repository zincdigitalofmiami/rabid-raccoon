'use client'

import { useEffect, useRef, useState } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'

type MesPoint = {
  time: number
  open: number
  high: number
  low: number
  close: number
}

type StreamStatus = 'connecting' | 'live' | 'error'

function toChartPoint(point: MesPoint) {
  return {
    time: point.time as UTCTimestamp,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
  }
}

export default function LiveMesChart() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick', Time> | null>(null)

  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [lastPrice, setLastPrice] = useState<number | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0d1117' },
        textColor: '#9aa4b2',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.05)' },
        horzLines: { color: 'rgba(255,255,255,0.05)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(255,255,255,0.15)',
      },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.15)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.25)' },
        horzLine: { color: 'rgba(255,255,255,0.25)' },
      },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.25,
      },
    })

    chartRef.current = chart
    seriesRef.current = series

    const onResize = () => {
      chart.timeScale().fitContent()
    }

    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [])

  useEffect(() => {
    const eventSource = new EventSource('/api/live/mes?backfill=320')

    const onSnapshot = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { points: MesPoint[] }
        if (!seriesRef.current) return
        const points = data.points || []
        if (points.length === 0) return
        seriesRef.current.setData(points.map(toChartPoint))
        setLastPrice(points[points.length - 1].close)
        chartRef.current?.timeScale().fitContent()
        setStatus('live')
        setError(null)
      } catch (e) {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Invalid live snapshot payload')
      }
    }

    const onUpdate = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { points: MesPoint[] }
        if (!seriesRef.current) return
        const points = data.points || []
        for (const point of points) {
          seriesRef.current.update(toChartPoint(point))
          setLastPrice(point.close)
        }
        if (points.length > 0) {
          setStatus('live')
          setError(null)
        }
      } catch (e) {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Invalid live update payload')
      }
    }

    const onError = () => {
      setStatus('error')
      setError('Live stream disconnected. Verify local MES live ingestion process is running.')
    }

    eventSource.addEventListener('snapshot', onSnapshot)
    eventSource.addEventListener('update', onUpdate)
    eventSource.onerror = onError

    return () => {
      eventSource.removeEventListener('snapshot', onSnapshot)
      eventSource.removeEventListener('update', onUpdate)
      eventSource.close()
    }
  }, [])

  return (
    <div className="rounded-xl border border-white/5 bg-[#0d1117] overflow-hidden">
      <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
        <span className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">MES Live 1m</span>
        <div className="flex items-center gap-3">
          {lastPrice != null && (
            <span className="text-xs font-mono text-white/80">{lastPrice.toFixed(2)}</span>
          )}
          <span
            className="text-[10px] font-bold uppercase tracking-wider"
            style={{ color: status === 'live' ? '#26a69a' : status === 'connecting' ? '#ffa726' : '#ef5350' }}
          >
            {status}
          </span>
        </div>
      </div>

      <div ref={containerRef} className="h-[420px] w-full" />

      {error && (
        <div className="px-4 py-2 border-t border-white/5">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
    </div>
  )
}
