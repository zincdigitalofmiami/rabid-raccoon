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
 *     gateway() provider + AI_GATEWAY_API_KEY (from `vercel env pull`)
 *     OR: CLAUDE_PROXY_URL for CLIProxyAPI subscription proxy
 *
 * ── Temperature ────────────────────────────────────────────────────
 *
 * Default: 0.15 (very low creativity — data-driven quant output).
 * When extended thinking is enabled, the server locks temperature at 1.0.
 */

import { createOpenAI } from '@ai-sdk/openai'
import type { AnthropicLanguageModelOptions } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { generateText, gateway } from 'ai'

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
// Priority: Proxy > Gateway (default)
//
// Proxy: CLIProxyAPI on localhost (OpenAI-compat, Max subscription, $0.00)
// Gateway: Vercel AI Gateway with OIDC (auto on Vercel) or AI_GATEWAY_API_KEY

const PROXY_URL = process.env.CLAUDE_PROXY_URL || ''
const USE_PROXY = Boolean(PROXY_URL)

// Proxy mode: OpenAI-compatible endpoint (CLIProxyAPI on localhost:8317)
const proxyProvider = USE_PROXY
  ? createOpenAI({
      baseURL: PROXY_URL,
      apiKey: 'subscription', // CLIProxyAPI ignores this field
    })
  : null

/** Get the model instance for the current provider. */
function getModel(): LanguageModel {
  if (proxyProvider) return proxyProvider(GATEWAY_MODEL_ID)
  // Vercel AI Gateway: auto OIDC on Vercel, AI_GATEWAY_API_KEY locally
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

  const useThinking = !USE_PROXY && thinkingBudget > 0
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

  const useThinking = !USE_PROXY && thinkingBudget > 0
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

  const useThinking = !USE_PROXY && thinkingBudget > 0
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
 * Gateway mode is always available (OIDC on Vercel, API key locally).
 * Proxy mode requires CLAUDE_PROXY_URL.
 */
export function isAIAvailable(): boolean {
  // Gateway mode: always available on Vercel (OIDC auto-injected)
  // Locally: needs AI_GATEWAY_API_KEY from `vercel env pull`
  return Boolean(
    USE_PROXY ||
      process.env.VERCEL ||
      process.env.AI_GATEWAY_API_KEY ||
      process.env.VERCEL_OIDC_TOKEN,
  )
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
  | 'proxy'
  | 'gateway_oidc'
  | 'gateway_apikey'
  | 'none' {
  if (USE_PROXY) return 'proxy'
  if (process.env.VERCEL) return 'gateway_oidc'
  if (process.env.AI_GATEWAY_API_KEY) return 'gateway_apikey'
  return 'none'
}
