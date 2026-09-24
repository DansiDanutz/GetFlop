import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';
import { errorMessage } from '../i18n/i18n';

type Kind = 'info' | 'success' | 'error';
interface Toast { id: number; kind: Kind; text: string }

interface ToastApi {
  show(text: string, kind?: Kind): void;
  /** Shows the translated message for any thrown error. */
  error(err: unknown): void;
}

const ToastContext = createContext<ToastApi | null>(null);
const DURATION_MS = 3_500;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, kind: Kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), DURATION_MS);
  }, []);
  const error = useCallback((err: unknown) => {
    show(err instanceof ApiError ? errorMessage(err.code, err.params) : errorMessage('generic'), 'error');
  }, [show]);
  const value = useMemo(() => ({ show, error }), [show, error]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((x) => <div key={x.id} className={`toast ${x.kind}`}>{x.text}</div>)}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
