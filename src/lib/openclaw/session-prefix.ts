export const MAIN_SESSION_PREFIX = 'agent:main:';

export function normalizeSessionPrefix(prefix?: string | null): string | null {
  if (!prefix) return null;
  const trimmed = prefix.trim();
  if (!trimmed) return null;
  return trimmed.endsWith(':') ? trimmed : `${trimmed}:`;
}

// Route default workspace traffic to "main" for backward compatibility.
export function buildWorkspaceSessionPrefix(workspaceSlug?: string | null): string {
  if (!workspaceSlug || workspaceSlug === 'default') {
    return MAIN_SESSION_PREFIX;
  }
  return `agent:${workspaceSlug}:`;
}

export function resolveSessionPrefix(params: {
  inheritedPrefix?: string | null;
  agentPrefix?: string | null;
  workspaceSlug?: string | null;
}): string {
  return (
    normalizeSessionPrefix(params.inheritedPrefix) ||
    normalizeSessionPrefix(params.agentPrefix) ||
    buildWorkspaceSessionPrefix(params.workspaceSlug)
  );
}

