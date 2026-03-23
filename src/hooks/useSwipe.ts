'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

export type SwipeDirection = 'left' | 'right' | 'up' | 'down' | null;

interface UseSwipeOptions {
  threshold?: number;
  onSwipe?: (direction: SwipeDirection) => void;
}

interface SwipeState {
  direction: SwipeDirection;
  offsetX: number;
  offsetY: number;
  isSwiping: boolean;
}

export function useSwipe(options: UseSwipeOptions = {}) {
  const { threshold = 80, onSwipe } = options;
  const [state, setState] = useState<SwipeState>({
    direction: null,
    offsetX: 0,
    offsetY: 0,
    isSwiping: false,
  });
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const elementRef = useRef<HTMLDivElement>(null);

  const handleStart = useCallback((clientX: number, clientY: number) => {
    startRef.current = { x: clientX, y: clientY };
    setState(s => ({ ...s, isSwiping: true }));
  }, []);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    if (!startRef.current) return;
    const dx = clientX - startRef.current.x;
    const dy = clientY - startRef.current.y;

    let direction: SwipeDirection = null;
    if (Math.abs(dx) > Math.abs(dy)) {
      direction = dx > threshold ? 'right' : dx < -threshold ? 'left' : null;
    } else {
      direction = dy < -threshold ? 'up' : dy > threshold ? 'down' : null;
    }

    setState({ direction, offsetX: dx, offsetY: dy, isSwiping: true });
  }, [threshold]);

  const handleEnd = useCallback(() => {
    if (state.direction && onSwipe) {
      onSwipe(state.direction);
    }
    startRef.current = null;
    setState({ direction: null, offsetX: 0, offsetY: 0, isSwiping: false });
  }, [state.direction, onSwipe]);

  // Touch events
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    handleStart(e.touches[0].clientX, e.touches[0].clientY);
  }, [handleStart]);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    handleMove(e.touches[0].clientX, e.touches[0].clientY);
  }, [handleMove]);

  const onTouchEnd = useCallback(() => {
    handleEnd();
  }, [handleEnd]);

  // Mouse events
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    handleStart(e.clientX, e.clientY);
  }, [handleStart]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!startRef.current) return;
    handleMove(e.clientX, e.clientY);
  }, [handleMove]);

  const onMouseUp = useCallback(() => {
    handleEnd();
  }, [handleEnd]);

  // Keyboard events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowLeft':
          onSwipe?.('left');
          break;
        case 'ArrowRight':
          onSwipe?.('right');
          break;
        case 'ArrowUp':
          e.preventDefault();
          onSwipe?.('up');
          break;
        case 'ArrowDown':
          e.preventDefault();
          onSwipe?.('down');
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onSwipe]);

  return {
    ...state,
    ref: elementRef,
    handlers: {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onMouseDown,
      onMouseMove,
      onMouseUp,
    },
  };
}
