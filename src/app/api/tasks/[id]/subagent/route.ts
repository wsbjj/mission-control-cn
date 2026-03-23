/**
 * Subagent Registration API
 * Register OpenClaw sub-agent sessions for tasks
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { ensureOpenClawIsolationColumns } from '@/lib/db/runtime-openclaw-columns';
import { broadcast } from '@/lib/events';

export const dynamic = 'force-dynamic';
/**
 * POST /api/tasks/[id]/subagent
 * Register a sub-agent session for a task
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const body = await request.json();
    
    const { openclaw_session_id, agent_name, agent_id } = body as {
      openclaw_session_id?: string;
      agent_name?: string;
      agent_id?: string;
    };

    if (!openclaw_session_id) {
      return NextResponse.json(
        { error: 'openclaw_session_id is required' },
        { status: 400 }
      );
    }

    const db = getDb();
    ensureOpenClawIsolationColumns(db);
    const sessionId = crypto.randomUUID();
    const task = db.prepare(`
      SELECT t.id, t.workspace_id, t.assigned_agent_id, w.openclaw_root_agent_id
      FROM tasks t
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.id = ?
    `).get(taskId) as { id: string; workspace_id: string; assigned_agent_id?: string | null; openclaw_root_agent_id?: string | null } | undefined;

    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Sub-agent sessions must always resolve to a workspace agent.
    let agentId = null;

    if (agent_id) {
      const existingById = db.prepare(
        'SELECT id FROM agents WHERE id = ? AND workspace_id = ?'
      ).get(agent_id, task.workspace_id) as { id: string } | undefined;
      if (!existingById) {
        return NextResponse.json(
          { error: 'Provided agent_id does not exist in this workspace' },
          { status: 400 }
        );
      }
      agentId = existingById.id;
    } else if (agent_name) {
      // Check if agent already exists
      const existingAgent = db.prepare(
        'SELECT id FROM agents WHERE name = ? AND workspace_id = ?'
      ).get(agent_name, task.workspace_id) as { id: string } | undefined;

      if (existingAgent) {
        agentId = existingAgent.id;
      } else if (process.env.ALLOW_DYNAMIC_AGENTS !== 'false') {
        // Create temporary sub-agent record (skipped when ALLOW_DYNAMIC_AGENTS=false)
        agentId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO agents (id, name, role, description, status, workspace_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          agentId,
          agent_name,
          'Sub-Agent',
          'Automatically created sub-agent',
          'working',
          task.workspace_id
        );
      } else {
        console.log(`[Subagent] Dynamic agent generation disabled (ALLOW_DYNAMIC_AGENTS=false), skipping creation of sub-agent "${agent_name}"`);
        return NextResponse.json(
          {
            error: 'Sub-agent does not exist in workspace while dynamic agent creation is disabled',
            code: 'SUBAGENT_NOT_FOUND_DYNAMIC_DISABLED',
          },
          { status: 409 }
        );
      }
    }

    if (!agentId) {
      return NextResponse.json(
        { error: 'agent_name or valid agent_id is required to register a sub-agent session' },
        { status: 400 }
      );
    }

    let inheritedSessionKeyPrefix: string | null = null;
    let inheritedModel: string | null = null;
    if (task.assigned_agent_id) {
      const parentAgent = db.prepare(`
        SELECT id, session_key_prefix, model, workspace_id
        FROM agents
        WHERE id = ?
      `).get(task.assigned_agent_id) as { id: string; session_key_prefix?: string | null; model?: string | null; workspace_id: string } | undefined;
      if (parentAgent && parentAgent.workspace_id === task.workspace_id) {
        inheritedSessionKeyPrefix = parentAgent.session_key_prefix || null;
        inheritedModel = parentAgent.model || null;
      }
    }

    // Insert OpenClaw session record
    db.prepare(`
      INSERT INTO openclaw_sessions 
        (id, agent_id, openclaw_session_id, parent_openclaw_agent_id, inherited_session_key_prefix, inherited_model, session_type, task_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      agentId,
      openclaw_session_id,
      task.openclaw_root_agent_id || null,
      inheritedSessionKeyPrefix,
      inheritedModel,
      'subagent',
      taskId,
      'active'
    );

    // Get the created session
    const session = db.prepare(`
      SELECT * FROM openclaw_sessions WHERE id = ?
    `).get(sessionId);

    // Broadcast agent spawned event
    broadcast({
      type: 'agent_spawned',
      payload: {
        taskId,
        sessionId: openclaw_session_id,
        agentName: agent_name,
      },
    });

    return NextResponse.json(session, { status: 201 });
  } catch (error) {
    console.error('Error registering sub-agent:', error);
    return NextResponse.json(
      { error: 'Failed to register sub-agent' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/tasks/[id]/subagent
 * Get all sub-agent sessions for a task
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const taskId = params.id;
    const db = getDb();

    const sessions = db.prepare(`
      SELECT 
        s.*,
        a.name as agent_name,
        a.avatar_emoji as agent_avatar_emoji
      FROM openclaw_sessions s
      LEFT JOIN agents a ON s.agent_id = a.id
      WHERE s.task_id = ? AND s.session_type = 'subagent'
      ORDER BY s.created_at DESC
    `).all(taskId);

    return NextResponse.json(sessions);
  } catch (error) {
    console.error('Error fetching sub-agents:', error);
    return NextResponse.json(
      { error: 'Failed to fetch sub-agents' },
      { status: 500 }
    );
  }
}
