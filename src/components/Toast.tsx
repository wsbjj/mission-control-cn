'use client';

import { useEffect, useState, useCallback, createContext, useContext, type ReactNode } from 'react';
import { AlertCircle, CheckCircle, Info, X, MessageSquareWarning } from 'lucide-react';

export type ToastType = 'error' | 'success' | 'info' | 'warning';

interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

interface ToastContextType {
  addToast: (toast: Omit<Toast, 'id'>) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

// Global reference so non-React code (like SSE handlers) can trigger toasts
let globalAddToast: ToastContextType['addToast'] | null = null;
export function showToast(toast: Omit<Toast, 'id'>) {
  if (globalAddToast) globalAddToast(toast);
}

const ICONS = {
  error: AlertCircle,
  success: CheckCircle,
  info: Info,
  warning: MessageSquareWarning,
};

const COLORS = {
  error: 'border-red-500/40 bg-red-500/10 text-red-300',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-300',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
};

const ICON_COLORS = {
  error: 'text-red-400',
  success: 'text-emerald-400',
  info: 'text-blue-400',
  warning: 'text-amber-400',
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const Icon = ICONS[toast.type];

  useEffect(() => {
    if (toast.duration !== 0) {
      const timer = setTimeout(onDismiss, toast.duration || (toast.type === 'error' ? 15000 : 5000));
      return () => clearTimeout(timer);
    }
  }, [toast.duration, toast.type, onDismiss]);

  return (
    <div className={`flex items-start gap-3 p-4 rounded-lg border backdrop-blur-sm shadow-lg max-w-md animate-slide-in ${COLORS[toast.type]}`}>
      <Icon size={18} className={`mt-0.5 shrink-0 ${ICON_COLORS[toast.type]}`} />
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">{toast.title}</p>
        {toast.message && <p className="text-xs mt-1 opacity-80 break-words">{toast.message}</p>}
        {toast.action && (
          <button
            onClick={toast.action.onClick}
            className="text-xs mt-2 underline underline-offset-2 hover:opacity-80 transition-opacity font-medium"
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button onClick={onDismiss} className="shrink-0 opacity-50 hover:opacity-100 transition-opacity">
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts(prev => [...prev, { ...toast, id }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Register global reference
  useEffect(() => {
    globalAddToast = addToast;
    return () => { globalAddToast = null; };
  }, [addToast]);

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      {/* Toast container — fixed bottom-right */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
