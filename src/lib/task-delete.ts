/**
 * Cascade delete tasks: children first (parent_task_id FK), then dependencies without relying solely on DB CASCADE.
 */

import { queryAll, queryOne, run, transaction } from '@/lib/db';

function childTaskIds(parentId: string): string[] {
  return queryAll<{ id: string }>('SELECT id FROM tasks WHERE parent_task_id = ?', [parentId]).map((r) => r.id);
}

/** Post-order: every child subtree before parent (safe for tasks.parent_task_id → tasks.id). */
export function collectPostOrderTaskIds(rootId: string): string[] {
  const order: string[] = [];
  const visited = new Set<string>();
  const walk = (tid: string) => {
    if (visited.has(tid)) return;
    visited.add(tid);
    for (const cid of childTaskIds(tid)) {
      walk(cid);
    }
    order.push(tid);
  };
  walk(rootId);
  return order;
}

/** Remove rows that reference this task_id (events/openclaw/knowledge have no or weak CASCADE in some DBs). */
export function deleteTaskRowDependencies(taskId: string): void {
  run('DELETE FROM openclaw_sessions WHERE task_id = ?', [taskId]);
  run('DELETE FROM events WHERE task_id = ?', [taskId]);
  run('UPDATE conversations SET task_id = NULL WHERE task_id = ?', [taskId]);
  run('DELETE FROM knowledge_entries WHERE task_id = ?', [taskId]);
  run('DELETE FROM task_activities WHERE task_id = ?', [taskId]);
  run('DELETE FROM task_deliverables WHERE task_id = ?', [taskId]);
  run('DELETE FROM task_roles WHERE task_id = ?', [taskId]);
  run('DELETE FROM task_role_agents WHERE task_id = ?', [taskId]);
  run('DELETE FROM planning_questions WHERE task_id = ?', [taskId]);
  run('DELETE FROM planning_specs WHERE task_id = ?', [taskId]);
}

/**
 * Delete root task and all descendants. Returns ids deleted in post-order (children before parents).
 * Run inside one transaction.
 */
export function deleteTaskCascade(rootTaskId: string): string[] {
  return transaction(() => {
    const ids = collectPostOrderTaskIds(rootTaskId);

    const agentIds = new Set<string>();
    for (const tid of ids) {
      const row = queryOne<{ assigned_agent_id: string | null }>(
        'SELECT assigned_agent_id FROM tasks WHERE id = ?',
        [tid]
      );
      if (row?.assigned_agent_id) agentIds.add(row.assigned_agent_id);
    }

    for (const tid of ids) {
      deleteTaskRowDependencies(tid);
      run('DELETE FROM tasks WHERE id = ?', [tid]);
    }

    const now = new Date().toISOString();
    const placeholders = ids.map(() => '?').join(',');
    for (const agentId of agentIds) {
      const otherActive = queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM tasks
         WHERE assigned_agent_id = ?
           AND (status IN ('assigned', 'in_progress', 'testing', 'review', 'verification') OR status LIKE 'verification_v%')
           AND id NOT IN (${placeholders})`,
        [agentId, ...ids]
      );
      if (!otherActive || otherActive.count === 0) {
        run(
          `UPDATE agents SET status = ?, updated_at = ? WHERE id = ? AND status = ?`,
          ['standby', now, agentId, 'working']
        );
      }
    }

    return ids;
  });
}
