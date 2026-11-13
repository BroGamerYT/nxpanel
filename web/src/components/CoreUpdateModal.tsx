import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Circle, Loader2, X } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox } from './ui';
import type { ActiveTask } from '../lib/types';

export interface UpdateProgress {
  phase: 'check' | 'download' | 'verify' | 'backup' | 'install';
  percent: number | null;
  bytes: number;
  total: number;
  startedAt: string;
  installStartedAt: string | null;
  version: string | null;
}

export interface UpdateStatusLike {
  current: string;
  state: 'idle' | 'downloading' | 'installing' | 'failed';
  message: string | null;
  progress: UpdateProgress | null;
}

type Source = 'update' | 'installer' | 'core' | 'audit';
const SOURCES: { id: Source; label: string }[] = [
  { id: 'update', label: 'Update' },
  { id: 'installer', label: 'Installer' },
  { id: 'core', label: 'Core' },
  { id: 'audit', label: 'Audit' },
];
const PHASES: { id: UpdateProgress['phase'] | 'restart'; label: string }[] = [
  { id: 'check', label: 'Version prüfen' },
  { id: 'download', label: 'Installer laden' },
  { id: 'verify', label: 'Prüfsumme prüfen' },
  { id: 'backup', label: 'Core sichern' },
  { id: 'install', label: 'Installieren (Core ist kurz weg)' },
  { id: 'restart', label: 'Neue Version startet' },
];

const fmtMb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const fmtSec = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/**
 * Fenster fuer das Core-Update: erst Bestaetigung (mit laufenden Aufgaben), dann Schritte, Fortschritt und Protokolle.
 * Der Core ist waehrend der Installation kurz weg - dann zeigt das Fenster die Wartezeit und fragt weiter, bis die neue Version antwortet.
 */
export function CoreUpdateModal({
  version,
  sizeMb,
  running,
  data,
  started,
  starting,
  error,
  coreDown,
  onStart,
  onClose,
}: {
  version: string;
  sizeMb: string;
  running: ActiveTask[];
  data: UpdateStatusLike | undefined;
  started: boolean;
  starting: boolean;
  error: string | null;
  coreDown: boolean;
  onStart: () => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<Source>('update');
  const [now, setNow] = useState(Date.now());
  const [installSince, setInstallSince] = useState<number | null>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const p = data?.progress ?? null;
  const installing = data?.state === 'installing' || (started && coreDown);
  useEffect(() => {
    if (installing && installSince == null) setInstallSince(p?.installStartedAt ? Date.parse(p.installStartedAt) : Date.now());
  }, [installing, installSince, p?.installStartedAt]);

  const logs = useQuery<{ lines: string[] }>({
    queryKey: ['core-update-logs', source],
    queryFn: () => api(`/admin/core-update/logs?source=${source}&lines=200`),
    enabled: started && !coreDown,
    refetchInterval: started ? 3000 : false,
    retry: false,
  });

  const current = installing ? (installSince && now - installSince > 20_000 ? 'restart' : 'install') : p?.phase ?? null;
  const idx = PHASES.findIndex((x) => x.id === current);
  const failed = data?.state === 'failed';
  const percent = p?.phase === 'download' && p.percent != null ? p.percent : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal aria-label="Core-Update">
      <div className="bg-rack border border-seam rounded-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-seam">
          <h2 className="text-base font-semibold text-ink">Core-Update auf {version}</h2>
          <button type="button" aria-label="Schließen" onClick={onClose} className="text-dim hover:text-ink" disabled={started && !failed && !coreDown && data?.state !== 'idle'}>
            <X className="size-4" />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          {!started ? (
            <>
              <p className="text-sm text-dim">
                Der Core lädt Version <span className="font-mono text-ink">{version}</span>{sizeMb}, prüft sie, sichert sich selbst und installiert sie still.
                Dabei startet der Core neu; laufende Spiele werden kurz beendet. Das dauert einige Minuten.
              </p>
              {running.length > 0 && (
                <div className="text-sm text-amber">
                  Achtung, es läuft gerade:
                  <ul className="list-disc ml-5">
                    {running.map((t) => (
                      <li key={t.id}>{t.title} ({t.serverName}{t.progressPercent != null ? `, ${Math.round(t.progressPercent)} %` : ''})</li>
                    ))}
                  </ul>
                  Das wird durch den Neustart abgebrochen.
                </div>
              )}
              {error && <ErrorBox>{error}</ErrorBox>}
              <div className="flex justify-end gap-2">
                <Button onClick={onClose}>Abbrechen</Button>
                <Button variant="primary" busy={starting} onClick={onStart}>Jetzt installieren</Button>
              </div>
            </>
          ) : (
            <>
              <ol className="space-y-1.5 text-sm">
                {PHASES.map((ph, i) => {
                  const done = idx > i;
                  const active = idx === i && !failed;
                  return (
                    <li key={ph.id} className={`flex items-center gap-2 ${done ? 'text-led-run' : active ? 'text-ink' : 'text-dim'}`}>
                      {done ? <Check className="size-4" aria-hidden /> : active ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Circle className="size-4" aria-hidden />}
                      {ph.label}
                      {active && ph.id === 'download' && p && <span className="font-mono text-xs text-dim">{fmtMb(p.bytes)}{p.total ? ` / ${fmtMb(p.total)}` : ''}</span>}
                      {active && (ph.id === 'install' || ph.id === 'restart') && installSince && <span className="font-mono text-xs text-dim">{fmtSec(Math.max(0, Math.round((now - installSince) / 1000)))}</span>}
                    </li>
                  );
                })}
              </ol>

              {percent != null && (
                <div className="h-2 rounded bg-seam overflow-hidden" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                  <div className="h-full bg-amber transition-all" style={{ width: `${percent}%` }} />
                </div>
              )}
              {installing && (
                <p className="text-sm text-amber">
                  {coreDown
                    ? 'Der Core ist gerade weg, der Installer arbeitet. Diese Seite fragt weiter und lädt sich selbst neu, sobald die neue Version antwortet.'
                    : 'Der Installer läuft. Gleich ist der Core kurz nicht erreichbar.'}
                </p>
              )}
              {failed && data?.message && <ErrorBox>{data.message}</ErrorBox>}
              {error && <ErrorBox>{error}</ErrorBox>}

              <div>
                <div className="flex gap-1 mb-2" role="tablist">
                  {SOURCES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="tab"
                      aria-selected={source === s.id}
                      onClick={() => setSource(s.id)}
                      className={`px-3 py-1 rounded text-xs ${source === s.id ? 'bg-amber text-black' : 'bg-seam text-dim hover:text-ink'}`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <pre className="h-56 overflow-auto bg-black/40 rounded p-2 text-[11px] leading-snug font-mono text-dim whitespace-pre-wrap break-all">
                  {coreDown
                    ? 'Core nicht erreichbar - Protokolle kommen wieder, sobald er läuft.'
                    : logs.data?.lines.length
                      ? logs.data.lines.join('\n')
                      : logs.isLoading ? 'Lade …' : 'Noch keine Einträge.'}
                </pre>
              </div>
              {(failed || data?.state === 'idle') && <div className="flex justify-end"><Button onClick={onClose}>Schließen</Button></div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
