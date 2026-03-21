import { NextRequest, NextResponse } from 'next/server';
import { runResearchCycle } from '@/lib/autopilot/research';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const cycleId = await runResearchCycle(id);
    return NextResponse.json({ cycle_id: cycleId }, { status: 202 });
  } catch (error) {
    console.error('Failed to start research cycle:', error);
    const message = error instanceof Error ? error.message : 'Failed to start research cycle';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
