/**
 * Product Program A/B Testing
 *
 * Allows users to create variant Product Programs for the same product,
 * run split research/ideation cycles, and compare which variant produces
 * higher-quality ideas measured by swipe acceptance rate, build success rate,
 * and cost efficiency.
 */

import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run, transaction } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type {
  ProductProgramVariant,
  ProductABTest,
  ABTestComparisonMetrics,
  ABTestComparison,
  Product,
} from '@/lib/types';

// ─── Variants CRUD ──────────────────────────────────────────────────────────

export function createVariant(input: {
  product_id: string;
  name: string;
  content: string;
  is_control?: boolean;
}): ProductProgramVariant {
  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO product_program_variants (id, product_id, name, content, is_control, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, input.product_id, input.name, input.content, input.is_control ? 1 : 0, now]
  );

  return queryOne<ProductProgramVariant>(
    'SELECT * FROM product_program_variants WHERE id = ?',
    [id]
  )!;
}

export function getVariant(id: string): ProductProgramVariant | undefined {
  return queryOne<ProductProgramVariant>(
    'SELECT * FROM product_program_variants WHERE id = ?',
    [id]
  );
}

export function listVariants(productId: string): ProductProgramVariant[] {
  return queryAll<ProductProgramVariant>(
    'SELECT * FROM product_program_variants WHERE product_id = ? ORDER BY created_at ASC',
    [productId]
  );
}

export function updateVariant(
  id: string,
  updates: Partial<{ name: string; content: string }>
): ProductProgramVariant | undefined {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.content !== undefined) {
    fields.push('content = ?');
    values.push(updates.content);
  }

  if (fields.length === 0) return getVariant(id);

  values.push(id);
  run(`UPDATE product_program_variants SET ${fields.join(', ')} WHERE id = ?`, values);
  return getVariant(id);
}

export function deleteVariant(id: string): { success: boolean; error?: string } {
  // Check if variant is used in any test
  const usedInTest = queryOne<{ id: string }>(
    `SELECT id FROM product_ab_tests WHERE variant_a_id = ? OR variant_b_id = ?`,
    [id, id]
  );
  if (usedInTest) {
    return { success: false, error: 'Cannot delete variant that is used in an A/B test' };
  }

  const result = run('DELETE FROM product_program_variants WHERE id = ?', [id]);
  return { success: result.changes > 0 };
}

// ─── A/B Test Lifecycle ─────────────────────────────────────────────────────

export function getActiveTest(productId: string): ProductABTest | undefined {
  return queryOne<ProductABTest>(
    `SELECT * FROM product_ab_tests WHERE product_id = ? AND status = 'active'`,
    [productId]
  );
}

export function getTest(testId: string): ProductABTest | undefined {
  const test = queryOne<ProductABTest>(
    'SELECT * FROM product_ab_tests WHERE id = ?',
    [testId]
  );
  if (test) {
    test.variant_a = getVariant(test.variant_a_id);
    test.variant_b = getVariant(test.variant_b_id);
  }
  return test;
}

export function startTest(input: {
  product_id: string;
  variant_a_id: string;
  variant_b_id: string;
  split_mode?: 'concurrent' | 'alternating';
  min_swipes?: number;
}): { test?: ProductABTest; error?: string } {
  // Enforce one active test per product
  const existing = getActiveTest(input.product_id);
  if (existing) {
    return { error: 'An active A/B test already exists for this product. Conclude or cancel it first.' };
  }

  // Validate variants exist and belong to this product
  const variantA = getVariant(input.variant_a_id);
  const variantB = getVariant(input.variant_b_id);

  if (!variantA || variantA.product_id !== input.product_id) {
    return { error: 'Variant A not found or does not belong to this product' };
  }
  if (!variantB || variantB.product_id !== input.product_id) {
    return { error: 'Variant B not found or does not belong to this product' };
  }
  if (input.variant_a_id === input.variant_b_id) {
    return { error: 'Variant A and Variant B must be different' };
  }

  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO product_ab_tests (id, product_id, variant_a_id, variant_b_id, status, split_mode, min_swipes, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      id,
      input.product_id,
      input.variant_a_id,
      input.variant_b_id,
      input.split_mode || 'concurrent',
      input.min_swipes ?? 50,
      now,
    ]
  );

  const test = getTest(id)!;
  broadcast({ type: 'ab_test_started', payload: { productId: input.product_id, testId: id } });
  return { test };
}

