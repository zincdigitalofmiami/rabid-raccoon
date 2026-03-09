import { NextResponse } from 'next/server'
import { classifyAIError, generateAIVision, isAIAvailable } from '@/lib/ai-provider'
import { prisma } from '@/lib/prisma'
import { aggregateCandles } from '@/lib/analyse-data'
import { toNum } from '@/lib/decimal'
import type { Decimal } from '@prisma/client/runtime/client'
import type { CandleData } from '@/lib/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface ChartRequestBody {
  image: string // base64 PNG from chart.takeScreenshot()
}

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

function formatCandles(candles: CandleData[], limit: number): string {
  const recent = candles.slice(-limit)
  return recent
    .map(
      (c) =>
        `${new Date(c.time * 1000).toISOString().slice(0, 16)} O:${c.open.toFixed(2)} H:${c.high.toFixed(2)} L:${c.low.toFixed(2)} C:${c.close.toFixed(2)}`
    )
    .join('\n')
}

export async function POST(request: Request): Promise<Response> {
  if (!isAIAvailable()) {
    return NextResponse.json(
      { error: 'AI provider is not configured in this environment.' },
      { status: 503 }
    )
  }

  let body: ChartRequestBody
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
    // Fetch 15m candles from DB and aggregate to 1h/4h
    const rows15m = await prisma.mktFuturesMes15m.findMany({
      orderBy: { eventTime: 'desc' },
      take: 384, // 4 days of 15m bars = good coverage for 4h analysis
    })

    const candles15m = rows15m.reverse().map(prismaRowToCandle)
    const candles1h = aggregateCandles(candles15m, 60)
    const candles4h = aggregateCandles(candles15m, 240)

    // Build structured data string
    const structuredData = [
      '=== 15M OHLCV (last 48 bars) ===',
      formatCandles(candles15m, 48),
      '',
      '=== 1H OHLCV (last 24 bars) ===',
      formatCandles(candles1h, 24),
      '',
      '=== 4H OHLCV (last 12 bars) ===',
      formatCandles(candles4h, 12),
    ].join('\n')

    // Strip the data:image/png;base64, prefix if present
    const base64Data = body.image.replace(/^data:image\/\w+;base64,/, '')

    const analysisPrompt = `You are an expert technical analyst reviewing a Micro E-mini S&P 500 (MES) chart. The screenshot shows 15-minute candlesticks with any forecast targets/fibonacci overlays.

Analyze the chart image AND the structured OHLCV data below across THREE timeframes: 15M, 1H, and 4H.

For each timeframe, identify ALL visible chart patterns including:
- Reversals: Head & shoulders, inverse H&S, double top, double bottom, engulfing candles, hammers, shooting stars, evening/morning stars
- Continuations: Flags, pennants, measured moves (AB=CD), cup & handle
- Triangles: Ascending, descending, symmetric
- Line breaks: Support/resistance breaks, trendline breaks
- Channels/Wedges: Rising/falling wedge, ascending/descending channel
- Other: Gaps, volume climaxes, divergences

${structuredData}

Respond with ONLY valid JSON matching this schema (no markdown, no code fences):
{
  "timeframes": [
    {
      "tf": "15M",
      "patterns": [
        {
          "name": "pattern name",
          "type": "reversal|continuation|triangle|line_break|channel|other",
          "bias": "bullish|bearish|neutral",
          "confidence": 75,
          "keyLevels": [5980.50, 6010.25],
          "description": "brief description of the pattern and its implications"
        }
      ],
      "bias": "bullish|bearish|neutral",
      "summary": "brief timeframe summary"
    }
  ],
  "overallBias": "bullish|bearish|neutral",
  "overallSummary": "1-2 sentence overall assessment across all timeframes"
}`

    const result = await generateAIVision(analysisPrompt, {
      imageBase64: base64Data,
      mimeType: 'image/png',
      maxTokens: 4096,
    })

    let jsonText = result.text.trim()
    // Strip code fences if model wraps output
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    const analysis: ChartAnalysisResponse = JSON.parse(jsonText)
    return NextResponse.json(analysis)
  } catch (error) {
    const classified = classifyAIError(error)
    const msg = error instanceof Error ? error.message : String(error)
    console.error('[analyse/chart]', msg)

    if (
      classified.category === 'availability' ||
      classified.category === 'service_unavailable' ||
      classified.category === 'rate_limited' ||
      classified.category === 'timeout'
    ) {
      return NextResponse.json(
        { error: `Chart analysis unavailable: ${classified.publicMessage}` },
        { status: 503 }
      )
    }

    return NextResponse.json(
      { error: 'Chart analysis failed: AI service error' },
      { status: 500 }
    )
  }
}
