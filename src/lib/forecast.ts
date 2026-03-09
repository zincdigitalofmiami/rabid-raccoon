import { classifyAIError, generateAIText, isAIAvailable } from './ai-provider'
import {
  ForecastResponse,
  MarketSummary,
  CompositeSignal,
  MeasuredMove,
  SymbolForecast,
} from './types'
import { ForecastWindow } from './forecast-cache'
import { MarketContext } from './market-context'

interface ForecastInput {
  symbols: MarketSummary[]
  compositeSignal: CompositeSignal
  window: ForecastWindow
  marketContext?: MarketContext | null
}

const WINDOW_PROMPTS: Record<ForecastWindow, string> = {
  morning:
    'MORNING ANALYSIS. Focus on opening-session plan and key triggers for the first 2-4 hours.',
  premarket:
    'PREMARKET SIGNAL. Keep it concise and tactical for the open.',
  midday:
    'MIDDAY UPDATE. Reassess intraday structure and whether signals are strengthening or fading.',
  afterhours:
    'AFTER-HOURS SNAPSHOT. Do not reference "morning thesis". Focus on session close state and next-session setup.',
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums.map((n) => Number(n.toFixed(2))))].sort((a, b) => a - b)
}

function getMesMeasuredMoves(symbols: MarketSummary[]): MeasuredMove[] {
  const mes = symbols.find((s) => s.symbol === 'MES')
  if (!mes?.signal?.measuredMove) return []
  return [mes.signal.measuredMove]
}

function userFacingFallbackNote(reason?: string): string {
  if (!reason) return 'Deterministic mode active.'
  return 'Deterministic mode active.'
}

function inferKeyLevels(symbols: MarketSummary[]): { support: number[]; resistance: number[] } {
  const mes = symbols.find((s) => s.symbol === 'MES') || symbols[0]
  if (!mes) return { support: [], resistance: [] }

  const mm = mes.signal.measuredMove
  if (mm) {
    if (mm.direction === 'BULLISH') {
      return {
        support: uniqueSorted([mm.entry, mm.stop, mes.price * 0.998]).slice(-3),
        resistance: uniqueSorted([mm.target, mes.price * 1.003]).slice(0, 3),
      }
    }
    return {
      support: uniqueSorted([mm.target, mes.price * 0.997]).slice(-3),
      resistance: uniqueSorted([mm.entry, mm.stop, mes.price * 1.002]).slice(0, 3),
    }
  }

  return {
    support: uniqueSorted([mes.price * 0.995, mes.price * 0.99]).slice(-3),
    resistance: uniqueSorted([mes.price * 1.005, mes.price * 1.01]).slice(0, 3),
  }
}

function deterministicForecast(input: ForecastInput, reason?: string): ForecastResponse {
  const { symbols, compositeSignal, window, marketContext } = input
  const mesMeasuredMoves = getMesMeasuredMoves(symbols)

  const mes = symbols.find((s) => s.symbol === 'MES') || symbols[0]
  const mesLine = mes
    ? `MES ${mes.direction} ${mes.signal.confidence}% at ${mes.price.toFixed(2)} (${mes.changePercent >= 0 ? '+' : ''}${mes.changePercent.toFixed(2)}%).`
    : 'MES data unavailable.'

  const activeMoves = mesMeasuredMoves.filter((m) => m.status === 'ACTIVE').length
  const fallbackNote = userFacingFallbackNote(reason)
  const analysis =
    `TL;DR: ${compositeSignal.direction} bias at ${compositeSignal.confidence}% confidence from deterministic signals only. ` +
    `${mesLine} ` +
    `MES active measured moves: ${activeMoves}. ` +
    `Confluence: ${compositeSignal.confluenceSummary.slice(0, 4).join(' | ') || 'none'}. ` +
    `${marketContext?.yieldContext ? `US10Y ${marketContext.yieldContext.tenYearYield.toFixed(2)}% (${marketContext.yieldContext.tenYearChangeBp >= 0 ? '+' : ''}${marketContext.yieldContext.tenYearChangeBp.toFixed(1)} bp). ` : ''}` +
    `${marketContext?.breakout7000 ? `SPX 7,000: ${marketContext.breakout7000.status}. ` : ''}` +
    `Window: ${window}. ` +
    fallbackNote

  const keyLevels = inferKeyLevels(symbols)
  const symbolForecasts: SymbolForecast[] = compositeSignal.symbolSignals.map((s) => ({
    symbol: s.symbol,
    direction: s.direction,
    confidence: clamp(s.confidence, 50, 95),
  }))

  return {
    window,
    direction: compositeSignal.direction,
    confidence: clamp(compositeSignal.confidence, 50, 95),
    analysis,
    symbolForecasts,
    keyLevels,
    measuredMoves: mesMeasuredMoves,
    intermarketNotes: compositeSignal.confluenceSummary.slice(0, 8),
    generatedAt: new Date().toISOString(),
  }
}

