/**
 * ai-provider.ts -- Unified AI provider for the entire application.
 *
 * ONE model. ONE config. ONE place to change anything.
 *
 * Provider: Anthropic Claude via Vercel AI Gateway
 * Model: Claude Sonnet 4.5 with Extended Thinking
 *
 * ── Auth paths ──────────────────────────────────────────────────────
 *
 *   Production/Preview (Vercel):
 *     gateway() provider + OIDC (automatic, $0.00 with Max subscription)
 *
 *   Local dev:
 *     gateway() provider + Vercel CLI/OIDC context
 *
 * ── Temperature ────────────────────────────────────────────────────
 *
 * Default: 0.15 (very low creativity — data-driven quant output).
 * When extended thinking is enabled, the server locks temperature at 1.0.
 */

import type { AnthropicLanguageModelOptions } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { generateText, gateway } from 'ai'

export type AIAuthMethod =
  | 'gateway_oidc'
  | 'none'

// ── Central config ─────────────────────────────────────────────────
// Gateway model ID format: "provider/model-name"
const GATEWAY_MODEL_ID =
  process.env.CLAUDE_MODEL || 'anthropic/claude-sonnet-4-5'

// Extended thinking token budget (higher = deeper reasoning)
const DEFAULT_THINKING_BUDGET = Number(
  process.env.CLAUDE_THINKING_BUDGET || '10000',
)

// Temperature: 0.15 = data-driven quant scientist, minimal hallucination.
const DEFAULT_TEMPERATURE = 0.15

// ── Provider routing ────────────────────────────────────────────────
// OIDC-only path: Vercel AI Gateway via OIDC/CLI auth context.

function hasGatewayOidcContext(): boolean {
  return Boolean(process.env.VERCEL || process.env.VERCEL_OIDC_TOKEN)
}

/** Get the model instance for the current provider. */
function getModel(): LanguageModel {
  // Vercel AI Gateway via OIDC/CLI auth context only.
  return gateway(GATEWAY_MODEL_ID)
}

// ── Anthropic-specific options (gateway mode) ───────────────────

function thinkingOptions(
  budget: number = DEFAULT_THINKING_BUDGET,
): { anthropic: AnthropicLanguageModelOptions } {
  return {
    anthropic: {
      thinking: { type: 'enabled', budgetTokens: budget },
    } satisfies AnthropicLanguageModelOptions,
  }
}

// ── Public API ─────────────────────────────────────────────────────

export interface AITextOptions {
  /** Max output tokens (default: 2000) */
  maxTokens?: number
  /** Thinking budget in tokens (default: 10000). Set 0 to disable thinking. */
  thinkingBudget?: number
  /** AbortSignal for timeout support */
  signal?: AbortSignal
}

export interface AIVisionOptions extends AITextOptions {
  /** Base64-encoded image data (no data:image prefix needed) */
  imageBase64: string
  /** MIME type (default: image/png) */
  mimeType?: string
}

/**
 * Generate text with Claude + extended thinking.
 * Single prompt in, text out. Used by forecast, synthesis, instant-analysis.
 */
export async function generateAIText(
  prompt: string,
  options: AITextOptions = {},
): Promise<{ text: string; reasoningText?: string }> {
  const {
    maxTokens = 2000,
    thinkingBudget = DEFAULT_THINKING_BUDGET,
    signal,
  } = options

  const useThinking = thinkingBudget > 0
  const providerOpts = useThinking ? thinkingOptions(thinkingBudget) : undefined

  const result = await generateText({
    model: getModel(),
    prompt,
    maxOutputTokens: maxTokens,
    temperature: useThinking ? undefined : DEFAULT_TEMPERATURE,
    ...(providerOpts && { providerOptions: providerOpts }),
    ...(signal && { abortSignal: signal }),
  })

  return { text: result.text, reasoningText: result.reasoningText }
}

/**
 * Generate text from an image + text prompt (vision).
 * Used by chart analysis.
 */
