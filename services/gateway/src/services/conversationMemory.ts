import { pool } from '../db/client';
import { callLLM } from './llm';
import { estimateTokens } from './router';
import type { Message } from '@sentinelai/shared';

// Conservative per-model context window limits (tokens)
const CONTEXT_LIMITS: Record<string, number> = {
  'llama-3.3-70b-versatile':    128_000,
  'llama-3.1-8b-instant':       128_000,
  'llama-3.1-70b-versatile':    128_000,
  'mistral-large-latest':       128_000,
  'mistral-small-latest':        32_000,
  'claude-3-5-sonnet-20241022':  200_000,
  'claude-haiku-4-5-20251001':   200_000,
};
const DEFAULT_CONTEXT_LIMIT = 32_000;
const SUMMARIZE_AT = 0.75;        // trigger summarization at 75% of limit
const FRESH_TURNS_TO_KEEP = 4;    // always preserve the most recent N turns

function contextLimit(model: string): number {
  return CONTEXT_LIMITS[model] ?? DEFAULT_CONTEXT_LIMIT;
}

export interface LoadedSession {
  // The full message array to send to the LLM (summary injected if present)
  llmMessages: Message[];
  // The raw fresh messages stored in DB (without the summary system msg)
  freshMessages: Message[];
  summary: string | undefined;
  was_summarized: boolean;
  turn_count: number;
}

export async function loadSession(
  tenantId: string,
  sessionId: string,
  newUserMessage: Message,
  model: string
): Promise<LoadedSession> {
  const result = await pool.query<{
    messages: Message[];
    summary: string | null;
    turn_count: number;
  }>(
    `SELECT messages, summary, turn_count
     FROM conversation_sessions
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId]
  );

  let history: Message[] = result.rows[0]?.messages ?? [];
  let summary: string | null = result.rows[0]?.summary ?? null;
  let turn_count: number = result.rows[0]?.turn_count ?? 0;
  let was_summarized = false;

  // Append incoming user message
  history = [...history, newUserMessage];

  // ── Context guard ──────────────────────────────────────────────────────────
  const tokenBudget = contextLimit(model);
  const totalText = history.map((m) => m.content).join(' ');
  const estimatedTokens = estimateTokens(totalText);

  if (estimatedTokens > tokenBudget * SUMMARIZE_AT && history.length > FRESH_TURNS_TO_KEEP) {
    const toCompress = history.slice(0, -FRESH_TURNS_TO_KEEP);
    const fresh = history.slice(-FRESH_TURNS_TO_KEEP);

    const priorContext = summary
      ? `Prior summary:\n${summary}\n\nNew turns to add:\n`
      : '';
    const turnText = toCompress
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    try {
      const summaryResult = await callLLM(
        'groq',
        'llama-3.1-8b-instant',
        [{ role: 'user', content: `${priorContext}Summarize the following conversation turns into 2-4 sentences, preserving key facts, decisions, and context. Be concise.\n\n${turnText}` }]
      );
      summary = summaryResult.content;
      history = fresh;
      was_summarized = true;
    } catch {
      // Summarization failed — hard-truncate to last N*2 turns
      history = history.slice(-(FRESH_TURNS_TO_KEEP * 2));
      was_summarized = true;
    }
  }

  // Build the message array the LLM will see: summary injected as system message
  const llmMessages: Message[] = summary
    ? [{ role: 'system', content: `Previous conversation summary:\n${summary}` }, ...history]
    : history;

  return {
    llmMessages,
    freshMessages: history,
    summary: summary ?? undefined,
    was_summarized,
    turn_count,
  };
}

export async function saveSession(
  tenantId: string,
  sessionId: string,
  freshMessages: Message[],
  assistantContent: string,
  summary: string | undefined
): Promise<void> {
  const updated = [...freshMessages, { role: 'assistant' as const, content: assistantContent }];
  const tokenCount = estimateTokens(updated.map((m) => m.content).join(' '));

  await pool.query(
    `INSERT INTO conversation_sessions
       (tenant_id, session_id, messages, summary, token_count, turn_count)
     VALUES ($1, $2, $3::jsonb, $4, $5, 1)
     ON CONFLICT (tenant_id, session_id) DO UPDATE
       SET messages    = EXCLUDED.messages,
           summary     = EXCLUDED.summary,
           token_count = EXCLUDED.token_count,
           turn_count  = conversation_sessions.turn_count + 1,
           updated_at  = NOW()`,
    [tenantId, sessionId, JSON.stringify(updated), summary ?? null, tokenCount]
  );
}

export async function getSession(tenantId: string, sessionId: string) {
  const result = await pool.query(
    `SELECT session_id, messages, summary, token_count, turn_count, created_at, updated_at
     FROM conversation_sessions
     WHERE tenant_id = $1 AND session_id = $2`,
    [tenantId, sessionId]
  );
  return result.rows[0] ?? null;
}

export async function listSessions(tenantId: string, limit: number, offset: number) {
  const result = await pool.query(
    `SELECT session_id, turn_count, token_count, created_at, updated_at
     FROM conversation_sessions
     WHERE tenant_id = $1
     ORDER BY updated_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );
  return result.rows;
}

export async function deleteSession(tenantId: string, sessionId: string): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM conversation_sessions
     WHERE tenant_id = $1 AND session_id = $2 RETURNING id`,
    [tenantId, sessionId]
  );
  return result.rows.length > 0;
}
