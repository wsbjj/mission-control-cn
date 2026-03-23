import { v4 as uuidv4 } from 'uuid';
import { queryOne, queryAll, run } from '@/lib/db';
import { broadcast } from '@/lib/events';
import type { AgentMailMessage } from '@/lib/types';

interface SendMailInput {
  convoyId: string;
  fromAgentId: string;
  toAgentId: string;
  subject?: string;
  body: string;
}

/**
 * Send a message from one agent to another within a convoy.
 */
export function sendMail(input: SendMailInput): AgentMailMessage {
  const { convoyId, fromAgentId, toAgentId, subject, body } = input;

  // Verify convoy exists
  const convoy = queryOne<{ id: string }>('SELECT id FROM convoys WHERE id = ?', [convoyId]);
  if (!convoy) throw new Error(`Convoy ${convoyId} not found`);

  const id = uuidv4();
  const now = new Date().toISOString();

  run(
    `INSERT INTO agent_mailbox (id, convoy_id, from_agent_id, to_agent_id, subject, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, convoyId, fromAgentId, toAgentId, subject || null, body, now]
  );

  const message = queryOne<AgentMailMessage>('SELECT * FROM agent_mailbox WHERE id = ?', [id])!;

  broadcast({ type: 'mail_received', payload: message });

  return message;
}

/**
 * Get unread mail for an agent.
 */
export function getUnreadMail(agentId: string): AgentMailMessage[] {
  const rows = queryAll<AgentMailMessage>(
    `SELECT m.*, fa.name as from_agent_name, ta.name as to_agent_name
     FROM agent_mailbox m
     LEFT JOIN agents fa ON m.from_agent_id = fa.id
     LEFT JOIN agents ta ON m.to_agent_id = ta.id
     WHERE m.to_agent_id = ? AND m.read_at IS NULL
     ORDER BY m.created_at ASC`,
    [agentId]
  );
  return rows;
}

/**
 * Mark a message as read.
 */
export function markAsRead(messageId: string): void {
  const now = new Date().toISOString();
  run('UPDATE agent_mailbox SET read_at = ? WHERE id = ?', [now, messageId]);
}

/**
 * Get all mail in a convoy.
 */
export function getConvoyMail(convoyId: string): AgentMailMessage[] {
  return queryAll<AgentMailMessage>(
    `SELECT m.*, fa.name as from_agent_name, ta.name as to_agent_name
     FROM agent_mailbox m
     LEFT JOIN agents fa ON m.from_agent_id = fa.id
     LEFT JOIN agents ta ON m.to_agent_id = ta.id
     WHERE m.convoy_id = ?
     ORDER BY m.created_at ASC`,
    [convoyId]
  );
}

/**
 * Format unread mail for injection into agent dispatch context.
 */
export function formatMailForDispatch(agentId: string): string | null {
  const messages = getUnreadMail(agentId);
  if (messages.length === 0) return null;

  let section = '\n📬 **Messages from your convoy teammates:**\n';
  for (const msg of messages) {
    const from = (msg as AgentMailMessage & { from_agent_name?: string }).from_agent_name || msg.from_agent_id;
    const subjectLine = msg.subject ? ` (${msg.subject})` : '';
    section += `- From **${from}**${subjectLine}: ${msg.body}\n`;
  }

  // Mark all as read
  for (const msg of messages) {
    markAsRead(msg.id);
  }

  return section;
}
