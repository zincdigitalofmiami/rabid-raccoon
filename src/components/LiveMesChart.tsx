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
import { calculateFibonacciMultiPeriod } from '@/lib/fibonacci'
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
const GO_RECENT_BARS = 32
const MAX_TOUCH_MARKERS = 1
const MAX_HOOK_MARKERS = 1

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

function setupSortTime(setup: BhgSetup): number {
  return setup.goTime ?? setup.hookTime ?? setup.touchTime ?? setup.createdAt
}

function isRenderableGoSetup(setup: BhgSetup): boolean {
  if (setup.phase !== 'TRIGGERED') return false
  if (setup.entry == null || setup.stopLoss == null || setup.tp1 == null || setup.tp2 == null) return false

  if (setup.direction === 'BULLISH') {
    return setup.stopLoss < setup.entry && setup.tp1 > setup.entry && setup.tp2 >= setup.tp1
  }
  return setup.tp2 <= setup.tp1 && setup.tp1 < setup.entry && setup.stopLoss > setup.entry
}

function selectSetupsForChart(
  setups: BhgSetup[],
  lastTimeSec: number | null
): BhgSetup[] {
  if (setups.length === 0) return []

  const goCandidates = setups
    .filter(isRenderableGoSetup)
    .sort((a, b) => setupSortTime(b) - setupSortTime(a))

  const recentGoCandidates =
    lastTimeSec == null
      ? goCandidates
      : goCandidates.filter(
          (s) => s.goTime != null && lastTimeSec - s.goTime <= BAR_INTERVAL_SEC * GO_RECENT_BARS
        )

  const sourceGo = recentGoCandidates.length > 0 ? recentGoCandidates : goCandidates
  const selectedGo = sourceGo.slice(0, 1)

  const leadDirection = selectedGo[0]?.direction
  const leadTime = selectedGo[0] ? setupSortTime(selectedGo[0]) : null

  const selectedHooks = setups
    .filter((s) => s.phase === 'CONFIRMED')
    .filter((s) => (leadDirection ? s.direction === leadDirection : true))
    .filter((s) => (leadTime != null ? setupSortTime(s) <= leadTime : true))
    .sort((a, b) => setupSortTime(b) - setupSortTime(a))
    .slice(0, MAX_HOOK_MARKERS)

  const selectedTouches = setups
    .filter((s) => s.phase === 'CONTACT')
    .filter((s) => (leadDirection ? s.direction === leadDirection : true))
    .filter((s) => (leadTime != null ? setupSortTime(s) <= leadTime : true))
    .sort((a, b) => setupSortTime(b) - setupSortTime(a))
    .slice(0, MAX_TOUCH_MARKERS)

  return [...selectedGo, ...selectedHooks, ...selectedTouches]
}

export interface LiveMesChartHandle {
  captureScreenshot: () => string | null
}

interface LiveMesChartProps {
  forecast?: ForecastResponse | null
  setups?: BhgSetup[]
  eventPhase?: string
  eventLabel?: string
}

