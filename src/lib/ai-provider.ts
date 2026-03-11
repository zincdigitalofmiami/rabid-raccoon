/**
 * ai-provider.ts -- Unified AI provider for the entire application.
 *
 * ONE provider layer. ONE config surface. ONE place to change anything.
 *
 * Provider: OpenRouter via the OpenAI-compatible Vercel AI SDK provider
 * Text/Chat Model: arcee-ai/trinity-large-preview:free
 * Vision Model: qwen/qwen3-vl-235b-a22b-thinking
 *
 * ── Auth ────────────────────────────────────────────────────────────
 *
 *   All environments:
 *     OPENROUTER_API_KEY
 *
 * ── Temperature ────────────────────────────────────────────────────
 *
 * Default: 0.15 (very low creativity — data-driven quant output).
 * thinkingBudget is retained in the public API for compatibility, but the
 * OpenRouter chat path does not apply Anthropic-specific thinking options.
 */

import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { generateText } from 'ai'

export type AIAuthMethod =
  | 'openrouter_api_key'
  | 'none'

// ── Central config ─────────────────────────────────────────────────
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'

const OPENROUTER_TEXT_MODEL_ID =
  process.env.OPENROUTER_TEXT_MODEL || 'arcee-ai/trinity-large-preview:free'

const OPENROUTER_VISION_MODEL_ID =
  process.env.OPENROUTER_VISION_MODEL || 'qwen/qwen3-vl-235b-a22b-thinking'

const DEFAULT_THINKING_BUDGET = Number(
  process.env.OPENROUTER_THINKING_BUDGET || '10000',
)

// Temperature: 0.15 = data-driven quant scientist, minimal hallucination.
const DEFAULT_TEMPERATURE = 0.15

const openrouter = createOpenAI({
  baseURL: OPENROUTER_BASE_URL,
  apiKey: process.env.OPENROUTER_API_KEY,
  name: 'openrouter',
  headers: {
    ...(process.env.OPENROUTER_HTTP_REFERER
      ? { 'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER }
      : {}),
    ...(process.env.OPENROUTER_X_TITLE
      ? { 'X-Title': process.env.OPENROUTER_X_TITLE }
      : {}),
  },
})

function hasOpenRouterApiKey(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY)
}

function getTextModel(): LanguageModel {
  return openrouter.chat(OPENROUTER_TEXT_MODEL_ID)
}

function getVisionModel(): LanguageModel {
  return openrouter.chat(OPENROUTER_VISION_MODEL_ID)
}

// ── Public API ─────────────────────────────────────────────────────

export interface AITextOptions {
  /** Max output tokens (default: 2000) */
  maxTokens?: number
  /** Compatibility knob retained from the previous provider contract. */
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
 * Generate text from the configured text model.
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

  void thinkingBudget

  const result = await generateText({
    model: getTextModel(),
    prompt,
    maxOutputTokens: maxTokens,
    temperature: DEFAULT_TEMPERATURE,
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

  void thinkingBudget

  const result = await generateText({
    model: getVisionModel(),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            image: `data:${mimeType};base64,${imageBase64}`,
          },
          { type: 'text', text: textPrompt },
        ],
      },
    ],
    maxOutputTokens: maxTokens,
    temperature: DEFAULT_TEMPERATURE,
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

  void thinkingBudget

  const result = await generateText({
    model: getTextModel(),
    messages,
    maxOutputTokens: maxTokens,
    temperature: DEFAULT_TEMPERATURE,
    ...(signal && { abortSignal: signal }),
  })

  return { text: result.text, reasoningText: result.reasoningText }
}

/**
 * Check if AI is available.
 * OpenRouter mode is available when the API key is configured.
 */
export function isAIAvailable(): boolean {
  return hasOpenRouterApiKey()
}

/**
 * Get the current text model ID (for logging/debugging).
 */
export function getModelId(): string {
  return OPENROUTER_TEXT_MODEL_ID
}

/**
 * Get the current auth method (for logging/debugging).
 */
export function getAuthMethod():
  AIAuthMethod {
  if (hasOpenRouterApiKey()) return 'openrouter_api_key'
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
      publicMessage: 'AI service is currently unavailable (billing or quota issue).',
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
      publicMessage: 'AI provider connection is not configured (OPENROUTER_API_KEY).',
      rawMessage,
    }
  }

  if (
    /service unavailable|bad gateway|upstream|internal server error|502|503|504|connection reset|socket hang up/.test(
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
