import { getOpenClawClient } from '@/lib/openclaw/client';

function normalizeWorkspaceAgentName(workspaceId: string, workspaceSlug: string): string {
  return `mc-workspace-${workspaceSlug}-${workspaceId.slice(0, 8)}`;
}

function resolveAgentId(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) return null;
  const id =
    record.id ||
    record.agentId ||
    record.agent_id ||
    (typeof record.agent === 'object' && record.agent
      ? ((record.agent as Record<string, unknown>).id ||
        (record.agent as Record<string, unknown>).agentId ||
        (record.agent as Record<string, unknown>).agent_id)
      : null);
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export async function createWorkspaceRootAgent(params: {
  workspaceId: string;
  workspaceSlug: string;
  preferredModel?: string | null;
}): Promise<{ agentId: string; status: string }> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  const list = await client.listAgents() as Array<{ id?: string; name?: string; status?: string }>;
  const expectedName = normalizeWorkspaceAgentName(params.workspaceId, params.workspaceSlug);
  const existing = list.find((a) => a.name === expectedName);
  if (existing?.id) {
    return { agentId: existing.id, status: existing.status || 'active' };
  }

  const created = await client.createAgent({
    workspace: params.workspaceSlug,
    name: expectedName,
    model: params.preferredModel || undefined,
  }) as unknown as Record<string, unknown>;

  const createdId = resolveAgentId(created);
  if (createdId) {
    const createdStatus = typeof created.status === 'string' ? created.status : 'active';
    return { agentId: createdId, status: createdStatus };
  }

  // Some gateway versions return an ack without agent id. Re-query by deterministic name.
  const refreshed = await client.listAgents() as Array<{ id?: string; name?: string; status?: string }>;
  const matched = refreshed.find((a) => a.name === expectedName);
  if (matched?.id) {
    return { agentId: matched.id, status: matched.status || 'active' };
  }

  throw new Error('OpenClaw did not return or expose a resolvable root agent id after create');
}

export async function disableWorkspaceRootAgent(agentId: string): Promise<void> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  try {
    await client.disableAgent(agentId);
    return;
  } catch (error) {
    // Fallback for gateways exposing status update instead of disable.
    await client.call('agents.update', { agentId, status: 'disabled' });
    if (error) {
      // no-op: keep first error suppressed once fallback succeeds
    }
  }
}

