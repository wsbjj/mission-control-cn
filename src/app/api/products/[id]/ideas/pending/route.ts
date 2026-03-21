import { NextRequest, NextResponse } from 'next/server';
import { getPendingIdeas } from '@/lib/autopilot/ideation';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const ideas = getPendingIdeas(id);
    return NextResponse.json(ideas);
  } catch (error) {
    console.error('Failed to fetch pending ideas:', error);
    return NextResponse.json({ error: 'Failed to fetch pending ideas' }, { status: 500 });
  }
}
