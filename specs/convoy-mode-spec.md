# Convoy Mode — Parallel Sub-Task Execution for Mission Control

**Version:** 1.0  
**Date:** 2026-03-18  
**Status:** Draft  
**Author:** Charlie (AI assistant)  
**Repo:** https://github.com/crshdn/mission-control (v1.5.3)

---

## Reference Implementation

This feature is inspired by concepts from **Gas Town** — a multi-agent orchestration system for Claude Code by Steve Yegge:

- **Repo:** https://github.com/steveyegge/gastown
- **Key concepts borrowed:** Convoys (parallel work bundles), Hooks (persistent work state), stuck agent detection (GUPP violations), inter-agent mailboxes
- **What we're NOT borrowing:** The Mayor (MC has planning mode which is better), Beads/Dolt (MC uses SQLite), the Go toolchain, TUI-only interface, git worktree storage (we use DB + file system)

Gas Town coordinates 20-30 Claude Code agents working in parallel with git-backed persistence. We're adapting their best ideas into Mission Control's existing Next.js + SQLite architecture.

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Solution Overview](#2-solution-overview)
3. [Architecture](#3-architecture)
4. [Database Schema Changes](#4-database-schema-changes)
5. [API Endpoints](#5-api-endpoints)
6. [Convoy Lifecycle](#6-convoy-lifecycle)
7. [Task Decomposition](#7-task-decomposition)
8. [Agent Health Monitoring](#8-agent-health-monitoring)
9. [Work State Persistence (Checkpoints)](#9-work-state-persistence-checkpoints)
10. [Inter-Agent Mailboxes](#10-inter-agent-mailboxes)
11. [UI Changes](#11-ui-changes)
12. [Integration with Existing Systems](#12-integration-with-existing-systems)
13. [Migration Strategy](#13-migration-strategy)
14. [Testing Plan](#14-testing-plan)

---

## 1. Problem Statement

Mission Control currently processes tasks **sequentially with a single agent per task**:

```
Task → 1 Agent → Testing → Review → Done
```

This creates three problems:

1. **No parallelism.** A complex task like "Build a customer portal with login, dashboard, and contact form" is handled by one agent doing everything sequentially. Three agents working in parallel would finish 3x faster.

2. **No crash recovery.** If an agent dies mid-task, all in-progress work is lost. The task goes back to ASSIGNED and starts from scratch. Gas Town solves this with git worktree "hooks" that persist work state — we need an equivalent.

3. **Weak stuck detection.** MC's only stuck-detection mechanism is a 2-minute stale dispatch timeout in the planning poll. Gas Town has real health states (GUPP violations, stalled, zombie) with configurable thresholds. We need something comparable.

---

## 2. Solution Overview

Add a **Convoy Mode** to Mission Control that enables:

- **Task decomposition:** A parent task can be broken into sub-tasks that execute in parallel
- **Parallel agent dispatch:** Multiple agents work simultaneously on different sub-tasks within the same convoy
- **Checkpoint persistence:** Agents periodically save work state to the database so crash recovery doesn't start from zero
- **Agent health monitoring:** Real-time health tracking with automatic escalation for stuck/stalled/dead agents
- **Inter-agent mailboxes:** Agents within a convoy can communicate directly without routing through the pipeline

The existing single-task pipeline remains unchanged. Convoy mode is opt-in — a task only becomes a convoy when decomposition is triggered (either during planning or manually by the user).

---

## 3. Architecture

### Current Architecture (Single-Task)

```
User creates task
       ↓
   PLANNING (spec generation)
       ↓
     INBOX
       ↓
   ASSIGNED → Agent dispatched
       ↓
  IN_PROGRESS (single agent works)
       ↓
    TESTING (automated checks)
       ↓
    REVIEW (human approval)
       ↓
     DONE
```

### New Architecture (Convoy Mode)

```
User creates task
       ↓
   PLANNING (spec generation)
       ↓
   DECOMPOSITION ← NEW: AI or human breaks task into sub-tasks
       ↓
  CONVOY CREATED (parent task becomes convoy)
       ↓
  ┌──────────────────────────────────────┐
  │  Sub-task A → Agent 1 → Testing → ✓ │
  │  Sub-task B → Agent 2 → Testing → ✓ │  ← Parallel execution
  │  Sub-task C → Agent 3 → Testing → ✓ │
  └──────────────────────────────────────┘
       ↓
  CONVOY COMPLETE (all sub-tasks done)
       ↓
  INTEGRATION (optional: merge/verify combined output)
       ↓
    REVIEW (human reviews full convoy output)
       ↓
     DONE
```

### Key Design Decisions

1. **Convoy is a property of a task, not a separate entity.** A task with `convoy_id IS NOT NULL` is a sub-task belonging to a convoy. The parent task IS the convoy.
2. **Sub-tasks follow the same lifecycle** as regular tasks (`in_progress` → `testing` → `review` → `done`) but their completion rolls up to the parent.
3. **The parent task status reflects convoy progress:** it stays in a new `convoy_active` status while sub-tasks are running, then moves to `review` when all sub-tasks complete.
4. **Backward compatible.** Tasks without sub-tasks work exactly as they do today. Zero changes to existing behavior.

---

## 4. Database Schema Changes

### New Tables

```sql
-- Convoys: metadata for parallel task groups
CREATE TABLE IF NOT EXISTS convoys (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completing', 'done', 'failed')),
  decomposition_strategy TEXT DEFAULT 'manual' CHECK (decomposition_strategy IN ('manual', 'ai', 'planning')),
  decomposition_spec TEXT,          -- JSON: the AI's reasoning for how it split the task
  total_subtasks INTEGER DEFAULT 0,
  completed_subtasks INTEGER DEFAULT 0,
  failed_subtasks INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Sub-tasks: individual work items within a convoy
-- These are ALSO entries in the tasks table (sub-tasks ARE tasks).
-- This table tracks the convoy relationship and ordering.
CREATE TABLE IF NOT EXISTS convoy_subtasks (
  id TEXT PRIMARY KEY,
  convoy_id TEXT NOT NULL REFERENCES convoys(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  sort_order INTEGER DEFAULT 0,
  depends_on TEXT,                  -- JSON array of subtask IDs this depends on (for sequential deps)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent health snapshots: periodic health state for stuck detection
CREATE TABLE IF NOT EXISTS agent_health (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id),
  health_state TEXT DEFAULT 'idle' CHECK (health_state IN ('idle', 'working', 'stalled', 'stuck', 'zombie', 'offline')),
  last_activity_at TEXT,            -- Timestamp of last meaningful activity
  last_checkpoint_at TEXT,          -- Timestamp of last checkpoint save
  progress_score REAL DEFAULT 0,    -- 0.0-1.0, derived from activity frequency
  consecutive_stall_checks INTEGER DEFAULT 0,
  metadata TEXT,                    -- JSON: additional health context
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Work checkpoints: periodic snapshots of agent work state
CREATE TABLE IF NOT EXISTS work_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  checkpoint_type TEXT DEFAULT 'auto' CHECK (checkpoint_type IN ('auto', 'manual', 'crash_recovery')),
  state_summary TEXT NOT NULL,      -- Human-readable summary of work done so far
  files_snapshot TEXT,              -- JSON array of {path, hash, size} for files created/modified
  context_data TEXT,                -- JSON: any structured data the agent wants to persist
  created_at TEXT DEFAULT (datetime('now'))
);

-- Agent mailboxes: direct inter-agent communication within a convoy
CREATE TABLE IF NOT EXISTS agent_mailbox (
  id TEXT PRIMARY KEY,
  convoy_id TEXT NOT NULL REFERENCES convoys(id) ON DELETE CASCADE,
  from_agent_id TEXT NOT NULL REFERENCES agents(id),
  to_agent_id TEXT NOT NULL REFERENCES agents(id),
  subject TEXT,
  body TEXT NOT NULL,
  read_at TEXT,                     -- NULL = unread
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_convoys_parent ON convoys(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_convoys_status ON convoys(status);
CREATE INDEX IF NOT EXISTS idx_convoy_subtasks_convoy ON convoy_subtasks(convoy_id);
CREATE INDEX IF NOT EXISTS idx_convoy_subtasks_task ON convoy_subtasks(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_health_agent ON agent_health(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_health_state ON agent_health(health_state);
CREATE INDEX IF NOT EXISTS idx_work_checkpoints_task ON work_checkpoints(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_to ON agent_mailbox(to_agent_id, read_at);
CREATE INDEX IF NOT EXISTS idx_agent_mailbox_convoy ON agent_mailbox(convoy_id);
```

### Changes to Existing Tables

```sql
-- Add to tasks table:
ALTER TABLE tasks ADD COLUMN convoy_id TEXT REFERENCES convoys(id);
ALTER TABLE tasks ADD COLUMN is_subtask INTEGER DEFAULT 0;

-- Add new valid status:
-- Update the CHECK constraint on tasks.status to include 'convoy_active':
-- ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 
--  'convoy_active', 'testing', 'review', 'verification', 'done')
```

### Update to `src/lib/types.ts`

```typescript
// Add to TaskStatus union:
export type TaskStatus = 
  | 'pending_dispatch' | 'planning' | 'inbox' | 'assigned' | 'in_progress' 
  | 'convoy_active'  // NEW: parent task while sub-tasks are running
  | 'testing' | 'review' | 'verification' | 'done';

// New types:
export type ConvoyStatus = 'active' | 'paused' | 'completing' | 'done' | 'failed';
export type DecompositionStrategy = 'manual' | 'ai' | 'planning';
export type AgentHealthState = 'idle' | 'working' | 'stalled' | 'stuck' | 'zombie' | 'offline';
export type CheckpointType = 'auto' | 'manual' | 'crash_recovery';

export interface Convoy {
  id: string;
  parent_task_id: string;
  name: string;
  status: ConvoyStatus;
  decomposition_strategy: DecompositionStrategy;
  decomposition_spec?: string;
  total_subtasks: number;
  completed_subtasks: number;
  failed_subtasks: number;
  created_at: string;
  updated_at: string;
  // Joined
  parent_task?: Task;
  subtasks?: ConvoySubtask[];
}

export interface ConvoySubtask {
  id: string;
  convoy_id: string;
  task_id: string;
  sort_order: number;
  depends_on?: string[];
  created_at: string;
  // Joined
  task?: Task;
}

export interface AgentHealth {
  id: string;
  agent_id: string;
  task_id?: string;
  health_state: AgentHealthState;
  last_activity_at?: string;
  last_checkpoint_at?: string;
  progress_score: number;
  consecutive_stall_checks: number;
  metadata?: Record<string, unknown>;
  updated_at: string;
  // Joined
  agent?: Agent;
}

export interface WorkCheckpoint {
  id: string;
  task_id: string;
  agent_id: string;
  checkpoint_type: CheckpointType;
  state_summary: string;
  files_snapshot?: Array<{ path: string; hash: string; size: number }>;
  context_data?: Record<string, unknown>;
  created_at: string;
}

export interface AgentMailMessage {
  id: string;
  convoy_id: string;
  from_agent_id: string;
  to_agent_id: string;
  subject?: string;
  body: string;
  read_at?: string;
  created_at: string;
  // Joined
  from_agent?: Agent;
  to_agent?: Agent;
}
```

---

## 5. API Endpoints

### Convoy Management

```
POST   /api/tasks/{id}/convoy              Create a convoy from a task (decompose)
GET    /api/tasks/{id}/convoy              Get convoy details + subtasks
PATCH  /api/tasks/{id}/convoy              Update convoy (pause, resume, cancel)
DELETE /api/tasks/{id}/convoy              Cancel convoy and all sub-tasks

POST   /api/tasks/{id}/convoy/subtasks     Add subtask(s) to a convoy
DELETE /api/tasks/{id}/convoy/subtasks/{subtaskId}  Remove a subtask
PATCH  /api/tasks/{id}/convoy/subtasks/{subtaskId}  Update subtask (reorder, change deps)

POST   /api/tasks/{id}/convoy/dispatch     Dispatch all ready sub-tasks to agents
GET    /api/tasks/{id}/convoy/progress     Get real-time progress summary
```

### Agent Health

```
GET    /api/agents/health                  Get health state of all agents
GET    /api/agents/{id}/health             Get health state of one agent
POST   /api/agents/{id}/health/nudge       Nudge a stuck agent (triggers context refresh)
POST   /api/agents/health/check            Trigger a health check cycle (called by cron/heartbeat)
```

### Work Checkpoints

```
POST   /api/tasks/{id}/checkpoint          Save a work checkpoint
GET    /api/tasks/{id}/checkpoints         List checkpoints for a task
GET    /api/tasks/{id}/checkpoints/latest  Get most recent checkpoint
POST   /api/tasks/{id}/checkpoint/restore  Restore from a checkpoint (re-dispatch with context)
```

### Agent Mailbox

```
POST   /api/convoy/{convoyId}/mail         Send a message to another agent in the convoy
GET    /api/agents/{id}/mail               Get unread mail for an agent
PATCH  /api/agents/{id}/mail/{messageId}   Mark message as read
GET    /api/convoy/{convoyId}/mail          Get all mail in a convoy (for visibility)
```

---

## 6. Convoy Lifecycle

### State Machine

```
                    ┌──────────┐
                    │  ACTIVE  │ ← Sub-tasks being dispatched and worked on
                    └────┬─────┘
                         │
              ┌──────────┼──────────┐
              ↓          ↓          ↓
          (all done)  (user pause) (failures > threshold)
              ↓          ↓          ↓
         COMPLETING   PAUSED     FAILED
              ↓          ↓
         (merge/verify) (user resume)
              ↓          ↓
            DONE      ACTIVE
```

### Lifecycle Steps

1. **Creation**: User or planning mode decides a task should be a convoy. `POST /api/tasks/{id}/convoy` is called with either manual sub-tasks or an AI decomposition request.

2. **Decomposition**: If `strategy = 'ai'`, the system calls the planning agent to decompose the parent task's spec into sub-tasks. Each sub-task gets its own title, description, and optionally assigned agent. Sub-tasks are created as real entries in the `tasks` table with `is_subtask = 1` and `convoy_id` set.

3. **Dispatch**: `POST /api/tasks/{id}/convoy/dispatch` iterates all sub-tasks in `inbox` status, checks dependency graph (`depends_on`), and dispatches all unblocked sub-tasks simultaneously using the existing dispatch mechanism.

4. **Execution**: Each sub-task follows the normal task lifecycle (`assigned` → `in_progress` → `testing` → `done`). The convoy's `completed_subtasks` counter increments as sub-tasks complete.

5. **Progress Tracking**: The parent task stays in `convoy_active` status. The UI shows a progress bar (completed/total). SSE events fire on each sub-task status change.

6. **Completion**: When `completed_subtasks == total_subtasks`, the convoy status moves to `completing`. If there's an integration step configured, it runs. Then the parent task moves to `review` for human approval.

7. **Failure Handling**: If a sub-task fails testing more than the configured retry limit (default: 3), the sub-task is marked failed. If `failed_subtasks` exceeds the convoy's failure threshold (default: total/2), the whole convoy moves to `failed`. Otherwise, remaining sub-tasks continue and the failed one can be manually retried.

---

## 7. Task Decomposition

### Three Modes

#### Manual Decomposition
User explicitly creates sub-tasks in the UI.

```typescript
// POST /api/tasks/{id}/convoy
{
  "strategy": "manual",
  "subtasks": [
    { "title": "Build login page", "description": "...", "agent_id": "agent-1" },
    { "title": "Build dashboard", "description": "...", "agent_id": "agent-2" },
    { "title": "Build contact form", "description": "...", "agent_id": "agent-3" }
  ]
}
```

#### AI Decomposition
System calls the planning agent to auto-decompose based on the task spec.

```typescript
// POST /api/tasks/{id}/convoy
{
  "strategy": "ai"
  // No subtasks needed — AI generates them from the planning spec
}
```

The AI decomposition prompt should:
- Read the parent task's planning spec
- Identify independent work streams
- Create sub-tasks that can run in parallel
- Identify dependencies between sub-tasks (if any)
- Suggest agent assignments based on role matching
- Store its reasoning in `decomposition_spec`

#### Planning-Integrated Decomposition
During the planning phase, the planning agent can identify that a task should be a convoy and pre-generate sub-tasks as part of the spec. When planning completes, the convoy is created automatically.

```typescript
// In the planning spec output, include:
{
  "convoy": true,
  "subtasks": [
    { "title": "...", "description": "...", "suggested_role": "developer" },
    { "title": "...", "description": "...", "suggested_role": "developer", "depends_on": ["subtask-0"] }
  ]
}
```

### Dependency Graph

Sub-tasks can declare dependencies on other sub-tasks:

```typescript
{
  "depends_on": ["subtask-id-1", "subtask-id-2"]
}
```

A sub-task with dependencies will NOT be dispatched until all dependencies are in `done` status. This allows mixed parallel/sequential workflows:

```
Sub-task A (no deps) ──→ runs immediately
Sub-task B (no deps) ──→ runs immediately (parallel with A)
Sub-task C (depends on A, B) ──→ waits for both, then runs
```

---

## 8. Agent Health Monitoring

### Health States

| State | Definition | Detection Method |
|-------|-----------|-----------------|
| **idle** | Agent has no active task | No task in `in_progress` |
| **working** | Agent is actively making progress | Activity logged within threshold |
| **stalled** | Agent has a task but progress has slowed | No activity for `STALL_THRESHOLD` (default: 5 min) |
| **stuck** | Agent has a task but no progress for extended period | No activity for `STUCK_THRESHOLD` (default: 15 min) |
| **zombie** | Agent session is dead but task still assigned | OpenClaw session check returns inactive/missing |
| **offline** | Agent is explicitly offline | Agent status is `offline` |

### Health Check Cycle

Called periodically (every 2 minutes via cron or heartbeat):

```typescript
// POST /api/agents/health/check
// For each agent with an active task:

async function checkAgentHealth(agentId: string): Promise<AgentHealthState> {
  const agent = getAgent(agentId);
  const activeTask = getActiveTaskForAgent(agentId);
  
  if (!activeTask) return 'idle';
  if (agent.status === 'offline') return 'offline';
  
  // Check if OpenClaw session is still alive
  const session = getOpenClawSession(agentId, activeTask.id);
  if (!session || session.status !== 'active') return 'zombie';
  
  // Check last activity timestamp
  const lastActivity = getLastActivityForTask(activeTask.id, agentId);
  const minutesSinceActivity = diffMinutes(now(), lastActivity?.created_at);
  
  if (minutesSinceActivity > STUCK_THRESHOLD) return 'stuck';
  if (minutesSinceActivity > STALL_THRESHOLD) return 'stalled';
  
  return 'working';
}
```

### Escalation Actions

| Health State | Auto-Action | Notification |
|-------------|------------|--------------|
| **stalled** | Log warning to task activity | None (may recover) |
| **stuck** | Increment `consecutive_stall_checks`. At 3: auto-nudge | Alert in activity log |
| **zombie** | Mark session dead. Re-dispatch task with latest checkpoint | Alert in activity log + SSE event |

### Nudge Mechanism

When an agent is nudged (`POST /api/agents/{id}/health/nudge`):

1. Retrieve the latest work checkpoint for the agent's active task
2. Kill the current OpenClaw session (if zombie)
3. Re-dispatch the task to the same agent with checkpoint context injected into the task description
4. Log the nudge as a task activity

This is analogous to Gas Town's `gt prime` (context recovery) and `gt nudge` commands.

---

## 9. Work State Persistence (Checkpoints)

### What Gas Town Does

Gas Town uses **git worktrees** as persistent storage. Each agent's work lives in a git branch. If the agent crashes, the worktree still has all the files.

### Our Approach: Database Checkpoints

Since MC uses SQLite + file uploads (not git worktrees), we persist work state as **checkpoints** in the database:

```typescript
// POST /api/tasks/{id}/checkpoint
{
  "state_summary": "Completed login form component and API route. Working on session management.",
  "files_snapshot": [
    { "path": "src/components/LoginForm.tsx", "hash": "abc123", "size": 2048 },
    { "path": "src/app/api/auth/route.ts", "hash": "def456", "size": 1024 }
  ],
  "context_data": {
    "current_step": "session_management",
    "completed_steps": ["login_form", "auth_api"],
    "remaining_steps": ["session_management", "protected_routes"],
    "notes": "Using next-auth for session management"
  }
}
```

### When Checkpoints Are Saved

1. **Auto (every N minutes):** The dispatching agent's instructions should include a directive to call the checkpoint API every 5 minutes of active work.
2. **On stage transition:** When a sub-task moves between statuses, a checkpoint is automatically created.
3. **On crash recovery:** When a zombie agent is detected and the task is re-dispatched, the latest checkpoint is loaded and injected.

### Crash Recovery Flow

```
Agent dies
    ↓
Health check detects zombie (session gone)
    ↓
Load latest checkpoint for that task
    ↓
Re-dispatch task to same or new agent with:
  - Original task description
  - Planning spec
  - Checkpoint summary ("Here's what was already done: ...")
  - Files snapshot ("These files were created: ...")
    ↓
Agent picks up where the previous agent left off
```

---

## 10. Inter-Agent Mailboxes

### Purpose

Agents working in a convoy may need to coordinate. Examples:
- Agent building the dashboard needs to know what auth token format the login agent chose
- Agent building the contact form needs to know what API route pattern the others are using

### Implementation

Simple message-passing within a convoy:

```typescript
// POST /api/convoy/{convoyId}/mail
{
  "from_agent_id": "agent-1",
  "to_agent_id": "agent-2",
  "subject": "Auth token format",
  "body": "Using JWT with {userId, email, role} payload. Token stored in httpOnly cookie named 'session'."
}
```

Agents check their mailbox at the start of each work session and periodically:

```typescript
// GET /api/agents/{id}/mail?unread=true
// Returns array of AgentMailMessage
```

### Injection Into Agent Context

When an agent is dispatched or nudged, unread mail is injected into the agent's task context:

```
📬 Messages from your convoy teammates:
- From LoginBuilder: "Auth token format: JWT with {userId, email, role} payload. Token stored in httpOnly cookie named 'session'."
```

This is analogous to Gas Town's `gt mail check --inject` which injects mailbox contents into the agent's startup context.

---

## 11. UI Changes

### Task Modal — Convoy Tab (New)

When a task is a convoy parent, add a **"Convoy"** tab to the TaskModal showing:

- **Progress bar:** X of Y sub-tasks complete
- **Sub-task list:** Each sub-task with its status, assigned agent, and health indicator
- **Dependency graph:** Visual DAG showing which sub-tasks depend on which
- **Actions:** 
  - "Add Sub-task" button
  - "Dispatch All" button
  - "Pause Convoy" / "Resume Convoy"
  - Per sub-task: "Re-dispatch", "Nudge Agent", "View Checkpoint"

### Mission Queue — Convoy Indicators

- Parent tasks in `convoy_active` status show a **convoy icon** (🚚) and progress badge (e.g., "3/5")
- Sub-tasks are **indented** under their parent in the queue, or hidden with an expand/collapse toggle
- Convoy parent rows show an aggregated health indicator (green if all working, yellow if any stalled, red if any stuck/zombie)

### Agent Sidebar — Health Indicators

Each agent card shows a health dot:
- 🟢 Working / Idle
- 🟡 Stalled  
- 🔴 Stuck / Zombie
- ⚫ Offline

### Activity Log — Convoy Events

New event types for the activity feed:
- `convoy_created` — "Convoy created with 3 sub-tasks"
- `convoy_subtask_completed` — "Sub-task 'Build login' completed (1/3)"
- `convoy_completed` — "All sub-tasks complete — ready for review"
- `agent_stalled` — "⚠️ Agent PageBuilder stalled on 'Build dashboard' (no activity for 5 min)"
- `agent_stuck` — "🔴 Agent PageBuilder stuck on 'Build dashboard' (no activity for 15 min)"
- `agent_nudged` — "Agent PageBuilder nudged — re-dispatching with checkpoint"
- `checkpoint_saved` — "Checkpoint saved: 'Completed login form, working on session management'"

### New SSE Event Types

```typescript
export type SSEEventType =
  | 'task_updated' | 'task_created' | 'task_deleted'
  | 'activity_logged' | 'deliverable_added'
  | 'agent_spawned' | 'agent_completed'
  // NEW:
  | 'convoy_created'
  | 'convoy_progress'       // fires on each sub-task completion
  | 'convoy_completed'
  | 'agent_health_changed'  // fires when health state transitions
  | 'checkpoint_saved'
  | 'mail_received';
```

---

## 12. Integration with Existing Systems

### OpenClaw Dispatch

The existing dispatch mechanism (`/api/tasks/{id}/dispatch`) works for sub-tasks unchanged. The convoy dispatch endpoint (`/api/tasks/{id}/convoy/dispatch`) is a batch wrapper that:

1. Finds all sub-tasks in `inbox` status
2. Checks dependency graph — only dispatches sub-tasks whose dependencies are all `done`
3. Calls the existing dispatch endpoint for each ready sub-task
4. Updates convoy progress counters

### Workflow Templates

Convoy mode works with existing workflow templates. Each sub-task inherits the parent task's workflow template. The template's stages apply to each sub-task independently.

### Task Governance

The existing `task-governance.ts` escalation logic applies to each sub-task independently. If a sub-task fails testing repeatedly, it escalates to the fixer agent as normal. The convoy tracks this via `failed_subtasks`.

### Planning Mode

Planning mode gains an optional output: convoy decomposition. When the planning agent finishes generating a spec, it can also output a convoy structure. The planning approval step then creates both the spec AND the convoy in one transaction.

### Learner

The learner is notified on convoy-level events (not just individual sub-task transitions). This allows it to learn patterns like "tasks of type X decompose better as 3 sub-tasks than 5."

---

## 13. Migration Strategy

### Phase 1: Schema + Core APIs (No UI)
1. Add new tables via migration in `src/lib/db/migrations.ts`
2. Add `convoy_id` and `is_subtask` columns to tasks table
3. Add `convoy_active` to task status CHECK constraint
4. Build convoy CRUD API endpoints
5. Build checkpoint API endpoints
6. Build health check API endpoint
7. Build mailbox API endpoints
8. Add new types to `src/lib/types.ts`

### Phase 2: Convoy Dispatch + Health Monitoring
1. Build convoy dispatch logic (batch dispatch with dependency graph)
2. Build health check cycle (callable from heartbeat/cron)
3. Build nudge mechanism (kill session + re-dispatch with checkpoint)
4. Build crash recovery flow (zombie detection + checkpoint restore)
5. Wire up SSE events for new event types

### Phase 3: UI
1. Add Convoy tab to TaskModal
2. Add convoy indicators to MissionQueue
3. Add health dots to AgentsSidebar
4. Add convoy events to ActivityLog / LiveFeed
5. Add convoy progress to WorkspaceDashboard

### Phase 4: AI Decomposition
1. Build AI decomposition prompt + integration with planning agent
2. Add planning-integrated decomposition (spec → convoy in one step)
3. Build dependency graph visualization in UI

---

## 14. Testing Plan

### Unit Tests

- Convoy CRUD operations
- Dependency graph resolution (topological sort)
- Health state transitions
- Checkpoint save/restore
- Sub-task completion → convoy progress updates
- Failure threshold logic

### Integration Tests

- Full convoy lifecycle: create → decompose → dispatch → complete → review
- Crash recovery: simulate agent death → zombie detection → checkpoint restore → re-dispatch
- Mixed dependencies: parallel sub-tasks with one sequential dependency
- Failure handling: sub-task fails → retry → escalate → convoy continues

### Manual Testing Scenarios

1. **Happy path:** Create task → convoy with 3 sub-tasks → all complete → review → done
2. **Agent crash:** Kill an agent mid-task → verify zombie detection → verify checkpoint restore
3. **Dependency chain:** Sub-task C depends on A and B → verify C only dispatches after both complete
4. **Partial failure:** 1 of 3 sub-tasks fails → verify other 2 continue → verify manual retry works
5. **Full failure:** More than half of sub-tasks fail → verify convoy moves to `failed`
6. **Mailbox:** Agent A sends mail to Agent B → verify B receives it on next dispatch

---

## File Inventory (Expected New/Modified Files)

### New Files
```
src/lib/convoy.ts                           — Convoy business logic
src/lib/agent-health.ts                     — Health check logic
src/lib/checkpoint.ts                       — Checkpoint save/restore logic
src/lib/mailbox.ts                          — Inter-agent mailbox logic
src/app/api/tasks/[id]/convoy/route.ts      — Convoy CRUD
src/app/api/tasks/[id]/convoy/subtasks/route.ts      — Sub-task management
src/app/api/tasks/[id]/convoy/dispatch/route.ts      — Batch dispatch
src/app/api/tasks/[id]/convoy/progress/route.ts      — Progress endpoint
src/app/api/tasks/[id]/checkpoint/route.ts           — Checkpoint CRUD
src/app/api/tasks/[id]/checkpoints/route.ts          — List checkpoints
src/app/api/agents/health/route.ts                   — Health overview
src/app/api/agents/[id]/health/route.ts              — Per-agent health
src/app/api/agents/[id]/health/nudge/route.ts        — Nudge endpoint
src/app/api/agents/[id]/mail/route.ts                — Agent mailbox
src/app/api/convoy/[convoyId]/mail/route.ts          — Convoy mail
src/components/ConvoyTab.tsx                          — Convoy tab in TaskModal
src/components/ConvoyProgress.tsx                     — Progress bar component
src/components/HealthIndicator.tsx                    — Health dot component
src/components/DependencyGraph.tsx                    — DAG visualization
```

### Modified Files
```
src/lib/db/schema.ts             — Add new tables
src/lib/db/migrations.ts         — Add migration for new tables + task columns
src/lib/types.ts                 — Add new types
src/lib/events.ts                — Add new SSE event types
src/lib/orchestration.ts         — Add convoy-aware orchestration helpers
src/lib/task-governance.ts       — Add convoy failure threshold logic
src/lib/auto-dispatch.ts         — Add convoy dispatch awareness
src/components/TaskModal.tsx      — Add Convoy tab
src/components/MissionQueue.tsx   — Add convoy indicators + sub-task grouping
src/components/AgentsSidebar.tsx  — Add health indicators
src/components/ActivityLog.tsx    — Add convoy event types
src/components/LiveFeed.tsx       — Add convoy events
src/components/WorkspaceDashboard.tsx — Add convoy stats
src/hooks/useSSE.ts              — Handle new SSE event types
```

---

## Open Questions

1. **Max parallel agents per convoy?** Should there be a configurable limit to prevent resource exhaustion? Suggested default: 5.
2. **Auto-decomposition trigger:** Should tasks above a certain complexity score automatically become convoys? Or always manual/explicit?
3. **Cross-convoy dependencies:** Can a sub-task in one convoy depend on a task in another? (Suggest: no, keep it simple for v1.)
4. **Checkpoint frequency:** Every 5 minutes? Configurable per workspace? Agent-driven vs. server-polled?
5. **Mailbox scope:** Should mailboxes work across convoys or only within a convoy? (Suggest: within convoy only for v1.)

---

## Summary

This spec adds four major capabilities to Mission Control:

1. **Convoy Mode** — Parallel sub-task execution with dependency management
2. **Agent Health Monitoring** — Real-time stuck/stalled/zombie detection with auto-recovery
3. **Work Checkpoints** — Crash-resilient work state that survives agent failures
4. **Inter-Agent Mailboxes** — Direct communication between agents in a convoy

These concepts are adapted from Gas Town's architecture but built natively for MC's Next.js + SQLite stack. The implementation is backward-compatible — existing single-task workflows are unchanged. Convoy mode is opt-in and additive.
