# 并行阶段（多智能体）子任务化 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让同一个工作流阶段（stage/role）可以选择多个智能体，并通过“自动生成子任务并行执行”的方式实现并行；父任务等待所有子任务完成后自动推进到下一阶段。

**Architecture:** 以父任务为“编排与汇总实体”，进入并行阶段时按该阶段绑定的多个智能体生成子任务并派发；子任务完成（done）后触发对父任务的聚合检查，全部完成才推进父任务到下一阶段并触发下一阶段的正常工作流派发。

**Tech Stack:** Next.js Route Handlers、SQLite（better-sqlite3 migrations）、Zod 校验、现有 `workflow-engine` / `dispatch` 流程。

---

### Task 1: 数据库最小迁移（父子任务关联 + 多选角色存储）

**Files:**
- Modify: `src/lib/db/schema.ts`
- Modify: `src/lib/db/migrations.ts`

**Step 1: 写迁移（migration 015）**
- 在 `tasks` 表新增可空列：`parent_task_id TEXT REFERENCES tasks(id)`
- 创建索引：`idx_tasks_parent_task_id`
- 新增表：`task_role_agents` 用于一个 role 绑定多个 agent
  - 字段：`id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, role TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id), created_at TEXT DEFAULT (datetime('now'))`
  - 唯一约束：`UNIQUE(task_id, role, agent_id)`
  - 索引：`idx_task_role_agents_task_role (task_id, role)`

**Step 2: 更新新库 schema**
- 在 `schema.ts` 里同步新增列与新表（用于 fresh DB）

**Step 3: 验证**
- Run: `npm test`
- Expected: 迁移可运行、测试全部通过

---

### Task 2: 角色分配 API 支持多选（role -> agent_ids）

**Files:**
- Modify: `src/app/api/tasks/[id]/roles/route.ts`
- (Optional) Modify: `src/lib/types.ts`（如要新增 API 返回类型）

**Step 1: 调整 PUT 入参**
- 支持两种入参（兼容旧客户端）：
  - 旧：`{ roles: [{ role, agent_id }] }`
  - 新：`{ roles: [{ role, agent_ids: string[] }] }`
- 存储到 `task_role_agents`（多条）
- 兼容旧逻辑：如果只给了 `agent_id`，当作 `agent_ids=[agent_id]`

**Step 2: 调整 GET 返回**
- 返回聚合结构：`[{ role, agent_ids, agents: [{id,name,avatar_emoji}] }]`
- 仍然允许前端按 `role` 渲染

**Step 3: 验证**
- Run: `npm test`
- Expected: roles API 的单选与多选两种 payload 都可写入与读出

---

### Task 3: TeamTab UI 把“单选智能体”改为“多选智能体”

**Files:**
- Modify: `src/components/TeamTab.tsx`

**Step 1: 多选控件**
- 每个 role 的 agent 选择从 `<select>` 单选改为多选（可先用原生 `multiple`，后续再增强搜索）
- UI 行为：
  - 允许同一 role 选 N 个 agent
  - 选中项以 tag/列表方式展示（或原生多选）

**Step 2: 适配 roles API**
- 保存时用新 payload：`{ roles: [{ role, agent_ids: [...] }] }`
- 加载时读取聚合返回，回填多选状态

**Step 3: 验证**
- Run: `npm run lint`
- Expected: 无新增 lint；UI 可保存并回显多选

---

### Task 4: 父任务进入并行阶段时生成子任务并派发

**Files:**
- Modify: `src/lib/workflow-engine.ts`
- Modify: `src/app/api/tasks/[id]/route.ts`（只做父任务推进触发点）

**Step 1: 在 `handleStageTransition` 中识别并行**
- 当目标 stage.role 在 `task_role_agents` 中绑定了 **2+ agent**：
  - 生成子任务 N 个（每个 agent 一个）
  - 子任务字段：
    - `parent_task_id = 父任务.id`
    - `title`：`[子] <父标题> — <stage.label> — <agent.name>`
    - `description`：继承父描述，并附加只读提示（可选）
    - `workflow_template_id`：留空或继承（建议留空，子任务不再二次编排）
    - `assigned_agent_id = agent.id`
    - `status = assigned`（触发既有 dispatch 逻辑）
  - 父任务字段：
    - **假设**：父任务移到 `review` 作为“等待/队列列”（避免新增 status）
    - 记录一条 `task_activities`：`Spawned <N> subtasks for parallel stage <label>`
  - 为每个子任务调用既有派发：复用 `PATCH /api/tasks/[id]` 的 auto-dispatch 或直接调用 `dispatch` endpoint（择一）

**Step 2: 幂等与重复进入保护**
- 如果同一父任务在同一阶段已经有未完成子任务（`parent_task_id=...` 且状态非 done），不要重复生成。

**Step 3: 验证**
- Run: `npm test`
- Expected: 父任务进入并行阶段后自动出现 N 个子任务并进入执行列

---

### Task 5: 子任务全部 done 后自动推进父任务到下一阶段

**Files:**
- Modify: `src/app/api/tasks/[id]/route.ts`
- Modify: `src/lib/workflow-engine.ts`（新增一个聚合推进 helper）

**Step 1: 在任务状态变更到 done 时触发检查**
- 当 `PATCH /api/tasks/[id]` 把某任务推进到 `done`，且该任务 `parent_task_id` 非空：
  - 查询同父的子任务是否全部 `done`
  - 若全部 done：解析父任务 workflow，找到父任务当前等待阶段对应的“下一阶段”，并推进父任务 status
  - 推进父任务后调用 `handleStageTransition` 触发下一阶段的正常派发

**Step 2: 验证**
- Run: `npm test`
- Expected: 最后一个子任务 done 时，父任务自动推进并派发下一阶段

---

### Task 6: 端到端手动验证步骤

**Step 1: 启动**
- Run: `npm run dev`

**Step 2: 配置并行角色**
- 打开任意任务 → `Team` 标签
- 选一个 workflow template
- 对某个 role（如 builder）选择 2 个以上智能体并保存

**Step 3: 触发并行阶段**
- 把父任务拖到对应阶段（或通过 workflow 引擎推进）
- 观察：自动生成 N 个子任务；父任务移到 `review` 等待

**Step 4: 完成子任务**
- 分别把所有子任务拖到 `done`
- 观察：最后一个子任务 done 后，父任务自动推进到下一阶段并派发

