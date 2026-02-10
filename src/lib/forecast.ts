import Anthropic from '@anthropic-ai/sdk'
import { ForecastResponse, MarketSummary, CompositeSignal, MeasuredMove, SymbolForecast } from './types'
import { getCurrentWindow } from './forecast-cache'

const client = new Anthropic()

interface ForecastInput {
  symbols: MarketSummary[]
  compositeSignal: CompositeSignal
  window: 'morning' | 'premarket' | 'midday'
}

const WINDOW_PROMPTS: Record<string, string> = {
  morning:
    'Generate a comprehensive MORNING ANALYSIS for the upcoming trading session. This is the primary daily forecast. Be thorough with measured move setups, fibonacci levels, intermarket correlations, and specific trade ideas.',
  premarket:
    'Generate a PREMARKET SIGNAL update. The market opens in minutes. Be concise and actionable — focus on the immediate opening trade setup, updated levels, and any overnight developments that change the thesis.',
  midday:
    'Generate a MIDDAY UPDATE reassessing the morning thesis. What has played out? What has changed? Update measured move targets and signal confidence based on actual price action.',
}

export async function generateForecast(input: ForecastInput): Promise<ForecastResponse> {
  const { symbols, compositeSignal, window } = input

  // Build market data section
  const marketDataLines = symbols.map((s) => {
    const dir = s.direction === 'BULLISH' ? '▲' : '▼'
    const chgSign = s.changePercent >= 0 ? '+' : ''
    const factors = s.signal.confluenceFactors.join(', ')
    return `${s.displayName}: ${s.price.toFixed(2)} (${chgSign}${s.changePercent.toFixed(2)}%) ${dir} ${s.signal.confidence}% | ${factors}`
  })

  // Build measured move section
  const allMeasuredMoves: MeasuredMove[] = []
  for (const s of symbols) {
    if (s.signal.measuredMove) {
      allMeasuredMoves.push(s.signal.measuredMove)
    }
  }

  const measuredMoveLines = allMeasuredMoves.map((m) => {
    const sym = symbols.find((s) => s.signal.measuredMove === m)?.displayName || '?'
    return `${sym} ${m.direction} AB=CD: A=${m.pointA.price.toFixed(2)} B=${m.pointB.price.toFixed(2)} C=${m.pointC.price.toFixed(2)} → D=${m.projectedD.toFixed(2)} | Entry ${m.entry.toFixed(2)} Stop ${m.stop.toFixed(2)} Target ${m.target.toFixed(2)} | Quality ${m.quality}/100 Status ${m.status}`
  })

  const prompt = `You are a professional futures market analyst using David Halsey's Measured Move Trading methodology. You analyze E-mini S&P 500 (MES) futures and correlated intermarket instruments.

MARKET DATA (Live):
${marketDataLines.join('\n')}

COMPOSITE SIGNAL: ${compositeSignal.direction} ${compositeSignal.confidence}%
Confluence: ${compositeSignal.confluenceSummary.join(' | ')}

MEASURED MOVES (AB=CD Patterns):
${measuredMoveLines.length > 0 ? measuredMoveLines.join('\n') : 'No active measured move patterns detected.'}

${WINDOW_PROMPTS[window]}

Respond ONLY with a JSON object in this exact format (no markdown, no code fences):
{
  "direction": "BULLISH" or "BEARISH",
  "confidence": number 50-95,
  "analysis": "2-4 paragraph analysis text covering thesis, measured moves, intermarket dynamics, and risk factors",
  "symbolForecasts": [{"symbol": "MES", "direction": "BULLISH", "confidence": 78}, ...for all 8 symbols],
  "keyLevels": {"support": [number, number], "resistance": [number, number]},
  "intermarketNotes": ["NQ leading ES = risk-on", "VIX declining supports bullish thesis", ...]
}`

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  })

  // Parse Claude's response
  const responseText = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')

  let parsed: {
    direction: 'BULLISH' | 'BEARISH'
    confidence: number
    analysis: string
    symbolForecasts: SymbolForecast[]
    keyLevels: { support: number[]; resistance: number[] }
    intermarketNotes: string[]
  }

  try {
    parsed = JSON.parse(responseText)
  } catch {
    // If Claude doesn't return clean JSON, try to extract it
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[0])
    } else {
      // Fallback: use signal engine data
      parsed = {
        direction: compositeSignal.direction,
        confidence: compositeSignal.confidence,
        analysis: responseText || 'Forecast generation in progress. Using signal engine data.',
        symbolForecasts: compositeSignal.symbolSignals.map((s) => ({
          symbol: s.symbol,
          direction: s.direction,
          confidence: s.confidence,
        })),
        keyLevels: { support: [], resistance: [] },
        intermarketNotes: compositeSignal.confluenceSummary,
      }
    }
  }

  return {
    window,
    direction: parsed.direction,
    confidence: parsed.confidence,
    analysis: parsed.analysis,
    symbolForecasts: parsed.symbolForecasts,
    keyLevels: parsed.keyLevels,
    measuredMoves: allMeasuredMoves,
    intermarketNotes: parsed.intermarketNotes,
    generatedAt: new Date().toISOString(),
  }
}
