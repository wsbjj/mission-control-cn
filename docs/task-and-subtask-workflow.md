# 任务流转与子任务流转说明

本文描述 Mission Control 中**主任务（父任务）**与**子任务**的状态机、工作流引擎行为及相关 API。实现主要位于 `src/lib/workflow-engine.ts`、`src/app/api/tasks/[id]/route.ts`、`src/lib/task-governance.ts`、`src/app/api/tasks/[id]/dispatch/route.ts`。

---

## 1. 核心概念

### 1.1 工作流模板（Workflow Template）

- 每个任务可绑定 `workflow_template_id`；未绑定时按**工作区默认模板**、再按**全局默认模板**解析（`getTaskWorkflow`）。
- 模板包含有序 **`stages`**：每阶段有 `status`（与任务列/状态一致）、`label`（展示名）、`role`（负责角色，可为空）、等。
- **`fail_targets`**：从某状态失败回退时的目标状态（JSON 对象）。
- **多轮验证**：模板里多个「验证」类阶段在加载时会被规范化为 `verification`、`verification_v2`、`verification_v3`…（`parseTemplate`），避免重复 `status` 冲突。

### 1.2 角色与智能体

- **`task_roles`**：传统「每角色一个」主负责人（兼容路径）。
- **`task_role_agents`**：**同一 `role` 可绑定多个智能体**。当某阶段 `stage.role` 对应 **≥2 个** agent 时，进入该阶段会走**并行子任务**逻辑（见下文）。

### 1.3 父子关系

- 子任务在 `tasks.parent_task_id` 指向父任务。
- 并行子任务在 `description` 末尾附带 **`MC_SUBTASK_META= {...}`** JSON（只读元数据，创建后一般不修改）。

---

## 2. 主任务（父任务）流转

### 2.1 入口：`PATCH /api/tasks/[id]`

状态变更的主入口。流程要点（顺序有依赖）：

1. **校验**：Zod `UpdateTaskSchema`。
2. **特殊规则**：例如 `review → done` 且由非主智能体发起时可能拒绝（`updated_by_agent_id` + `is_master`）。
3. **就绪检查**：无负责人、规划未完成等会写入 `planning_dispatch_error` 等（见代码 `readinessIssues`）。
4. **状态变更子流程**（当 `nextStatus` 与当前不同）：
   - **工作流守卫**：若存在模板，则 `nextStatus` 必须在模板 `stages[].status` 允许集合内（否则 `STATUS_NOT_ALLOWED`）。
   - **证据门（Evidence Gate）**：进入 `testing`、`review`、`verification`、`verification_vN`、`done` 等「质量相关」目标状态时（除非 **Board Override**），要求：
     - `task_deliverables` 至少 1 条；
     - `task_activities` 中至少 1 条且 `activity_type ∈ ('completed','file_created','updated')`。
     - 实现：`hasStageEvidence(taskId)`。
   - **失败回退**：从 `testing` / `review` / `verification` / `verification_vN` 退到 `in_progress` 或 `assigned` 时，**必须**带 `status_reason`（`STATUS_REASON_REQUIRED`）。
   - **完成（done）**：除证据门外，`taskCanBeDone` 要求：
     - `status_reason` **不以** `Failed:` 开头（工作流 `POST /fail` 写入的格式）；普通智能体写的 “Verification failed: …” 不永久阻塞。
     - 且仍满足 `hasStageEvidence`。
   - **向前流转且未显式传 `status_reason`**：自动 `status_reason = NULL`，避免陈旧说明干扰。
5. **`UPDATE tasks`** 落库后广播 SSE。

### 2.2 工作流派发：`handleStageTransition`

在 `PATCH` 之后根据条件调用（`assigned` 自动派发、工作流阶段前进、分配负责人等场景）。

**逻辑摘要**（`workflow-engine.ts`）：

| 条件 | 行为 |
|------|------|
| 无模板 | `handedOff: false`，由上层决定是否 legacy dispatch |
| `newStatus` 不在模板 stages | 视为非工作流控制，成功但不交接 |
| 目标阶段 `role === null` 且非 `done` | **队列阶段**：尝试 `drainQueue`（见下） |
| 目标阶段 `role` 在 `task_role_agents` 中有 **≥2** 人 | **并行子任务**：`spawnParallelSubtasks`，**不**对父任务做单智能体 handoff |
| 否则 | 解析该 role 的负责人（`task_role_agents` 首人 → `task_roles` → `assigned_agent_id` → `pickDynamicAgent`），更新 `assigned_agent_id`，写活动「阶段交接: …」，**POST 内部** `/api/tasks/{id}/dispatch` |

失败时可能写入 `planning_dispatch_error`。

### 2.3 队列与 `drainQueue`

- 阶段 **`role === null`** 且非 `done` 时作为**排队列**。
- `drainQueue`：在同一 `workspace_id` 内，若**下一阶段**当前**没有**其他任务占用，则把队列里**最旧**的任务推进到下一阶段并调用 `handleStageTransition`。
- 触发时机包括：任务进入队列阶段、任务 **`done`**（腾出验证位）、从验证/测试 **失败回退** 等（见 `route.ts` 与 `handleStageFailure` 注释）。

### 2.4 阶段失败：`POST /api/tasks/[id]/fail`

- 仅允许从 `testing`、`review`、`verification`、`verification_vN` 发起。
- `handleStageFailure`：根据模板 `fail_targets` 解析回退状态；验证类可无配置时默认回 `in_progress`；写入 `status_reason = Failed: {reason}`，记录活动，必要时升级 Fixer，再 `handleStageTransition` 回退阶段。

