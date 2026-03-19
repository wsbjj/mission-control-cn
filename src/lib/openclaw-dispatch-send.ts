/**
 * Resilient OpenClaw chat.send for task dispatch — timeouts + retries.
 */

import type { OpenClawClient } from '@/lib/openclaw/client';

function parseEnvInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Timeout for chat.send only; falls back to OPENCLAW_RPC_TIMEOUT_MS semantics via env read here. */
export function getOpenClawChatSendTimeoutMs(): number {
  const chat = Number.parseInt(process.env.OPENCLAW_CHAT_SEND_TIMEOUT_MS || '', 10);
  if (Number.isFinite(chat) && chat >= 5000) return chat;
  const rpc = Number.parseInt(process.env.OPENCLAW_RPC_TIMEOUT_MS || '30000', 10);
  return Math.max(5000, Number.isFinite(rpc) ? rpc : 30000);
}

export function getDispatchMaxAttempts(): number {
  return Math.max(1, Math.min(10, parseEnvInt('OPENCLAW_DISPATCH_MAX_ATTEMPTS', 3)));
}

export function getDispatchRetryBaseDelayMs(): number {
  return Math.max(200, parseEnvInt('OPENCLAW_DISPATCH_RETRY_DELAY_MS', 1500));
}

function isRetriableDispatchError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|Not connected|ECONNRESET|ETIMEDOUT|EPIPE|socket|network|Failed to connect|Connection timeout/i.test(
    msg
  );
}

/**
 * Sends the task prompt to OpenClaw with per-attempt timeout and exponential backoff retries.
 * Each attempt uses a fresh idempotency suffix so the gateway does not drop legitimate retries.
 */
export async function sendChatSendWithRetry(
  client: OpenClawClient,
  args: { sessionKey: string; message: string; idempotencyKey: string }
): Promise<void> {
  const timeoutMs = getOpenClawChatSendTimeoutMs();
  const maxAttempts = getDispatchMaxAttempts();
  const baseDelay = getDispatchRetryBaseDelayMs();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!client.isConnected()) {
        await client.connect();
      }
      await client.call(
        'chat.send',
        {
          sessionKey: args.sessionKey,
          message: args.message,
          idempotencyKey: `${args.idempotencyKey}-a${attempt}`,
        },
        { timeoutMs }
      );
      if (attempt > 1) {
        console.log(`[Dispatch] chat.send succeeded on attempt ${attempt}/${maxAttempts}`);
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[Dispatch] chat.send attempt ${attempt}/${maxAttempts} failed:`, lastError.message);
      const retriable = isRetriableDispatchError(lastError);
      if (!retriable || attempt >= maxAttempts) {
        throw lastError;
      }
      await new Promise((r) => setTimeout(r, baseDelay * attempt));
    }
  }

  throw lastError ?? new Error('chat.send failed');
}
