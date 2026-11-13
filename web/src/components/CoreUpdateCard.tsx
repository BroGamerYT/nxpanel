import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Button, ErrorBox } from './ui';
import type { ActiveTask } from '../lib/types';

interface UpdateStatus {
  current: string;
  platform: string;
  supported: boolean;
  reason: string | null;
  latest: { version: string; name: string; notes: string; publishedAt: string | null; url: string; asset: { size: number; sha256: string | null } | null } | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
  state: 'idle' | 'downloading' | 'installing' | 'failed';
  message: string | null;
}

/** Core-Update (nur Administratoren): neueste Version von GitHub, ein Klick laedt und installiert sie (Windows). */
export function CoreUpdateCard() {
  const qc = useQueryClient();
  // Nach dem Start des Installers ist der Core kurz weg: so lange immer wieder fragen, bis die neue Version antwortet
  const [target, setTarget] = useState<string | null>(null);

  const status = useQuery<UpdateStatus>({
    queryKey: ['core-update'],
    queryFn: () => api('/admin/core-update'),
    refetchInterval: target ? 3000 : false,
    retry: false,
    staleTime: 60_000,
  });
  const data = status.data;
  // Laufende Installationen, Backups usw.: ein Neustart des Cores unterbricht sie
  const active = useQuery<{ tasks: ActiveTask[] }>({ queryKey: ['tasks-active-update'], queryFn: () => api('/tasks/active'), refetchInterval: 10_000 });
  const running = active.data?.tasks ?? [];

  useEffect(() => {
    if (target && data?.current === target) window.location.reload();
  }, [target, data?.current]);

  const refresh = useMutation({
    mutationFn: () => api<UpdateStatus>('/admin/core-update?refresh=1'),
    onSuccess: (d) => qc.setQueryData(['core-update'], d),
  });
  const install = useMutation({
    mutationFn: () => api<{ version: string }>('/admin/core-update/install', { method: 'POST' }),
    onSuccess: (r) => setTarget(r.version),
  });

  if (status.isLoading) return null;
  if (!data) return null;

  const mb = data.latest?.asset?.size ? ` (${(data.latest.asset.size / (1024 * 1024)).toFixed(0)} MB)` : '';
  const err = install.error ? (install.error instanceof ApiError ? install.error.message : (install.error as Error).message) : null;

  return (
    <section className="bg-rack border border-seam rounded-xl p-5 space-y-3" aria-label="Core-Update">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink flex items-center gap-2">
            <Download className="size-4 text-amber" aria-hidden />
            Core-Update
          </h2>
          <p className="text-sm text-dim mt-1">
            Läuft: <span className="font-mono text-ink">{data.current}</span>
            {data.latest && <> · Neueste auf GitHub: <span className="font-mono text-ink">{data.latest.version}</span></>}
            {data.latest && !data.updateAvailable && <span className="text-led-run"> · aktuell</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => refresh.mutate()} busy={refresh.isPending} disabled={!!target}>
            <RefreshCw className="size-4" aria-hidden /> Prüfen
          </Button>
          {data.updateAvailable && data.supported && (
            <Button
              variant="primary"
              busy={install.isPending || !!target}
              disabled={!!target}
              onClick={() => {
                const busy = running.length ? `\n\nAchtung, es läuft gerade:\n${running.map((t) => `• ${t.title} (${t.serverName}${t.progressPercent != null ? `, ${Math.round(t.progressPercent)} %` : ''})`).join('\n')}\nDas wird durch den Neustart abgebrochen.` : '';
                if (window.confirm(`Version ${data.latest!.version} installieren?\n\nDer Core startet dabei neu, laufende Spiele werden kurz beendet. Das dauert einige Minuten.${busy}`)) install.mutate();
              }}
            >
              Jetzt aktualisieren{mb}
            </Button>
          )}
        </div>
      </div>

      {running.length > 0 && !target && (
        <p className="text-sm text-amber">
          Es läuft gerade: {running.map((t) => `${t.title} (${t.serverName})`).join(', ')} – ein Update würde das abbrechen. Besser erst fertig werden lassen.
        </p>
      )}
      {target && <p className="text-sm text-amber">Version {target} wird installiert – der Core startet neu, diese Seite lädt danach von selbst.</p>}
      {data.updateAvailable && !data.supported && data.reason && <p className="text-sm text-dim">{data.reason}</p>}
      {data.updateAvailable && data.latest?.notes && (
        <details className="text-sm text-dim">
          <summary className="cursor-pointer text-ink">Was ist neu in {data.latest.version}</summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-xs leading-relaxed">{data.latest.notes}</pre>
        </details>
      )}
      {!data.latest && !data.error && <p className="text-sm text-dim">Auf GitHub gibt es noch kein Core-Release.</p>}
      {data.error && <p className="text-xs text-dim">GitHub nicht erreichbar: {data.error}</p>}
      {data.state === 'failed' && data.message && <ErrorBox>{data.message}</ErrorBox>}
      {err && <ErrorBox>{err}</ErrorBox>}
    </section>
  );
}
