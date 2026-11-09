import { useSyncExternalStore } from 'react';

export type ToastType = 'success' | 'error' | 'warn' | 'info';

export interface Toast {
  id: number;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

/**
 * Globales Toast-System.
 *
 * Der Zustand lebt auf Modulebene (ein einziger Store), damit jede
 * Komponente – egal wo im Baum – Meldungen auslösen kann und der
 * zentrale `<Toaster />` sie anzeigt. `useToasts()` abonniert den Store
 * über `useSyncExternalStore`; `toast.*` löst Meldungen von überall aus.
 */
let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function add(type: ToastType, title: string, message?: string, duration = 4000): number {
  const id = ++nextId;
  toasts = [...toasts, { id, type, title, message, duration }];
  emit();
  if (duration > 0) {
    setTimeout(() => dismiss(id), duration);
  }
  return id;
}

export function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function getSnapshot(): Toast[] {
  return toasts;
}

/** Abonniert den globalen Toast-Store (für `<Toaster />`). */
export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Meldungen von überall auslösen – ohne Hook, ohne Provider. */
export const toast = {
  success: (title: string, message?: string, duration = 4000) => add('success', title, message, duration),
  error: (title: string, message?: string, duration = 6000) => add('error', title, message, duration),
  warn: (title: string, message?: string, duration = 5000) => add('warn', title, message, duration),
  info: (title: string, message?: string, duration = 4000) => add('info', title, message, duration),
};
