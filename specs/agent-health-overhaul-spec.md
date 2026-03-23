# Agent Health System Overhaul — Completion Detection, Self-Healing & UI Alerts

**Version:** 1.0  
**Date:** 2026-03-19  
**Status:** Draft  
**Author:** Charlie (AI assistant)  
**Triggered by:** StructuredDataArchitect stall incident — agent completed task, session was aborted, health system logged "stalled" for 1+ hour without recovery

---

## Table of Contents

1. [Root Cause Analysis](#1-root-cause-analysis)
2. [Architecture Overview](#2-architecture-overview)
3. [Database Schema Changes](#3-database-schema-changes)
4. [Health Check Fix — Self-Defeating Loop](#4-health-check-fix)
5. [Task-Scoped Auth Tokens](#5-task-scoped-auth-tokens)
6. [Session Liveness Monitor](#6-session-liveness-monitor)
7. [Artifact Detection (Supplemental)](#7-artifact-detection)
8. [Escalation & Recovery Pipeline](#8-escalation--recovery-pipeline)
9. [UI — Task Card Health Indicators](#9-ui--task-card-health-indicators)
10. [UI — Board-Level Alert Banner](#10-ui--board-level-alert-banner)
11. [UI — Browser Notifications](#11-ui--browser-notifications)
12. [SSE & Store Integration](#12-sse--store-integration)
13. [Build Order](#13-build-order)
14. [Testing Plan](#14-testing-plan)

---

## 1. Root Cause Analysis

### What happened

1. Task "Schema.org JSON-LD Structured Data Auto-Injection" dispatched to StructuredDataArchitect at `17:35:52`
2. Agent cloned repo, created branch, built classifier/generator/injector/UI panel, ran 38/38 tests passing, committed, pushed, created PR #1 — **all in ~9 minutes**
3. Agent tried to callback to MC API (`PATCH /api/tasks/{id}`) — got `401 Unauthorized`
4. Agent spent 5 attempts trying auth variations, then its OpenClaw session was **aborted** at `17:45:56` (prompt-error: aborted)
5. MC's health checker saw no activity → logged "Agent health: stalled" to `task_activities`
6. **Bug:** The "stalled" log entry counted as new activity, resetting the timer. The health checker could never escalate to "stuck" (15 min threshold) because its own entries kept the timer under 6 minutes
7. Auto-nudge requires `stuck` state → never fired
8. Task remained `in_progress` with "stalled" health for 1+ hour

### Three layers of failure

| Layer | What failed | Fix |
|-------|------------|-----|
| Auth | Agent can't call MC APIs — no token provided in dispatch message | Task-scoped auth tokens |
| Health detection | Health check's own log entries count as activity → stall/stuck escalation never fires | `last_real_activity_at` field, filter system entries |
| Recovery | No session liveness check — MC doesn't know the OpenClaw session was aborted | Session monitor polling OpenClaw gateway |

---

## 2. Architecture Overview

### Current: Single-signal completion (callback only)

```
Agent finishes → tries PATCH /api/tasks/{id} → 401 → ??? → silent failure
                                                           ↑
                                              Health checker logs "stalled" forever
```

### New: Three-signal completion detection

```
Signal 1: Agent callback (with task-scoped token) ──────→ Task status updated
Signal 2: Session liveness monitor (polls gateway) ──────→ Detect dead sessions
Signal 3: Artifact detection (check git/PRs) ────────────→ Supplemental confirmation
                           ↓
              Escalation Pipeline: stalled → stuck → zombie → recovery
                           ↓
              UI: health dots on cards, alert banner, browser notifications
```

---

## 3. Database Schema Changes

### Migration: `add_health_overhaul`

```sql
-- 1. Add last_real_activity_at to agent_health
-- This tracks ONLY agent-originated activity, not health check system entries
ALTER TABLE agent_health ADD COLUMN last_real_activity_at TEXT;

-- 2. Add is_system flag to task_activities
-- Distinguishes health-check/system entries from real agent work
ALTER TABLE task_activities ADD COLUMN is_system INTEGER DEFAULT 0;

-- 3. Add task-scoped auth token to tasks
-- Short-lived token the agent uses to callback
ALTER TABLE tasks ADD COLUMN dispatch_token TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_token_expires_at TEXT;

-- 4. Add session_dead flag to openclaw_sessions
-- Set by session liveness monitor when session is confirmed dead
ALTER TABLE openclaw_sessions ADD COLUMN last_checked_at TEXT;
ALTER TABLE openclaw_sessions ADD COLUMN session_alive INTEGER DEFAULT 1;

-- 5. Track recovery attempts
ALTER TABLE agent_health ADD COLUMN recovery_attempts INTEGER DEFAULT 0;
ALTER TABLE agent_health ADD COLUMN last_recovery_at TEXT;
ALTER TABLE agent_health ADD COLUMN recovery_reason TEXT;

-- 6. Index for fast token lookup
CREATE INDEX idx_tasks_dispatch_token ON tasks(dispatch_token) WHERE dispatch_token IS NOT NULL;
```

### Backfill existing data

```sql
-- Set last_real_activity_at from the most recent NON-system activity for each agent
UPDATE agent_health SET last_real_activity_at = (
  SELECT MAX(created_at) FROM task_activities 
  WHERE task_activities.task_id = agent_health.task_id 
  AND task_activities.message NOT LIKE 'Agent health:%'
);

-- Mark existing health-check entries as system
UPDATE task_activities SET is_system = 1 
WHERE message LIKE 'Agent health:%' 
   OR message LIKE 'Agent nudged%';
```

---

## 4. Health Check Fix

### Problem

In `agent-health.ts`, `checkAgentHealth()` queries:

```typescript
const lastActivity = queryOne<{ created_at: string }>(
  `SELECT created_at FROM task_activities WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`,
  [activeTask.id]
);
```

This returns health check entries ("Agent health: stalled") as the most recent activity, keeping `minutesSince` at ~6 minutes (one cycle), preventing escalation to `stuck`.

### Fix

**Change 1:** Read `last_real_activity_at` from `agent_health` instead of querying `task_activities`:

```typescript
export function checkAgentHealth(agentId: string): AgentHealthState {
  // ... existing agent/task lookup ...

  const health = queryOne<AgentHealth>(
    'SELECT * FROM agent_health WHERE agent_id = ?',
    [agentId]
  );

  // Use last_real_activity_at (only set by real agent work)
  const lastRealActivity = health?.last_real_activity_at || activeTask.updated_at;
  const minutesSince = (Date.now() - new Date(lastRealActivity).getTime()) / 60000;

  if (minutesSince > STUCK_THRESHOLD_MINUTES) return 'stuck';
  if (minutesSince > STALL_THRESHOLD_MINUTES) return 'stalled';
  return 'working';
}
```

**Change 2:** Mark health check log entries as system:

```typescript
// In runHealthCheckCycle(), when logging stall/stuck/zombie:
run(
  `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, is_system, created_at)
   VALUES (?, ?, ?, 'status_changed', ?, 1, ?)`,
  [uuidv4(), activeTask.id, agentId, `Agent health: ${healthState}`, now]
);
```

**Change 3:** Update `last_real_activity_at` only from real agent activity sources:

```typescript
// Called from: dispatch route, checkpoint save, deliverable add, task status change (from agent)
export function recordRealActivity(agentId: string, taskId?: string): void {
  const now = new Date().toISOString();
  run(
    `UPDATE agent_health SET last_real_activity_at = ?, updated_at = ? WHERE agent_id = ?`,
    [now, now, agentId]
  );
}
```

Places that call `recordRealActivity()`:
- `POST /api/tasks/[id]/dispatch` — on successful dispatch
- `POST /api/tasks/[id]/activities` — when agent logs activity (non-system)
- `POST /api/tasks/[id]/deliverables` — when agent registers a deliverable
- `PATCH /api/tasks/[id]` — when task status changes via agent callback
- Checkpoint save (`buildCheckpointContext`)

---

## 5. Task-Scoped Auth Tokens

### Design

When dispatching, generate a short-lived token that authorizes operations **only on that specific task**. Not the master MC_API_TOKEN.

### Token generation (in dispatch route)

```typescript
import crypto from 'crypto';

function generateDispatchToken(taskId: string): { token: string; expiresAt: string } {
  // HMAC-based token: taskId + timestamp + random, signed with MC_API_TOKEN
  const secret = process.env.MC_API_TOKEN || 'dev-fallback';
  const payload = `${taskId}:${Date.now()}:${crypto.randomBytes(16).toString('hex')}`;
  const token = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  
  // Expires in 4 hours (generous — tasks rarely take longer)
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  
  return { token, expiresAt };
}
```

### Store on task row

```typescript
// In dispatch route, before sending message to agent:
const { token: dispatchToken, expiresAt: tokenExpiry } = generateDispatchToken(task.id);
run(
  'UPDATE tasks SET dispatch_token = ?, dispatch_token_expires_at = ? WHERE id = ?',
  [dispatchToken, tokenExpiry, task.id]
);
```

### Include in dispatch message

Add to the completion instructions block:

```
**AUTH TOKEN (for API callbacks):**
Include this header on all API calls: Authorization: Bearer ${dispatchToken}
This token is scoped to this task only and expires at ${tokenExpiry}.
```

### Validate in middleware

```typescript
// In middleware.ts, add before the master token check:

// Check for task-scoped dispatch token
if (pathname.match(/^\/api\/tasks\/[^/]+/)) {
  const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)/);
  if (taskIdMatch && authHeader) {
    const token = authHeader.substring(7);
    // Check if this is a valid dispatch token for this task
    const task = queryOne<{ dispatch_token: string; dispatch_token_expires_at: string }>(
      'SELECT dispatch_token, dispatch_token_expires_at FROM tasks WHERE id = ? AND dispatch_token = ?',
      [taskIdMatch[1], token]
    );
    if (task && new Date(task.dispatch_token_expires_at) > new Date()) {
      return NextResponse.next(); // Authorized for this task's endpoints
    }
  }
}
```

**Note:** The middleware uses Next.js edge runtime and can't import `better-sqlite3` directly. Two options:

**Option A (simple):** Add a lightweight API route `/api/auth/validate-dispatch-token` that the middleware calls internally. Adds ~1ms latency.

**Option B (recommended):** Keep dispatch tokens in a `Map` in-process memory (populated on startup + refreshed on dispatch). No DB call per request:

```typescript
// In-memory dispatch token cache (process-level)
const dispatchTokenCache = new Map<string, { taskId: string; expiresAt: number }>();

// On dispatch: add to cache
dispatchTokenCache.set(token, { taskId: task.id, expiresAt: Date.parse(tokenExpiry) });

// In middleware: check cache
function validateDispatchToken(token: string, taskId: string): boolean {
  const entry = dispatchTokenCache.get(token);
  if (!entry) return false;
  if (entry.taskId !== taskId) return false;
  if (Date.now() > entry.expiresAt) {
    dispatchTokenCache.delete(token);
    return false;
  }
  return true;
}
```

The cache is ephemeral — if MC restarts, tokens are lost, but agents will get a new token on the next dispatch. A cleanup interval removes expired entries every 30 minutes.

### Token lifecycle

```
Dispatch → generate token → store in DB + cache → include in agent message
Agent calls back → middleware validates token → authorized
Task reaches done/failed → token invalidated (deleted from cache + DB)
Token expires (4h) → auto-invalidated
MC restart → tokens lost from cache → agents need re-dispatch
```

---

## 6. Session Liveness Monitor

### Why

The OpenClaw session for StructuredDataArchitect was aborted at `17:45:56`. MC's `openclaw_sessions` table still showed `status = 'active'`. Nobody noticed.

### Design

Add a session liveness check to the health check cycle. MC already has an OpenClaw gateway client (`getOpenClawClient()`). Use it to verify sessions are actually alive.

### Implementation

```typescript
// New function in agent-health.ts

export async function checkSessionLiveness(agentId: string): Promise<'alive' | 'dead' | 'unknown'> {
  const session = queryOne<OpenClawSession>(
    `SELECT * FROM openclaw_sessions WHERE agent_id = ? AND status = 'active' LIMIT 1`,
    [agentId]
  );
  
  if (!session) return 'dead'; // No active session record
  
  try {
    const client = getOpenClawClient();
    if (!client.isConnected()) return 'unknown';
    
    const prefix = getAgentSessionPrefix(agentId);
    const sessionKey = `${prefix}${session.openclaw_session_id}`;
    
    // Use sessions.list or sessions.status to check if session exists
    const result = await client.call('sessions.list', {
      sessionKey,
    });
    
    // If session not found or ended, it's dead
    if (!result || result.status === 'ended') {
      // Update our record
      const now = new Date().toISOString();
      run(
        `UPDATE openclaw_sessions SET session_alive = 0, last_checked_at = ?, updated_at = ? WHERE id = ?`,
        [now, now, session.id]
      );
      return 'dead';
    }
    
    // Update last checked
    run(
      `UPDATE openclaw_sessions SET session_alive = 1, last_checked_at = ? WHERE id = ?`,
      [new Date().toISOString(), session.id]
    );
    
    return 'alive';
  } catch (err) {
    console.error(`[Health] Session liveness check failed for agent ${agentId}:`, err);
    return 'unknown';
  }
}
```

### Integration into health cycle

```typescript
// In runHealthCheckCycle(), after determining healthState:

if (healthState === 'stalled' || healthState === 'stuck') {
  // Check if the session is actually alive
  const liveness = await checkSessionLiveness(agentId);
  
  if (liveness === 'dead') {
    // Session is dead but task is still in_progress → zombie
    healthState = 'zombie';
    
    // Check if the agent actually completed (artifact detection)
    const artifacts = await checkTaskArtifacts(activeTask);
    if (artifacts.completed) {
      // Agent finished but couldn't report back — auto-complete the task
      await autoCompleteTask(activeTask, artifacts);
      healthState = 'idle'; // Resolved
    }
  }
}
```

---

## 7. Artifact Detection

### Purpose

When a session is dead and the task is still open, check if the agent actually finished the work. This prevents re-dispatching work that's already done.

### Implementation

```typescript
interface ArtifactCheck {
  completed: boolean;
  evidence: string[];
  prUrl?: string;
  branch?: string;
  filesCreated?: number;
}

export async function checkTaskArtifacts(task: Task): Promise<ArtifactCheck> {
  const evidence: string[] = [];
  let prUrl: string | undefined;
  let branch: string | undefined;
  
  // Check 1: Does the task already have a PR URL stored?
  if (task.pr_url) {
    evidence.push(`PR exists: ${task.pr_url}`);
    prUrl = task.pr_url;
  }
  
  // Check 2: For repo-backed tasks, check if branch/PR exists on GitHub
  if (task.repo_url && !prUrl) {
    try {
      const branchSlug = `autopilot/${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`;
      
      // Check if branch exists
      const branchCheck = execSync(
        `git ls-remote --heads ${task.repo_url} ${branchSlug} 2>/dev/null`
      ).toString().trim();
      
      if (branchCheck) {
        evidence.push(`Feature branch exists: ${branchSlug}`);
        branch = branchSlug;
      }
      
      // Check for open PRs via gh CLI
      const prCheck = execSync(
        `gh pr list --repo ${task.repo_url} --head ${branchSlug} --json url,state --limit 1 2>/dev/null`
      ).toString().trim();
      
      if (prCheck) {
        const prs = JSON.parse(prCheck);
        if (prs.length > 0) {
          prUrl = prs[0].url;
          evidence.push(`PR found: ${prUrl}`);
        }
      }
    } catch {
      // Git/gh CLI not available or repo not accessible — skip
    }
  }
  
  // Check 3: Check if deliverables directory exists and has files
  const projectsPath = getProjectsPath();
  const projectDir = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const taskDir = `${projectsPath}/${projectDir}`;
  
  try {
    const stat = fs.statSync(taskDir);
    if (stat.isDirectory()) {
      const files = fs.readdirSync(taskDir, { recursive: true });
      const fileCount = files.filter(f => !f.toString().includes('node_modules')).length;
      if (fileCount > 0) {
        evidence.push(`Output directory exists with ${fileCount} files`);
      }
    }
  } catch {
    // Directory doesn't exist — no artifacts
  }
  
  return {
    completed: evidence.length >= 2 || !!prUrl, // PR is strong signal; 2+ other signals needed
    evidence,
    prUrl,
    branch,
  };
}
```

### Auto-complete flow

```typescript
async function autoCompleteTask(task: Task, artifacts: ArtifactCheck): Promise<void> {
  const now = new Date().toISOString();
  
  // Update task with discovered artifacts
  const updates: Record<string, string | undefined> = {
    status: 'review', // Don't auto-mark as done — put in review for human check
    status_reason: `Auto-detected completion: ${artifacts.evidence.join('; ')}`,
    updated_at: now,
  };
  
  if (artifacts.prUrl && !task.pr_url) {
    updates.pr_url = artifacts.prUrl;
    updates.pr_status = 'open';
  }
  
  run(
    `UPDATE tasks SET status = ?, status_reason = ?, pr_url = COALESCE(?, pr_url), pr_status = COALESCE(?, pr_status), updated_at = ? WHERE id = ?`,
    [updates.status, updates.status_reason, artifacts.prUrl || null, artifacts.prUrl ? 'open' : null, now, task.id]
  );
  
  // Log the auto-completion
  run(
    `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, is_system, created_at)
     VALUES (?, ?, ?, 'auto_completed', ?, 1, ?)`,
    [uuidv4(), task.id, task.assigned_agent_id, 
     `Task auto-promoted to review: agent session died but work was completed. Evidence: ${artifacts.evidence.join(', ')}`,
     now]
  );
  
  // Broadcast update
  const updatedTask = queryOne<Task>('SELECT * FROM tasks WHERE id = ?', [task.id]);
  if (updatedTask) {
    broadcast({ type: 'task_updated', payload: updatedTask });
  }
}
```

---

## 8. Escalation & Recovery Pipeline

### State machine

```
working ──(5 min no activity)──→ stalled ──(15 min)──→ stuck ──(session dead)──→ zombie
   ↑                               │                     │                        │
   │                               │                     │                        │
   └── real activity ──────────────┘                     │                        │
   └── successful nudge ─────────────────────────────────┘                        │
   └── auto-complete (artifacts found) ───────────────────────────────────────────┘
```

### Escalation actions

| State | Trigger | Action |
|-------|---------|--------|
| `stalled` | 5 min no real activity | Log to task_activities (is_system=1). Show yellow indicator on card. |
| `stuck` | 15 min no real activity | Auto-nudge: kill session, re-dispatch with checkpoint. Max 3 nudges per task. Show red indicator. |
| `zombie` | Session confirmed dead | Check artifacts → auto-complete if found, else re-dispatch. Show red pulsing indicator + alert banner. |

### Recovery attempt limits

```typescript
const MAX_RECOVERY_ATTEMPTS = 3;

// In the recovery path:
if (health.recovery_attempts >= MAX_RECOVERY_ATTEMPTS) {
  // Give up — mark task as failed, alert user
  run(
    `UPDATE tasks SET status = 'assigned', status_reason = ?, planning_dispatch_error = ?, updated_at = ? WHERE id = ?`,
    [
      `Auto-recovery failed after ${MAX_RECOVERY_ATTEMPTS} attempts`,
      `Agent could not complete this task after ${MAX_RECOVERY_ATTEMPTS} recovery attempts. Manual intervention required.`,
      now, task.id
    ]
  );
  
  // Broadcast for alert banner
  broadcast({ 
    type: 'task_recovery_failed', 
    payload: { taskId: task.id, taskTitle: task.title, agentName: agent.name, attempts: health.recovery_attempts }
  });
  return;
}

// Increment recovery counter
run(
  `UPDATE agent_health SET recovery_attempts = recovery_attempts + 1, last_recovery_at = ?, recovery_reason = ? WHERE agent_id = ?`,
  [now, `Auto-recovery: ${healthState}`, agentId]
);
```

### Reset recovery counter

When a task moves to `done` or a new task is dispatched, reset:

```typescript
run(
  `UPDATE agent_health SET recovery_attempts = 0, recovery_reason = NULL WHERE agent_id = ?`,
  [agentId]
);
```

---

## 9. UI — Task Card Health Indicators

### Design

Add a health status indicator to the `TaskCard` component. Only shows on tasks in active states (`in_progress`, `testing`, `verification`, `convoy_active`).

### Health dot placement

Top-right corner of the card, overlapping the border slightly:

```
┌────────────────────────────────────┐
│ Schema.org JSON-LD Structured  🔴 │ ← health dot
│ Data Auto-Injection                │
│                                    │
│ 🏗️ StructuredDataArchitect        │
│ ⚠️ Stuck · 1h 22m    [Nudge]     │ ← status badge + inline action
│                                    │
│ ● Normal          2 hours ago      │
└────────────────────────────────────┘
```

### Health dot styles

```typescript
const healthDotStyles: Record<AgentHealthState, { bg: string; animate: boolean; label: string }> = {
  working:  { bg: 'bg-green-500',  animate: true,  label: 'Working' },       // green pulse
  stalled:  { bg: 'bg-yellow-500', animate: false, label: 'Stalled' },       // yellow solid
  stuck:    { bg: 'bg-red-500',    animate: true,  label: 'Stuck' },         // red pulse
  zombie:   { bg: 'bg-red-600',    animate: true,  label: 'Session dead' },  // dark red pulse
  idle:     { bg: 'bg-gray-500',   animate: false, label: 'Idle' },          // gray solid
  offline:  { bg: 'bg-gray-700',   animate: false, label: 'Offline' },       // dark gray
};
```

### Status badge (shown when stalled/stuck/zombie)

```tsx
{(healthState === 'stalled' || healthState === 'stuck' || healthState === 'zombie') && (
  <div className={`flex items-center justify-between gap-2 ${portraitMode ? 'mb-3 py-2 px-3' : 'mb-2 py-1.5 px-2.5'} ${
    healthState === 'stalled' 
      ? 'bg-yellow-500/10 border border-yellow-500/30' 
      : 'bg-red-500/10 border border-red-500/30'
  } rounded-md`}>
    <div className="flex items-center gap-2">
      <div className={`w-2 h-2 rounded-full ${
        healthState === 'stalled' ? 'bg-yellow-400' : 'bg-red-400 animate-pulse'
      }`} />
      <span className={`text-xs font-medium ${
        healthState === 'stalled' ? 'text-yellow-200' : 'text-red-300'
      }`}>
        {healthState === 'stalled' ? 'Stalled' : healthState === 'stuck' ? 'Stuck' : 'Session dead'}
        {stalledDuration && ` · ${stalledDuration}`}
      </span>
    </div>
    
    {/* Inline nudge button for stuck/zombie */}
    {(healthState === 'stuck' || healthState === 'zombie') && (
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleNudge(task.id, task.assigned_agent_id);
        }}
        className="text-xs px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded border border-red-500/30 transition-colors"
      >
        Nudge
      </button>
    )}
  </div>
)}
```

### Duration calculation

```typescript
function getHealthDuration(task: Task, healthData: AgentHealth | null): string | null {
  if (!healthData) return null;
  if (!['stalled', 'stuck', 'zombie'].includes(healthData.health_state)) return null;
  
  // Duration since last real activity
  const since = healthData.last_real_activity_at || task.updated_at;
  return formatDistanceToNow(new Date(since), { addSuffix: false });
}
```

---

## 10. UI — Board-Level Alert Banner

### Design

A persistent banner at the top of the kanban board (below the "Mission Queue" header, above the columns). Only appears when there are stuck/zombie agents.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ⚠️ 1 agent needs attention                                                 │
│                                                                             │
│ 🔴 StructuredDataArchitect stuck on "Schema.org JSON-LD..." (1h 22m)       │
│    Session aborted — work appears complete (PR #1 created)                  │
│    [View Task]  [Nudge Agent]  [Mark Complete]                              │
│                                                                        [✕] │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component

```tsx
// src/components/HealthAlertBanner.tsx

interface HealthAlert {
  agentId: string;
  agentName: string;
  agentEmoji: string;
  taskId: string;
  taskTitle: string;
  healthState: 'stuck' | 'zombie';
  duration: string;
  recoveryAttempts: number;
  sessionAlive: boolean;
  hasArtifacts: boolean;
}

export function HealthAlertBanner() {
  const { healthAlerts } = useMissionControl();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  
  const visibleAlerts = healthAlerts.filter(a => !dismissed.has(a.taskId));
  
  if (visibleAlerts.length === 0) return null;
  
  return (
    <div className="mx-3 mt-3 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-red-300">
          ⚠️ {visibleAlerts.length} agent{visibleAlerts.length > 1 ? 's' : ''} need{visibleAlerts.length === 1 ? 's' : ''} attention
        </span>
        {visibleAlerts.length > 0 && (
          <button 
            onClick={() => setDismissed(new Set(visibleAlerts.map(a => a.taskId)))}
            className="text-xs text-red-400 hover:text-red-300"
          >
            Dismiss all
          </button>
        )}
      </div>
      
      <div className="space-y-2">
        {visibleAlerts.map(alert => (
          <div key={alert.taskId} className="flex items-center justify-between gap-3 py-2 px-3 bg-mc-bg-secondary/50 rounded">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse flex-shrink-0" />
              <span className="text-base flex-shrink-0">{alert.agentEmoji}</span>
              <span className="text-xs text-mc-text-secondary truncate">
                {alert.agentName} {alert.healthState} on "{alert.taskTitle}" ({alert.duration})
                {!alert.sessionAlive && ' — session dead'}
                {alert.hasArtifacts && ' — work appears complete'}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button className="text-xs px-2 py-1 bg-mc-bg-tertiary hover:bg-mc-accent/20 text-mc-text-secondary rounded border border-mc-border transition-colors">
                View
              </button>
              <button className="text-xs px-2 py-1 bg-red-500/20 hover:bg-red-500/30 text-red-300 rounded border border-red-500/30 transition-colors">
                Nudge
              </button>
              {alert.hasArtifacts && (
                <button className="text-xs px-2 py-1 bg-green-500/20 hover:bg-green-500/30 text-green-300 rounded border border-green-500/30 transition-colors">
                  Complete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

### Placement in layout

In `MissionQueue.tsx`, add above the columns container:

```tsx
<HealthAlertBanner />
```

---

## 11. UI — Browser Notifications

### When

Fire a browser notification when:
- An agent transitions from `stalled` → `stuck`
- An agent enters `zombie` state
- Auto-recovery fails after max attempts

### Implementation

```typescript
// src/lib/notifications.ts

export function requestNotificationPermission(): void {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

export function sendHealthNotification(alert: HealthAlert): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  
  const title = alert.healthState === 'zombie' 
    ? `⚠️ Agent session dead: ${alert.agentName}`
    : `⚠️ Agent stuck: ${alert.agentName}`;
    
  const body = `"${alert.taskTitle}" — ${alert.duration} without progress${
    alert.hasArtifacts ? ' (work appears complete)' : ''
  }`;
  
  new Notification(title, {
    body,
    icon: '/favicon.ico',
    tag: `health-${alert.taskId}`, // Prevents duplicate notifications for same task
    requireInteraction: true,       // Stays until dismissed
  });
}
```

### Permission request

Request on first page load (in the workspace layout):

```tsx
useEffect(() => {
  requestNotificationPermission();
}, []);
```

---

## 12. SSE & Store Integration

### New store fields

```typescript
// In store.ts, add to the store interface:
interface MissionControlStore {
  // ... existing fields ...
  
  // Health data
  agentHealthMap: Record<string, AgentHealth>;     // agentId → health
  healthAlerts: HealthAlert[];                      // Current stuck/zombie alerts
  
  // Actions
  updateAgentHealth: (health: AgentHealth) => void;
  setHealthAlerts: (alerts: HealthAlert[]) => void;
}
```

### SSE handler update

```typescript
// In useSSE.ts, add case for health events:

case 'agent_health_changed': {
  const health = sseEvent.payload as AgentHealth;
  updateAgentHealth(health);
  
  // Generate alert if stuck/zombie
  if (health.health_state === 'stuck' || health.health_state === 'zombie') {
    // Trigger browser notification
    sendHealthNotification(buildHealthAlert(health));
  }
  break;
}

case 'task_recovery_failed': {
  const { taskId, taskTitle, agentName, attempts } = sseEvent.payload;
  sendHealthNotification({
    taskId, taskTitle, agentName,
    healthState: 'zombie',
    duration: 'recovery failed',
    recoveryAttempts: attempts,
    sessionAlive: false,
    hasArtifacts: false,
    agentId: '', agentEmoji: '🔴',
  });
  break;
}
```

### Health data on task cards

The `TaskCard` component needs access to health data. Two options:

**Option A:** Fetch health inline per card (N+1 problem — bad for many cards)

**Option B (recommended):** Keep `agentHealthMap` in the store, populated by SSE. Cards read from the map:

```tsx
function TaskCard({ task, ... }: TaskCardProps) {
  const { agentHealthMap } = useMissionControl();
  const healthData = task.assigned_agent_id 
    ? agentHealthMap[task.assigned_agent_id] 
    : null;
  
  // ... render health indicator based on healthData ...
}
```

### Initial load

On page load, fetch all health data once:

```typescript
// In workspace page or useSSE hook:
useEffect(() => {
  fetch('/api/agents/health')
    .then(r => r.json())
    .then(data => {
      const map: Record<string, AgentHealth> = {};
      data.forEach((h: AgentHealth) => { map[h.agent_id] = h; });
      setAgentHealthMap(map);
    });
}, []);
```

---

## 13. Build Order

### Phase 1: Fix the health check (critical — prevents the stall loop)
1. Migration — add `last_real_activity_at`, `is_system`, recovery columns
2. Update `agent-health.ts` — read `last_real_activity_at` instead of querying task_activities
3. Add `recordRealActivity()` helper, call from dispatch/activities/deliverables/task-update routes
4. Mark health check log entries as `is_system = 1`
5. Backfill existing data

### Phase 2: Task-scoped auth tokens
6. Token generation utility
7. Update dispatch route to generate + store token
8. Add token to dispatch message (completion instructions block)
9. Update middleware to accept dispatch tokens for task-scoped routes
10. Token cleanup on task completion/expiry

### Phase 3: Session liveness monitor
11. `checkSessionLiveness()` function
12. Integrate into health check cycle
13. Zombie detection + artifact check
14. Auto-complete flow for dead sessions with completed work

### Phase 4: UI — health indicators
15. Add `agentHealthMap` and `healthAlerts` to store
16. SSE handler for `agent_health_changed` events
17. Health API initial load on page mount
18. Health dot on TaskCard (green/yellow/red)
19. Status badge + duration on stalled/stuck/zombie cards
20. Inline Nudge button

### Phase 5: UI — alert system
21. `HealthAlertBanner` component
22. Integrate into MissionQueue layout
23. Browser notification support
24. Nudge/Complete/View actions from banner

---

## 14. Testing Plan

### Unit tests
- `recordRealActivity()` — updates `last_real_activity_at` but NOT from health check entries
- `checkAgentHealth()` — reads `last_real_activity_at`, correctly escalates stalled → stuck
- Token generation — unique per dispatch, validates correctly, rejects expired
- Token scoping — can only access its own task's endpoints
- Artifact detection — finds branches, PRs, output directories

### Integration tests
- **The stall loop fix:** Dispatch task, simulate no activity for 20 minutes → verify escalation reaches `stuck` → verify auto-nudge fires. Previously this was impossible.
- **Auth flow:** Dispatch task → agent receives token → agent calls back with token → 200 OK
- **Session death:** Dispatch task → kill OpenClaw session → next health check detects zombie → check artifacts → auto-complete
- **Recovery limits:** Nudge 3 times → fourth attempt marks task as failed → alert banner appears

### Manual smoke test
1. Dispatch a task
2. Verify green health dot on card
3. Wait 6 minutes — verify yellow dot + "Stalled · 6m" badge
4. Wait 16 minutes — verify red pulsing dot + "Stuck" badge + alert banner + browser notification
5. Click "Nudge" in banner — verify agent re-dispatches
6. Kill agent session manually — verify zombie detection + "Session dead" badge
7. If task had output, verify "work appears complete" message + "Complete" button in banner
