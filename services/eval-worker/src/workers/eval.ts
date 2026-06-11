import { Worker, Job } from 'bullmq';
import { Pool } from 'pg';
import OpenAI from 'openai';
import pino from 'pino';
import { z } from 'zod';
import { QUEUES, type EvalJobData } from '@sentinelai/shared';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const EvalOutputSchema = z.object({
  faithfulness_score: z.number().min(0).max(1),
  relevance_score: z.number().min(0).max(1),
  coherence_score: z.number().min(0).max(1),
  hallucination_detected: z.boolean(),
  reasoning: z.string(),
});

const EVAL_SYSTEM_PROMPT = `You are an AI response quality evaluator. Given a user prompt and an AI response, score the response on three dimensions (0.0 to 1.0):

- faithfulness_score: Is the response grounded in facts? (1.0 = fully grounded, 0.0 = hallucinated)
- relevance_score: Does the response address the user's question? (1.0 = fully relevant, 0.0 = off-topic)
- coherence_score: Is the response clear, well-structured, and logical? (1.0 = excellent, 0.0 = incoherent)
- hallucination_detected: true if the response contains clearly fabricated facts

Respond ONLY with valid JSON: {"faithfulness_score": float, "relevance_score": float, "coherence_score": float, "hallucination_detected": boolean, "reasoning": "brief explanation"}`;

export function startEvalWorker(opts: {
  redisUrl: string;
  pool: Pool;
  groqApiKey: string;
  evalModel: string;
  concurrency: number;
}) {
  // Groq uses OpenAI-compatible SDK
  const groq = new OpenAI({
    apiKey: opts.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const worker = new Worker<EvalJobData>(
    QUEUES.EVAL,
    async (job: Job<EvalJobData>) => {
      const { request_id, tenant_id, prompt, response, retrieved_chunks, mode } = job.data;
      const start = Date.now();

      const contextSection =
        mode === 'rag' && retrieved_chunks?.length
          ? `\n\nRetrieved context:\n${retrieved_chunks.map((c) => `- ${c.content_preview}`).join('\n')}`
          : '';

      let rawOutput: unknown;
      let scores;

      try {
        const completion = await groq.chat.completions.create({
          model: opts.evalModel,
          messages: [
            { role: 'system', content: EVAL_SYSTEM_PROMPT },
            { role: 'user', content: `User prompt: ${prompt}${contextSection}\n\nAI response: ${response}` },
          ],
          response_format: { type: 'json_object' },
          temperature: 0,
        });

        rawOutput = completion.choices[0]?.message?.content;
        scores = EvalOutputSchema.parse(JSON.parse(rawOutput as string));
      } catch (err) {
        log.warn({ request_id, err }, 'Eval scoring failed — skipping');
        return;
      }

      await opts.pool.query(
        `INSERT INTO eval_results
           (request_id, tenant_id, faithfulness_score, relevance_score, coherence_score,
            hallucination_detected, eval_model, eval_latency_ms, raw_eval_output)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          request_id, tenant_id,
          scores.faithfulness_score, scores.relevance_score, scores.coherence_score,
          scores.hallucination_detected, opts.evalModel,
          Date.now() - start,
          JSON.stringify({ scores, reasoning: scores.reasoning }),
        ]
      );

      log.info({ request_id, faithfulness: scores.faithfulness_score, hallucination: scores.hallucination_detected }, 'Eval complete');
    },
    { connection: { url: opts.redisUrl } as never, concurrency: opts.concurrency }
  );

  worker.on('failed', (job, err) => log.error({ job: job?.id, err }, 'Eval job failed'));

  return worker;
}
