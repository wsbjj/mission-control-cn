/**
 * Lightweight LLM completion via OpenClaw Gateway's OpenAI-compatible endpoint.
 * Uses /v1/chat/completions for stateless prompt→response (no agent sessions).
 */

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL?.replace('ws://', 'http://').replace('wss://', 'https://') || 'http://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
const DEFAULT_MODEL = process.env.AUTOPILOT_MODEL || 'anthropic/claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export interface CompletionOptions {
  model?: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CompletionResult {
  content: string;
  model: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Send a prompt and get a completion response.
 * Uses the Gateway's /v1/chat/completions endpoint — stateless, no agent session.
 */
export async function complete(prompt: string, options: CompletionOptions = {}): Promise<CompletionResult> {
  const {
    model = DEFAULT_MODEL,
    systemPrompt,
    temperature = 0.7,
    maxTokens = 8192,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM completion failed (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      model: string;
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const content = data.choices?.[0]?.message?.content || '';

    return {
      content,
      model: data.model || model,
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      },
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Send a prompt and parse the response as JSON.
 * Handles markdown code blocks and embedded JSON.
 */
export async function completeJSON<T = unknown>(prompt: string, options: CompletionOptions = {}): Promise<{ data: T; raw: string; usage: CompletionResult['usage'] }> {
  const result = await complete(prompt, options);

  // Try direct parse
  try {
    return { data: JSON.parse(result.content.trim()) as T, raw: result.content, usage: result.usage };
  } catch {
    // Continue
  }

  // Try markdown code block
  const codeBlockMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return { data: JSON.parse(codeBlockMatch[1].trim()) as T, raw: result.content, usage: result.usage };
    } catch {
      // Continue
    }
  }

  // Try first { to last }
  const firstBrace = result.content.indexOf('{');
  const lastBrace = result.content.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      return { data: JSON.parse(result.content.slice(firstBrace, lastBrace + 1)) as T, raw: result.content, usage: result.usage };
    } catch {
      // Continue
    }
  }

  // Try first [ to last ]
  const firstBracket = result.content.indexOf('[');
  const lastBracket = result.content.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    try {
      return { data: JSON.parse(result.content.slice(firstBracket, lastBracket + 1)) as T, raw: result.content, usage: result.usage };
    } catch {
      // Continue
    }
  }

  throw new Error(`Failed to parse JSON from LLM response. Raw content (first 500 chars): ${result.content.slice(0, 500)}`);
}
