'use client'

import { CandleData, FibLevel, SwingPoint, MeasuredMove } from '@/lib/types'

interface TechChartProps {
  candles: CandleData[]
  fibLevels: FibLevel[]
  swingHighs: SwingPoint[]
  swingLows: SwingPoint[]
  measuredMoves: MeasuredMove[]
  entry: number
  stop: number
  target: number
}

const W = 1200
const H = 420
const PAD_TOP = 20
const PAD_BOT = 20
const PAD_LEFT = 8
const PRICE_COL = 72
const PLOT_W = W - PAD_LEFT - PRICE_COL
const PLOT_H = H - PAD_TOP - PAD_BOT

export default function TechChart({
  candles,
  fibLevels,
  swingHighs,
  swingLows,
  measuredMoves,
  entry,
  stop,
  target,
}: TechChartProps) {
  if (candles.length < 3) return null

  // Price range — include fibs, entry/stop/target
  const allPrices = [
    ...candles.flatMap(c => [c.high, c.low]),
    ...fibLevels.filter(f => !f.isExtension).map(f => f.price),
    ...(entry > 0 ? [entry] : []),
    ...(stop > 0 ? [stop] : []),
    ...(target > 0 ? [target] : []),
  ]
  const rawMin = Math.min(...allPrices)
  const rawMax = Math.max(...allPrices)
  const pad = (rawMax - rawMin) * 0.04
  const yMin = rawMin - pad
  const yMax = rawMax + pad
  const yRange = yMax - yMin || 1

  const y = (price: number) => PAD_TOP + ((yMax - price) / yRange) * PLOT_H
  const barW = PLOT_W / candles.length
  const bodyW = Math.max(barW * 0.55, 2)
  const x = (i: number) => PAD_LEFT + i * barW + barW / 2

  const lastPrice = candles[candles.length - 1].close
  const isUp = lastPrice >= candles[0].open

  // Price scale: pick ~6 nice levels
  const step = niceStep(yRange, 6)
  const scaleStart = Math.ceil(yMin / step) * step
  const scaleLevels: number[] = []
  for (let p = scaleStart; p <= yMax; p += step) scaleLevels.push(p)

  return (
    <div className="w-full rounded-xl border border-white/5 bg-[#0d1117] overflow-hidden">
      <div className="px-4 py-2 border-b border-white/5 flex items-center justify-between">
        <span className="text-xs font-bold text-white/30 uppercase tracking-[0.2em]">
          MES 15-Min Chart
        </span>
        <span className="text-xs tabular-nums" style={{ color: isUp ? '#26a69a' : '#ef5350' }}>
          {lastPrice.toFixed(2)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {/* Grid lines */}
        {scaleLevels.map(p => (
          <line
            key={`g-${p}`}
            x1={PAD_LEFT}
            y1={y(p)}
            x2={PAD_LEFT + PLOT_W}
            y2={y(p)}
            stroke="rgba(255,255,255,0.03)"
            strokeWidth="0.5"
          />
        ))}

        {/* Fibonacci levels — subtle dashed lines */}
        {fibLevels
          .filter(f => !f.isExtension && f.ratio > 0 && f.ratio < 1)
          .map(f => {
            const py = y(f.price)
            return (
              <g key={`fib-${f.ratio}`}>
                <line
                  x1={PAD_LEFT}
                  y1={py}
                  x2={PAD_LEFT + PLOT_W}
                  y2={py}
                  stroke={f.color}
                  strokeWidth="0.7"
                  strokeDasharray="6,4"
                  opacity="0.35"
                />
                <text
                  x={PAD_LEFT + PLOT_W + 4}
                  y={py + 3}
                  fill={f.color}
                  fontSize="9"
                  fontFamily="monospace"
                  opacity="0.6"
                >
                  {f.label}
                </text>
              </g>
            )
          })}

        {/* Entry / Stop / Target lines */}
        {entry > 0 && (
          <g>
            <line
              x1={PAD_LEFT}
              y1={y(entry)}
              x2={PAD_LEFT + PLOT_W}
              y2={y(entry)}
              stroke="#ffffff"
              strokeWidth="1"
              strokeDasharray="8,4"
              opacity="0.5"
            />
            <text
              x={PAD_LEFT + PLOT_W + 4}
              y={y(entry) + 3}
              fill="#ffffff"
              fontSize="9"
              fontWeight="bold"
              fontFamily="monospace"
              opacity="0.7"
            >
              E {entry.toFixed(2)}
            </text>
          </g>
        )}
        {stop > 0 && (
          <g>
            <line
              x1={PAD_LEFT}
              y1={y(stop)}
              x2={PAD_LEFT + PLOT_W}
              y2={y(stop)}
              stroke="#ef5350"
              strokeWidth="1.2"
              opacity="0.6"
            />
            <text
              x={PAD_LEFT + PLOT_W + 4}
              y={y(stop) + 3}
              fill="#ef5350"
              fontSize="9"
              fontWeight="bold"
              fontFamily="monospace"
              opacity="0.8"
            >
              S {stop.toFixed(2)}
            </text>
          </g>
        )}
        {target > 0 && (
          <g>
            <line
              x1={PAD_LEFT}
              y1={y(target)}
              x2={PAD_LEFT + PLOT_W}
              y2={y(target)}
              stroke="#26a69a"
              strokeWidth="1.2"
              opacity="0.6"
            />
            <text
              x={PAD_LEFT + PLOT_W + 4}
              y={y(target) + 3}
              fill="#26a69a"
              fontSize="9"
              fontWeight="bold"
              fontFamily="monospace"
              opacity="0.8"
            >
              T {target.toFixed(2)}
            </text>
          </g>
        )}

        {/* Measured move lines (A→B→C→D) */}
        {measuredMoves
          .filter(m => m.status === 'ACTIVE' || m.status === 'FORMING')
          .slice(0, 2)
          .map((mm, idx) => {
            const aX = x(Math.min(mm.pointA.barIndex, candles.length - 1))
            const bX = x(Math.min(mm.pointB.barIndex, candles.length - 1))
            const cX = x(Math.min(mm.pointC.barIndex, candles.length - 1))
            const dX = PAD_LEFT + PLOT_W - 10
            const color = mm.direction === 'BULLISH' ? '#26a69a' : '#ef5350'
            return (
              <g key={`mm-${idx}`} opacity="0.5">
                <polyline
                  points={`${aX},${y(mm.pointA.price)} ${bX},${y(mm.pointB.price)} ${cX},${y(mm.pointC.price)} ${dX},${y(mm.projectedD)}`}
                  fill="none"
                  stroke={color}
                  strokeWidth="1.5"
                  strokeDasharray="5,3"
                />
                {/* Labels */}
                <text x={aX} y={y(mm.pointA.price) + (mm.pointA.isHigh ? -6 : 12)} fill={color} fontSize="8" fontWeight="bold" textAnchor="middle" fontFamily="monospace">A</text>
                <text x={bX} y={y(mm.pointB.price) + (mm.pointB.isHigh ? -6 : 12)} fill={color} fontSize="8" fontWeight="bold" textAnchor="middle" fontFamily="monospace">B</text>
                <text x={cX} y={y(mm.pointC.price) + (mm.pointC.isHigh ? -6 : 12)} fill={color} fontSize="8" fontWeight="bold" textAnchor="middle" fontFamily="monospace">C</text>
                <text x={dX} y={y(mm.projectedD) + (mm.direction === 'BULLISH' ? -6 : 12)} fill={color} fontSize="8" fontWeight="bold" textAnchor="middle" fontFamily="monospace">D</text>
              </g>
            )
          })}

        {/* Candlesticks */}
        {candles.map((c, i) => {
          const cx = x(i)
          const up = c.close >= c.open
          const color = up ? '#26a69a' : '#ef5350'
          const top = y(Math.max(c.open, c.close))
          const bot = y(Math.min(c.open, c.close))
          const bodyH = Math.max(bot - top, 0.5)
          return (
            <g key={`c-${i}`}>
              <line x1={cx} y1={y(c.high)} x2={cx} y2={y(c.low)} stroke={color} strokeWidth="0.8" />
              <rect
                x={cx - bodyW / 2}
                y={top}
                width={bodyW}
                height={bodyH}
                fill={color}
                rx="0.5"
              />
            </g>
          )
        })}

        {/* Swing highs — tiny dots */}
        {swingHighs.slice(0, 8).map((s, i) => {
          if (s.barIndex >= candles.length) return null
          return (
            <circle
              key={`sh-${i}`}
              cx={x(s.barIndex)}
              cy={y(s.price) - 5}
              r="2"
              fill="#ef5350"
              opacity="0.4"
            />
          )
        })}

        {/* Swing lows — tiny dots */}
        {swingLows.slice(0, 8).map((s, i) => {
          if (s.barIndex >= candles.length) return null
          return (
            <circle
              key={`sl-${i}`}
              cx={x(s.barIndex)}
              cy={y(s.price) + 5}
              r="2"
              fill="#26a69a"
              opacity="0.4"
            />
          )
        })}

        {/* Current price line */}
        <line
          x1={PAD_LEFT}
          y1={y(lastPrice)}
          x2={PAD_LEFT + PLOT_W}
          y2={y(lastPrice)}
          stroke={isUp ? '#26a69a' : '#ef5350'}
          strokeWidth="0.6"
          strokeDasharray="2,2"
          opacity="0.5"
        />

        {/* Price scale */}
        {scaleLevels.map(p => (
          <text
            key={`ps-${p}`}
            x={PAD_LEFT + PLOT_W + 4}
            y={y(p) + 3}
            fill="rgba(255,255,255,0.15)"
            fontSize="8"
            fontFamily="monospace"
          >
            {p.toFixed(2)}
          </text>
        ))}

        {/* Current price tag */}
        <rect
          x={PAD_LEFT + PLOT_W + 1}
          y={y(lastPrice) - 7}
          width={PRICE_COL - 4}
          height={14}
          rx="2"
          fill={isUp ? '#26a69a' : '#ef5350'}
        />
        <text
          x={PAD_LEFT + PLOT_W + 4}
          y={y(lastPrice) + 3}
          fill="#fff"
          fontSize="9"
          fontWeight="bold"
          fontFamily="monospace"
        >
          {lastPrice.toFixed(2)}
        </text>
      </svg>
    </div>
  )
}

function niceStep(range: number, targetTicks: number): number {
  const rough = range / targetTicks
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  let step: number
  if (norm < 1.5) step = 1
  else if (norm < 3.5) step = 2
  else if (norm < 7.5) step = 5
  else step = 10
  return step * mag
}
