import { NextRequest, NextResponse } from 'next/server';
import { collectRecentLogs } from '@/lib/error-reporting';

/**
 * GET /api/error-reports/logs?productId=xxx&taskId=yyy
 * Returns recent logs for a given context, used to pre-fill the mailto body.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const productId = searchParams.get('productId') || undefined;
  const taskId = searchParams.get('taskId') || undefined;

  const logs = collectRecentLogs({ productId, taskId });
  return NextResponse.json({ logs });
}
