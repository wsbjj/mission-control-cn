import test from 'node:test';
import assert from 'node:assert/strict';
import { v4 as uuidv4 } from 'uuid';
import { run, queryOne, queryAll } from '@/lib/db';
import {
  computeEffectiveWeights,
  computeHealthScore,
  calculateAndPersist,
  getLatestScore,
  getScoreHistory,
  takeDailySnapshot,
  updateWeights,
  DEFAULT_WEIGHTS,
} from './health-score';
import type { HealthWeightConfig, HealthComponent, ProductHealthScore } from '@/lib/types';

// ── Helper: create a test product ──────────────────────────────────────

function createTestProduct(overrides?: { health_weight_config?: string }): string {
  const id = uuidv4();
  run(
    `INSERT INTO products (id, workspace_id, name, status, created_at, updated_at, health_weight_config)
     VALUES (?, 'default', 'Test Product', 'active', datetime('now'), datetime('now'), ?)`,
    [id, overrides?.health_weight_config || null]
  );
  return id;
}

function createResearchCycle(productId: string, completedDaysAgo: number): void {
  const completedAt = new Date(Date.now() - completedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
  run(
    `INSERT INTO research_cycles (id, product_id, status, completed_at, started_at)
     VALUES (?, ?, 'completed', ?, datetime('now'))`,
    [uuidv4(), productId, completedAt]
  );
}

function createPendingIdeas(productId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    run(
      `INSERT INTO ideas (id, product_id, title, description, category, status, created_at, updated_at)
       VALUES (?, ?, ?, 'desc', 'feature', 'pending', datetime('now'), datetime('now'))`,
      [uuidv4(), productId, `Idea ${i}`]
    );
  }
}

