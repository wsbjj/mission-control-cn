import { NextRequest, NextResponse } from 'next/server';
import { queryOne, run } from '@/lib/db';
import { getMissionControlUrl } from '@/lib/config';

export const dynamic = 'force-dynamic';

/**
 * POST /api/tasks/[id]/dispatch/retry
 *
 * Clears `planning_dispatch_error` and sends the task prompt to OpenClaw again
 * (same body as POST /api/tasks/[id]/dispatch). Use after chat.send timeouts,
 * gateway flakes, or when the agent never picked up the work.
 *
 * Optional: schedule this URL from cron / external automation with MC_API_TOKEN.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: taskId } = await params;

  const task = queryOne<{ id: string; assigned_agent_id: string | null }>(
    'SELECT id, assigned_agent_id FROM tasks WHERE id = ?',
    [taskId]
  );

  if (!task) {
    return NextResponse.json({ error: 'Task not found' }, { status: 404 });
  }

  if (!task.assigned_agent_id) {
    return NextResponse.json({ error: 'Task has no assigned agent' }, { status: 400 });
  }

  run(`UPDATE tasks SET planning_dispatch_error = NULL, updated_at = datetime('now') WHERE id = ?`, [taskId]);

  const base = getMissionControlUrl().replace(/\/$/, '');
  const headers: HeadersInit = { Accept: 'application/json' };
  if (process.env.MC_API_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.MC_API_TOKEN}`;
  }

  try {
    const dispatchRes = await fetch(`${base}/api/tasks/${taskId}/dispatch`, {
      method: 'POST',
      headers,
    });
    const text = await dispatchRes.text();
    let details: unknown;
    try {
      details = JSON.parse(text);
    } catch {
      details = { raw: text };
    }

    if (!dispatchRes.ok) {
      return NextResponse.json(
        {
          success: false,
          error: 'Dispatch retry failed',
          httpStatus: dispatchRes.status,
          details,
        },
        { status: dispatchRes.status >= 400 && dispatchRes.status < 600 ? dispatchRes.status : 502 }
      );
    }

    return NextResponse.json({ success: true, message: 'Dispatch replayed', details });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    run(`UPDATE tasks SET planning_dispatch_error = ?, updated_at = datetime('now') WHERE id = ?`, [
      `Redispatch fetch failed: ${msg}`,
      taskId,
    ]);
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
