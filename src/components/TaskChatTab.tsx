'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { Send, Check, Loader, MessageSquare } from 'lucide-react';
import type { TaskNote } from '@/lib/types';

interface TaskChatTabProps {
  taskId: string;
}

export function TaskChatTab({ taskId }: TaskChatTabProps) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadNotes = async () => {
    try {
      const res = await fetch(`/api/tasks/${taskId}/chat`);
      if (res.ok) {
        const data: TaskNote[] = await res.json();
        setNotes(data);
      }
    } catch {
      // Silently fail — will retry on next poll
    }
  };

  useEffect(() => {
    loadNotes();
    const interval = setInterval(loadNotes, 2000);
    return () => clearInterval(interval);
  }, [taskId]);

  // Derive "waiting" from data: last message is from user, delivered, and less than 5 min old
  const waiting = useMemo(() => {
    if (notes.length === 0) return false;
    const last = notes[notes.length - 1];
    if (last.role === 'assistant') return false;
    if (last.role !== 'user') return false;
    // Check if the message is recent (< 5 minutes)
    const age = Date.now() - new Date(last.created_at).getTime();
    return age < 300000;
  }, [notes]);

  // Auto-scroll on new notes or waiting state change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [notes, waiting]);

  const handleSend = async () => {
    if (!message.trim() || sending) return;
    setError(null);
    setSending(true);

    try {
      const res = await fetch(`/api/tasks/${taskId}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: message.trim() }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to send' }));
        setError(data.error || 'Failed to send message');
        return;
      }

      setMessage('');
      await loadNotes();
    } catch {
      setError('Network error — please try again');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full min-h-[400px]">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {notes.length === 0 && !waiting && (
          <div className="text-center py-12">
            <MessageSquare className="w-8 h-8 text-mc-text-secondary mx-auto mb-3 opacity-50" />
            <p className="text-mc-text-secondary text-sm">No messages yet</p>
            <p className="text-mc-text-secondary/60 text-xs mt-1">
              Send a message to the agent — it will be dispatched automatically
            </p>
          </div>
        )}

        {notes.map(note => {
          const isAgent = note.role === 'assistant';
          return (
            <div key={note.id} className={isAgent ? 'mr-8' : 'ml-8'}>
              <div className={`border rounded-lg px-3 py-2 ${
                isAgent
                  ? 'bg-green-500/10 border-green-500/20'
                  : 'bg-blue-500/10 border-blue-500/20'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-mc-text-secondary">
                    {isAgent ? 'Agent' : 'You'}
                  </span>
                  {!isAgent && note.status === 'pending' && (
                    <span className="flex items-center gap-1 text-xs text-amber-400">
                      <Loader className="w-3 h-3 animate-spin" />
                      Sending
                    </span>
                  )}
                  {!isAgent && note.status === 'delivered' && (
                    <span className="flex items-center gap-1 text-xs text-green-400">
                      <Check className="w-3 h-3" />
                      Delivered
                    </span>
                  )}
                  <span className="ml-auto text-xs text-mc-text-secondary/50">
                    {new Date(note.created_at.endsWith('Z') ? note.created_at : note.created_at + 'Z').toLocaleTimeString()}
                  </span>
                </div>
                <div className="text-sm text-mc-text whitespace-pre-wrap">{note.content}</div>
              </div>
            </div>
          );
        })}

        {/* Thinking bubble — derived from data, survives modal close/reopen */}
        {waiting && (
          <div className="mr-8">
            <div className="bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 inline-flex items-center gap-2">
              <span className="text-xs font-medium text-mc-text-secondary">Agent</span>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-mc-border p-3 space-y-2">
        {error && (
          <div className="text-xs text-red-400 px-1">{error}</div>
        )}

        <div className="flex gap-2">
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message the agent..."
            className="flex-1 bg-mc-bg border border-mc-border rounded-lg px-3 py-2 text-sm text-mc-text resize-none focus:outline-none focus:border-mc-accent"
            rows={2}
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="self-end min-h-11 min-w-11 flex items-center justify-center rounded-lg bg-mc-accent text-white hover:bg-mc-accent/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {sending ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
}