function createSwipeHistory(productId: string, count: number, daysAgo: number = 0): void {
  for (let i = 0; i < count; i++) {
    const ideaId = uuidv4();
    // Create the idea first
    run(
      `INSERT INTO ideas (id, product_id, title, description, category, status, created_at, updated_at)
       VALUES (?, ?, 'Swiped', 'desc', 'feature', 'approved', datetime('now'), datetime('now'))`,
      [ideaId, productId]
    );
    const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    run(
      `INSERT INTO swipe_history (id, idea_id, product_id, action, category, created_at)
       VALUES (?, ?, ?, 'approve', 'feature', ?)`,
      [uuidv4(), ideaId, productId, createdAt]
    );
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

test('computeEffectiveWeights: equal weights with all active', () => {
  const weights: HealthWeightConfig = {
    research: 20, pipeline: 20, swipe: 20, build: 20, cost: 20, disabled: [],
  };
  const result = computeEffectiveWeights(weights, ['research', 'pipeline', 'swipe', 'build', 'cost']);

  assert.equal(result.research, 20);
  assert.equal(result.pipeline, 20);
  assert.equal(result.swipe, 20);
  assert.equal(result.build, 20);
  assert.equal(result.cost, 20);
});

test('computeEffectiveWeights: redistributes when components disabled', () => {
  const weights: HealthWeightConfig = {
    research: 20, pipeline: 20, swipe: 20, build: 20, cost: 20,
    disabled: ['build', 'cost'],
  };
  const available: HealthComponent[] = ['research', 'pipeline', 'swipe', 'build', 'cost'];
  const result = computeEffectiveWeights(weights, available);

  // build and cost should be 0
  assert.equal(result.build, 0);
  assert.equal(result.cost, 0);

  // research, pipeline, swipe should each get ~33.33%
  const activeTotal = result.research + result.pipeline + result.swipe;
  assert.ok(Math.abs(activeTotal - 100) < 0.1, `Active total should be ~100, got ${activeTotal}`);
});

test('computeEffectiveWeights: redistributes when components missing data', () => {
  const weights: HealthWeightConfig = {
    research: 40, pipeline: 30, swipe: 30, build: 0, cost: 0, disabled: [],
  };
  // Only research and pipeline have data
  const available: HealthComponent[] = ['research', 'pipeline'];
  const result = computeEffectiveWeights(weights, available);

  assert.equal(result.swipe, 0);
  assert.equal(result.build, 0);
  assert.equal(result.cost, 0);

  // research: 40/(40+30) * 100 ≈ 57.14, pipeline: 30/(40+30) * 100 ≈ 42.86
  const total = result.research + result.pipeline;
  assert.ok(Math.abs(total - 100) < 0.1, `Active total should be ~100, got ${total}`);
});

test('computeEffectiveWeights: all disabled returns zeros', () => {
  const weights: HealthWeightConfig = {
    research: 20, pipeline: 20, swipe: 20, build: 20, cost: 20,
    disabled: ['research', 'pipeline', 'swipe', 'build', 'cost'],
  };
  const result = computeEffectiveWeights(weights, ['research', 'pipeline', 'swipe', 'build', 'cost']);

  assert.equal(result.research, 0);
  assert.equal(result.pipeline, 0);
  assert.equal(result.swipe, 0);
  assert.equal(result.build, 0);
  assert.equal(result.cost, 0);
});

test('computeHealthScore: new product with zero data returns 0', () => {
  const productId = createTestProduct();
  const { overallScore, components, weights } = computeHealthScore(productId);

  assert.equal(overallScore, 0);
  assert.equal(components.length, 5);
  assert.deepStrictEqual(weights, DEFAULT_WEIGHTS);

  // All component scores should be 0
  for (const comp of components) {
    assert.equal(comp.score, 0, `${comp.name} should be 0`);
  }
});

test('computeHealthScore: research freshness scores correctly', () => {
  const productId = createTestProduct();
  createResearchCycle(productId, 0); // completed today

  const { components } = computeHealthScore(productId);
  const research = components.find((c) => c.name === 'research')!;

  assert.ok(research.score >= 95, `Fresh research should score high, got ${research.score}`);
});

test('computeHealthScore: pipeline depth scales linearly', () => {
  const productId = createTestProduct();
  createPendingIdeas(productId, 5); // 5 pending = 50%

  const { components } = computeHealthScore(productId);
  const pipeline = components.find((c) => c.name === 'pipeline')!;

  assert.ok(Math.abs(pipeline.score - 50) < 1, `5 ideas should score ~50, got ${pipeline.score}`);
});

test('computeHealthScore: swipe velocity computed correctly', () => {
  const productId = createTestProduct();
  // 35 swipes in 7 days = 5/day = 100
  createSwipeHistory(productId, 35, 3); // all within 7 days

  const { components } = computeHealthScore(productId);
  const swipe = components.find((c) => c.name === 'swipe')!;

  assert.ok(swipe.score >= 95, `35 swipes in 7d should score high, got ${swipe.score}`);
});

test('computeHealthScore: partial data redistributes weights', () => {
  const productId = createTestProduct();
  // Only research has data
  createResearchCycle(productId, 1); // completed yesterday

  const { overallScore, components } = computeHealthScore(productId);
  const research = components.find((c) => c.name === 'research')!;

  // Research should have high effective weight since it's the only one with data
  assert.ok(research.effectiveWeight > 20, `Research effective weight should be > 20%, got ${research.effectiveWeight}`);
  assert.ok(overallScore > 0, `Score should be > 0 when one component has data`);
});

test('calculateAndPersist: saves and retrieves score', () => {
  const productId = createTestProduct();
  createPendingIdeas(productId, 10);

  const persisted = calculateAndPersist(productId);

  assert.ok(persisted.id);
  assert.equal(persisted.product_id, productId);
  assert.ok(persisted.overall_score >= 0);
  assert.ok(persisted.pipeline_depth_score >= 0);

  // Verify it can be retrieved
  const retrieved = getLatestScore(productId);
  assert.ok(retrieved);
  assert.equal(retrieved!.id, persisted.id);
});

test('takeDailySnapshot: creates snapshot with date', () => {
  const productId = createTestProduct();
  createPendingIdeas(productId, 5);

  takeDailySnapshot(productId);

  const today = new Date().toISOString().split('T')[0];
  const snapshots = getScoreHistory(productId, 1);

  assert.ok(snapshots.length >= 1, 'Should have at least 1 snapshot');
  const todaySnapshot = snapshots.find((s) => s.snapshot_date === today);
  assert.ok(todaySnapshot, 'Should have today\'s snapshot');
});

test('takeDailySnapshot: idempotent — does not duplicate', () => {
  const productId = createTestProduct();
  createPendingIdeas(productId, 5);

  takeDailySnapshot(productId);
  takeDailySnapshot(productId); // call again

  const today = new Date().toISOString().split('T')[0];
  const all = queryAll<ProductHealthScore>(
    `SELECT * FROM product_health_scores WHERE product_id = ? AND snapshot_date = ?`,
    [productId, today]
  );

  assert.equal(all.length, 1, 'Should only have 1 snapshot per day');
});

test('updateWeights: saves and recalculates', () => {
  const productId = createTestProduct();

  const newWeights = updateWeights(productId, {
    research: 40,
    pipeline: 10,
    swipe: 10,
    build: 30,
    cost: 10,
    disabled: ['cost'],
  });

  assert.equal(newWeights.research, 40);
  assert.equal(newWeights.cost, 10);
  assert.deepStrictEqual(newWeights.disabled, ['cost']);

  // Verify persisted
  const product = queryOne<{ health_weight_config: string }>(
    'SELECT health_weight_config FROM products WHERE id = ?',
    [productId]
  );
  assert.ok(product?.health_weight_config);
  const parsed = JSON.parse(product!.health_weight_config);
  assert.equal(parsed.research, 40);
});