export function concludeTest(
  testId: string,
  winnerVariantId: string
): { test?: ProductABTest; error?: string } {
  const test = getTest(testId);
  if (!test) return { error: 'A/B test not found' };
  if (test.status !== 'active') return { error: 'Test is not active' };

  if (winnerVariantId !== test.variant_a_id && winnerVariantId !== test.variant_b_id) {
    return { error: 'Winner must be one of the test variants' };
  }

  const now = new Date().toISOString();
  run(
    `UPDATE product_ab_tests SET status = 'concluded', winner_variant_id = ?, concluded_at = ? WHERE id = ?`,
    [winnerVariantId, now, testId]
  );

  const concluded = getTest(testId)!;
  broadcast({
    type: 'ab_test_concluded',
    payload: { productId: test.product_id, testId, winnerVariantId },
  });
  return { test: concluded };
}

export function cancelTest(testId: string): { test?: ProductABTest; error?: string } {
  const test = getTest(testId);
  if (!test) return { error: 'A/B test not found' };
  if (test.status !== 'active') return { error: 'Test is not active' };

  const now = new Date().toISOString();
  run(
    `UPDATE product_ab_tests SET status = 'cancelled', concluded_at = ? WHERE id = ?`,
    [now, testId]
  );

  const cancelled = getTest(testId)!;
  broadcast({
    type: 'ab_test_cancelled',
    payload: { productId: test.product_id, testId },
  });
  return { test: cancelled };
}

export function listTests(productId: string): ProductABTest[] {
  const tests = queryAll<ProductABTest>(
    'SELECT * FROM product_ab_tests WHERE product_id = ? ORDER BY created_at DESC',
    [productId]
  );
  for (const test of tests) {
    test.variant_a = getVariant(test.variant_a_id);
    test.variant_b = getVariant(test.variant_b_id);
  }
  return tests;
}

// ─── Promote Winner ─────────────────────────────────────────────────────────

export function promoteWinner(testId: string): { success: boolean; error?: string } {
  const test = getTest(testId);
  if (!test) return { success: false, error: 'A/B test not found' };
  if (test.status !== 'concluded') return { success: false, error: 'Test must be concluded before promoting' };
  if (!test.winner_variant_id) return { success: false, error: 'No winner selected' };

  const winner = getVariant(test.winner_variant_id);
  if (!winner) return { success: false, error: 'Winner variant not found' };

  // Copy winner content to product's primary program
  const now = new Date().toISOString();
  run(
    `UPDATE products SET product_program = ?, updated_at = ? WHERE id = ?`,
    [winner.content, now, test.product_id]
  );

  return { success: true };
}

// ─── Statistics Engine ──────────────────────────────────────────────────────

