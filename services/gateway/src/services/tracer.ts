import { randomUUID } from 'crypto';
import { query } from '../db/client';
import type { SpanAttributes } from '@sentinelai/shared';

export interface Span {
  id: string;
  trace_id: string;
  parent_id?: string;
  name: string;
  kind: 'server' | 'client' | 'internal' | 'producer' | 'consumer';
  start_time: Date;
  end_time?: Date;
  status: 'ok' | 'error' | 'unset';
  status_msg?: string;
  attributes: SpanAttributes;
  events: Array<{ name: string; timestamp: string; attributes?: SpanAttributes }>;
}

export function startSpan(
  traceId: string,
  name: string,
  opts: {
    parentId?: string;
    kind?: Span['kind'];
    attributes?: SpanAttributes;
    requestId?: string;
    tenantId?: string;
  } = {}
): Span {
  return {
    id: randomUUID(),
    trace_id: traceId,
    parent_id: opts.parentId,
    name,
    kind: opts.kind ?? 'internal',
    start_time: new Date(),
    status: 'unset',
    attributes: opts.attributes ?? {},
    events: [],
  };
}

export function endSpan(span: Span, status: 'ok' | 'error' = 'ok', msg?: string): Span {
  span.end_time = new Date();
  span.status = status;
  if (msg) span.status_msg = msg;
  return span;
}

export async function flushSpans(
  spans: Span[],
  tenantId: string,
  requestId?: string
): Promise<void> {
  if (spans.length === 0) return;

  const values = spans.map((s) => [
    s.id,
    s.trace_id,
    s.parent_id ?? null,
    requestId ?? null,
    tenantId,
    s.name,
    s.kind,
    s.start_time.toISOString(),
    s.end_time?.toISOString() ?? null,
    s.end_time && s.start_time
      ? s.end_time.getTime() - s.start_time.getTime()
      : null,
    s.status,
    s.status_msg ?? null,
    JSON.stringify(s.attributes),
    JSON.stringify(s.events),
  ]);

  // Batch insert — fire-and-forget (don't block request response)
  for (const v of values) {
    query(
      `INSERT INTO trace_spans
         (id, trace_id, parent_id, request_id, tenant_id, name, kind,
          start_time, end_time, duration_ms, status, status_msg, attributes, events)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING`,
      v
    ).catch((err) => console.error('Failed to persist span', err));
  }
}
