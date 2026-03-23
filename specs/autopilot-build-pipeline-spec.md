# Autopilot Build Pipeline Spec

## Overview

Close the gap between "Yes on an idea" and "PR ready to merge." When a user swipes Yes/Now on an idea, the task flows through MC's existing build → test → review pipeline, and the agent creates a PR against the product's repo.

**What already exists:**
- `createTaskFromIdea()` creates MC tasks from approved ideas
- `/api/tasks/[id]/dispatch` sends tasks to agents with rich context (planning specs, knowledge, workflow stages, images, checkpoint recovery)
- Builder → Tester → Reviewer workflow with role-based dispatch
- Agent session management via OpenClaw Gateway

**What's missing:**
- Repo context doesn't flow from product → task → dispatch
- No PR creation instructions in the dispatch message
- No repo-missing warning in the UI
- No build automation settings (safety tier, cost caps)
- Tasks from Autopilot land in `planning` status and wait — no auto-dispatch option

---

## 1. Schema Changes (Migration 019)

### Products table — new columns

```sql
ALTER TABLE products ADD COLUMN build_automation TEXT DEFAULT 'supervised'
  CHECK (build_automation IN ('supervised', 'semi_auto', 'full_auto'));
ALTER TABLE products ADD COLUMN default_branch TEXT DEFAULT 'main';
ALTER TABLE products ADD COLUMN build_agent TEXT;  -- preferred agent model/id
ALTER TABLE products ADD COLUMN cost_cap_per_task REAL;  -- null = no cap
ALTER TABLE products ADD COLUMN cost_cap_monthly REAL;   -- null = no cap
```

### Tasks table — new columns

```sql
ALTER TABLE tasks ADD COLUMN repo_url TEXT;
ALTER TABLE tasks ADD COLUMN repo_branch TEXT;         -- target branch for PR
ALTER TABLE tasks ADD COLUMN pr_url TEXT;              -- filled after PR created
ALTER TABLE tasks ADD COLUMN pr_status TEXT CHECK (pr_status IN ('pending', 'open', 'merged', 'closed'));
```

---

## 2. Task Creation (`createTaskFromIdea`)

Current: creates task with title, description, priority, complexity-based cost estimate.

**Add:**

```typescript
// In createTaskFromIdea(), after getting product:
const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [idea.product_id]);

// Include repo context in task
run(
  `INSERT INTO tasks (id, title, description, status, priority, workspace_id,
    workflow_template_id, product_id, idea_id, estimated_cost_usd,
    repo_url, repo_branch, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [taskId, idea.title, description, status, priority, workspaceId,
   template?.id || null, idea.product_id, idea.id, estimatedCost,
   product?.repo_url || null, product?.default_branch || 'main',
   now, now]
);
```

**Auto-dispatch for "Now!" swipes (when repo is connected):**

```typescript
case 'fire': {
  // ... existing code ...
  task = createTaskFromIdea(idea, { urgent: true, notes: input.notes });

  // If product has repo + build automation != supervised, auto-dispatch
  if (product?.repo_url && product?.build_automation !== 'supervised') {
    // Move task directly to assigned → triggers dispatch
    run('UPDATE tasks SET status = ? WHERE id = ?', ['assigned', task.id]);
    // Fire dispatch async (don't block swipe response)
    queueDispatch(task.id);
  }
  break;
}
```

---

## 3. Dispatch Enhancement

In `/api/tasks/[id]/dispatch`, add repo context to the task message sent to agents.

**After the existing message sections, add:**

```typescript
let repoSection = '';
if (task.repo_url) {
  const branchName = `autopilot/${task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}`;
  
  repoSection = `
---
**🔗 REPOSITORY:**
- **Repo:** ${task.repo_url}
- **Base branch:** ${task.repo_branch || 'main'}
- **Feature branch:** ${branchName}

**GIT WORKFLOW:**
1. Clone the repo (or use existing local copy)
2. Create branch \`${branchName}\` from \`${task.repo_branch || 'main'}\`
3. Implement the feature
4. Commit with clear messages (reference task ID: ${task.id})
5. Push branch and create a Pull Request

**PR REQUIREMENTS:**
- Title: "🤖 Autopilot: ${task.title}"
- Body must include:
  - What was built and why
  - Research backing (from the idea)
  - Technical approach taken
  - Any risks or trade-offs
  - Task ID: ${task.id}
- Target branch: ${task.repo_branch || 'main'}
- After creating PR, report the PR URL back:
  PATCH ${missionControlUrl}/api/tasks/${task.id}
  Body: {"pr_url": "<github PR url>", "pr_status": "open"}
`;
}
```

Insert `${repoSection}` into the `taskMessage` template string.

---

## 4. PR Status Tracking

### New API endpoint: `PATCH /api/tasks/[id]`

Already exists. Just needs to accept `pr_url` and `pr_status` fields (add to validation schema).

### Webhook for PR merge (future)

GitHub webhook → `/api/webhooks/github` → updates `pr_status` to `merged`, marks task `done`. Not in this phase — users can manually merge or we add it later.

---

## 5. UI Changes

### 5a. Product Creation (`/autopilot/new`)

**Repo warning** — when `repo_url` is empty, show below the field:

```tsx
{!form.repo_url && (
  <div className="flex items-start gap-2 mt-2 px-3 py-2 bg-amber-500/10 border border-amber-500/20 rounded-lg">
    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
    <p className="text-xs text-amber-300">
      Without a repository, Autopilot can research and generate ideas but agents
      won't be able to build features or create pull requests.
    </p>
  </div>
)}
```

**Build automation setting** — add to product form or settings page:

```tsx
<div>
  <label className="block text-sm font-medium text-mc-text mb-2">Build Automation</label>
  <select value={form.build_automation} onChange={...}>
    <option value="supervised">Supervised — PRs created, you review & merge</option>
    <option value="semi_auto">Semi-auto — PRs auto-merge if CI passes</option>
    <option value="full_auto">Full auto — PRs auto-merge after agent review</option>
  </select>
