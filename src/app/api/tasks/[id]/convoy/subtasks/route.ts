import { NextRequest, NextResponse } from 'next/server';
import { getConvoy, addSubtasks } from '@/lib/convoy';
import { run } from '@/lib/db';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST /api/tasks/[id]/convoy/subtasks — Add subtask(s) to a convoy
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { subtasks } = body as {
      subtasks: Array<{ title: string; description?: string; agent_id?: string; depends_on?: string[] }>;
    };

    if (!subtasks || !Array.isArray(subtasks) || subtasks.length === 0) {
      return NextResponse.json({ error: 'subtasks array is required' }, { status: 400 });
    }

    const convoy = getConvoy(id);
    if (!convoy) {
      return NextResponse.json({ error: 'No convoy found for this task' }, { status: 404 });
    }

    const created = addSubtasks(convoy.id, subtasks);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to add subtasks';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

// DELETE /api/tasks/[id]/convoy/subtasks?subtaskId=xxx — Remove a subtask
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const subtaskId = request.nextUrl.searchParams.get('subtaskId');

    if (!subtaskId) {
      return NextResponse.json({ error: 'subtaskId query param is required' }, { status: 400 });
    }

    const convoy = getConvoy(id);
    if (!convoy) {
      return NextResponse.json({ error: 'No convoy found for this task' }, { status: 404 });
    }

    // Delete the task (CASCADE handles convoy_subtasks)
    run('DELETE FROM tasks WHERE id = ? AND is_subtask = 1', [subtaskId]);
    run('UPDATE convoys SET total_subtasks = total_subtasks - 1, updated_at = datetime(\'now\') WHERE id = ?', [convoy.id]);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to remove subtask';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
