import test from 'node:test';
import assert from 'node:assert/strict';
import { run, queryOne } from './db';
import {
  hasStageEvidence,
  taskCanBeDone,
  ensureFixerExists,
  getFailureCountInStage,
  pickDynamicAgent,
} from './task-governance';

function seedTask(id: string, workspace = 'default') {
  run(
    `INSERT INTO tasks (id, title, status, priority, workspace_id, business_id, created_at, updated_at)
     VALUES (?, 'T', 'review', 'normal', ?, 'default', datetime('now'), datetime('now'))`,
    [id, workspace]
  );
}

function seedWorkspace(id: string, slug: string) {
  run(
    `INSERT OR IGNORE INTO workspaces (id, name, slug, icon, created_at, updated_at)
     VALUES (?, ?, ?, '📁', datetime('now'), datetime('now'))`,
    [id, `WS-${slug}`, slug]
  );
}

function seedAgent(params: {
  id: string;
  name: string;
  role: string;
  workspaceId: string;
  status?: 'standby' | 'working' | 'offline';
  isMaster?: 0 | 1;
}) {
  run(
    `INSERT INTO agents (id, name, role, status, is_master, workspace_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      params.id,
      params.name,
      params.role,
      params.status || 'standby',
      params.isMaster || 0,
      params.workspaceId,
    ]
  );
}

test('evidence gate requires deliverable + activity', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  assert.equal(hasStageEvidence(taskId), false);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(hasStageEvidence(taskId), true);
});

test('task cannot be done when status_reason indicates failure', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(`UPDATE tasks SET status_reason = 'Validation failed: CSS broken' WHERE id = ?`, [taskId]);
  run(
    `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'file', 'index.html', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'completed', 'did thing', datetime('now'))`,
    [taskId]
  );

  assert.equal(taskCanBeDone(taskId), false);
});

test('ensureFixerExists creates fixer when missing', () => {
  const fixer = ensureFixerExists('default');
  assert.equal(fixer.created, true);

  const stored = queryOne<{ id: string; role: string }>('SELECT id, role FROM agents WHERE id = ?', [fixer.id]);
  assert.ok(stored);
  assert.equal(stored?.role, 'fixer');
});

test('failure counter reads status_changed failure events', () => {
  const taskId = crypto.randomUUID();
  seedTask(taskId);

  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: x)', datetime('now'))`,
    [taskId]
  );
  run(
    `INSERT INTO task_activities (id, task_id, activity_type, message, created_at)
     VALUES (lower(hex(randomblob(16))), ?, 'status_changed', 'Stage failed: verification → in_progress (reason: y)', datetime('now'))`,
    [taskId]
  );

  assert.equal(getFailureCountInStage(taskId, 'verification'), 2);
});

test('pickDynamicAgent planner candidates never cross workspace', () => {
  const wsA = `ws-a-${crypto.randomUUID().slice(0, 8)}`;
  const wsB = `ws-b-${crypto.randomUUID().slice(0, 8)}`;
  seedWorkspace(wsA, wsA);
  seedWorkspace(wsB, wsB);

  const taskId = crypto.randomUUID();
  seedTask(taskId, wsA);

  const foreignCandidateId = crypto.randomUUID();
  const localCandidateId = crypto.randomUUID();
  seedAgent({ id: foreignCandidateId, name: 'Foreign Builder', role: 'builder', workspaceId: wsB });
  seedAgent({ id: localCandidateId, name: 'Local Builder', role: 'builder', workspaceId: wsA });

  run('UPDATE tasks SET planning_agents = ? WHERE id = ?', [
    JSON.stringify([
      { agent_id: foreignCandidateId, role: 'builder' },
      { agent_id: localCandidateId, role: 'builder' },
    ]),
    taskId,
  ]);

  const picked = pickDynamicAgent(taskId, 'builder');
  assert.ok(picked);
  assert.equal(picked?.id, localCandidateId);
});

test('pickDynamicAgent role query is scoped to task workspace', () => {
  const wsA = `ws-a-${crypto.randomUUID().slice(0, 8)}`;
  const wsB = `ws-b-${crypto.randomUUID().slice(0, 8)}`;
  seedWorkspace(wsA, wsA);
  seedWorkspace(wsB, wsB);

  const taskId = crypto.randomUUID();
  seedTask(taskId, wsA);

  const localTesterId = crypto.randomUUID();
  const foreignTesterId = crypto.randomUUID();
  seedAgent({ id: localTesterId, name: 'Local Tester', role: 'tester', workspaceId: wsA });
  seedAgent({ id: foreignTesterId, name: 'Foreign Tester', role: 'tester', workspaceId: wsB });

  const picked = pickDynamicAgent(taskId, 'tester');
  assert.ok(picked);
  assert.equal(picked?.id, localTesterId);
});

test('pickDynamicAgent fallback query is scoped to task workspace', () => {
  const wsA = `ws-a-${crypto.randomUUID().slice(0, 8)}`;
  const wsB = `ws-b-${crypto.randomUUID().slice(0, 8)}`;
  seedWorkspace(wsA, wsA);
  seedWorkspace(wsB, wsB);

  const taskId = crypto.randomUUID();
  seedTask(taskId, wsA);

  const localAgentId = crypto.randomUUID();
  const foreignAgentId = crypto.randomUUID();
  seedAgent({ id: localAgentId, name: 'Local Generic', role: 'custom-role', workspaceId: wsA, isMaster: 0 });
  seedAgent({ id: foreignAgentId, name: 'Foreign Generic', role: 'custom-role', workspaceId: wsB, isMaster: 0 });

  const picked = pickDynamicAgent(taskId, null);
  assert.ok(picked);
  assert.equal(picked?.id, localAgentId);
});