### 2.5 规划完成后的派发与重试

- 规划轮询（`planning/poll`）可在「已 in_progress 但近期无活动」时把任务打回 `assigned` 并**再派发**（防丢消息）。
- UI / API：`POST /api/tasks/[id]/planning/retry-dispatch` 在**规划已完成**前提下重试派发。

---

## 3. 子任务流转

### 3.1 创建时机（并行阶段）

当父任务通过 `handleStageTransition` 进入某阶段，且该阶段在模板中有 `role`，并且 **`getAgentsForRole` 返回 ≥2**：

1. **`hasSpawnedSubtasksForStage`**：若该 `(parent, stage_status)` 已生成过子任务（`description` 含对应 `MC_SUBTASK_META` 的 `stage_status`），则**不再生成**（幂等）。
2. 否则为每个 agent 插入一条子任务：
   - `title`: `[子任务] {父标题} — {stage.label} — {agent.name}`
   - `status` = 该阶段 `stage.status`（如 `testing`、`verification`）
   - `assigned_agent_id` = 对应 agent
   - `parent_task_id` = 父任务 id
   - `description` 含 **`MC_SUBTASK_META`**：`parent_task_id`、`stage_status`、`stage_role`、`stage_label`、`agent_id`、`agent_name`
3. 父任务**停留在当前阶段状态**（不改为 review 等待列；与早期设计文档可能不同，以代码为准）。
4. 对每个子任务 **`dispatchTaskBestEffort`** → `POST /api/tasks/{subtaskId}/dispatch`。

### 3.2 子任务状态推进

- 子任务与普通任务一样通过 **`PATCH /api/tasks/{id}`** 改 `status`，受同一套**工作流守卫**、**证据门**、`taskCanBeDone`（当目标为 `done`）约束。
- **`PATCH` 后**若进入 `testing` / `review` / `verification` / `verification_vN` 且非 `shouldDispatch` 已处理路径，会再调 **`handleStageTransition(subtaskId, nextStatus)`**，从而可能再次 **dispatch 子任务**（阶段交接活动记在**子任务**上）。

### 3.3 派发提示词与子任务（重要）

`dispatch/route.ts` 生成 OpenClaw 提示时：

- 从 **`MC_SUBTASK_META`** 读取 `stage_role` 等，用于区分 Builder / Tester / Verifier **文案模板**。
- **工作流「当前阶段 → 下一阶段」**的锚点：优先使用 **`tasks.status` 且该值在模板 stages 中存在**；仅当行状态对不上模板时，才回退用 meta 里的 `stage_status`。  
  **原因**：meta 里的 `stage_status` 在创建时固定（如永远是 `verification`），若用它算「下一状态」，会在已到 `verification_v2` 时仍提示 PATCH 到 `verification_v2`，造成重复验证/重复派发。

### 3.4 子任务全部完成后父任务推进：`maybeAdvanceParentFromSubtasks`

当某任务 **`PATCH` 为 `done`** 时，若 `parent_task_id` 非空，异步调用 `maybeAdvanceParentFromSubtasks(subtaskId)`：

1. 子任务必须已是 **`done`**。
2. 解析子任务 `MC_SUBTASK_META` 得到 **`stage_status`**（父任务当时并行等待的列）。
3. 父任务当前 **`status` 必须仍等于该 `stage_status`**（避免与人工拖列竞态）。
4. 统计同父、且 `description` 含相同 `stage_status` 的 meta、且 **`status != 'done'`** 的子任务数量；**>0 则不打断**。
5. 若已全部 `done`：在父工作流中找到 `stage_status` 对应阶段的**下一阶段**，更新父任务 `status`，广播，再 **`handleStageTransition(parent.id, nextStage.status)`**（下一阶段可能是单智能体或再次并行）。

**注意**：父任务推进依赖子任务 **`done`**，仅停在 `verification_v2` 等中间态不会触发父任务前进。

---

## 4. 相关 API 索引

| API | 用途 |
|-----|------|
| `PATCH /api/tasks/[id]` | 更新任务含状态；证据门、完成校验、工作流 handoff、子任务完成后触发父任务检查 |
| `POST /api/tasks/[id]/dispatch` | 向 OpenClaw 发送任务说明（含 builder/tester/verifier 指令） |
| `POST /api/tasks/[id]/dispatch/retry` | 清除 `planning_dispatch_error` 后再次 dispatch |
| `POST /api/tasks/[id]/fail` | 阶段失败回退 |
| `POST /api/tasks/[id]/activities` | 活动记录（证据门计数用） |
| `POST /api/tasks/[id]/deliverables` | 交付物（证据门计数用） |
| `GET/PUT /api/tasks/[id]/roles` | 角色与多智能体绑定（`task_role_agents`） |
| `POST /api/tasks/[id]/planning/retry-dispatch` | 规划完成后的派发重试 |

---

## 5. 派发层重试（与状态机无关）

OpenClaw `chat.send` 在单次 `POST .../dispatch` 内可按环境变量**自动重试**（超时/网络类错误）；详见 `src/lib/openclaw-dispatch-send.ts` 与 `.env.example` 中 `OPENCLAW_DISPATCH_*`、`OPENCLAW_RPC_TIMEOUT_MS` 等。

---

## 6. 延伸阅读

- 并行子任务原始实现计划：`docs/plans/2026-03-18-parallel-stage-subtasks.md`（部分行为已以当前代码为准，例如父任务停留阶段而非固定移到 `review`）。

---

*文档随代码演进，如有不一致以 `src/lib/workflow-engine.ts` 与 `src/app/api/tasks/[id]/route.ts` 为准。*
