import { v4 as uuidv4 } from 'uuid';
import { run } from '@/lib/db';
import { broadcast } from '@/lib/events';

/**
 * Emit an autopilot activity event — persists to DB and broadcasts via SSE.
 */
export function emitAutopilotActivity(input: {
  productId: string;
  cycleId: string;
  cycleType: 'research' | 'ideation';
  eventType: string;
  message: string;
  detail?: string;
  costUsd?: number;
  tokensUsed?: number;
}): void {
  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO autopilot_activity_log (id, product_id, cycle_id, cycle_type, event_type, message, detail, cost_usd, tokens_used, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, input.productId, input.cycleId, input.cycleType,
      input.eventType, input.message, input.detail || null,
      input.costUsd || null, input.tokensUsed || null, now
    ]
  );

  broadcast({
    type: 'autopilot_activity',
    payload: {
      id,
      product_id: input.productId,
      cycle_id: input.cycleId,
      cycle_type: input.cycleType,
      event_type: input.eventType,
      message: input.message,
      detail: input.detail,
      cost_usd: input.costUsd,
      tokens_used: input.tokensUsed,
      created_at: now,
    }
  });
}
