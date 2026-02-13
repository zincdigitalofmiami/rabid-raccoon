'use client'

import { useEffect, useRef, useState, useMemo, forwardRef, useImperativeHandle } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from 'lightweight-charts'
import type { ForecastResponse, MeasuredMove, CandleData } from '@/lib/types'
import type { BhgSetup } from '@/lib/bhg-engine'
import { ForecastTargetsPrimitive } from '@/lib/charts/ForecastTargetsPrimitive'
import { BhgMarkersPrimitive } from '@/lib/charts/BhgMarkersPrimitive'
import { mapMeasuredMoveAndCoreToTargets } from '@/lib/charts/blendTargets'
import { ensureFutureWhitespace } from '@/lib/charts/ensureFutureWhitespace'
import { detectSwings } from '@/lib/swing-detection'
import { calculateFibonacci } from '@/lib/fibonacci'
import TV from '@/lib/colors'

type MesPoint = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

type StreamStatus = 'connecting' | 'live' | 'error'

const BAR_INTERVAL_SEC = 900 // 15m

function toChartPoint(point: MesPoint) {
  return {
    time: point.time as UTCTimestamp,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
  }
}

function toCandle(point: MesPoint): CandleData {
  return {
    time: point.time,
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close,
    volume: point.volume,
  }
}

export interface LiveMesChartHandle {
  captureScreenshot: () => string | null
}

interface LiveMesChartProps {
  forecast?: ForecastResponse | null
  setups?: BhgSetup[]
}

