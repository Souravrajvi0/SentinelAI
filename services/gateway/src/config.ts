import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.string().default('info'),

  GATEWAY_PORT: z.coerce.number().default(3000),
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  JWT_SECRET: z.string().min(32),

  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(10),

  REDIS_URL: z.string().default('redis://localhost:6379'),

  OPENAI_API_KEY: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  MISTRAL_API_KEY: z.string().optional(),
  CEREBRAS_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),

  DEFAULT_PROVIDER: z.enum(['openai', 'anthropic', 'groq', 'mistral', 'cerebras', 'gemini']).default('groq'),
  DEFAULT_MODEL: z.string().default('llama-3.3-70b-versatile'),
  FALLBACK_PROVIDER: z.enum(['openai', 'anthropic', 'groq', 'mistral', 'cerebras', 'gemini']).optional(),
  FALLBACK_MODEL: z.string().optional(),

  MISTRAL_EMBEDDING_MODEL: z.string().default('mistral-embed'),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1024),

  DEFAULT_RATE_LIMIT_RPM: z.coerce.number().default(60),

  EVAL_MODEL: z.string().default('llama-3.3-70b-versatile'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
