import { queryOne, queryAll } from '@/lib/db';

interface CostOverview {
  today: number;
  this_week: number;
  this_month: number;
  total: number;
}

interface CostBreakdown {
  by_event_type: Array<{ event_type: string; total: number; count: number }>;
  by_product: Array<{ product_id: string; product_name: string; total: number; count: number }>;
  by_agent: Array<{ agent_id: string; agent_name: string; total: number; count: number }>;
}

interface PerFeatureStats {
  avg_cost_per_idea: number;
  avg_cost_per_shipped_feature: number;
  total_ideas_cost: number;
  total_build_cost: number;
}

export function getCostOverview(workspaceId: string): CostOverview {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

  // Start of week (Monday)
  const dayOfWeek = now.getDay();
  const diffToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diffToMonday).toISOString();

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const today = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, todayStart]
  );
  const week = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, weekStart]
  );
  const month = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, monthStart]
  );
  const total = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events WHERE workspace_id = ?`,
    [workspaceId]
  );

  return {
    today: today?.total || 0,
    this_week: week?.total || 0,
    this_month: month?.total || 0,
    total: total?.total || 0,
  };
}

export function getCostBreakdown(workspaceId: string): CostBreakdown {
  const by_event_type = queryAll<{ event_type: string; total: number; count: number }>(
    `SELECT event_type, SUM(cost_usd) as total, COUNT(*) as count
     FROM cost_events WHERE workspace_id = ?
     GROUP BY event_type ORDER BY total DESC`,
    [workspaceId]
  );

  const by_product = queryAll<{ product_id: string; product_name: string; total: number; count: number }>(
    `SELECT ce.product_id, COALESCE(p.name, 'Unassigned') as product_name, SUM(ce.cost_usd) as total, COUNT(*) as count
     FROM cost_events ce LEFT JOIN products p ON ce.product_id = p.id
     WHERE ce.workspace_id = ?
     GROUP BY ce.product_id ORDER BY total DESC`,
    [workspaceId]
  );

  const by_agent = queryAll<{ agent_id: string; agent_name: string; total: number; count: number }>(
    `SELECT ce.agent_id, COALESCE(a.name, 'Unknown') as agent_name, SUM(ce.cost_usd) as total, COUNT(*) as count
     FROM cost_events ce LEFT JOIN agents a ON ce.agent_id = a.id
     WHERE ce.workspace_id = ?
     GROUP BY ce.agent_id ORDER BY total DESC`,
    [workspaceId]
  );

  return { by_event_type, by_product, by_agent };
}

export function getPerFeatureStats(workspaceId: string): PerFeatureStats {
  const ideaCost = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events
     WHERE workspace_id = ? AND event_type IN ('research_cycle', 'ideation_cycle')`,
    [workspaceId]
  );

  const buildCost = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(cost_usd), 0) as total FROM cost_events
     WHERE workspace_id = ? AND event_type = 'build_task'`,
    [workspaceId]
  );

  const ideaCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM ideas WHERE product_id IN (SELECT id FROM products WHERE workspace_id = ?)`,
    [workspaceId]
  );

  const shippedCount = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM ideas WHERE status = 'shipped' AND product_id IN (SELECT id FROM products WHERE workspace_id = ?)`,
    [workspaceId]
  );

  const totalIdeas = ideaCount?.count || 0;
  const totalShipped = shippedCount?.count || 0;

  return {
    avg_cost_per_idea: totalIdeas > 0 ? (ideaCost?.total || 0) / totalIdeas : 0,
    avg_cost_per_shipped_feature: totalShipped > 0 ? ((ideaCost?.total || 0) + (buildCost?.total || 0)) / totalShipped : 0,
    total_ideas_cost: ideaCost?.total || 0,
    total_build_cost: buildCost?.total || 0,
  };
}
