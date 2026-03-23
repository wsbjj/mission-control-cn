import { NextResponse } from 'next/server';
import { getHealthDetail, formatPrometheus } from '@/lib/health';

export const dynamic = 'force-dynamic';

/**
 * GET /api/health/metrics
 *
 * Returns Prometheus text exposition format (text/plain; version=0.0.4).
 * Unauthenticated — designed for scraping by Prometheus/Grafana/etc.
 */
export async function GET() {
  try {
    const detail = getHealthDetail();
    const body = formatPrometheus(detail);

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return new NextResponse(
      `# ERROR: Health metrics unavailable\n# ${error instanceof Error ? error.message : String(error)}\n`,
      {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      },
    );
  }
}