const LiveMesChart = forwardRef<LiveMesChartHandle, LiveMesChartProps>(function LiveMesChart({ forecast, setups }, ref) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick', Time> | null>(null)
  const primitiveRef = useRef<ForecastTargetsPrimitive | null>(null)
  const bhgPrimitiveRef = useRef<BhgMarkersPrimitive | null>(null)
  const pointsRef = useRef<MesPoint[]>([])

  const [status, setStatus] = useState<StreamStatus>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [lastPrice, setLastPrice] = useState<number | null>(null)
  const [priceChange, setPriceChange] = useState<number>(0)
  const [sessionHigh, setSessionHigh] = useState<number | null>(null)
  const [sessionLow, setSessionLow] = useState<number | null>(null)

  // Get the best active measured move from the forecast
  const activeMove = useMemo<MeasuredMove | null>(() => {
    if (!forecast?.measuredMoves) return null
    const active = forecast.measuredMoves.filter((m) => m.status === 'ACTIVE')
    return active.length > 0 ? active[0] : null
  }, [forecast])

  // Expose screenshot capture for chart analysis
  useImperativeHandle(ref, () => ({
    captureScreenshot: () => {
      if (!chartRef.current) return null
      try {
        const canvas = chartRef.current.takeScreenshot()
        return canvas.toDataURL('image/png')
      } catch {
        return null
      }
    },
  }))

  // --- Chart setup ---
  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: TV.bg.primary },
        textColor: TV.text.secondary,
        fontFamily: '-apple-system, BlinkMacSystemFont, Inter, sans-serif',
      },
      grid: {
        vertLines: { color: TV.border.secondary },
        horzLines: { color: TV.border.secondary },
      },
      rightPriceScale: {
        borderColor: TV.border.primary,
      },
      timeScale: {
        borderColor: TV.border.primary,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.2)' },
        horzLine: { color: 'rgba(255,255,255,0.2)' },
      },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: TV.bull.primary,
      downColor: TV.bear.primary,
      borderVisible: false,
      wickUpColor: TV.bull.primary,
      wickDownColor: TV.bear.primary,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.25,
      },
    })

    // Attach forecast targets primitive
    const primitive = new ForecastTargetsPrimitive()
    series.attachPrimitive(primitive)

    // Attach BHG markers primitive
    const bhgPrimitive = new BhgMarkersPrimitive()
    series.attachPrimitive(bhgPrimitive)

    chartRef.current = chart
    seriesRef.current = series
    primitiveRef.current = primitive
    bhgPrimitiveRef.current = bhgPrimitive

    const resizeObserver = new ResizeObserver(() => {
      chart.timeScale().fitContent()
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      series.detachPrimitive(primitive)
      series.detachPrimitive(bhgPrimitive)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      primitiveRef.current = null
      bhgPrimitiveRef.current = null
    }
  }, [])

  // --- SSE stream ---
  useEffect(() => {
    const eventSource = new EventSource('/api/live/mes15m?backfill=96')

    const updateSessionStats = (points: MesPoint[]) => {
      if (points.length === 0) return
      const last = points[points.length - 1]
      setLastPrice(last.close)

      // Session H/L from visible data
      let high = -Infinity
      let low = Infinity
      for (const p of points) {
        if (p.high > high) high = p.high
        if (p.low < low) low = p.low
      }
      setSessionHigh(high)
      setSessionLow(low)

      // Change % from first to last
      const first = points[0]
      if (first.open > 0) {
        setPriceChange(((last.close - first.open) / first.open) * 100)
      }
    }

    const onSnapshot = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { points: MesPoint[] }
        if (!seriesRef.current) return
        const points = data.points || []
        if (points.length === 0) return

        pointsRef.current = points

        // Add whitespace for future target zones
        const lastTime = points[points.length - 1].time
        const whitespace = ensureFutureWhitespace(lastTime, BAR_INTERVAL_SEC, 8)
        const chartData = [...points.map(toChartPoint), ...whitespace]
        seriesRef.current.setData(chartData)

        updateSessionStats(points)
        chartRef.current?.timeScale().fitContent()
        setStatus('live')
        setError(null)
      } catch (e) {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Invalid snapshot')
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
        }
        pointsRef.current = [...byTime.values()].sort((a, b) => a.time - b.time)
        updateSessionStats(pointsRef.current)
        setStatus('live')
        setError(null)
      } catch (e) {
        setStatus('error')
        setError(e instanceof Error ? e.message : 'Invalid update')
      }
    }

    const onSseError = () => {
      setStatus('error')
      setError('Live stream disconnected. Verify MES 15m ingestion is running.')
    }

    eventSource.addEventListener('snapshot', onSnapshot)
    eventSource.addEventListener('update', onUpdate)
    eventSource.onerror = onSseError

    return () => {
      eventSource.removeEventListener('snapshot', onSnapshot)
      eventSource.removeEventListener('update', onUpdate)
      eventSource.close()
    }
  }, [])

  // --- Wire forecast targets to primitive ---
  useEffect(() => {
    if (!primitiveRef.current) return

    if (!activeMove || pointsRef.current.length === 0) {
      primitiveRef.current.setTargets([])
      return
    }

    const points = pointsRef.current
    const lastTime = points[points.length - 1].time
    const futureEnd = lastTime + BAR_INTERVAL_SEC * 8

    // Run fib calculation on candle data for snap-blend alignment
    const candles = points.map(toCandle)
    const swings = detectSwings(candles)
    const fib = calculateFibonacci(swings.highs, swings.lows)

    const targets = mapMeasuredMoveAndCoreToTargets(
      activeMove,
      fib,
      lastTime,
      futureEnd
    )

    primitiveRef.current.setTargets(targets)
  }, [activeMove, lastPrice])

  // --- Wire BHG setups to primitive ---
  useEffect(() => {
    if (!bhgPrimitiveRef.current) return

    if (!setups || setups.length === 0 || pointsRef.current.length === 0) {
      bhgPrimitiveRef.current.setMarkers(null)
      return
    }

    const lastTime = pointsRef.current[pointsRef.current.length - 1].time

    bhgPrimitiveRef.current.setMarkers({
      setups,
      lastTime,
      futureBars: 8,
      barInterval: BAR_INTERVAL_SEC,
    })
  }, [setups, lastPrice])

  const changeColor = priceChange >= 0 ? TV.bull.bright : TV.bear.bright

  return (
    <div
      className="relative w-full rounded-2xl overflow-hidden border border-white/5"
      style={{ background: 'linear-gradient(180deg, #131722 0%, #0d1117 100%)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full animate-pulse shadow-lg"
              style={{
                backgroundColor: status === 'live' ? TV.bull.bright : status === 'connecting' ? '#ffa726' : TV.bear.bright,
                boxShadow: status === 'live' ? `0 0 8px ${TV.bull.bright}80` : 'none',
              }}
            />
            <span className="text-base font-semibold text-white tracking-tight">MES</span>
          </div>
          <span className="text-xs text-white/30 font-medium">Micro E-mini S&P 500 &bull; 15m</span>
        </div>

        <div className="flex items-center gap-6">
          {sessionHigh != null && sessionLow != null && (
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-white/30">H</span>
                <span className="text-white/60 font-mono">{sessionHigh.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-white/30">L</span>
                <span className="text-white/60 font-mono">{sessionLow.toFixed(2)}</span>
              </div>
            </div>
          )}

          {sessionHigh != null && <div className="h-4 w-px bg-white/10" />}

          {lastPrice != null && (
            <div className="flex items-center gap-3">
              <span className="text-2xl font-semibold text-white tabular-nums">
                {lastPrice.toFixed(2)}
              </span>
              <span
                className="text-sm font-medium tabular-nums"
                style={{ color: changeColor }}
              >
                {priceChange >= 0 ? '+' : ''}
                {priceChange.toFixed(2)}%
              </span>
            </div>
          )}

          <span
            className="text-[10px] font-bold uppercase tracking-wider"
            style={{ color: status === 'live' ? TV.bull.bright : status === 'connecting' ? '#ffa726' : TV.bear.bright }}
          >
            {status}
          </span>
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} className="w-full" style={{ height: '480px' }} />

      {/* Legend Footer */}
      <div className="flex items-center justify-center gap-8 px-6 py-3 border-t border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: TV.bull.primary }} />
          <span className="text-[10px] text-white/40 uppercase tracking-wider">Bullish</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: TV.bear.primary }} />
          <span className="text-[10px] text-white/40 uppercase tracking-wider">Bearish</span>
        </div>
        {activeMove && (
          <>
            <div className="flex items-center gap-2">
              <div className="w-4 h-2 rounded-sm" style={{ backgroundColor: TV.bull.primary, opacity: 0.3 }} />
              <span className="text-[10px] text-white/40 uppercase tracking-wider">TP Zone</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5 border-t border-dashed" style={{ borderColor: TV.bear.primary }} />
              <span className="text-[10px] text-white/40 uppercase tracking-wider">Stop</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-0.5 border-t border-dashed" style={{ borderColor: TV.blue.primary }} />
              <span className="text-[10px] text-white/40 uppercase tracking-wider">Entry</span>
            </div>
          </>
        )}
        {setups && setups.length > 0 && (
          <>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#787b86' }} />
              <span className="text-[10px] text-white/40 uppercase tracking-wider">Touch</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-transparent border-b-[#ff9800]" />
              <span className="text-[10px] text-white/40 uppercase tracking-wider">Hook</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rotate-45" style={{ backgroundColor: TV.bull.bright }} />
              <span className="text-[10px] text-white/40 uppercase tracking-wider">GO</span>
            </div>
          </>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="px-6 py-2 border-t border-white/5">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}
    </div>
  )
})

export default LiveMesChart
