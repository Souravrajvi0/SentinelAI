import OpenAI from 'openai';
import { config } from '../config';
import { estimateCost } from './llm';
import type { AgentStep } from '@sentinelai/shared';

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'retrieve_documents',
      description: 'Search indexed company documents for relevant information. Use this when the user asks about internal knowledge, policies, or any topic that might be in the document store.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate',
      description: 'Evaluate a simple mathematical expression. Input must be a safe JS math expression.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'e.g. "2 * (3 + 4)" or "Math.sqrt(144)"' },
        },
        required: ['expression'],
      },
    },
  },
];

// ── Tool executors ────────────────────────────────────────────────────────────

async function executeRetrieve(
  args: { query: string; top_k?: number | string },
  tenantId: string,
  pool: import('pg').Pool
): Promise<string> {
  // Inline retrieval using pgvector — avoids internal HTTP call
  // Embeddings require Mistral API; fall back to keyword search if not available
  try {
    const OpenAIClient = new OpenAI({
      apiKey: config.MISTRAL_API_KEY,
      baseURL: 'https://api.mistral.ai/v1',
    });

    const embRes = await OpenAIClient.embeddings.create({
      model: config.MISTRAL_EMBEDDING_MODEL,
      input: args.query,
    });
    const embedding = embRes.data[0]?.embedding;
    if (!embedding) throw new Error('No embedding');

    const result = await pool.query<{ content: string; doc_title: string; score: number }>(
      `SELECT c.content, d.title AS doc_title, 1 - (c.embedding <=> $1::vector) AS score
       FROM document_chunks c JOIN documents d ON c.document_id = d.id
       WHERE c.tenant_id = $2
       ORDER BY c.embedding <=> $1::vector
       LIMIT $3`,
      [`[${embedding.join(',')}]`, tenantId, parseInt(String(args.top_k ?? 3))]
    );

    if (result.rows.length === 0) return 'No relevant documents found.';

    return result.rows
      .map((r, i) => `[${i + 1}] (${r.doc_title ?? 'Untitled'}, score: ${r.score.toFixed(3)})\n${r.content}`)
      .join('\n\n');
  } catch {
    return 'Document retrieval unavailable.';
  }
}

function executeCalculate(args: { expression: string }): string {
  // Allow only digits, operators, parens, and whitelisted Math methods
  const safe = /^[\d\s\+\-\*\/%\(\)\.]+$/.test(args.expression.replace(/Math\.(sqrt|pow|abs|ceil|floor|round|min|max|log|PI)\b/g, '0'));
  if (!safe) return 'Invalid expression — only basic math operators and Math.* functions allowed.';
  try {
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${args.expression})`)();
    return String(result);
  } catch {
    return 'Could not evaluate expression.';
  }
}

// ── Agent runtime ─────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  goal: string;
  model: string;
  maxSteps: number;
  tenantId: string;
  pool: import('pg').Pool;
  onStep?: (step: AgentStep) => void;
}

export interface AgentRunResult {
  answer: string;
  steps: AgentStep[];
  total_tokens: number;
  total_cost_usd: number;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const groq = new OpenAI({
    apiKey: config.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const steps: AgentStep[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content:
        'You are a helpful AI agent. Use the available tools when needed to answer the user\'s question accurately. Think step by step.',
    },
    { role: 'user', content: opts.goal },
  ];

  for (let step = 0; step < opts.maxSteps; step++) {
    const start = Date.now();

    const response = await groq.chat.completions.create({
      model: opts.model,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const msg = response.choices[0]?.message;
    if (!msg) break;

    totalPromptTokens += response.usage?.prompt_tokens ?? 0;
    totalCompletionTokens += response.usage?.completion_tokens ?? 0;
    messages.push(msg);

    // ── Tool call ──────────────────────────────────────────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments ?? '{}');
        const toolStart = Date.now();

        const toolCallStep: AgentStep = {
          step,
          type: 'tool_call',
          content: `Calling ${call.function.name}`,
          tool_name: call.function.name,
          tool_input: args,
        };
        steps.push(toolCallStep);
        opts.onStep?.(toolCallStep);

        let toolResult: string;
        if (call.function.name === 'retrieve_documents') {
          toolResult = await executeRetrieve(args, opts.tenantId, opts.pool);
        } else if (call.function.name === 'calculate') {
          toolResult = executeCalculate(args);
        } else {
          toolResult = `Unknown tool: ${call.function.name}`;
        }

        const toolResultStep: AgentStep = {
          step,
          type: 'tool_result',
          content: toolResult,
          tool_name: call.function.name,
          tool_output: toolResult,
          latency_ms: Date.now() - toolStart,
        };
        steps.push(toolResultStep);
        opts.onStep?.(toolResultStep);

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResult,
        });
      }
      continue;
    }

    // ── Final answer ───────────────────────────────────────────────────────
    const answer = msg.content ?? '';
    const answerStep: AgentStep = { step, type: 'answer', content: answer, latency_ms: Date.now() - start };
    steps.push(answerStep);
    opts.onStep?.(answerStep);

    const costUsd = estimateCost(opts.model, totalPromptTokens, totalCompletionTokens);
    return { answer, steps, total_tokens: totalPromptTokens + totalCompletionTokens, total_cost_usd: costUsd };
  }

  const costUsd = estimateCost(opts.model, totalPromptTokens, totalCompletionTokens);
  return {
    answer: 'Agent reached maximum steps without a final answer.',
    steps,
    total_tokens: totalPromptTokens + totalCompletionTokens,
    total_cost_usd: costUsd,
  };
}
