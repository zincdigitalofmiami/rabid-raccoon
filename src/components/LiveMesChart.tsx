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
  volume?: number
}

type StreamStatus = 'connecting' | 'live' | 'error'
type TrendState = 'UP' | 'DOWN' | 'FLAT'

function toChartPoint(point: MesPoint) {
  return {
    time: point.time as UTCTimestamp,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
  }
}

function aggregateCandles(points: MesPoint[], periodMinutes: number): MesPoint[] {
  if (points.length === 0) return []
  const periodSec = periodMinutes * 60
  const out: MesPoint[] = []
  let bucket: MesPoint | null = null
  let bucketStart = 0

  for (const point of points) {
    const aligned = Math.floor(point.time / periodSec) * periodSec
    if (bucket === null || aligned !== bucketStart) {
      if (bucket) out.push(bucket)
      bucket = { ...point, time: aligned }
      bucketStart = aligned
      continue
    }

    bucket.high = Math.max(bucket.high, point.high)
    bucket.low = Math.min(bucket.low, point.low)
    bucket.close = point.close
    bucket.volume = (bucket.volume || 0) + (point.volume || 0)
  }

  if (bucket) out.push(bucket)
  return out
}

function computeTrend(points: MesPoint[]): TrendState {
  if (points.length < 2) return 'FLAT'
  const last = points[points.length - 1].close
  const lookback = points[Math.max(0, points.length - 4)].close
  if (last > lookback) return 'UP'
  if (last < lookback) return 'DOWN'
  return 'FLAT'
}

export default function LiveMesChart() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick', Time> | null>(null)
  const pointsRef = useRef<MesPoint[]>([])

  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [trend1h, setTrend1h] = useState<TrendState>('FLAT')
  const [trend4h, setTrend4h] = useState<TrendState>('FLAT')

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
    const eventSource = new EventSource('/api/live/mes?backfill=220')

    const onSnapshot = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { points: MesPoint[] }
        if (!seriesRef.current) return
        const points = data.points || []
        if (points.length === 0) return
        pointsRef.current = points
        seriesRef.current.setData(points.map(toChartPoint))
        setLastPrice(points[points.length - 1].close)
        setTrend1h(computeTrend(aggregateCandles(points, 60)))
        setTrend4h(computeTrend(aggregateCandles(points, 240)))
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
        const updates = data.points || []
        if (updates.length === 0) return
        const byTime = new Map(pointsRef.current.map((p) => [p.time, p] as const))
        for (const point of updates) {
          byTime.set(point.time, point)
          seriesRef.current.update(toChartPoint(point))
          setLastPrice(point.close)
        }
        pointsRef.current = [...byTime.values()].sort((a, b) => a.time - b.time)
        setTrend1h(computeTrend(aggregateCandles(pointsRef.current, 60)))
        setTrend4h(computeTrend(aggregateCandles(pointsRef.current, 240)))
        setStatus('live')
        setError(null)
      } catch (e) {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Invalid live update payload')
      }
    }

    const onError = () => {
      setStatus('error')
      setError('Live stream disconnected. Verify local MES 15m ingestion process is running.')
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
        <span className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">MES Live 15m (Entries)</span>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-white/45 font-semibold uppercase">
            1H {trend1h}
          </span>
          <span className="text-[10px] text-white/45 font-semibold uppercase">
            4H {trend4h}
          </span>
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
