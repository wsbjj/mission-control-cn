import { NextRequest, NextResponse } from 'next/server';
import { getCheckpoints } from '@/lib/checkpoint';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/tasks/[id]/checkpoints — List all checkpoints for a task
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const checkpoints = getCheckpoints(id);
    return NextResponse.json(checkpoints);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch checkpoints' }, { status: 500 });
  }
}