function sanitizeForecast(
  parsed: unknown,
  input: ForecastInput
): Omit<ForecastResponse, 'window' | 'measuredMoves' | 'generatedAt'> {
  const fallback = deterministicForecast(input)
  const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>

  // Keep direction/confidence/symbol forecasts/levels deterministic from real signal math.
  const direction = fallback.direction
  const confidence = fallback.confidence

  const analysis =
    typeof p.analysis === 'string' && p.analysis.trim().length > 0
      ? p.analysis.trim()
      : fallback.analysis

  const symbolForecasts: SymbolForecast[] = fallback.symbolForecasts
  const support = fallback.keyLevels.support
  const resistance = fallback.keyLevels.resistance

  const intermarketNotes = Array.isArray(p.intermarketNotes)
    ? p.intermarketNotes
      .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
      .map((n) => n.trim())
      .slice(0, 10)
    : fallback.intermarketNotes

  return {
    direction,
    confidence,
    analysis,
    symbolForecasts,
    keyLevels: { support, resistance },
    intermarketNotes,
  }
}

export async function generateForecast(input: ForecastInput): Promise<ForecastResponse> {
  const { symbols, compositeSignal, window, marketContext } = input

  const mesMeasuredMoves = getMesMeasuredMoves(symbols)

  const marketDataLines = symbols.map((s) => {
    const dir = s.direction === 'BULLISH' ? '▲' : '▼'
    const chgSign = s.changePercent >= 0 ? '+' : ''
    const factors = s.signal.confluenceFactors.join(', ')
    return `${s.displayName}: ${s.price.toFixed(2)} (${chgSign}${s.changePercent.toFixed(2)}%) ${dir} ${s.signal.confidence}% | ${factors}`
  })

  const measuredMoveLines = mesMeasuredMoves.map((m) => {
    const sym = symbols.find((s) => s.signal.measuredMove === m)?.displayName || '?'
    return `${sym} ${m.direction} AB=CD: A=${m.pointA.price.toFixed(2)} B=${m.pointB.price.toFixed(2)} C=${m.pointC.price.toFixed(2)} -> D=${m.projectedD.toFixed(2)} | Entry ${m.entry.toFixed(2)} Stop ${m.stop.toFixed(2)} Target ${m.target.toFixed(2)} | Quality ${m.quality}/100 Status ${m.status}`
  })

  const corrLines =
    marketContext?.correlations?.map((c) => `${c.pair}=${c.value} (${c.interpretation})`).join(' | ') ||
    'data unavailable'
  const ratesLine = marketContext?.yieldContext
    ? `US10Y ${marketContext.yieldContext.tenYearYield.toFixed(2)}% (${marketContext.yieldContext.tenYearChangeBp >= 0 ? '+' : ''}${marketContext.yieldContext.tenYearChangeBp.toFixed(1)} bp); FedFunds ${marketContext.yieldContext.fedFundsRate == null ? 'n/a' : `${marketContext.yieldContext.fedFundsRate.toFixed(2)}%`}; Spread ${marketContext.yieldContext.spread10yMinusFedBp == null ? 'n/a' : `${marketContext.yieldContext.spread10yMinusFedBp.toFixed(1)} bp`}`
    : 'US10Y/Fed data unavailable'
  const techLine =
    marketContext?.techLeaders?.map((t) => `${t.symbol} ${t.dayChangePercent >= 0 ? '+' : ''}${t.dayChangePercent.toFixed(2)}%`).join(' | ') ||
    'data unavailable'
  const themesLine = marketContext
    ? `Tariffs=${marketContext.themeScores.tariffs}, Rates=${marketContext.themeScores.rates}, Trump=${marketContext.themeScores.trump}, Analysts=${marketContext.themeScores.analysts}, AI/Tech=${marketContext.themeScores.aiTech}, EventRisk=${marketContext.themeScores.eventRisk}`
    : 'data unavailable'
  const shockLine = marketContext
    ? `VIX spike n=${marketContext.shockReactions.vixSpikeSample}, avg next MES=${marketContext.shockReactions.vixSpikeAvgNextDayMesPct == null ? 'n/a' : `${marketContext.shockReactions.vixSpikeAvgNextDayMesPct.toFixed(2)}%`}; 10Y spike n=${marketContext.shockReactions.yieldSpikeSample}, avg next MES=${marketContext.shockReactions.yieldSpikeAvgNextDayMesPct == null ? 'n/a' : `${marketContext.shockReactions.yieldSpikeAvgNextDayMesPct.toFixed(2)}%`}`
    : 'data unavailable'
  const breakoutLine = marketContext?.breakout7000
    ? `status=${marketContext.breakout7000.status}; close=${marketContext.breakout7000.latestClose.toFixed(2)}; dist=${marketContext.breakout7000.distanceFromLevel >= 0 ? '+' : ''}${marketContext.breakout7000.distanceFromLevel.toFixed(2)}; last2=${marketContext.breakout7000.lastTwoCloses[0].toFixed(2)},${marketContext.breakout7000.lastTwoCloses[1].toFixed(2)}; twoCloseConfirmation=${marketContext.breakout7000.twoCloseConfirmation}; plan=${marketContext.breakout7000.tradePlan}`
    : 'data unavailable'

  const prompt = `You are a futures market analyst. Be math-first, concise, and data-bound.
Use only the data below. Do not invent external facts, policy events, or date-specific narratives.
If a datapoint is unavailable, say "data unavailable".

MARKET DATA:
${marketDataLines.join('\n')}

COMPOSITE SIGNAL: ${compositeSignal.direction} ${compositeSignal.confidence}%
Confluence: ${compositeSignal.confluenceSummary.join(' | ')}

MEASURED MOVES:
${measuredMoveLines.length > 0 ? measuredMoveLines.join('\n') : 'No active measured move patterns detected.'}

CORRELATIONS (explicitly use MES↔VX and MES↔US10Y when available):
${corrLines}

RATES CONTEXT:
${ratesLine}

TOP AI/TECH DRIVERS:
${techLine}

NEWS THEME SCORES:
${themesLine}

HISTORICAL SHOCK BASELINE:
${shockLine}

SPX 7,000 BREAKOUT DETECTOR (strict two-close confirmation):
${breakoutLine}

WINDOW:
${window.toUpperCase()} — ${WINDOW_PROMPTS[window]}

Return JSON only:
{
  "direction": "BULLISH" | "BEARISH",
  "confidence": 50-95,
  "analysis": "4-7 short sentences. Start with TL;DR. Include numeric state, VIX + US10Y references, one invalidation risk, and one concrete trade trigger plan.",
  "symbolForecasts": [{"symbol":"MES","direction":"BULLISH","confidence":78}, ...for all input symbols],
  "keyLevels": {"support":[number, number], "resistance":[number, number]},
  "intermarketNotes": ["short note", "short note"]
}

Hard constraints:
- Do not reference "morning thesis" unless WINDOW is MORNING.
- Respect 7,000 breakout as valid only after two consecutive closes above 7,000.
- Keep numbers realistic to provided prices.
- Output valid JSON and nothing else.`

  if (!isAIAvailable()) {
    return deterministicForecast(input, 'AI provider is not configured in this environment.')
  }

  try {
    const response = await generateAIText(prompt, { maxTokens: 1800 })

    const text = response.text?.trim()
    if (!text) {
      return deterministicForecast(input, 'AI model returned empty text')
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      const m = text.match(/\{[\s\S]*\}/)
      if (!m) return deterministicForecast(input, 'Failed to parse JSON from AI response')
      parsed = JSON.parse(m[0])
    }

    const cleaned = sanitizeForecast(parsed, input)
    return {
      window,
      ...cleaned,
      measuredMoves: mesMeasuredMoves,
      generatedAt: new Date().toISOString(),
    }
  } catch (error) {
    const classified = classifyAIError(error)
    return deterministicForecast(input, classified.publicMessage)
  }
}
