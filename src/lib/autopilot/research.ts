import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import { recordCostEvent } from '@/lib/costs/tracker';
import { emitAutopilotActivity } from './activity';
import { completeJSON } from './llm';
import type { Product, ResearchCycle } from '@/lib/types';

function buildResearchPrompt(product: Product, learnedPreferences?: string): string {
  return `You are a Product Research Agent for Mission Control. Your job is to research and analyze a product to identify improvement opportunities.

## Your Process

1. Read the Product Program to understand what this product is, who uses it, and what matters to the owner.
2. If a repo URL is provided, consider what the codebase likely contains based on the product description — missing features, UX gaps, possible technical debt.
3. Analyze the competitive landscape: products in the same category, feature gaps, pricing and positioning.
4. Identify market trends: industry trends, emerging technologies, community signals.
5. Research the technology landscape: new libraries, API integrations, infrastructure improvements.

## Output Format

Produce a JSON research report with this structure:
{
  "sections": {
    "codebase": { "findings": [], "gaps": [], "opportunities": [] },
    "competitors": { "products_analyzed": [], "feature_gaps": [], "market_position": "" },
    "trends": { "relevant_trends": [], "emerging_tech": [], "community_signals": [] },
    "technology": { "new_tools": [], "integration_opportunities": [], "infrastructure_improvements": [] }
  }
}

Include specific, actionable findings — not generic observations. Every finding should inspire a concrete idea.

IMPORTANT: Respond with ONLY the JSON object. No markdown, no code blocks, no explanation text before or after. Just the raw JSON.

## Product Program

${product.product_program || 'No product program defined yet.'}

${product.repo_url ? `## Repository\n${product.repo_url}` : ''}
${product.live_url ? `## Live URL\n${product.live_url}` : ''}

${learnedPreferences ? `## Learned Preferences\n${learnedPreferences}` : ''}`;
}

/**
 * Run a research cycle for a product.
 * Uses the Gateway's /v1/chat/completions endpoint for stateless prompt→response.
 */
export async function runResearchCycle(productId: string, existingCycleId?: string): Promise<string> {
  const product = queryOne<Product>('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw new Error(`Product ${productId} not found`);

  const prefModel = queryOne<{ learned_preferences_md: string }>(
    'SELECT learned_preferences_md FROM preference_models WHERE product_id = ? ORDER BY last_updated DESC LIMIT 1',
    [productId]
  );

  const cycleId = existingCycleId || uuidv4();
  const now = new Date().toISOString();

  // Phase: init
  if (!existingCycleId) {
    run(
      `INSERT INTO research_cycles (id, product_id, status, current_phase, started_at, last_heartbeat)
       VALUES (?, ?, 'running', 'init', ?, ?)`,
      [cycleId, productId, now, now]
    );
  }

  emitAutopilotActivity({
    productId, cycleId, cycleType: 'research',
    eventType: 'phase_init',
    message: 'Research cycle started',
    detail: `Product: ${product.name}`,
  });

  broadcast({ type: 'research_started', payload: { productId, cycleId } });
  broadcast({ type: 'research_phase', payload: { productId, cycleId, phase: 'init' } });

  // Run asynchronously
  (async () => {
    try {
      const prompt = buildResearchPrompt(product, prefModel?.learned_preferences_md);

      // Phase: llm_submitted
      run(
        `UPDATE research_cycles SET current_phase = 'llm_submitted', last_heartbeat = ? WHERE id = ?`,
        [new Date().toISOString(), cycleId]
      );
      emitAutopilotActivity({
        productId, cycleId, cycleType: 'research',
        eventType: 'phase_llm_submitted',
        message: 'Sending research prompt to LLM...',
      });
      broadcast({ type: 'research_phase', payload: { productId, cycleId, phase: 'llm_submitted' } });

      // Phase: llm_polling (actually waiting for HTTP response — label kept for consistency)
      run(
        `UPDATE research_cycles SET current_phase = 'llm_polling', last_heartbeat = ? WHERE id = ?`,
        [new Date().toISOString(), cycleId]
      );
      emitAutopilotActivity({
        productId, cycleId, cycleType: 'research',
        eventType: 'phase_llm_polling',
        message: 'Waiting for research agent response...',
      });
      broadcast({ type: 'research_phase', payload: { productId, cycleId, phase: 'llm_polling' } });

      const { data: report, usage } = await completeJSON(prompt, {
        systemPrompt: 'You are a product research agent. Analyze the product and respond with a JSON research report only.',
        timeoutMs: 300_000, // 5 minutes
      });

      // Phase: report_received
      run(
        `UPDATE research_cycles SET current_phase = 'report_received', phase_data = ?, last_heartbeat = ? WHERE id = ?`,
        [JSON.stringify({ report }), new Date().toISOString(), cycleId]
      );
      emitAutopilotActivity({
        productId, cycleId, cycleType: 'research',
        eventType: 'phase_report_received',
        message: 'Research report received',
        detail: `Sections: ${Object.keys((report as Record<string, unknown>).sections || (report as object)).join(', ')}`,
      });
      broadcast({ type: 'research_phase', payload: { productId, cycleId, phase: 'report_received' } });

      // Phase: completed
      run(
        `UPDATE research_cycles SET status = 'completed', report = ?, completed_at = ?, current_phase = 'completed' WHERE id = ?`,
        [JSON.stringify(report), new Date().toISOString(), cycleId]
      );

      recordCostEvent({
        product_id: productId,
        workspace_id: product.workspace_id,
        cycle_id: cycleId,
        event_type: 'research_cycle',
        cost_usd: 0, // TODO: calculate from usage
      });

      emitAutopilotActivity({
        productId, cycleId, cycleType: 'research',
        eventType: 'phase_completed',
        message: 'Research cycle completed successfully',
        detail: `Tokens used: ${usage.totalTokens}`,
      });

      broadcast({ type: 'research_completed', payload: { productId, cycleId } });
      broadcast({ type: 'research_phase', payload: { productId, cycleId, phase: 'completed' } });

      console.log(`[Research] Cycle ${cycleId} completed successfully (tokens: ${usage.totalTokens})`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      run(
        `UPDATE research_cycles SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`,
        [errMsg, new Date().toISOString(), cycleId]
      );
      emitAutopilotActivity({
        productId, cycleId, cycleType: 'research',
        eventType: 'error',
        message: 'Research cycle failed',
        detail: errMsg,
      });
      console.error(`[Research] Cycle ${cycleId} failed:`, error);
    }
  })();

  return cycleId;
}

export function getResearchCycles(productId: string): ResearchCycle[] {
  return queryAll<ResearchCycle>(
    'SELECT * FROM research_cycles WHERE product_id = ? ORDER BY started_at DESC',
    [productId]
  );
}

export function getResearchCycle(cycleId: string): ResearchCycle | undefined {
  return queryOne<ResearchCycle>('SELECT * FROM research_cycles WHERE id = ?', [cycleId]);
}
