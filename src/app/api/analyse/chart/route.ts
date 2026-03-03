import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { aggregateCandles } from '@/lib/analyse-data'
import { toNum } from '@/lib/decimal'
import type { Decimal } from '@prisma/client/runtime/client'
import type { CandleData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface PatternResult {
  name: string
  type: 'reversal' | 'continuation' | 'triangle' | 'line_break' | 'channel' | 'other'
  bias: 'bullish' | 'bearish' | 'neutral'
  confidence: number
  keyLevels: number[]
  description: string
}

interface TimeframeAnalysis {
  tf: '15M' | '1H' | '4H'
  patterns: PatternResult[]
  bias: 'bullish' | 'bearish' | 'neutral'
  summary: string
}

interface ChartAnalysisResponse {
  timeframes: TimeframeAnalysis[]
  overallBias: 'bullish' | 'bearish' | 'neutral'
  overallSummary: string
}

function prismaRowToCandle(row: {
  eventTime: Date
  open: Decimal | number
  high: Decimal | number
  low: Decimal | number
  close: Decimal | number
  volume: bigint | null
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: toNum(row.open),
    high: toNum(row.high),
    low: toNum(row.low),
    close: toNum(row.close),
    volume: row.volume == null ? 0 : Number(row.volume),
  }
}

function detectBias(candles: CandleData[]): 'bullish' | 'bearish' | 'neutral' {
  if (candles.length < 3) return 'neutral'
  const recent = candles.slice(-5)
  const firstClose = recent[0].close
  const lastClose = recent[recent.length - 1].close
  const pctChange = (lastClose - firstClose) / firstClose
  if (pctChange > 0.001) return 'bullish'
  if (pctChange < -0.001) return 'bearish'
  return 'neutral'
}

function buildTimeframeAnalysis(
  candles: CandleData[],
  tf: '15M' | '1H' | '4H'
): TimeframeAnalysis {
  const bias = detectBias(candles)
  const recent = candles.slice(-10)
  const highs = recent.map((c) => c.high)
  const lows = recent.map((c) => c.low)
  const maxHigh = Math.max(...highs)
  const minLow = Math.min(...lows)

  return {
    tf,
    patterns: [],
    bias,
    summary: `${tf}: Price ranging ${minLow.toFixed(2)}-${maxHigh.toFixed(2)}, bias ${bias}. AI chart pattern detection disabled (Anthropic API removed).`,
  }
}

export async function POST(request: Request): Promise<Response> {
  let body: { image?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.image) {
    return NextResponse.json(
      { error: 'Missing image field (base64 PNG)' },
      { status: 400 }
    )
  }

  try {
    const rows15m = await prisma.mktFuturesMes15m.findMany({
      orderBy: { eventTime: 'desc' },
      take: 384,
    })

    const candles15m = rows15m.reverse().map(prismaRowToCandle)
    const candles1h = aggregateCandles(candles15m, 60)
    const candles4h = aggregateCandles(candles15m, 240)

    const analysis: ChartAnalysisResponse = {
      timeframes: [
        buildTimeframeAnalysis(candles15m, '15M'),
        buildTimeframeAnalysis(candles1h, '1H'),
        buildTimeframeAnalysis(candles4h, '4H'),
      ],
      overallBias: detectBias(candles1h),
      overallSummary:
        'Deterministic OHLCV-based bias detection. AI-powered visual chart pattern analysis has been disabled (Anthropic API removed).',
    }

    return NextResponse.json(analysis)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[analyse/chart]', msg)
    return NextResponse.json(
      { error: `Chart analysis failed: ${msg}` },
      { status: 500 }
    )
  }
}
