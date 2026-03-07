/**
 * ai-provider.ts -- Unified AI provider for the entire application.
 *
 * ONE model. ONE config. ONE place to change anything.
 *
 * Provider: Claude Code Max subscription via CLIProxyAPI (OpenAI-compatible)
 * Model: claude-sonnet-4-5 (configurable via CLAUDE_MODEL)
 *
 * ── Auth ────────────────────────────────────────────────────────────
 *
 *   ALL environments (local dev, Vercel production, Inngest):
 *     CLAUDE_PROXY_URL=http://localhost:8317/v1   ← CLIProxyAPI, $0.00
 *
 *   No Vercel AI Gateway. No direct Anthropic API key. No per-token cost.
 *   If CLAUDE_PROXY_URL is not set, AI calls return deterministic fallbacks.
 *
 * ── Starting the proxy ──────────────────────────────────────────────
 *
 *   npx @anthropic-ai/claude-code --serve --port 8317
 *   or: npx cliproxyapi --port 8317
 *
 * ── Temperature ────────────────────────────────────────────────────
 *
 *   0.15 (data-driven quant output, minimal hallucination).
 *   Extended thinking is disabled in proxy mode — CLIProxyAPI does not
 *   support the Anthropic-specific thinking parameter.
 */

import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { generateText } from 'ai'

// ── Central config ─────────────────────────────────────────────────

const PROXY_URL = process.env.CLAUDE_PROXY_URL || ''

// Model string sent to the proxy (CLIProxyAPI passes it through to Claude)
const MODEL_ID = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5'

const DEFAULT_TEMPERATURE = 0.15

// ── Provider ───────────────────────────────────────────────────────

const proxyProvider = PROXY_URL
  ? createOpenAI({
      baseURL: PROXY_URL,
      apiKey: 'subscription', // CLIProxyAPI ignores this field
    })
  : null

/** Get the proxy model instance. Throws if proxy is not configured. */
function getModel(): LanguageModel {
  if (!proxyProvider) {
    throw new Error(
      'AI is not configured. Set CLAUDE_PROXY_URL to your CLIProxyAPI endpoint ' +
        '(e.g. http://localhost:8317/v1). See .env.example for setup instructions.',
    )
  }
  return proxyProvider(MODEL_ID)
}

// ── Public API ─────────────────────────────────────────────────────

export interface AITextOptions {
  /** Max output tokens (default: 2000) */
  maxTokens?: number
  /**
   * Thinking budget (ignored in proxy mode — CLIProxyAPI does not support
   * Anthropic extended thinking). Kept for API compatibility.
   */
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
 * Generate text with Claude via Max subscription proxy.
 * Single prompt in, text out. Used by forecast, synthesis, instant-analysis.
 */
export async function generateAIText(
  prompt: string,
  options: AITextOptions = {},
): Promise<{ text: string; reasoningText?: string }> {
  const { maxTokens = 2000, signal } = options

  const result = await generateText({
    model: getModel(),
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
  const { imageBase64, mimeType = 'image/png', maxTokens = 4096, signal } =
    options

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
  const { maxTokens = 2000, signal } = options

  const result = await generateText({
    model: getModel(),
    messages,
    maxOutputTokens: maxTokens,
    temperature: DEFAULT_TEMPERATURE,
    ...(signal && { abortSignal: signal }),
  })

  return { text: result.text, reasoningText: result.reasoningText }
}

/**
 * Check if AI is available.
 * Returns true only when CLAUDE_PROXY_URL is configured (Max subscription proxy).
 */
export function isAIAvailable(): boolean {
  return Boolean(PROXY_URL)
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
export function getAuthMethod(): 'proxy' | 'none' {
  return PROXY_URL ? 'proxy' : 'none'
}
