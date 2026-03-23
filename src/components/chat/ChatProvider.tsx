'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { ChatWidget } from './ChatWidget';
import { CommandPalette, buildDefaultCommands, type PaletteCommand } from './CommandPalette';

/**
 * ChatProvider — wraps the app to provide:
 * 1. Floating ChatWidget (bottom-right)
 * 2. Cmd+K CommandPalette (global)
 * 3. Keyboard shortcut handlers
 * 4. Slash-command bridge from chat input → palette
 */
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(undefined);

  // Cmd+K to open command palette
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteFilter('');
        setPaletteOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Listen for slash-command events from chat inputs
  useEffect(() => {
    const handleSlashOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.taskId) setActiveTaskId(detail.taskId);
      setPaletteFilter(detail?.filter || '');
      setPaletteOpen(true);
    };
    window.addEventListener('commandpalette:open', handleSlashOpen);
    return () => window.removeEventListener('commandpalette:open', handleSlashOpen);
  }, []);

  const commands = useMemo(() => buildDefaultCommands({
    selectedTaskId: activeTaskId,
    onToggleChat: () => {
      window.dispatchEvent(new CustomEvent('chat:toggle'));
    },
  }), [activeTaskId]);

  return (
    <>
      {children}
      <ChatWidget />
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
        initialFilter={paletteFilter}
      />
    </>
  );
}