const LiveMesChart = forwardRef<LiveMesChartHandle, LiveMesChartProps>(function LiveMesChart({ forecast, setups, eventPhase, eventLabel }, ref) {
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

  const chartSetups = useMemo(
    () => selectSetupsForChart(setups ?? [], pointsRef.current[pointsRef.current.length - 1]?.time ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lastPrice triggers recalc when pointsRef updates
    [setups, lastPrice]
  )

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
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(255,255,255,0.4)',
        fontFamily: 'Inter, sans-serif',
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: {
        borderColor: 'transparent',
        autoScale: true,
        scaleMargins: { top: 0.05, bottom: 0.05 },
      },
      timeScale: {
        borderColor: 'transparent',
        timeVisible: false,
        fixLeftEdge: false,
        fixRightEdge: false,
        rightOffset: 16,
        barSpacing: 8,
        minBarSpacing: 4,
      },
      crosshair: {
        vertLine: {
          color: 'rgba(139,92,246,0.6)',
          width: 1,
          labelBackgroundColor: 'rgba(20,10,40,0.9)',
        },
        horzLine: {
          color: 'rgba(139,92,246,0.6)',
          width: 1,
          labelBackgroundColor: 'rgba(20,10,40,0.9)',
        },
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: false,
        pinch: true,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
    })

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26C6DA',
      downColor: '#FF0000',
      borderUpColor: 'transparent',
      borderDownColor: 'transparent',
      wickUpColor: '#FFFFFF',
      wickDownColor: 'rgba(178,181,190,0.83)',
      priceLineVisible: true,
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
      chart.applyOptions({ autoSize: true })
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
    const eventSource = new EventSource('/api/live/mes15m?backfill=384')

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

        // Show all bars with proper barSpacing (don't fitContent — it overrides barSpacing)
        const totalBars = points.length
        const RIGHT_PADDING = 16
        chartRef.current?.timeScale().setVisibleLogicalRange({
          from: 0,
          to: totalBars - 1 + RIGHT_PADDING,
        })

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

    // Run fib calculation on candle data for snap-blend alignment (multi-period confluence)
    const candles = points.map(toCandle)
    const fib = calculateFibonacciMultiPeriod(candles)

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

    if (!chartSetups || chartSetups.length === 0 || pointsRef.current.length === 0) {
      bhgPrimitiveRef.current.setMarkers(null)
      return
    }

    const lastTime = pointsRef.current[pointsRef.current.length - 1].time

    bhgPrimitiveRef.current.setMarkers({
      setups: chartSetups,
      lastTime,
      futureBars: 8,
      barInterval: BAR_INTERVAL_SEC,
    })
  }, [chartSetups, lastPrice])

  const changeColor = priceChange >= 0 ? TV.bull.bright : TV.bear.bright

  return (
    <div
      className="relative w-full rounded-xl overflow-hidden border border-white/5"
      style={{ background: 'linear-gradient(180deg, #131722 0%, #0d1117 100%)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div
              className="w-2 h-2 rounded-full animate-pulse shadow-lg"
              style={{
                backgroundColor: status === 'live' ? '#26C6DA' : status === 'connecting' ? '#ffa726' : '#FF0000',
                boxShadow: status === 'live' ? '0 0 8px rgba(38,198,218,0.5)' : 'none',
              }}
            />
            <span className="text-base font-semibold text-white tracking-tight">MES</span>
          </div>
          <span className="text-xs text-white/30 font-medium">Micro E-mini S&P 500 &bull; 15m</span>
          {eventPhase && eventPhase !== 'CLEAR' && (
            <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md border ${
              eventPhase === 'BLACKOUT' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
              eventPhase === 'IMMINENT' ? 'bg-orange-500/10 text-orange-400 border-orange-500/20' :
              eventPhase === 'APPROACHING' ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' :
              eventPhase === 'DIGESTING' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' :
              'bg-white/5 text-white/40 border-white/10'
            }`}>
              {eventLabel ?? eventPhase}
            </span>
          )}
        </div>

        <div className="flex items-center gap-6">
          {sessionHigh != null && sessionLow != null && (
            <div className="flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-white/30">H</span>
                <span className="text-white/60 font-mono tabular-nums">{sessionHigh.toFixed(2)}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-white/30">L</span>
                <span className="text-white/60 font-mono tabular-nums">{sessionLow.toFixed(2)}</span>
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
            style={{ color: status === 'live' ? '#26C6DA' : status === 'connecting' ? '#ffa726' : '#FF0000' }}
          >
            {status}
          </span>
        </div>
      </div>

      {/* Chart */}
      <div ref={containerRef} className="w-full" style={{ height: '70vh' }} />

      {/* Legend Footer */}
      <div className="flex items-center justify-center gap-8 px-6 py-3 border-t border-white/5 bg-black/20">
        <div className="flex items-center gap-2">
          <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: '#26C6DA' }} />
          <span className="text-[10px] text-white/40 uppercase tracking-wider">Bullish</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-4 rounded-sm" style={{ backgroundColor: '#FF0000' }} />
          <span className="text-[10px] text-white/40 uppercase tracking-wider">Bearish</span>
        </div>
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
              <div className="w-2.5 h-2.5 rotate-45" style={{ backgroundColor: '#26C6DA' }} />
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
