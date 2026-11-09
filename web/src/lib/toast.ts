import { useCallback, useState } from 'react';

export type ToastType = 'success' | 'error' | 'warn' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

let nextId = 0;

/**
 * Einfaches Toast-System. Rufe `useToast()` in einer Komponente auf,
 * die oben im Baum sitzt (z. B. in `main.tsx` oder `ServerPage.tsx`),
 * und rendere `<Toaster />` an zentraler Stelle.
 */
export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback((type: ToastType, title: string, message?: string, duration = 4000) => {
    const id = String(++nextId);
    setToasts((prev) => [...prev, { id, type, title, message, duration }]);
    if (duration > 0) {
      setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), duration);
    }
    return id;
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const success = useCallback((title: string, message?: string, duration?: number) =>
    show('success', title, message, duration), [show]);
  const error = useCallback((title: string, message?: string, duration?: number) =>
    show('error', title, message, duration), [show]);
  const warn = useCallback((title: string, message?: string, duration?: number) =>
    show('warn', title, message, duration), [show]);
  const info = useCallback((title: string, message?: string, duration?: number) =>
    show('info', title, message, duration), [show]);

  return { toasts, show, dismiss, success, error, warn, info };
}

export const TOAST_TYPE_LABEL: Record<ToastType, string> = {
  success: 'Erfolg',
  error: 'Fehler',
  warn: 'Warnung',
  info: 'Information',
};
