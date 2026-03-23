import { getOpenClawClient } from '@/lib/openclaw/client';

function normalizeWorkspaceAgentName(workspaceId: string, workspaceSlug: string): string {
  return `mc-workspace-${workspaceSlug}-${workspaceId.slice(0, 8)}`;
}

function normalizeWorkspaceRoleAgentName(workspaceId: string, workspaceSlug: string, role: string): string {
  return `mc-${workspaceSlug}-${workspaceId.slice(0, 8)}-${role}-agent`;
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

async function bestEffortDisableAgentsByName(
  client: ReturnType<typeof getOpenClawClient>,
  agentName: string
): Promise<void> {
  try {
    const list = await client.listAgents() as Array<{ id?: string; name?: string; status?: string }>;
    const candidates = list.filter((a) => a.name === agentName && a.id);
    for (const candidate of candidates) {
      if (!candidate.id) continue;
      try {
        await client.disableAgent(candidate.id);
      } catch {
        // Fallback for gateways exposing status update instead of disable.
        await client.call('agents.update', { agentId: candidate.id, status: 'disabled' });
      }
    }
  } catch {
    // Best-effort cleanup: ignore secondary failures.
  }
}

export async function bestEffortDisableWorkspaceAgents(params: {
  workspaceId: string;
  workspaceSlug: string;
  roles: string[];
}): Promise<void> {
  const client = getOpenClawClient();
  try {
    if (!client.isConnected()) {
      await client.connect();
    }
    const names = new Set<string>();
    names.add(normalizeWorkspaceAgentName(params.workspaceId, params.workspaceSlug));
    for (const role of params.roles) {
      names.add(normalizeWorkspaceRoleAgentName(params.workspaceId, params.workspaceSlug, role));
    }
    for (const name of names) {
      await bestEffortDisableAgentsByName(client, name);
    }
  } catch {
    // Best-effort cleanup: ignore secondary failures.
  }
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

  // Creation may have succeeded but id lookup failed; prevent orphan agents.
  await bestEffortDisableAgentsByName(client, expectedName);
  throw new Error('OpenClaw did not return or expose a resolvable root agent id after create');
}

export async function ensureWorkspaceRoleAgents(params: {
  workspaceId: string;
  workspaceSlug: string;
  roles: Array<{ role: string; name: string; model?: string | null }>;
}): Promise<Map<string, { gatewayAgentId: string; sessionKeyPrefix: string }>> {
  const client = getOpenClawClient();
  if (!client.isConnected()) {
    await client.connect();
  }

  const existing = await client.listAgents() as Array<{ id?: string; name?: string; status?: string }>;
  const mapping = new Map<string, { gatewayAgentId: string; sessionKeyPrefix: string }>();
  const prefix = `agent:${params.workspaceSlug}:`;

  for (const roleAgent of params.roles) {
    const expectedName = normalizeWorkspaceRoleAgentName(
      params.workspaceId,
      params.workspaceSlug,
      roleAgent.role
    );
    const found = existing.find((a) => a.name === expectedName);
    if (found?.id) {
      mapping.set(roleAgent.role, { gatewayAgentId: found.id, sessionKeyPrefix: prefix });
      continue;
    }

    const created = await client.createAgent({
      workspace: params.workspaceSlug,
      name: expectedName,
      model: roleAgent.model || undefined,
    }) as unknown as Record<string, unknown>;

    const createdId = resolveAgentId(created);
    if (createdId) {
      mapping.set(roleAgent.role, { gatewayAgentId: createdId, sessionKeyPrefix: prefix });
      continue;
    }

    const refreshed = await client.listAgents() as Array<{ id?: string; name?: string }>;
    const matched = refreshed.find((a) => a.name === expectedName);
    if (matched?.id) {
      mapping.set(roleAgent.role, { gatewayAgentId: matched.id, sessionKeyPrefix: prefix });
      continue;
    }

    throw new Error(`Unable to resolve workspace role agent id for role=${roleAgent.role}`);
  }

  return mapping;
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

