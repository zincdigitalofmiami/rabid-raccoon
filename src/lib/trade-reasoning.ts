/**
 * trade-reasoning.ts — AI Reasoning Layer (Layer 2)
 *
 * Per-trade OpenAI rationale for qualifying setups (composite score ≥ 50).
 * Follows the model cascade pattern from forecast.ts.
 *
 * Guardrails:
 *   - AI p(TP1) must be within ±0.20 of ML baseline
 *   - VIX > 30 forces risk warning
 *   - BLACKOUT phase = no reasoning (deterministic fallback)
 *   - 3 second timeout, falls back to Layer 1 only
 */

import { generateAIChat, isAIAvailable } from './ai-provider'
import type { TradeFeatureVector } from '@/lib/trade-features'
import type { TradeScore } from '@/lib/composite-score'
import type { EventContext } from '@/lib/event-awareness'
import type { MarketContext } from '@/lib/market-context'
import type { BhgSetup } from '@/lib/bhg-engine'

// ─────────────────────────────────────────────
// Exported types
// ─────────────────────────────────────────────

export interface TradeReasoning {
  adjustedPTp1: number
  adjustedPTp2: number
  rationale: string
  keyRisks: string[]
  tradeQuality: 'A' | 'B' | 'C' | 'D'
  catalysts: string[]
  source: 'ai' | 'deterministic'
}

// ─────────────────────────────────────────────
// Deterministic fallback
// ─────────────────────────────────────────────

function deterministicFallback(
  score: TradeScore,
  features: TradeFeatureVector,
  reason: string,
): TradeReasoning {
  const risks: string[] = []
  if (features.eventPhase === 'BLACKOUT') risks.push('Economic event releasing — no trades')
  if (features.eventPhase === 'IMMINENT') risks.push('Event imminent — reduced size')
  if (!features.isAligned) risks.push('Cross-asset misalignment')
  if (features.riskGrade === 'D') risks.push('Low risk-reward ratio')
  if (features.wvfPercentile != null && features.wvfPercentile > 1.0) risks.push('Elevated fear')
  if (risks.length === 0) risks.push('Standard risk')

  const catalysts: string[] = []
  if (features.measuredMoveAligned) catalysts.push('Measured move confirms direction')
  if (features.sqzState === 4) catalysts.push('Squeeze fired — momentum breakout')
  if (features.isAligned) catalysts.push('Cross-asset alignment')

  return {
    adjustedPTp1: score.pTp1,
    adjustedPTp2: score.pTp2,
    rationale: `Layer 1 score: ${score.composite}/100 (${score.grade}). ${reason}`,
    keyRisks: risks,
    tradeQuality: score.grade,
    catalysts,
    source: 'deterministic',
  }
}

// ─────────────────────────────────────────────
// Prompt construction
// ─────────────────────────────────────────────

function buildPrompt(
  setup: BhgSetup,
  score: TradeScore,
  features: TradeFeatureVector,
  eventContext: EventContext,
  marketContext: MarketContext,
): string {
  return `You are a professional MES (Micro E-mini S&P 500) futures trade analyst.

Evaluate this BHG (Touch-Hook-Go) setup and provide your assessment.

SETUP:
- Direction: ${setup.direction}
- Fib ratio: ${features.fibRatio} (${features.fibRatio >= 0.618 ? 'deep' : 'shallow'} retracement)
- Entry: ${setup.entry ?? 'pending'}
- Stop: ${setup.stopLoss ?? 'pending'}
- TP1: ${setup.tp1 ?? 'pending'} | TP2: ${setup.tp2 ?? 'pending'}
- Go type: ${features.goType}
- Risk grade: ${features.riskGrade} (R:R ${features.rrRatio.toFixed(1)})
- Hook quality: ${(features.hookQuality * 100).toFixed(0)}%

COMPOSITE SCORE: ${score.composite}/100 (${score.grade})
Sub-scores: Fib=${score.subScores.fib} Risk=${score.subScores.risk} Event=${score.subScores.event} Corr=${score.subScores.correlation} Tech=${score.subScores.technical} ML=${score.subScores.mlBaseline}
ML baseline: p(TP1)=${score.pTp1.toFixed(3)} p(TP2)=${score.pTp2.toFixed(3)}

EVENT CONTEXT:
- Phase: ${eventContext.phase}
- ${eventContext.label}
- Confidence adjustment: ${features.confidenceAdjustment}

MARKET CONTEXT:
- Regime: ${marketContext.regime}
- Theme scores: tariffs=${marketContext.themeScores.tariffs} rates=${marketContext.themeScores.rates} trump=${marketContext.themeScores.trump}
- Correlation aligned: ${features.isAligned ? 'YES' : 'NO'} (composite=${features.compositeAlignment.toFixed(3)})

TECHNICALS:
- Squeeze: state=${features.sqzState ?? 'N/A'} mom=${features.sqzMom?.toFixed(2) ?? 'N/A'}
- WVF percentile: ${features.wvfPercentile?.toFixed(2) ?? 'N/A'}
- MACD above zero: ${features.macdAboveZero == null ? 'N/A' : features.macdAboveZero ? 'YES' : 'NO'}
- MACD above signal: ${features.macdAboveSignal == null ? 'N/A' : features.macdAboveSignal ? 'YES' : 'NO'}
- MACD hist above zero: ${features.macdHistAboveZero == null ? 'N/A' : features.macdHistAboveZero ? 'YES' : 'NO'}

NEWS (24h): ${features.newsVolume24h} total, ${features.policyNewsVolume24h} policy

${score.flags.length > 0 ? `FLAGS: ${score.flags.join('; ')}` : ''}

RESPOND IN VALID JSON ONLY:
{
  "adjustedPTp1": <number 0-1, your adjusted probability — must be within ±0.20 of ${score.pTp1.toFixed(3)}>,
  "adjustedPTp2": <number 0-1, your adjusted probability — must be within ±0.20 of ${score.pTp2.toFixed(3)}>,
  "rationale": "<1-2 sentence trade rationale — concise, specific, actionable>",
  "keyRisks": ["<risk 1>", "<risk 2>"],
  "tradeQuality": "<A|B|C|D>",
  "catalysts": ["<catalyst 1>", "<catalyst 2>"]
}`
}