</div>
```

### 5b. Swipe Deck — "Yes" button context

When no repo is connected, show a tooltip/subtitle on Yes and Now! buttons:

```tsx
{!product.repo_url && (
  <span className="text-[10px] text-mc-text-secondary block">task only — no repo</span>
)}
```

### 5c. Task Card — PR badge

In the task list/card UI, show PR status when present:

```tsx
{task.pr_url && (
  <a href={task.pr_url} target="_blank" className="text-xs px-2 py-0.5 rounded bg-purple-500/20 text-purple-400">
    {task.pr_status === 'merged' ? '✅ Merged' : task.pr_status === 'open' ? '🔄 PR Open' : 'PR'}
  </a>
)}
```

### 5d. Product Dashboard — Build Queue tab

Already exists (`BuildQueue` component). Enhance to show:
- PR status column
- Link to GitHub PR
- "Re-dispatch" button for failed builds

---

## 6. Build Automation Tiers

| Tier | Swipe action | Task status flow | PR behavior |
|------|-------------|-----------------|-------------|
| **Supervised** | Yes → `planning`, Now → `inbox` | Normal MC flow (manual assign/dispatch) | PR created, human merges |
| **Semi-auto** | Yes → `planning`, Now → `assigned` (auto-dispatch) | Auto-dispatches "Now!" tasks | PR auto-merges if CI passes |
| **Full auto** | Yes → `assigned`, Now → `assigned` | Auto-dispatches all approved tasks | PR auto-merges after agent review |

Default: **Supervised** (no surprises for new users).

---

## 7. Cost Guardrails

Optional, set per-product in settings.

- **Per-task cap** (`cost_cap_per_task`): Dispatch includes cap in agent message. Agent should self-limit. MC tracks `actual_cost_usd` on task. If exceeded, alert user (don't kill mid-build).
- **Monthly cap** (`cost_cap_monthly`): Checked before dispatch. If monthly spend for product exceeds cap, task goes to `inbox` instead of auto-dispatching. User sees warning: "Monthly budget reached — dispatch manually to override."

Cost tracking already exists via `cost_events` table. Just need to sum before dispatch.

---

## 8. Implementation Order

1. **Migration 019** — add columns to products + tasks (30 min)
2. **`createTaskFromIdea` update** — pass repo_url, repo_branch, wire auto-dispatch for fire (30 min)
3. **Dispatch message enhancement** — add repo/PR section to agent message (30 min)
4. **UI: repo warning** — on product creation page (15 min)
5. **UI: PR badge** — on task cards (15 min)
6. **UI: build automation setting** — product settings (30 min)
7. **Validation** — accept pr_url/pr_status in task PATCH (15 min)
8. **Cost cap check** — pre-dispatch budget check (30 min)

Total: ~3.5 hours. No new tables. No new agents. No new API routes (just field additions to existing ones).

---

## 9. What This Does NOT Include (Future)

- GitHub webhook for auto-merge on CI pass (Phase 2)
- Automatic CI status polling (Phase 2)
- Multi-repo support per product (Phase 2)
- Custom PR templates (Phase 2)
- Branch protection rule awareness (Phase 2)
- Deploy-on-merge pipeline (Phase 3)