function getVariantMetrics(
  testId: string,
  variantId: string,
  variant: ProductProgramVariant
): ABTestComparisonMetrics {
  // Ideas generated by this variant
  const ideasGenerated = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM ideas WHERE variant_id = ?`,
    [variantId]
  )?.count || 0;

  // Swipe stats for ideas from this variant
  const swipeStats = queryOne<{
    total: number;
    approved: number;
    rejected: number;
    maybe: number;
  }>(
    `SELECT
       COUNT(*) as total,
       SUM(CASE WHEN sh.action IN ('approve', 'fire') THEN 1 ELSE 0 END) as approved,
       SUM(CASE WHEN sh.action = 'reject' THEN 1 ELSE 0 END) as rejected,
       SUM(CASE WHEN sh.action = 'maybe' THEN 1 ELSE 0 END) as maybe
     FROM swipe_history sh
     JOIN ideas i ON sh.idea_id = i.id
     WHERE i.variant_id = ?`,
    [variantId]
  ) || { total: 0, approved: 0, rejected: 0, maybe: 0 };

  // Tasks created from ideas of this variant
  const tasksCreated = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM tasks t
     JOIN ideas i ON t.idea_id = i.id
     WHERE i.variant_id = ?`,
    [variantId]
  )?.count || 0;

  // Tasks completed (done/shipped) from this variant's ideas
  const tasksCompleted = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count FROM tasks t
     JOIN ideas i ON t.idea_id = i.id
     WHERE i.variant_id = ? AND t.status = 'done'`,
    [variantId]
  )?.count || 0;

  // Total cost from tasks spawned by this variant's ideas
  const costTotal = queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(ce.cost_usd), 0) as total FROM cost_events ce
     JOIN tasks t ON ce.task_id = t.id
     JOIN ideas i ON t.idea_id = i.id
     WHERE i.variant_id = ?`,
    [variantId]
  )?.total || 0;

  const acceptanceRate = swipeStats.total > 0 ? swipeStats.approved / swipeStats.total : 0;
  const buildSuccessRate = tasksCreated > 0 ? tasksCompleted / tasksCreated : 0;
  const costPerShipped = tasksCompleted > 0 ? costTotal / tasksCompleted : null;

  return {
    variant_id: variantId,
    variant_name: variant.name,
    is_control: variant.is_control === 1,
    ideas_generated: ideasGenerated,
    swipes_total: swipeStats.total,
    swipes_approved: swipeStats.approved,
    swipes_rejected: swipeStats.rejected,
    swipes_maybe: swipeStats.maybe,
    acceptance_rate: Math.round(acceptanceRate * 10000) / 10000,
    tasks_created: tasksCreated,
    tasks_completed: tasksCompleted,
    build_success_rate: Math.round(buildSuccessRate * 10000) / 10000,
    cost_total_usd: Math.round(costTotal * 100) / 100,
    cost_per_shipped_idea: costPerShipped !== null ? Math.round(costPerShipped * 100) / 100 : null,
  };
}

/**
 * Chi-squared test for independence on a 2x2 contingency table.
 * Input: [[a_approved, a_rejected], [b_approved, b_rejected]]
 * Returns { chiSquared, pValue }
 */
export function chiSquaredTest(
  aApproved: number,
  aRejected: number,
  bApproved: number,
  bRejected: number
): { chiSquared: number; pValue: number } {
  const table = [
    [aApproved, aRejected],
    [bApproved, bRejected],
  ];

  const rowTotals = table.map(row => row[0] + row[1]);
  const colTotals = [table[0][0] + table[1][0], table[0][1] + table[1][1]];
  const grandTotal = rowTotals[0] + rowTotals[1];

  if (grandTotal === 0) return { chiSquared: 0, pValue: 1 };

  // Calculate expected values and chi-squared statistic
  let chiSquared = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const expected = (rowTotals[i] * colTotals[j]) / grandTotal;
      if (expected === 0) continue;
      chiSquared += Math.pow(table[i][j] - expected, 2) / expected;
    }
  }

  // Approximate p-value for 1 degree of freedom using survival function
  // Using the chi-squared CDF approximation for df=1
  const pValue = chiSquaredSurvival(chiSquared, 1);

  return { chiSquared: Math.round(chiSquared * 10000) / 10000, pValue: Math.round(pValue * 10000) / 10000 };
}

/**
 * Approximation of chi-squared survival function (1 - CDF) for df=1.
 * Uses the relationship: P(X > x) = 2 * (1 - Phi(sqrt(x))) for df=1,
 * where Phi is the standard normal CDF.
 */
