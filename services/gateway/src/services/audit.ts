import { pool } from '../db/client';

export type AuditAction =
  | 'request.created' | 'request.filtered' | 'request.error'
  | 'key.created' | 'key.revoked'
  | 'doc.indexed' | 'doc.deleted'
  | 'cache.hit' | 'budget.alert' | 'budget.exceeded'
  | 'experiment.created' | 'experiment.stopped';

export interface AuditEntry {
  tenant_id: string;
  actor_type: 'api_key' | 'system' | 'admin';
  actor_id?: string;
  action: AuditAction;
  resource_type?: string;
  resource_id?: string;
  ip_address?: string;
  user_agent?: string;
  details?: Record<string, unknown>;
}

export function writeAudit(entry: AuditEntry): void {
  pool.query(
    `INSERT INTO audit_logs
       (tenant_id, actor_type, actor_id, action, resource_type, resource_id,
        ip_address, user_agent, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      entry.tenant_id, entry.actor_type, entry.actor_id ?? null,
      entry.action, entry.resource_type ?? null, entry.resource_id ?? null,
      entry.ip_address ?? null, entry.user_agent ?? null,
      JSON.stringify(entry.details ?? {}),
    ]
  ).catch(() => {});
}
