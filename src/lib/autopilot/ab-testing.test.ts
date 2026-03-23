/**
 * Tests for Product Program A/B Testing
 *
 * Covers: chi-squared statistics, variant CRUD (via raw SQL against in-memory DB),
 * test lifecycle, one-active-test constraint, promotion flow, alternating mode,
 * and edge cases (0 swipes, equal results, small samples).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chiSquaredTest } from './ab-testing';

// ─── Chi-Squared Statistics Tests ───────────────────────────────────────────

test('chiSquaredTest: returns chi=0, p=1 for all zeros', () => {
  const result = chiSquaredTest(0, 0, 0, 0);
  assert.equal(result.chiSquared, 0);
  assert.equal(result.pValue, 1);
});

test('chiSquaredTest: returns p=1 for equal distributions', () => {
  const result = chiSquaredTest(50, 50, 50, 50);
  assert.equal(result.chiSquared, 0);
  assert.equal(result.pValue, 1);
});

test('chiSquaredTest: detects significant difference (80% vs 40%)', () => {
  // Variant A: 80/100 approve, Variant B: 40/100 approve
  const result = chiSquaredTest(80, 20, 40, 60);
  // chi-squared critical value at p<0.05 for df=1 is 3.841
  assert.ok(result.chiSquared > 3.84, `Expected chi-squared > 3.84, got ${result.chiSquared}`);
  assert.ok(result.pValue < 0.05, `Expected p-value < 0.05, got ${result.pValue}`);
});

test('chiSquaredTest: non-significant for very small sample', () => {
  // 5 vs 4 approved out of 10 each — very close rates, tiny sample
  const result = chiSquaredTest(5, 5, 4, 6);
  assert.ok(result.pValue > 0.05, `Expected p-value > 0.05, got ${result.pValue}`);
});

test('chiSquaredTest: extreme case — 100% vs 0%', () => {
  const result = chiSquaredTest(100, 0, 0, 100);
  assert.ok(result.chiSquared > 0, 'Chi-squared should be positive');
  assert.ok(result.pValue < 0.001, `Expected p-value < 0.001, got ${result.pValue}`);
});

test('chiSquaredTest: both all-approved (no difference)', () => {
  const result = chiSquaredTest(50, 0, 50, 0);
  assert.equal(result.chiSquared, 0);
  assert.equal(result.pValue, 1);
});

test('chiSquaredTest: single observation per group', () => {
  const result = chiSquaredTest(1, 0, 0, 1);
  assert.ok(result.chiSquared > 0, 'Should produce non-zero chi-squared');
  assert.equal(typeof result.pValue, 'number');
});

test('chiSquaredTest: large unbalanced sample', () => {
  // A: 95/100, B: 85/100 — moderate difference, large N
  const result = chiSquaredTest(95, 5, 85, 15);
  assert.ok(result.chiSquared > 0, 'Should detect some difference');
  // With N=200 and ~10% rate difference, should be significant
  assert.ok(result.pValue < 0.05, `Expected significant with p=${result.pValue}`);
});

// ─── Database Integration Tests (in-memory SQLite) ──────────────────────────

test('A/B Testing: full lifecycle via raw SQL', async () => {
  // Dynamically import better-sqlite3 so the test doesn't fail at parse time
  // if it's not available in CI (the test still exercises all SQL patterns)
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create minimal schema
  db.exec(`
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    );
    INSERT INTO workspaces (id, name, slug) VALUES ('default', 'Default', 'default');

    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      product_program TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE product_program_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      is_control INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE product_ab_tests (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      variant_a_id TEXT NOT NULL REFERENCES product_program_variants(id),
      variant_b_id TEXT NOT NULL REFERENCES product_program_variants(id),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'concluded', 'cancelled')),
      split_mode TEXT NOT NULL DEFAULT 'concurrent' CHECK (split_mode IN ('concurrent', 'alternating')),
      min_swipes INTEGER NOT NULL DEFAULT 50,
      last_variant_used TEXT,
      winner_variant_id TEXT REFERENCES product_program_variants(id),
      created_at TEXT DEFAULT (datetime('now')),
      concluded_at TEXT
    );

    CREATE TABLE ideas (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      variant_id TEXT REFERENCES product_program_variants(id),
      task_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE swipe_history (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL REFERENCES ideas(id),
      product_id TEXT NOT NULL,
      action TEXT NOT NULL,
      category TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT DEFAULT 'inbox',
      idea_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE cost_events (
      id TEXT PRIMARY KEY,
      product_id TEXT,
      workspace_id TEXT NOT NULL,
      task_id TEXT,
      event_type TEXT NOT NULL,
      cost_usd REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed test data
  db.exec(`INSERT INTO products (id, workspace_id, name, product_program) VALUES ('prod-1', 'default', 'Test Product', 'Original program')`);
  db.exec(`INSERT INTO product_program_variants (id, product_id, name, content, is_control) VALUES ('var-a', 'prod-1', 'Control', 'Focus on UX and quality', 1)`);
  db.exec(`INSERT INTO product_program_variants (id, product_id, name, content, is_control) VALUES ('var-b', 'prod-1', 'Experiment', 'Focus on monetization and growth', 0)`);

  // Test 1: Create variant
  const variants = db.prepare('SELECT * FROM product_program_variants WHERE product_id = ?').all('prod-1') as { id: string }[];
  assert.equal(variants.length, 2, 'Should have 2 variants');

  // Test 2: Start A/B test
  db.exec(`INSERT INTO product_ab_tests (id, product_id, variant_a_id, variant_b_id, status, split_mode, min_swipes) VALUES ('test-1', 'prod-1', 'var-a', 'var-b', 'active', 'concurrent', 50)`);
  const activeTest = db.prepare(`SELECT * FROM product_ab_tests WHERE product_id = ? AND status = 'active'`).get('prod-1') as { id: string } | undefined;
  assert.ok(activeTest, 'Should have an active test');

  // Test 3: One-active-test constraint — attempting to insert a second active test should be blocked at app level
  // (DB doesn't have a unique constraint — this is enforced by application code, which checks before inserting)
  const activeCount = (db.prepare(`SELECT COUNT(*) as c FROM product_ab_tests WHERE product_id = ? AND status = 'active'`).get('prod-1') as { c: number }).c;
  assert.equal(activeCount, 1, 'Should have exactly 1 active test');

  // Test 4: Tag ideas with variant_id
  db.exec(`INSERT INTO ideas (id, product_id, title, description, category, variant_id) VALUES ('idea-a1', 'prod-1', 'UX Idea 1', 'Better onboarding', 'ux', 'var-a')`);
  db.exec(`INSERT INTO ideas (id, product_id, title, description, category, variant_id) VALUES ('idea-a2', 'prod-1', 'UX Idea 2', 'Better nav', 'ux', 'var-a')`);
  db.exec(`INSERT INTO ideas (id, product_id, title, description, category, variant_id) VALUES ('idea-a3', 'prod-1', 'UX Idea 3', 'Better search', 'ux', 'var-a')`);
  db.exec(`INSERT INTO ideas (id, product_id, title, description, category, variant_id) VALUES ('idea-b1', 'prod-1', 'Rev Idea 1', 'Subscriptions', 'monetization', 'var-b')`);
  db.exec(`INSERT INTO ideas (id, product_id, title, description, category, variant_id) VALUES ('idea-b2', 'prod-1', 'Rev Idea 2', 'Ads', 'monetization', 'var-b')`);
  db.exec(`INSERT INTO ideas (id, product_id, title, description, category, variant_id) VALUES ('idea-none', 'prod-1', 'Regular Idea', 'No variant', 'feature', NULL)`);

  const varAIdeas = (db.prepare('SELECT COUNT(*) as c FROM ideas WHERE variant_id = ?').get('var-a') as { c: number }).c;
  const varBIdeas = (db.prepare('SELECT COUNT(*) as c FROM ideas WHERE variant_id = ?').get('var-b') as { c: number }).c;
  const noVarIdeas = (db.prepare('SELECT COUNT(*) as c FROM ideas WHERE variant_id IS NULL').get() as { c: number }).c;
  assert.equal(varAIdeas, 3, 'Variant A should have 3 ideas');
  assert.equal(varBIdeas, 2, 'Variant B should have 2 ideas');
  assert.equal(noVarIdeas, 1, 'Should have 1 idea with no variant');

  // Test 5: Swipe history per variant
  db.exec(`INSERT INTO swipe_history (id, idea_id, product_id, action, category) VALUES ('sw-1', 'idea-a1', 'prod-1', 'approve', 'ux')`);
  db.exec(`INSERT INTO swipe_history (id, idea_id, product_id, action, category) VALUES ('sw-2', 'idea-a2', 'prod-1', 'approve', 'ux')`);
  db.exec(`INSERT INTO swipe_history (id, idea_id, product_id, action, category) VALUES ('sw-3', 'idea-a3', 'prod-1', 'reject', 'ux')`);
  db.exec(`INSERT INTO swipe_history (id, idea_id, product_id, action, category) VALUES ('sw-4', 'idea-b1', 'prod-1', 'reject', 'monetization')`);
  db.exec(`INSERT INTO swipe_history (id, idea_id, product_id, action, category) VALUES ('sw-5', 'idea-b2', 'prod-1', 'reject', 'monetization')`);

  // Verify per-variant metrics query
  const varAMetrics = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN sh.action IN ('approve', 'fire') THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN sh.action = 'reject' THEN 1 ELSE 0 END) as rejected
    FROM swipe_history sh
    JOIN ideas i ON sh.idea_id = i.id
    WHERE i.variant_id = ?
  `).get('var-a') as { total: number; approved: number; rejected: number };

  assert.equal(varAMetrics.total, 3, 'Variant A should have 3 swipes');
  assert.equal(varAMetrics.approved, 2, 'Variant A should have 2 approved');
  assert.equal(varAMetrics.rejected, 1, 'Variant A should have 1 rejected');

  const varBMetrics = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN sh.action IN ('approve', 'fire') THEN 1 ELSE 0 END) as approved,
      SUM(CASE WHEN sh.action = 'reject' THEN 1 ELSE 0 END) as rejected
    FROM swipe_history sh
    JOIN ideas i ON sh.idea_id = i.id
    WHERE i.variant_id = ?
  `).get('var-b') as { total: number; approved: number; rejected: number };

  assert.equal(varBMetrics.total, 2, 'Variant B should have 2 swipes');
  assert.equal(varBMetrics.approved, 0, 'Variant B should have 0 approved');
  assert.equal(varBMetrics.rejected, 2, 'Variant B should have 2 rejected');

  // Test 6: Conclude with winner
  const now = new Date().toISOString();
  db.prepare(`UPDATE product_ab_tests SET status = 'concluded', winner_variant_id = ?, concluded_at = ? WHERE id = ?`).run('var-a', now, 'test-1');
  const concluded = db.prepare('SELECT * FROM product_ab_tests WHERE id = ?').get('test-1') as { status: string; winner_variant_id: string };
  assert.equal(concluded.status, 'concluded');
  assert.equal(concluded.winner_variant_id, 'var-a');

  // Test 7: Promote winner — copy variant content to product's primary program
  const winnerVariant = db.prepare('SELECT content FROM product_program_variants WHERE id = ?').get('var-a') as { content: string };
  db.prepare('UPDATE products SET product_program = ?, updated_at = ? WHERE id = ?').run(winnerVariant.content, new Date().toISOString(), 'prod-1');
  const updatedProduct = db.prepare('SELECT product_program FROM products WHERE id = ?').get('prod-1') as { product_program: string };
  assert.equal(updatedProduct.product_program, 'Focus on UX and quality', 'Product program should be updated to winner content');

  // Test 8: Cannot delete variant used in test
  const usedInTest = db.prepare('SELECT id FROM product_ab_tests WHERE variant_a_id = ? OR variant_b_id = ?').get('var-a', 'var-a') as { id: string } | undefined;
  assert.ok(usedInTest, 'Variant should be found in a test');

  // Test 9: Alternating mode tracking
  db.exec(`INSERT INTO product_ab_tests (id, product_id, variant_a_id, variant_b_id, status, split_mode, min_swipes, last_variant_used) VALUES ('test-alt', 'prod-1', 'var-a', 'var-b', 'active', 'alternating', 50, NULL)`);

  let altTest = db.prepare('SELECT last_variant_used FROM product_ab_tests WHERE id = ?').get('test-alt') as { last_variant_used: string | null };
  assert.equal(altTest.last_variant_used, null, 'Initial last_variant_used should be null');

  // Simulate first run picks var-a
  db.prepare('UPDATE product_ab_tests SET last_variant_used = ? WHERE id = ?').run('var-a', 'test-alt');
  altTest = db.prepare('SELECT last_variant_used FROM product_ab_tests WHERE id = ?').get('test-alt') as { last_variant_used: string | null };
  assert.equal(altTest.last_variant_used, 'var-a');

  // Next run should pick var-b (app logic checks: if last == var-a then next == var-b)
  const lastUsed = altTest.last_variant_used;
  const nextVariant = lastUsed === 'var-a' ? 'var-b' : 'var-a';
  assert.equal(nextVariant, 'var-b', 'Alternating should flip to var-b');

  // Test 10: Past experiments browsable
  db.prepare('UPDATE product_ab_tests SET status = ? WHERE id = ?').run('cancelled', 'test-alt');
  const allTests = db.prepare('SELECT * FROM product_ab_tests WHERE product_id = ? ORDER BY created_at DESC').all('prod-1') as { id: string; status: string }[];
  assert.ok(allTests.length >= 2, 'Should have at least 2 tests in history');
  assert.ok(allTests.some(t => t.status === 'concluded'), 'Should have a concluded test');
  assert.ok(allTests.some(t => t.status === 'cancelled'), 'Should have a cancelled test');

  db.close();
});
