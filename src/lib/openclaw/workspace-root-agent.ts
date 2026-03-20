import { getOpenClawClient } from '@/lib/openclaw/client';

function normalizeWorkspaceAgentName(workspaceId: string, workspaceSlug: string): string {
  return `mc-workspace-${workspaceSlug}-${workspaceId.slice(0, 8)}`;
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
  });

  if (!created?.id) {
    throw new Error('OpenClaw returned empty agent id for workspace root agent');
  }

  return { agentId: created.id, status: created.status || 'active' };
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

