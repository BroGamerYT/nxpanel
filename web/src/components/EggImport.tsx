import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileUp } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, ErrorBox } from './ui';

/**
 * Admin: Spielvorlage (Egg) als JSON einspielen - eigenes Format oder
 * Pterodactyl/Pelican (z. B. von github.com/pelican-eggs). Der Import passt
 * Zusatzports, Startmuster, Konfigurationsdateien und Benutzer selbst an.
 */
export function EggImport() {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ name: string; warnings: string[] } | null>(null);
  const imp = useMutation({
    mutationFn: async (file: File) => {
      let body: unknown;
      try { body = JSON.parse(await file.text()); } catch { throw new Error(t('eggImport.notJson')); }
      return api<{ name: string; warnings: string[] }>('/admin/eggs', { method: 'POST', body });
    },
    onSuccess: (r) => { setResult(r); void qc.invalidateQueries({ queryKey: ['eggs'] }); },
  });
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Button type="button" busy={imp.isPending} onClick={() => { setResult(null); imp.reset(); ref.current?.click(); }}>
          <FileUp className="size-4" aria-hidden />{t('eggImport.button')}
        </Button>
        <span className="text-dim">{t('eggImport.hint')}</span>
        <input ref={ref} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) imp.mutate(f); e.target.value = ''; }} />
      </div>
      {result && (
        <div className="rounded-md border border-led-run/40 bg-led-run/10 px-3 py-2 text-sm">
          <p>{t('eggImport.done', { name: result.name })}</p>
          {result.warnings.length > 0 && <ul className="list-disc pl-5 text-dim text-xs mt-1">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        </div>
      )}
      {imp.error && <ErrorBox>{(imp.error as Error).message}</ErrorBox>}
    </div>
  );
}