export async function generateAIVision(
  textPrompt: string,
  options: AIVisionOptions,
): Promise<{ text: string; reasoningText?: string }> {
  const {
    imageBase64,
    mimeType = 'image/png',
    maxTokens = 4096,
    thinkingBudget = DEFAULT_THINKING_BUDGET,
    signal,
  } = options

  const useThinking = thinkingBudget > 0
  const providerOpts = useThinking ? thinkingOptions(thinkingBudget) : undefined

  const result = await generateText({
    model: getModel(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: imageBase64,
            mediaType: mimeType,
          },
          { type: 'text', text: textPrompt },
        ],
      },
    ],
    maxOutputTokens: maxTokens,
    temperature: useThinking ? undefined : DEFAULT_TEMPERATURE,
    ...(providerOpts && { providerOptions: providerOpts }),
    ...(signal && { abortSignal: signal }),
  })

  return { text: result.text, reasoningText: result.reasoningText }
}

/**
 * Generate a chat-style completion (messages array).
 * Used by trade-reasoning where we need role-based messages.
 */
export async function generateAIChat(
  messages: { role: 'user' | 'assistant'; content: string }[],
  options: AITextOptions = {},
): Promise<{ text: string; reasoningText?: string }> {
  const {
    maxTokens = 2000,
    thinkingBudget = DEFAULT_THINKING_BUDGET,
    signal,
  } = options

  const useThinking = thinkingBudget > 0
  const providerOpts = useThinking ? thinkingOptions(thinkingBudget) : undefined

  const result = await generateText({
    model: getModel(),
    messages,
    maxOutputTokens: maxTokens,
    temperature: useThinking ? undefined : DEFAULT_TEMPERATURE,
    ...(providerOpts && { providerOptions: providerOpts }),
    ...(signal && { abortSignal: signal }),
  })

  return { text: result.text, reasoningText: result.reasoningText }
}

/**
 * Check if AI is available.
 * OIDC-only mode is available when OIDC/CLI auth context is present.
 */
export function isAIAvailable(): boolean {
  return hasGatewayOidcContext()
}

/**
 * Get the current model ID (for logging/debugging).
 */
export function getModelId(): string {
  return GATEWAY_MODEL_ID
}

/**
 * Get the current auth method (for logging/debugging).
 */
export function getAuthMethod():
  AIAuthMethod {
  if (hasGatewayOidcContext()) return 'gateway_oidc'
  return 'none'
}

export interface AIProviderStatus {
  modelId: string
  authMethod: AIAuthMethod
  configured: boolean
  available: boolean
}

export function getAIProviderStatus(): AIProviderStatus {
  const authMethod = getAuthMethod()
  return {
    modelId: getModelId(),
    authMethod,
    configured: authMethod !== 'none',
    available: isAIAvailable(),
  }
}

export type AIErrorCategory =
  | 'availability'
  | 'service_unavailable'
  | 'rate_limited'
  | 'timeout'
  | 'unknown'

export interface AIErrorClassification {
  category: AIErrorCategory
  publicMessage: string
  rawMessage: string
}

/**
 * Classify provider/runtime failures into deterministic fallback buckets.
 * This keeps dashboard messaging truthful without leaking provider-specific jargon.
 */
export function classifyAIError(error: unknown): AIErrorClassification {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '')
  const msg = rawMessage.toLowerCase()

  if (
    /insufficient funds|insufficient credits?|billing|quota|payment required/.test(
      msg,
    )
  ) {
    return {
      category: 'service_unavailable',
      publicMessage: 'AI gateway is currently unavailable (billing or quota issue).',
      rawMessage,
    }
  }

  if (/rate limit|too many requests|429/.test(msg)) {
    return {
      category: 'rate_limited',
      publicMessage: 'AI service is temporarily rate-limited.',
      rawMessage,
    }
  }

  if (/timeout|timed out|abort|aborted|deadline exceeded/.test(msg)) {
    return {
      category: 'timeout',
      publicMessage: 'AI service timed out.',
      rawMessage,
    }
  }

  if (
    /api[_ -]?key|credentials|unauthorized|forbidden|auth(?:entication)?|not set|missing/.test(
      msg,
    )
  ) {
    return {
      category: 'availability',
      publicMessage: 'AI provider connection is not configured (CLI/OIDC).',
      rawMessage,
    }
  }

  if (
    /gateway|service unavailable|bad gateway|upstream|internal server error|502|503|504|connection reset|socket hang up/.test(
      msg,
    )
  ) {
    return {
      category: 'service_unavailable',
      publicMessage: 'AI service is temporarily unavailable.',
      rawMessage,
    }
  }

  return {
    category: 'unknown',
    publicMessage: 'AI service is unavailable.',
    rawMessage,
  }
}
