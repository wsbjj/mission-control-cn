/**
 * Error Reporting — server-side log collection for error reports.
 * Returns formatted logs that get pre-filled into a mailto: link.
 */

import { queryAll, queryOne } from '@/lib/db';

/**
 * Collect recent logs relevant to the error context.
 * Gathers from autopilot_activity_log, task_activities, and operations_log.
 */
export function collectRecentLogs(context: {
  productId?: string;
  taskId?: string;
  limit?: number;
}): string {
  const limit = context.limit || 30;
  const sections: string[] = [];

  if (context.productId) {
    const product = queryOne<{ name: string }>('SELECT name FROM products WHERE id = ?', [context.productId]);
    if (product) sections.push(`Product: ${product.name}`);

    const activities = queryAll<{ event_type: string; message: string; detail: string | null; created_at: string }>(
      `SELECT event_type, message, detail, created_at FROM autopilot_activity_log
       WHERE product_id = ? ORDER BY created_at DESC LIMIT ?`,
      [context.productId, limit]
    );
    if (activities.length > 0) {
      sections.push('\n--- Autopilot Activity ---');
      for (const a of activities) {
        sections.push(`[${a.created_at}] ${a.event_type}: ${a.message}${a.detail ? ` | ${a.detail}` : ''}`);
      }
    }

    const failedCycles = queryAll<{ id: string; error_message: string; current_phase: string; created_at: string }>(
      `SELECT id, error_message, current_phase, created_at FROM ideation_cycles
       WHERE product_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 3`,
      [context.productId]
    );
    if (failedCycles.length > 0) {
      sections.push('\n--- Failed Ideation Cycles ---');
      for (const c of failedCycles) {
        sections.push(`[${c.created_at}] ${c.id.slice(0, 8)} phase:${c.current_phase} err:${c.error_message}`);
      }
    }

    const failedResearch = queryAll<{ id: string; error_message: string; current_phase: string; created_at: string }>(
      `SELECT id, error_message, current_phase, created_at FROM research_cycles
       WHERE product_id = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 3`,
      [context.productId]
    );
    if (failedResearch.length > 0) {
      sections.push('\n--- Failed Research Cycles ---');
      for (const c of failedResearch) {
        sections.push(`[${c.created_at}] ${c.id.slice(0, 8)} phase:${c.current_phase} err:${c.error_message}`);
      }
    }
  }

  if (context.taskId) {
    const task = queryOne<{ title: string }>('SELECT title FROM tasks WHERE id = ?', [context.taskId]);
    if (task) sections.push(`Task: ${task.title}`);

    const taskActivities = queryAll<{ activity_type: string; message: string; created_at: string }>(
      `SELECT activity_type, message, created_at FROM task_activities
       WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      [context.taskId, limit]
    );
    if (taskActivities.length > 0) {
      sections.push('\n--- Task Activities ---');
      for (const a of taskActivities) {
        sections.push(`[${a.created_at}] ${a.activity_type}: ${a.message}`);
      }
    }
  }

  return sections.join('\n') || 'No recent logs found.';
}
