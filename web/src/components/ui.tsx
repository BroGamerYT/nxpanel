import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { STATUS } from '../lib/status';
import { t } from '../lib/i18n';
import type { ServerStatus } from './../lib/types';
import { CheckCircle2, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import type { Toast, ToastType } from '../lib/toast';

type Variant = 'primary' | 'quiet' | 'danger';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }>(
  function Button({ variant = 'quiet', busy, className = '', children, disabled, ...rest }, ref) {
    const look: Record<Variant, string> = {
      primary: 'bg-amber text-amber-ink hover:brightness-110 font-semibold',
      quiet: 'bg-rack-2 text-ink hover:bg-seam border border-seam',
      danger: 'bg-transparent text-led-crash border border-led-crash/50 hover:bg-led-crash/10',
    };
    return (
      <button
        ref={ref}
        disabled={disabled || busy}
        className={`inline-flex items-center justify-center gap-2 rounded-md px-3.5 h-9 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${look[variant]} ${className}`}
        {...rest}
      >
        {busy && <span className="size-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />}
        {children}
      </button>
    );
  },
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={`w-full h-10 rounded-md bg-rack-2 border border-seam px-3 text-ink placeholder:text-dim/70 focus:border-amber focus:outline-none disabled:opacity-55 disabled:cursor-not-allowed ${className}`}
      {...rest}
    />
  );
});

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`${/\bw-/.test(className) ? '' : 'w-full'} h-10 rounded-md bg-rack-2 border border-seam px-3 text-ink focus:border-amber focus:outline-none disabled:opacity-55 disabled:cursor-not-allowed ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string | undefined; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">{label}</label>
      {children}
      {error ? <p className="text-sm text-led-crash">{error}</p> : hint ? <p className="text-sm text-dim">{hint}</p> : null}
    </div>
  );
}

export function Led({ status, className = '' }: { status: ServerStatus; className?: string }) {
  const s = STATUS[status];
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${s.led} ${s.busy ? 'led-busy' : ''} ${className}`} />;
}

export function StatusLabel({ status }: { status: ServerStatus }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Led status={status} />
      <span>{STATUS[status].label}</span>
    </span>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-md border border-led-crash/40 bg-led-crash/10 px-3 py-2 text-sm text-ink">{children}</div>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-dim text-sm" role="status">
      <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />
      {label ?? t('common.loading')}
    </div>
  );
}

const TOAST_ICON: Record<ToastType, typeof Info> = {
  success: CheckCircle2,
  error: AlertCircle,
  warn: AlertTriangle,
  info: Info,
};

const TOAST_COLOR: Record<ToastType, string> = {
  success: 'text-led-run border-led-run/50 bg-led-run/10',
  error: 'text-led-crash border-led-crash/50 bg-led-crash/10',
  warn: 'text-led-start border-led-start/50 bg-led-start/10',
  info: 'text-sky-400 border-sky-400/50 bg-sky-400/10',
};

export function Toast({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const Icon = TOAST_ICON[toast.type];
  return (
    <div
      className={`flex items-start gap-3 rounded-md border p-3 text-sm ${TOAST_COLOR[toast.type]} animate-in slide-in-from-top duration-200`}
      role="alert"
      aria-live="polite"
    >
      <Icon className="size-4 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-ink">{toast.title}</div>
        {toast.message && <div className="text-dim text-xs mt-0.5">{toast.message}</div>}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="p-1 text-dim/60 hover:text-ink rounded transition-colors"
        aria-label="Benachrichtigung schließen"
      >
        <span className="sr-only">Schließen</span>
        <span className="size-3.5">✕</span>
      </button>
    </div>
  );
}

export function Toaster({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: string) => void }) {
  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto w-full max-w-xs">
          <Toast toast={t} onDismiss={onDismiss} />
        </div>
      ))}
    </div>
  );
}
