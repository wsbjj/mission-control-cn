import { NextRequest, NextResponse } from 'next/server';
import { getUnreadMail, markAsRead } from '@/lib/mailbox';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ id: string }>;
}

// GET /api/agents/[id]/mail — Get unread mail for an agent
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const messages = getUnreadMail(id);
    return NextResponse.json(messages);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch mail' }, { status: 500 });
  }
}

// PATCH /api/agents/[id]/mail?messageId=xxx — Mark message as read
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const messageId = request.nextUrl.searchParams.get('messageId');
    if (!messageId) {
      return NextResponse.json({ error: 'messageId query param is required' }, { status: 400 });
    }

    markAsRead(messageId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: 'Failed to mark message as read' }, { status: 500 });
  }
}
