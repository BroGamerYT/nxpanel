import { useState } from 'react';
import { Eye, EyeOff, Copy, Check } from 'lucide-react';
import type { EggVariable } from '../lib/types';
import { Field, Input, Select } from './ui';
import { t, getLocale } from '../lib/i18n';
import { copyText } from '../lib/clipboard';

/** "FS_SOURCE=steam" - Feld nur zeigen, wenn die Bedingung erfuellt ist. */
export function visible(v: EggVariable, vals: Record<string, string>) {
  if (!v.requires) return true;
  const [k, want] = v.requires.split('=');
  return k ? (vals[k.trim()] ?? '') === (want ?? '').trim() : true;
}

export function VariableField({ v, value, error, onChange, disabled, secretSet }: { v: EggVariable; value: string; error?: string | undefined; onChange: (s: string) => void; disabled?: boolean; secretSet?: boolean }) {
  const id = `var-${v.env}`;
  const lang = getLocale();
  const label = (v.labelLocales && v.labelLocales[lang]) ? v.labelLocales[lang] : v.label;
  const hint = (v.descriptionLocales && v.descriptionLocales[lang]) ? v.descriptionLocales[lang] : v.description ?? undefined;
  const isBool = v.options?.length === 2 && v.options.every((o) => ['true', 'false', '1', '0'].includes(o.toLowerCase()));
  const isSecret = Boolean(v.secret || v.widget === 'password');
  const [showSecret, setShowSecret] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!value) return;
    await copyText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isBool) {
    const on = v.options!.find((o) => ['true', '1'].includes(o.toLowerCase()))!;
    const off = v.options!.find((o) => o !== on)!;
    return (
      <label className="flex items-start gap-3 text-sm">
        <input id={id} type="checkbox" disabled={disabled} className="mt-1 accent-amber size-4" checked={value === on} onChange={(e) => onChange(e.target.checked ? on : off)} />
        <span>
          <span className="block text-ink font-medium">{label}</span>
          {hint && <span className="block text-dim">{hint}</span>}
          {error && <span className="block text-led-crash">{error}</span>}
        </span>
      </label>
    );
  }

  return (
    <Field label={v.required ? label : t('field.optional', { label })} htmlFor={id} hint={hint} error={error}>
      {v.options ? (
        <Select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {!v.required && <option value="">–</option>}
          {v.options.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      ) : v.widget === 'textarea' ? (
        <textarea id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} rows={4}
          className="w-full rounded-md bg-rack-2 border border-seam px-3 py-2 text-ink focus:border-amber focus:outline-none" />
      ) : isSecret ? (
        <div className="relative flex items-center">
          <Input
            id={id}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            {...(secretSet && !value ? { placeholder: 'gesetzt – leer lassen zum Behalten' } : {})}
            type={showSecret ? 'text' : 'password'}
            autoComplete="new-password"
            className="pr-20 font-mono"
            required={v.required && !secretSet}
          />
          <div className="absolute right-1.5 flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSecret(!showSecret)}
              title={showSecret ? 'Passwort verbergen' : 'Passwort anzeigen'}
              className="p-1.5 text-dim hover:text-ink rounded transition-colors"
            >
              {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
            {value ? (
              <button
                type="button"
                onClick={handleCopy}
                title="Passwort kopieren"
                className="p-1.5 text-dim hover:text-ink rounded transition-colors"
              >
                {copied ? <Check className="size-4 text-led-up" /> : <Copy className="size-4" />}
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <Input
          id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
          {...(secretSet ? { placeholder: 'gesetzt – leer lassen zum Behalten' } : {})}
          type={v.type === 'number' ? 'number' : 'text'}
          autoComplete="off"
          {...(v.min !== undefined ? { min: v.min } : {})}
          {...(v.max !== undefined ? (v.type === 'number' ? { max: v.max } : { maxLength: v.max }) : {})}
          required={v.required && !secretSet}
        />
      )}
    </Field>
  );
}

