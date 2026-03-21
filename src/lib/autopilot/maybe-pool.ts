import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { MaybePoolEntry, Idea } from '@/lib/types';

export function getMaybePool(productId: string): (MaybePoolEntry & { idea: Idea })[] {
  const entries = queryAll<MaybePoolEntry>(
    'SELECT * FROM maybe_pool WHERE product_id = ? ORDER BY next_evaluate_at ASC',
    [productId]
  );

  return entries.map(entry => {
    const idea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [entry.idea_id]);
    return { ...entry, idea: idea! };
  }).filter(e => e.idea);
}

/**
 * Resurface an idea from the maybe pool — creates a new idea with source='resurfaced'.
 */
export function resurfaceIdea(ideaId: string, reason?: string): Idea {
  const original = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [ideaId]);
  if (!original) throw new Error(`Idea ${ideaId} not found`);

  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO ideas (id, product_id, cycle_id, title, description, category, research_backing, impact_score, feasibility_score, complexity, estimated_effort_hours, competitive_analysis, target_user_segment, revenue_potential, technical_approach, risks, tags, source, status, resurfaced_from, resurfaced_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resurfaced', 'pending', ?, ?, ?, ?)`,
    [
      id, original.product_id, original.cycle_id,
      original.title, original.description, original.category,
      original.research_backing, original.impact_score, original.feasibility_score,
      original.complexity, original.estimated_effort_hours,
      original.competitive_analysis, original.target_user_segment,
      original.revenue_potential, original.technical_approach,
      original.risks, original.tags,
      ideaId, reason || 'Manually resurfaced',
      now, now
    ]
  );

  // Remove from maybe pool
  run('DELETE FROM maybe_pool WHERE idea_id = ?', [ideaId]);

  // Update evaluation count
  const newIdea = queryOne<Idea>('SELECT * FROM ideas WHERE id = ?', [id])!;
  broadcast({ type: 'maybe_resurfaced', payload: { productId: original.product_id, ideaId: id, originalIdeaId: ideaId } });
  return newIdea;
}

/**
 * Evaluate due maybe pool entries.
 */
export function evaluateMaybePool(productId: string): { resurfaced: number; kept: number } {
  const now = new Date().toISOString();
  const dueEntries = queryAll<MaybePoolEntry>(
    `SELECT * FROM maybe_pool WHERE product_id = ? AND next_evaluate_at <= ?`,
    [productId, now]
  );

  let resurfaced = 0;
  let kept = 0;

  for (const entry of dueEntries) {
    // Simple heuristic: resurface after 3 evaluations or if older than 30 days
    const age = Date.now() - new Date(entry.created_at).getTime();
    const isOld = age > 30 * 24 * 60 * 60 * 1000;

    if (entry.evaluation_count >= 2 || isOld) {
      resurfaceIdea(entry.idea_id, 'Automatic re-evaluation — due for review');
      resurfaced++;
    } else {
      // Keep in pool, bump evaluation
      const nextEval = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      run(
        `UPDATE maybe_pool SET evaluation_count = evaluation_count + 1, last_evaluated_at = ?, next_evaluate_at = ? WHERE id = ?`,
        [now, nextEval, entry.id]
      );
      kept++;
    }
  }

  return { resurfaced, kept };
}
