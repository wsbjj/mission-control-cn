import { NextRequest, NextResponse } from 'next/server';
import { getConvoy } from '@/lib/convoy';
import { queryAll } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/convoy/progress — Real-time progress summary
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const convoy = getConvoy(id);

    if (!convoy) {
      return NextResponse.json({ error: 'No convoy found for this task' }, { status: 404 });
    }

    // Get status breakdown
    const statusCounts = queryAll<{ status: string; cnt: number }>(
      `SELECT t.status, COUNT(*) as cnt
       FROM convoy_subtasks cs
       JOIN tasks t ON cs.task_id = t.id
       WHERE cs.convoy_id = ?
       GROUP BY t.status`,
      [convoy.id]
    );

    const breakdown: Record<string, number> = {};
    for (const { status, cnt } of statusCounts) {
      breakdown[status] = cnt;
    }

    return NextResponse.json({
      convoy_id: convoy.id,
      status: convoy.status,
      total: convoy.total_subtasks,
      completed: convoy.completed_subtasks,
      failed: convoy.failed_subtasks,
      breakdown,
      subtasks: convoy.subtasks.map(st => ({
        id: st.id,
        task_id: st.task_id,
        title: st.task?.title,
        status: st.task?.status,
        assigned_agent_id: st.task?.assigned_agent_id,
        sort_order: st.sort_order,
        depends_on: st.depends_on,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch progress' }, { status: 500 });
  }
}
