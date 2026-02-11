'use client'

interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  bullColor?: string
  bearColor?: string
  strokeWidth?: number
}

export default function Sparkline({
  data,
  width = 400,
  height = 120,
  bullColor = '#26a69a',
  bearColor = '#ef5350',
  strokeWidth = 2,
}: SparklineProps) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const padding = 4
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

  // Unique gradient ID per instance
  const gradId = `sparkGrad-${isBull ? 'b' : 'r'}-${width}-${height}`

  // Build gradient fill area
  const firstX = padding
  const lastX = padding + plotWidth
  const bottomY = height
  const areaPath =
    `M ${firstX},${padding + plotHeight - ((data[0] - min) / range) * plotHeight} ` +
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
      className="w-full h-full overflow-visible"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
