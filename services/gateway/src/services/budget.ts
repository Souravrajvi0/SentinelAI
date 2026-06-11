import { pool } from '../db/client';
import { writeAudit } from './audit';

export interface BudgetStatus {
  monthly_budget_usd: number;
  spent_usd: number;
  remaining_usd: number;
  pct_used: number;
  alert_threshold_pct: number;
  exceeded: boolean;
  near_limit: boolean;
}

export async function checkBudget(tenantId: string): Promise<BudgetStatus | null> {
  const result = await pool.query<{
    monthly_budget_usd: string;
    alert_threshold_pct: number;
    alert_webhook_url: string | null;
    spent_usd: string;
  }>(
    `SELECT b.monthly_budget_usd, b.alert_threshold_pct, b.alert_webhook_url,
            COALESCE(SUM(r.cost_usd), 0) AS spent_usd
     FROM tenant_budgets b
     LEFT JOIN llm_requests r
       ON r.tenant_id = b.tenant_id
      AND r.created_at >= date_trunc('month', NOW())
      AND r.status = 'success'
     WHERE b.tenant_id = $1
     GROUP BY b.monthly_budget_usd, b.alert_threshold_pct, b.alert_webhook_url`,
    [tenantId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0]!;

  const budget = parseFloat(row.monthly_budget_usd);
  const spent = parseFloat(row.spent_usd);
  const pct = budget > 0 ? Math.round((spent / budget) * 100) : 0;
  const exceeded = spent >= budget;
  const near_limit = !exceeded && pct >= row.alert_threshold_pct;

  if ((near_limit || exceeded) && row.alert_webhook_url) {
    const event = exceeded ? 'budget.exceeded' : 'budget.alert';
    fetch(row.alert_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, tenant_id: tenantId, spent_usd: spent, budget_usd: budget, pct_used: pct }),
    }).catch(() => {});
    writeAudit({
      tenant_id: tenantId,
      actor_type: 'system',
      action: exceeded ? 'budget.exceeded' : 'budget.alert',
      details: { spent_usd: spent, budget_usd: budget, pct_used: pct },
    });
  }

  return {
    monthly_budget_usd: budget,
    spent_usd: spent,
    remaining_usd: Math.max(0, budget - spent),
    pct_used: pct,
    alert_threshold_pct: row.alert_threshold_pct,
    exceeded,
    near_limit,
  };
}
