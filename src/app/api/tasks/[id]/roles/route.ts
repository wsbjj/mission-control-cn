import { NextRequest, NextResponse } from 'next/server';
import { queryAll, queryOne, run, getDb } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { Task } from '@/lib/types';

export const dynamic = 'force-dynamic';

const normalizeRole = (value: string) => value.trim().toLowerCase();

type PutRoleEntry =
  | { role: string; agent_id: string }
  | { role: string; agent_ids: string[] };

function toAgentIds(entry: PutRoleEntry): string[] {
  if ('agent_ids' in entry) return Array.isArray(entry.agent_ids) ? entry.agent_ids : [];
  if ('agent_id' in entry && entry.agent_id) return [entry.agent_id];
  return [];
}

/**
 * GET /api/tasks/[id]/roles
 * List role assignments for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const rows = queryAll<{
      id: string;
      task_id: string;
      role: string;
      agent_id: string;
      created_at: string;
      agent_name: string;
      agent_emoji: string;
    }>(
      `SELECT tra.*, a.name as agent_name, a.avatar_emoji as agent_emoji
       FROM task_role_agents tra
       JOIN agents a ON tra.agent_id = a.id
       WHERE tra.task_id = ?
       ORDER BY tra.created_at ASC`,
      [taskId]
    );

    const map = new Map<string, {
      role: string;
      agent_ids: string[];
      agents: Array<{ id: string; name: string; avatar_emoji: string }>;
    }>();

    for (const r of rows) {
      const role = normalizeRole(r.role || '');
      if (!role) continue;
      const existing = map.get(role) || { role, agent_ids: [], agents: [] };
      if (!existing.agent_ids.includes(r.agent_id)) {
        existing.agent_ids.push(r.agent_id);
        existing.agents.push({ id: r.agent_id, name: r.agent_name, avatar_emoji: r.agent_emoji });
      }
      map.set(role, existing);
    }

    return NextResponse.json(Array.from(map.values()));
  } catch (error) {
    console.error('Failed to fetch task roles:', error);
    return NextResponse.json({ error: 'Failed to fetch roles' }, { status: 500 });
  }
}

/**
 * PUT /api/tasks/[id]/roles
 * Assign roles for a task (replaces all existing role assignments)
 * Body (legacy): { roles: [{ role: "builder", agent_id: "..." }, ...] }
 * Body (new):    { roles: [{ role: "builder", agent_ids: ["...","..."] }, ...] }
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  try {
    const body = await request.json();
    const { roles } = body;

    if (!Array.isArray(roles)) {
      return NextResponse.json(
        { error: 'roles must be an array of { role, agent_id } or { role, agent_ids }' },
        { status: 400 }
      );
    }

    const task = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [taskId]);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    const db = getDb();
    db.transaction(() => {
      // Clear existing role-agent assignments
      db.prepare('DELETE FROM task_role_agents WHERE task_id = ?').run(taskId);

      // Insert new role-agent assignments (normalized + deduped per (role,agent))
      const insert = db.prepare(
        `INSERT INTO task_role_agents (id, task_id, role, agent_id, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      );

      const firstAgentByRole = new Map<string, string>();
      const seen = new Set<string>();
      for (const entry of roles as PutRoleEntry[]) {
        const normalizedRole = normalizeRole((entry as any).role || '');
        if (!normalizedRole) continue;

        const agentIds = toAgentIds(entry)
          .map(String)
          .map(s => s.trim())
          .filter(Boolean);

        for (const agentId of agentIds) {
          const key = `${normalizedRole}::${agentId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          insert.run(crypto.randomUUID(), taskId, normalizedRole, agentId);
          if (!firstAgentByRole.has(normalizedRole)) firstAgentByRole.set(normalizedRole, agentId);
        }
      }

      // Also set the primary assigned_agent_id to the builder (first selected) if not set
      if (firstAgentByRole.size > 0 && !task.assigned_agent_id) {
        const builderAgentId = firstAgentByRole.get('builder') || Array.from(firstAgentByRole.values())[0];
        if (builderAgentId) {
          db.prepare('UPDATE tasks SET assigned_agent_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(builderAgentId, taskId);
        }
      }
    })();

    // Fetch and return updated roles (aggregated)
    const rows = queryAll<{
      id: string; task_id: string; role: string; agent_id: string;
      created_at: string; agent_name: string; agent_emoji: string;
    }>(
      `SELECT tra.*, a.name as agent_name, a.avatar_emoji as agent_emoji
       FROM task_role_agents tra
       JOIN agents a ON tra.agent_id = a.id
       WHERE tra.task_id = ?
       ORDER BY tra.created_at ASC`,
      [taskId]
    );
    const map = new Map<string, {
      role: string;
      agent_ids: string[];
      agents: Array<{ id: string; name: string; avatar_emoji: string }>;
    }>();
    for (const r of rows) {
      const role = normalizeRole(r.role || '');
      if (!role) continue;
      const existing = map.get(role) || { role, agent_ids: [], agents: [] };
      if (!existing.agent_ids.includes(r.agent_id)) {
        existing.agent_ids.push(r.agent_id);
        existing.agents.push({ id: r.agent_id, name: r.agent_name, avatar_emoji: r.agent_emoji });
      }
      map.set(role, existing);
    }
    const updatedRoles = Array.from(map.values());

    // Broadcast task update
    const updatedTask = queryOne<Task>(
      `SELECT t.*, aa.name as assigned_agent_name, aa.avatar_emoji as assigned_agent_emoji
       FROM tasks t LEFT JOIN agents aa ON t.assigned_agent_id = aa.id WHERE t.id = ?`,
      [taskId]
    );
    if (updatedTask) {
      broadcast({ type: 'task_updated', payload: updatedTask });
    }

    return NextResponse.json(updatedRoles);
  } catch (error) {
    console.error('Failed to update task roles:', error);
    return NextResponse.json({ error: 'Failed to update roles' }, { status: 500 });
  }
}
