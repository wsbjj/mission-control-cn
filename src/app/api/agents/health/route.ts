import { NextRequest, NextResponse } from 'next/server';
import { getAllAgentHealth, runHealthCheckCycle } from '@/lib/agent-health';

export const dynamic = 'force-dynamic';

// GET /api/agents/health — Get health state of all agents
export async function GET() {
  try {
    const health = getAllAgentHealth();
    return NextResponse.json(health);
  } catch (error) {
    return NextResponse.json({ error: 'Failed to fetch agent health' }, { status: 500 });
  }
}

// POST /api/agents/health — Trigger a health check cycle
export async function POST() {
  try {
    const results = await runHealthCheckCycle();
    return NextResponse.json({
      checked: results.length,
      results: results.map(r => ({
        agent_id: r.agent_id,
        health_state: r.health_state,
        task_id: r.task_id,
        consecutive_stall_checks: r.consecutive_stall_checks,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: 'Health check cycle failed' }, { status: 500 });
  }
}
