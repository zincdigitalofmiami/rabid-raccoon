/**
 * ai-provider.ts -- Unified AI provider for the entire application.
 *
 * ONE model. ONE config. ONE place to change anything.
 *
 * Provider: Anthropic (Claude) via Vercel AI SDK
 * Model: Claude Sonnet 4.5 with Extended Thinking
 *
 * ── Auth paths (pick ONE) ──────────────────────────────────────────
 *
 *   Path 1 — Vercel AI Gateway (Max subscription, $0.00):
 *     ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh
 *     Auth via VERCEL_OIDC_TOKEN (from `vercel env pull`). No API key.
 *
 *   Path 2 — Subscription Proxy (local dev, $0.00):
 *     CLAUDE_PROXY_URL=http://localhost:8317/v1
 *     Routes through CLIProxyAPI → Claude Code → Max subscription.
 *
 *   Path 3 — API Key (per-token billing, production fallback):
 *     ANTHROPIC_API_KEY=sk-ant-...
 *
 * Priority: Proxy > Gateway/Auth Token > API Key
 *
 * ── Temperature ────────────────────────────────────────────────────
 *
 * Default: 0.15 (very low creativity — data-driven quant output).
 * When extended thinking is enabled on native Anthropic, the server
 * locks temperature at 1.0 (the thinking chain constrains hallucination).
 * Proxy mode always sends temperature 0.15.
 */

import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import type { AnthropicLanguageModelOptions } from '@ai-sdk/anthropic'
import type { LanguageModel } from 'ai'
import { generateText } from 'ai'

// ── Central config ─────────────────────────────────────────────────
// Change the model here, it changes everywhere in the app.
const MODEL_ID = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5-20250929'

// Extended thinking token budget (higher = deeper reasoning)
// Only used in native Anthropic mode (not through proxy).
const DEFAULT_THINKING_BUDGET = Number(
  process.env.CLAUDE_THINKING_BUDGET || '10000',
)

// Temperature: 0.15 = data-driven quant scientist, minimal hallucination.
const DEFAULT_TEMPERATURE = 0.15

// ── Provider routing ────────────────────────────────────────────────
// Proxy URL → CLIProxyAPI (Max subscription, $0.00, OpenAI-compat format)
// Otherwise → native Anthropic API (auth token or API key)

const PROXY_URL = process.env.CLAUDE_PROXY_URL || ''
const USE_PROXY = Boolean(PROXY_URL)

// Proxy mode: OpenAI-compatible endpoint (CLIProxyAPI on localhost:8317)
const proxyProvider = USE_PROXY
  ? createOpenAI({
      baseURL: PROXY_URL,
      apiKey: 'subscription', // CLIProxyAPI ignores this field
    })
  : null

// Auth token: explicit ANTHROPIC_AUTH_TOKEN, or Vercel OIDC token (Max subscription via gateway)
const AUTH_TOKEN =
  process.env.ANTHROPIC_AUTH_TOKEN || process.env.VERCEL_OIDC_TOKEN || ''

// Native mode: Anthropic Messages API
// Gateway path: ANTHROPIC_BASE_URL + VERCEL_OIDC_TOKEN (no API key)
// Direct path: ANTHROPIC_API_KEY (per-token billing)
const nativeProvider = !USE_PROXY
  ? createAnthropic({
      ...(process.env.ANTHROPIC_BASE_URL && {
        baseURL: process.env.ANTHROPIC_BASE_URL,
      }),
      ...(AUTH_TOKEN && { authToken: AUTH_TOKEN }),
      ...(process.env.ANTHROPIC_API_KEY &&
        !AUTH_TOKEN && {
          apiKey: process.env.ANTHROPIC_API_KEY,
        }),
    })
  : null

/** Get the model instance for the current provider. */
function getModel(): LanguageModel {
  if (proxyProvider) return proxyProvider(MODEL_ID)
  if (nativeProvider) return nativeProvider(MODEL_ID)
  throw new Error(
    'No AI provider configured. Set CLAUDE_PROXY_URL, ANTHROPIC_AUTH_TOKEN, or ANTHROPIC_API_KEY.',
  )
}

// ── Anthropic-specific options (native mode only) ───────────────────

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
  /** Thinking budget in tokens (default: 10000). Set 0 to disable thinking. Native mode only. */
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

  // Native Anthropic: extended thinking with server-locked temp
  // Proxy: temperature 0.15, no thinking control (model reasons naturally)
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
 * Check if AI is available (any auth path configured).
 */
export function isAIAvailable(): boolean {
  return Boolean(
    PROXY_URL ||
      AUTH_TOKEN ||
      process.env.ANTHROPIC_API_KEY,
  )
}

/**
 * Get the current model ID (for logging/debugging).
 */
export function getModelId(): string {
  return MODEL_ID
}

/**
 * Get the current auth method (for logging/debugging).
 */
export function getAuthMethod():
  | 'proxy'
  | 'gateway'
  | 'auth_token'
  | 'api_key'
  | 'none' {
  if (USE_PROXY) return 'proxy'
  if (process.env.VERCEL_OIDC_TOKEN) return 'gateway'
  if (process.env.ANTHROPIC_AUTH_TOKEN) return 'auth_token'
  if (process.env.ANTHROPIC_API_KEY) return 'api_key'
  return 'none'
}
