'use client';

import { useCallback } from 'react';
import { useToast } from '@/components/Toast';
import { openErrorReport } from '@/components/ErrorReportModal';

/**
 * Hook for triggering error toasts with a "Report this issue" action
 * that opens the user's email client with logs pre-filled.
 */
export function useErrorReport() {
  const { addToast } = useToast();

  const triggerError = useCallback((
    type: string,
    message: string,
    opts?: { productId?: string; taskId?: string; silent?: boolean }
  ) => {
    if (!opts?.silent) {
      addToast({
        type: 'error',
        title: formatErrorTitle(type),
        message: message.length > 120 ? message.slice(0, 120) + '...' : message,
        duration: 0,
        action: {
          label: 'Report this issue',
          onClick: () => openErrorReport({
            errorType: type,
            errorMessage: message,
            productId: opts?.productId,
            taskId: opts?.taskId,
          }),
        },
      });
    }
  }, [addToast]);

  return { triggerError };
}

function formatErrorTitle(type: string): string {
  const titles: Record<string, string> = {
    autopilot_pipeline: 'Autopilot pipeline failed',
    research_failed: 'Research cycle failed',
    ideation_failed: 'Ideation cycle failed',
    dispatch_failed: 'Task dispatch failed',
    planning_failed: 'Planning failed',
    build_failed: 'Build failed',
    agent_error: 'Agent error',
  };
  return titles[type] || 'Something went wrong';
}