function chiSquaredSurvival(x: number, df: number): number {
  if (x <= 0) return 1;
  if (df !== 1) {
    // For df=1 only — higher df would need a more complex implementation.
    // We only use 2x2 tables, so df is always 1.
    return 1;
  }
  // P(chi2 > x) = 2 * (1 - Phi(sqrt(x)))  for df=1
  const z = Math.sqrt(x);
  return 2 * (1 - normalCDF(z));
}

/**
 * Standard normal CDF approximation (Abramowitz and Stegun 26.2.17).
 * Accurate to ~1.5e-7.
 */
function normalCDF(z: number): number {
  if (z < -8) return 0;
  if (z > 8) return 1;

  const neg = z < 0;
  if (neg) z = -z;

  const p = 0.2316419;
  const b1 = 0.319381530;
  const b2 = -0.356563782;
  const b3 = 1.781477937;
  const b4 = -1.821255978;
  const b5 = 1.330274429;

  const t = 1 / (1 + p * z);
  const pdf = Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
  const cdf = 1 - pdf * (b1 * t + b2 * t ** 2 + b3 * t ** 3 + b4 * t ** 4 + b5 * t ** 5);

  return neg ? 1 - cdf : cdf;
}

/**
 * Get full comparison metrics for an A/B test.
 */
export function getTestComparison(testId: string): ABTestComparison | undefined {
  const test = getTest(testId);
  if (!test) return undefined;

  const variantA = getVariant(test.variant_a_id);
  const variantB = getVariant(test.variant_b_id);
  if (!variantA || !variantB) return undefined;

  const metricsA = getVariantMetrics(testId, test.variant_a_id, variantA);
  const metricsB = getVariantMetrics(testId, test.variant_b_id, variantB);

  // Determine confidence tier based on available data
  const minSwipesA = metricsA.swipes_total;
  const minSwipesB = metricsB.swipes_total;
  const minSwipes = Math.min(minSwipesA, minSwipesB);

  let confidenceTier: 'raw' | 'ci' | 'significance' = 'raw';
  if (minSwipes >= test.min_swipes) {
    confidenceTier = 'significance';
  } else if (minSwipes >= 20) {
    confidenceTier = 'ci';
  }

  // Run chi-squared test on acceptance rates
  let chiSquaredResult = { chiSquared: 0, pValue: 1 };
  let significant = false;
  let recommendedWinner: string | null = null;

  if (minSwipes >= 5) {
    // Use approve vs reject (exclude maybe for cleaner signal)
    chiSquaredResult = chiSquaredTest(
      metricsA.swipes_approved,
      metricsA.swipes_rejected,
      metricsB.swipes_approved,
      metricsB.swipes_rejected
    );

    significant = chiSquaredResult.pValue < 0.05;

    if (significant && confidenceTier === 'significance') {
      // Recommend the variant with higher acceptance rate
      recommendedWinner = metricsA.acceptance_rate > metricsB.acceptance_rate
        ? test.variant_a_id
        : metricsB.acceptance_rate > metricsA.acceptance_rate
          ? test.variant_b_id
          : null;
    }
  }

  return {
    test,
    variant_a_metrics: metricsA,
    variant_b_metrics: metricsB,
    statistics: {
      chi_squared: minSwipes >= 5 ? chiSquaredResult.chiSquared : null,
      p_value: minSwipes >= 5 ? chiSquaredResult.pValue : null,
      confidence_tier: confidenceTier,
      significant,
      recommended_winner: recommendedWinner,
    },
  };
}

// ─── Research/Ideation Integration ──────────────────────────────────────────

/**
 * Get the Product Program content to use for a research/ideation cycle,
 * accounting for active A/B tests.
 *
 * If no active test exists, returns the product's primary program.
 * If an active test exists in concurrent mode, returns both variants.
 * If an active test exists in alternating mode, returns the next variant.
 */
