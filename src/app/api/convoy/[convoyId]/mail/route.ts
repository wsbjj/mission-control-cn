import { NextRequest, NextResponse } from 'next/server';
import { sendMail, getConvoyMail } from '@/lib/mailbox';

export const dynamic = 'force-dynamic';

interface RouteParams {
  params: Promise<{ convoyId: string }>;
}

// POST /api/convoy/[convoyId]/mail — Send a message to another agent in the convoy
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { convoyId } = await params;
    const body = await request.json();
    const { from_agent_id, to_agent_id, subject, body: messageBody } = body as {
      from_agent_id: string;
      to_agent_id: string;
      subject?: string;
      body: string;
    };

    if (!from_agent_id || !to_agent_id || !messageBody) {
      return NextResponse.json(
        { error: 'from_agent_id, to_agent_id, and body are required' },
        { status: 400 }
      );
    }

    const message = sendMail({
      convoyId,
      fromAgentId: from_agent_id,
      toAgentId: to_agent_id,
      subject,
      body: messageBody,
    });

    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to send mail';
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

// GET /api/convoy/[convoyId]/mail — Get all mail in a convoy
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { convoyId } = await params;
    const messages = getConvoyMail(convoyId);
    return NextResponse.json(messages);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch convoy mail' }, { status: 500 });
  }
}
