'use client';

import { useState, useCallback, useEffect, useMemo } from 'react';
import { ChatWidget } from './ChatWidget';
import { CommandPalette, buildDefaultCommands, type PaletteCommand } from './CommandPalette';

/**
 * ChatProvider — wraps the app to provide:
 * 1. Floating ChatWidget (bottom-right)
 * 2. Cmd+K CommandPalette (global)
 * 3. Keyboard shortcut handlers
 */
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteFilter, setPaletteFilter] = useState('');

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

  const commands = useMemo(() => buildDefaultCommands({
    onToggleChat: () => {
      // Dispatch a custom event that the ChatWidget listens to
      window.dispatchEvent(new CustomEvent('chat:toggle'));
    },
  }), []);

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