export function getResearchPrograms(productId: string): Array<{
  program: string;
  variantId: string | null;
  variantName: string | null;
}> {
  const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) return [];

  const activeTest = getActiveTest(productId);
  if (!activeTest) {
    // No test active — use the primary product program
    return [{
      program: product.product_program || '',
      variantId: null,
      variantName: null,
    }];
  }

  const variantA = getVariant(activeTest.variant_a_id);
  const variantB = getVariant(activeTest.variant_b_id);
  if (!variantA || !variantB) {
    return [{
      program: product.product_program || '',
      variantId: null,
      variantName: null,
    }];
  }

  if (activeTest.split_mode === 'concurrent') {
    // Run both variants in the same cycle
    return [
      { program: variantA.content, variantId: variantA.id, variantName: variantA.name },
      { program: variantB.content, variantId: variantB.id, variantName: variantB.name },
    ];
  }

  // Alternating mode — flip between variants
  const lastUsed = activeTest.last_variant_used;
  let nextVariant: ProductProgramVariant;

  if (!lastUsed || lastUsed === activeTest.variant_b_id) {
    nextVariant = variantA;
  } else {
    nextVariant = variantB;
  }

  // Update last_variant_used
  run(
    `UPDATE product_ab_tests SET last_variant_used = ? WHERE id = ?`,
    [nextVariant.id, activeTest.id]
  );

  return [
    { program: nextVariant.content, variantId: nextVariant.id, variantName: nextVariant.name },
  ];
}

// ─── Learning Engine Integration ────────────────────────────────────────────

/**
 * After promoting a winner, analyze what made the winning variant better
 * and generate refinement suggestions. Returns a markdown analysis.
 */
export function analyzeWinnerDelta(testId: string): string | null {
  const test = getTest(testId);
  if (!test || test.status !== 'concluded' || !test.winner_variant_id) return null;

  const comparison = getTestComparison(testId);
  if (!comparison) return null;

  const winner = test.winner_variant_id === test.variant_a_id
    ? { metrics: comparison.variant_a_metrics, variant: test.variant_a! }
    : { metrics: comparison.variant_b_metrics, variant: test.variant_b! };
  const loser = test.winner_variant_id === test.variant_a_id
    ? { metrics: comparison.variant_b_metrics, variant: test.variant_b! }
    : { metrics: comparison.variant_a_metrics, variant: test.variant_a! };

  const lines: string[] = [
    `## A/B Test Analysis: ${winner.variant.name} vs ${loser.variant.name}`,
    '',
    `**Winner:** ${winner.variant.name} (${(winner.metrics.acceptance_rate * 100).toFixed(1)}% acceptance)`,
    `**Loser:** ${loser.variant.name} (${(loser.metrics.acceptance_rate * 100).toFixed(1)}% acceptance)`,
    '',
    '### Key Differences',
    `- Acceptance rate delta: ${((winner.metrics.acceptance_rate - loser.metrics.acceptance_rate) * 100).toFixed(1)}pp`,
    `- Ideas generated: ${winner.metrics.ideas_generated} (winner) vs ${loser.metrics.ideas_generated} (loser)`,
    `- Build success: ${(winner.metrics.build_success_rate * 100).toFixed(1)}% vs ${(loser.metrics.build_success_rate * 100).toFixed(1)}%`,
  ];

  if (comparison.statistics.chi_squared !== null) {
    lines.push(
      '',
      '### Statistical Significance',
      `- Chi-squared: ${comparison.statistics.chi_squared}`,
      `- p-value: ${comparison.statistics.p_value}`,
      `- Significant: ${comparison.statistics.significant ? 'Yes' : 'No'}`,
    );
  }

  lines.push(
    '',
    '### Suggested Refinements',
    '- Review the winning program for patterns that drove higher acceptance',
    '- Consider running a follow-up test to iterate on the winning variant',
    `- Focus areas the winning variant emphasized that the loser did not`,
  );

  return lines.join('\n');
}
