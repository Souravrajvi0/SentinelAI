import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import type { Message, Provider } from '@sentinelai/shared';

export type ExtendedProvider = Provider | 'mistral' | 'cerebras';

// All providers except Anthropic use the OpenAI-compatible SDK with a custom baseURL
function openaiCompatClient(provider: ExtendedProvider): OpenAI {
  switch (provider) {
    case 'openai':
      if (!config.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
      return new OpenAI({ apiKey: config.OPENAI_API_KEY });
    case 'groq':
      if (!config.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
      return new OpenAI({ apiKey: config.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
    case 'mistral':
      if (!config.MISTRAL_API_KEY) throw new Error('MISTRAL_API_KEY not set');
      return new OpenAI({ apiKey: config.MISTRAL_API_KEY, baseURL: 'https://api.mistral.ai/v1' });
    case 'cerebras':
      if (!config.CEREBRAS_API_KEY) throw new Error('CEREBRAS_API_KEY not set');
      return new OpenAI({ apiKey: config.CEREBRAS_API_KEY, baseURL: 'https://api.cerebras.ai/v1' });
    case 'gemini':
      if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');
      return new OpenAI({ apiKey: config.GEMINI_API_KEY, baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

let _anthropic: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!_anthropic) {
    if (!config.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    _anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

export interface LLMResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  ttfb_ms?: number;
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr!: Error;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as Error;
      if (attempt < maxAttempts - 1) {
        const delay = Math.min(100 * Math.pow(2, attempt) + Math.random() * 50, 2000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export async function callLLM(
  provider: ExtendedProvider,
  model: string,
  messages: Message[],
  systemPrompt?: string
): Promise<LLMResult> {
  const start = Date.now();

  if (provider === 'anthropic') {
    const client = anthropicClient();
    const anthropicMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    const systemMsg = systemPrompt ?? messages.find((m) => m.role === 'system')?.content;

    const res = await withRetry(() => client.messages.create({
      model,
      max_tokens: 4096,
      system: systemMsg,
      messages: anthropicMessages,
    }));

    const block = res.content[0];
    if (!block || block.type !== 'text') throw new Error('Empty response from Anthropic');

    return {
      content: block.text,
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
      ttfb_ms: Date.now() - start,
    };
  }

  // All OpenAI-compatible providers
  const client = openaiCompatClient(provider);
  const allMessages: OpenAI.ChatCompletionMessageParam[] = [];
  if (systemPrompt) allMessages.push({ role: 'system', content: systemPrompt });
  allMessages.push(...messages.map((m) => ({ role: m.role, content: m.content })));

  const res = await withRetry(() => client.chat.completions.create({ model, messages: allMessages }));
  const choice = res.choices[0];
  if (!choice?.message?.content) throw new Error(`Empty response from ${provider}`);

  return {
    content: choice.message.content,
    prompt_tokens: res.usage?.prompt_tokens ?? 0,
    completion_tokens: res.usage?.completion_tokens ?? 0,
    total_tokens: res.usage?.total_tokens ?? 0,
    ttfb_ms: Date.now() - start,
  };
}

// Cost per 1M tokens (prompt / completion) — free tier providers show $0
const COST_TABLE: Record<string, [number, number]> = {
  'llama-3.3-70b-versatile':    [0, 0],
  'llama-3.1-8b-instant':       [0, 0],
  'mistral-large-latest':       [2.00, 6.00],
  'mistral-small-latest':       [0.10, 0.30],
  'claude-3-5-sonnet-20241022': [3.00, 15.00],
  'claude-haiku-4-5-20251001':  [0.25, 1.25],
  'gemini-2.0-flash':           [0.10, 0.40],
  'gemini-1.5-flash':           [0.075, 0.30],
  'gemini-1.5-pro':             [1.25, 5.00],
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const entry = COST_TABLE[model];
  if (!entry) return 0;
  return (
    (promptTokens / 1_000_000) * entry[0] +
    (completionTokens / 1_000_000) * entry[1]
  );
}
