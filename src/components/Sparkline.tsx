'use client'

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  bullColor?: string
  bearColor?: string
}

export default function Sparkline({
  data,
  width = 120,
  height = 40,
  bullColor = '#26a69a',
  bearColor = '#ef5350',
}: SparklineProps) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const padding = 2
  const plotWidth = width - padding * 2
  const plotHeight = height - padding * 2

  const points = data
    .map((value, i) => {
      const x = padding + (i / (data.length - 1)) * plotWidth
      const y = padding + plotHeight - ((value - min) / range) * plotHeight
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const isBull = data[data.length - 1] >= data[0]
  const color = isBull ? bullColor : bearColor

  // Build gradient fill area
  const firstX = padding
  const lastX = padding + plotWidth
  const bottomY = height
  const areaPath = `M ${firstX},${padding + plotHeight - ((data[0] - min) / range) * plotHeight} ` +
    data
      .map((value, i) => {
        const x = padding + (i / (data.length - 1)) * plotWidth
        const y = padding + plotHeight - ((value - min) / range) * plotHeight
        return `L ${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ') +
    ` L ${lastX},${bottomY} L ${firstX},${bottomY} Z`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={`sparkGrad-${isBull ? 'bull' : 'bear'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={areaPath}
        fill={`url(#sparkGrad-${isBull ? 'bull' : 'bear'})`}
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
