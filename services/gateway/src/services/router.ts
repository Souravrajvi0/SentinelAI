import { config } from '../config';
import { pool } from '../db/client';
import type { Provider } from '@sentinelai/shared';

export interface RouteDecision {
  provider: Provider;
  model: string;
  is_fallback: boolean;
  ab_experiment_id?: string;
  ab_variant?: 'control' | 'variant';
}

export interface RoutingContext {
  requested_provider?: Provider;
  requested_model?: string;
  estimated_tokens: number;
  priority?: 'low' | 'normal' | 'high';
}

const ROUTING_RULES: Array<{
  condition: (req: RoutingContext) => boolean;
  provider: Provider;
  model: string;
}> = [
  // Long context → Groq's larger model
  {
    condition: (r) => r.estimated_tokens > 8000,
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
  },
  // Low priority / cost-sensitive → fast small model
  {
    condition: (r) => r.priority === 'low',
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
  },
];

export function routeRequest(ctx: RoutingContext): RouteDecision {
  if (ctx.requested_provider && ctx.requested_model) {
    return { provider: ctx.requested_provider, model: ctx.requested_model, is_fallback: false };
  }

  for (const rule of ROUTING_RULES) {
    if (rule.condition(ctx)) {
      return { provider: rule.provider, model: rule.model, is_fallback: false };
    }
  }

  return {
    provider: config.DEFAULT_PROVIDER as Provider,
    model: config.DEFAULT_MODEL,
    is_fallback: false,
  };
}

export function getFallbackRoute(): RouteDecision | null {
  if (!config.FALLBACK_PROVIDER || !config.FALLBACK_MODEL) return null;
  return { provider: config.FALLBACK_PROVIDER as Provider, model: config.FALLBACK_MODEL, is_fallback: true };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function getAbRoute(tenantId: string): Promise<RouteDecision | null> {
  const result = await pool.query<{
    id: string;
    traffic_split: number;
    control_provider: string;
    control_model: string;
    variant_provider: string;
    variant_model: string;
  }>(
    `SELECT id, traffic_split, control_provider, control_model, variant_provider, variant_model
     FROM ab_experiments
     WHERE tenant_id = $1 AND is_active = TRUE
     LIMIT 1`,
    [tenantId]
  );

  if (result.rows.length === 0) return null;
  const exp = result.rows[0]!;
  const useVariant = Math.random() * 100 < exp.traffic_split;

  return {
    provider: (useVariant ? exp.variant_provider : exp.control_provider) as Provider,
    model: useVariant ? exp.variant_model : exp.control_model,
    is_fallback: false,
    ab_experiment_id: exp.id,
    ab_variant: useVariant ? 'variant' : 'control',
  };
}