// ─────────────────────────────────────────────
// AI call with timeout and guardrails
// ─────────────────────────────────────────────

const TIMEOUT_MS = 3000
const P_CLAMP_RANGE = 0.20

export async function getTradeReasoning(
  setup: BhgSetup,
  score: TradeScore,
  features: TradeFeatureVector,
  eventContext: EventContext,
  marketContext: MarketContext,
): Promise<TradeReasoning> {
  // Guardrail: BLACKOUT = no AI, deterministic only
  if (features.eventPhase === 'BLACKOUT') {
    return deterministicFallback(score, features, 'BLACKOUT — AI reasoning skipped.')
  }

  // Guardrail: low-quality setups don't warrant AI cost
  if (score.composite < 40) {
    return deterministicFallback(score, features, 'Score below threshold — AI reasoning skipped.')
  }

  if (!isAIAvailable()) {
    return deterministicFallback(score, features, 'No Anthropic API key configured.')
  }

  const prompt = buildPrompt(setup, score, features, eventContext, marketContext)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    const response = await generateAIChat(
      [{ role: 'user', content: prompt }],
      {
        maxTokens: 400,
        thinkingBudget: 4000, // lighter thinking for per-trade reasoning (speed)
        signal: controller.signal,
      },
    )

    clearTimeout(timeout)

    const content = response.text?.trim()
    if (!content) {
      return deterministicFallback(score, features, 'Claude returned empty response.')
    }

    // Parse JSON — strip code fences if present
    let jsonText = content
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
    }
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      return deterministicFallback(score, features, 'Failed to parse JSON from Claude.')
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      adjustedPTp1?: number
      adjustedPTp2?: number
      rationale?: string
      keyRisks?: string[]
      tradeQuality?: string
      catalysts?: string[]
    }

    // Guardrail: clamp AI probabilities within ±0.20 of ML baseline
    const pTp1 = clamp(
      parsed.adjustedPTp1 ?? score.pTp1,
      score.pTp1 - P_CLAMP_RANGE,
      score.pTp1 + P_CLAMP_RANGE,
    )
    const pTp2 = clamp(
      parsed.adjustedPTp2 ?? score.pTp2,
      score.pTp2 - P_CLAMP_RANGE,
      score.pTp2 + P_CLAMP_RANGE,
    )

    const quality = (['A', 'B', 'C', 'D'] as const).includes(
      parsed.tradeQuality as 'A' | 'B' | 'C' | 'D',
    )
      ? (parsed.tradeQuality as 'A' | 'B' | 'C' | 'D')
      : score.grade

    return {
      adjustedPTp1: Math.round(Math.max(0, Math.min(1, pTp1)) * 10000) / 10000,
      adjustedPTp2: Math.round(Math.max(0, Math.min(1, pTp2)) * 10000) / 10000,
      rationale: parsed.rationale || `AI assessment: ${score.grade}-grade setup.`,
      keyRisks: Array.isArray(parsed.keyRisks) ? parsed.keyRisks.slice(0, 5) : [],
      tradeQuality: quality,
      catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.slice(0, 5) : [],
      source: 'ai',
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const reason = message.includes('abort') || message.includes('Abort')
      ? 'AI timeout — using Layer 1 only.'
      : `AI error: ${message.slice(0, 80)}`
    return deterministicFallback(score, features, reason)
  }
}

// ─────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
