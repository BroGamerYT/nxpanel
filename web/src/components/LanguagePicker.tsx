import { Languages } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { LANGUAGES, chooseBeforeLogin, getLocale, setLocale, t } from '../lib/i18n';

/** Sprachauswahl. Angemeldet wird die Wahl am Konto gespeichert und gilt auf jedem Geraet. */
export function LanguagePicker({ className = '' }: { className?: string }) {
  const { me } = useAuth();
  if (LANGUAGES.length < 2) return null;
  return (
    <label className={`inline-flex items-center gap-1.5 text-xs text-dim hover:text-ink ${className}`}>
      <Languages className="size-3.5" aria-hidden />
      <span className="sr-only">{t('language.label')}</span>
      <select
        value={getLocale()}
        onChange={(e) => {
          const code = e.target.value;
          if (me) {
            setLocale(code);
            void api('/auth/me', { method: 'PATCH', body: { locale: code } }).catch(() => {});
          } else chooseBeforeLogin(code);
        }}
        className="bg-transparent text-xs focus:outline-none cursor-pointer"
      >
        {LANGUAGES.map((l) => <option key={l.code} value={l.code} className="bg-rack text-ink">{l.name}</option>)}
      </select>
    </label>
  );
}
