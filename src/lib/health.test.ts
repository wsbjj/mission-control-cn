import test from 'node:test';
import assert from 'node:assert/strict';
import { getHealthSummary, getHealthDetail, formatPrometheus } from './health';
import type { HealthDetail } from './health';

// ---------- getHealthSummary ----------

test('getHealthSummary returns correct shape', () => {
  const summary = getHealthSummary();

  assert.ok(summary.status === 'ok' || summary.status === 'error', 'status must be ok or error');
  assert.equal(typeof summary.uptime_seconds, 'number');
  assert.ok(summary.uptime_seconds >= 0, 'uptime must be non-negative');
  assert.equal(typeof summary.version, 'string');
  assert.ok(summary.version.length > 0, 'version must not be empty');
});

// ---------- getHealthDetail ----------

test('getHealthDetail returns all components', () => {
  const detail = getHealthDetail();

  // Top-level fields
  assert.ok(detail.status === 'ok' || detail.status === 'error');
  assert.equal(typeof detail.uptime_seconds, 'number');
  assert.equal(typeof detail.version, 'string');
  assert.ok(detail.components, 'must have components');

  // DB component
  const db = detail.components.db;
  assert.ok(db.status === 'ok' || db.status === 'error');
  assert.equal(typeof db.writable, 'boolean');
  assert.equal(typeof db.schema_version, 'number');
  assert.equal(typeof db.size_bytes, 'number');
  assert.ok(db.size_bytes >= 0, 'size_bytes must be non-negative');

  // Gateway component
  const gw = detail.components.gateway;
  assert.ok(gw.status === 'ok' || gw.status === 'error' || gw.status === 'unconfigured');
  assert.equal(typeof gw.connected, 'boolean');

  // Agents component
  const agents = detail.components.agents;
  assert.ok(agents.status === 'ok' || agents.status === 'error');
  assert.equal(typeof agents.active_count, 'number');
  assert.equal(typeof agents.total_count, 'number');
  assert.equal(typeof agents.by_state, 'object');

  // Queue component
  const queue = detail.components.queue;
  assert.ok(queue.status === 'ok' || queue.status === 'error');
  assert.equal(typeof queue.assigned, 'number');
  assert.equal(typeof queue.in_progress, 'number');
  assert.equal(typeof queue.total_pending, 'number');
  assert.equal(typeof queue.by_status, 'object');

  // Research component
  const research = detail.components.research;
  assert.ok(research.status === 'ok' || research.status === 'error');
  assert.ok(Array.isArray(research.products));

  // Costs component
  const costs = detail.components.costs;
  assert.ok(costs.status === 'ok' || costs.status === 'error');
  assert.ok(Array.isArray(costs.caps));
});

// ---------- formatPrometheus ----------

test('formatPrometheus produces valid exposition format', () => {
  // Build a synthetic detail payload to test formatting
  const detail: HealthDetail = {
    status: 'ok',
    uptime_seconds: 3600,
    version: '2.2.0',
    components: {
      db: { status: 'ok', writable: true, schema_version: 15, size_bytes: 1048576 },
      gateway: { status: 'ok', connected: true },
      agents: { status: 'ok', active_count: 3, total_count: 5, by_state: { working: 2, idle: 1 } },
      queue: { status: 'ok', assigned: 2, in_progress: 1, total_pending: 5, by_status: { assigned: 2, in_progress: 1, queued: 2 } },
      research: {
        status: 'ok',
        products: [
          { product_id: 'prod-1', current_phase: 'completed', last_cycle_at: new Date(Date.now() - 60000).toISOString(), status: 'completed' },
        ],
      },
      costs: {
        status: 'ok',
        caps: [
          { product_id: 'prod-1', cap_type: 'monthly', limit_usd: 100, current_spend_usd: 42, utilization_pct: 42, status: 'active' },
        ],
      },
    },
  };

  const output = formatPrometheus(detail);

  // Must end with newline
  assert.ok(output.endsWith('\n'), 'must end with newline');

  // Must contain key metrics
  assert.ok(output.includes('autensa_up 1'), 'must include autensa_up');
  assert.ok(output.includes('autensa_uptime_seconds 3600'), 'must include uptime');
  assert.ok(output.includes('autensa_db_ok 1'), 'must include db_ok');
  assert.ok(output.includes('autensa_db_size_bytes 1048576'), 'must include db size');
  assert.ok(output.includes('autensa_db_schema_version 15'), 'must include schema version');
  assert.ok(output.includes('autensa_gateway_connected 1'), 'must include gateway');
  assert.ok(output.includes('autensa_agents_active 3'), 'must include agents active');
  assert.ok(output.includes('autensa_agents_total 5'), 'must include agents total');
  assert.ok(output.includes('autensa_queue_assigned 2'), 'must include queue assigned');
  assert.ok(output.includes('autensa_queue_in_progress 1'), 'must include queue in_progress');
  assert.ok(output.includes('autensa_queue_total_pending 5'), 'must include queue total_pending');
  assert.ok(output.includes('autensa_cost_utilization_pct'), 'must include cost utilization');
  assert.ok(output.includes('product_id="prod-1"'), 'must include product label');
  assert.ok(output.includes('autensa_research_last_cycle_age_seconds'), 'must include research age');

  // Every metric line must follow HELP/TYPE/value pattern
  const metricLines = output.split('\n').filter((l) => l && !l.startsWith('#'));
  for (const line of metricLines) {
    // Prometheus metric line: name{labels} value  OR  name value
    assert.match(line, /^[a-z_]+(\{[^}]*\})?\s+-?\d+(\.\d+)?$/, `Invalid metric line: "${line}"`);
  }

  // Every # HELP must be followed by a # TYPE
  const helpLines = output.split('\n').filter((l) => l.startsWith('# HELP'));
  const typeLines = output.split('\n').filter((l) => l.startsWith('# TYPE'));
  assert.equal(helpLines.length, typeLines.length, 'HELP and TYPE counts must match');
});

test('formatPrometheus handles error state', () => {
  const detail: HealthDetail = {
    status: 'error',
    uptime_seconds: 10,
    version: '0.0.0',
    components: {
      db: { status: 'error', writable: false, schema_version: 0, size_bytes: 0, error: 'disk full' },
      gateway: { status: 'error', connected: false },
      agents: { status: 'ok', active_count: 0, total_count: 0, by_state: {} },
      queue: { status: 'ok', assigned: 0, in_progress: 0, total_pending: 0, by_status: {} },
      research: { status: 'ok', products: [] },
      costs: { status: 'ok', caps: [] },
    },
  };

  const output = formatPrometheus(detail);
  assert.ok(output.includes('autensa_up 0'), 'service must be marked down');
  assert.ok(output.includes('autensa_db_ok 0'), 'db must be marked error');
  assert.ok(output.includes('autensa_gateway_connected 0'), 'gateway must be disconnected');
});
