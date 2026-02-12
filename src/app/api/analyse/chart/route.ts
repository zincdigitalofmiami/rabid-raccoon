import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { aggregateCandles } from '@/lib/analyse-data'
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
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}): CandleData {
  return {
    time: Math.floor(row.eventTime.getTime() / 1000),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
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
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'ANTHROPIC_API_KEY not set' },
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
    const rows15m = await prisma.mesPrice15m.findMany({
      orderBy: { eventTime: 'desc' },
      take: 384, // 4 days of 15m bars = good coverage for 4h analysis
    })

    const candles15m = rows15m.reverse().map(prismaRowToCandle)
    const candles1h = aggregateCandles(candles15m, 60)
    const candles4h = aggregateCandles(candles15m, 240)

    // Build structured data string for Claude
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

    const client = new Anthropic({ apiKey })

    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64Data,
              },
            },
            {
              type: 'text',
              text: `You are an expert technical analyst reviewing a Micro E-mini S&P 500 (MES) chart. The screenshot shows 15-minute candlesticks with any forecast targets/fibonacci overlays.

Analyze the chart image AND the structured OHLCV data below across THREE timeframes: 15M, 1H, and 4H.

For each timeframe, identify ALL visible chart patterns including:
- **Reversals**: Head & shoulders, inverse H&S, double top, double bottom, engulfing candles, hammers, shooting stars, evening/morning stars
- **Continuations**: Flags, pennants, measured moves (AB=CD), cup & handle
- **Triangles**: Ascending, descending, symmetric
- **Line breaks**: Support/resistance breaks, trendline breaks
- **Channels/Wedges**: Rising/falling wedge, ascending/descending channel
- **Other**: Gaps, volume climaxes, divergences

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
}`,
            },
          ],
        },
      ],
    })

    // Extract text content from Claude response
    const textBlock = response.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return NextResponse.json(
        { error: 'No text response from Claude' },
        { status: 502 }
      )
    }

    // Parse JSON — Claude sometimes wraps in code fences
    let jsonText = textBlock.text.trim()
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }

    const analysis: ChartAnalysisResponse = JSON.parse(jsonText)
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
