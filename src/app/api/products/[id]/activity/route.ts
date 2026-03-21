import { NextRequest, NextResponse } from 'next/server';
import { queryAll } from '@/lib/db';
import type { AutopilotActivityEntry } from '@/lib/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: productId } = await params;
  const { searchParams } = request.nextUrl;

  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
  const after = searchParams.get('after');

  let sql = 'SELECT * FROM autopilot_activity_log WHERE product_id = ?';
  const sqlParams: unknown[] = [productId];

  if (after) {
    sql += ' AND created_at > ?';
    sqlParams.push(after);
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  sqlParams.push(limit);

  const entries = queryAll<AutopilotActivityEntry>(sql, sqlParams);

  return NextResponse.json({ entries });
}
