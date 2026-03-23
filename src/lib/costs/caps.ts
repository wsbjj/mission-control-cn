import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { CostCap } from '@/lib/types';

export function createCostCap(input: {
  workspace_id?: string;
  product_id?: string | null;
  cap_type: string;
  limit_usd: number;
  period_start?: string;
  period_end?: string;
}): CostCap {
  const id = uuidv4();
  const workspaceId = input.workspace_id || 'default';
  const now = new Date().toISOString();

  run(
    `INSERT INTO cost_caps (id, workspace_id, product_id, cap_type, limit_usd, period_start, period_end, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, workspaceId, input.product_id || null, input.cap_type, input.limit_usd, input.period_start || null, input.period_end || null, now, now]
  );

  return queryOne<CostCap>('SELECT * FROM cost_caps WHERE id = ?', [id])!;
}

export function listCostCaps(workspaceId?: string, productId?: string): CostCap[] {
  if (productId) {
    return queryAll<CostCap>(
      'SELECT * FROM cost_caps WHERE product_id = ? ORDER BY created_at DESC',
      [productId]
    );
  }
  const wsId = workspaceId || 'default';
  return queryAll<CostCap>(
    'SELECT * FROM cost_caps WHERE workspace_id = ? ORDER BY created_at DESC',
    [wsId]
  );
}

export function updateCostCap(id: string, updates: Partial<{
  limit_usd: number;
  status: string;
  current_spend_usd: number;
  period_start: string;
  period_end: string;
}>): CostCap | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (fields.length === 0) return queryOne<CostCap>('SELECT * FROM cost_caps WHERE id = ?', [id]);

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  run(`UPDATE cost_caps SET ${fields.join(', ')} WHERE id = ?`, values);
  return queryOne<CostCap>('SELECT * FROM cost_caps WHERE id = ?', [id]);
}

export function deleteCostCap(id: string): boolean {
  return run('DELETE FROM cost_caps WHERE id = ?', [id]).changes > 0;
}

/** Check all active caps for a workspace/product. Returns warnings and exceeded caps. */
export function checkCaps(workspaceId: string, productId?: string): {
  warnings: CostCap[];
  exceeded: CostCap[];
  ok: boolean;
} {
  const caps = queryAll<CostCap>(
    `SELECT * FROM cost_caps WHERE workspace_id = ? AND status = 'active'`,
    [workspaceId]
  );

  const warnings: CostCap[] = [];
  const exceeded: CostCap[] = [];

  for (const cap of caps) {
    // Skip product-specific caps if checking workspace-level
    if (cap.product_id && productId && cap.product_id !== productId) continue;

    // Calculate current spend based on cap type
    let currentSpend = 0;
    const now = new Date();

    if (cap.cap_type === 'daily') {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const result = queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE workspace_id = ? AND created_at >= ?`,
        [workspaceId, todayStart]
      );
      currentSpend = result?.total || 0;
    } else if (cap.cap_type === 'monthly') {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const result = queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE workspace_id = ? AND created_at >= ?`,
        [workspaceId, monthStart]
      );
      currentSpend = result?.total || 0;
    } else if (cap.cap_type === 'per_product_monthly' && (cap.product_id || productId)) {
      const pid = cap.product_id || productId;
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const result = queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE product_id = ? AND created_at >= ?`,
        [pid, monthStart]
      );
      currentSpend = result?.total || 0;
    } else {
      currentSpend = cap.current_spend_usd;
    }

    // Update current_spend_usd
    run('UPDATE cost_caps SET current_spend_usd = ? WHERE id = ?', [currentSpend, cap.id]);

    const ratio = currentSpend / cap.limit_usd;

    if (ratio >= 1) {
      exceeded.push({ ...cap, current_spend_usd: currentSpend });
      if (cap.status !== 'exceeded') {
        run(`UPDATE cost_caps SET status = 'exceeded', updated_at = ? WHERE id = ?`, [new Date().toISOString(), cap.id]);
        broadcast({ type: 'cost_cap_exceeded', payload: { capId: cap.id, capType: cap.cap_type, currentSpend, limit: cap.limit_usd } });
      }
    } else if (ratio >= 0.8) {
      warnings.push({ ...cap, current_spend_usd: currentSpend });
      broadcast({ type: 'cost_cap_warning', payload: { capId: cap.id, capType: cap.cap_type, currentSpend, limit: cap.limit_usd, ratio } });
    }
  }

  return { warnings, exceeded, ok: exceeded.length === 0 };
}
