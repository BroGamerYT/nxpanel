import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DatabaseBackup, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Button, ErrorBox } from './ui';

interface CoreBackup { id: string; createdAt: string; reason: string; version: string; sizeBytes: number }
interface BackupList { backups: CoreBackup[]; pendingRestore: boolean }
interface Check { name: string; ok: boolean; detail: string; fix?: string }
interface CheckResult { ok: boolean; checks: Check[] }

const when = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const message = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);

/**
 * Core-Sicherung und Reparatur (nur Administratoren): sichert Datenbank, Benutzerkonten und Schluessel des Cores
 * (vor jedem Update automatisch), prueft den Zustand und spielt eine Sicherung zurueck.
 */
export function CoreBackupCard() {
  const qc = useQueryClient();
  const [restoring, setRestoring] = useState(false);
  const list = useQuery<BackupList>({ queryKey: ['core-backups'], queryFn: () => api('/admin/core-backups'), staleTime: 30_000 });
  const reload = () => qc.invalidateQueries({ queryKey: ['core-backups'] });

  const create = useMutation({ mutationFn: () => api('/admin/core-backups', { method: 'POST', body: {} }), onSuccess: reload });
  const remove = useMutation({ mutationFn: (id: string) => api(`/admin/core-backups/${id}`, { method: 'DELETE' }), onSuccess: reload });
  const check = useMutation({ mutationFn: () => api<CheckResult>('/admin/core-check') });
  const restore = useMutation({
    mutationFn: (id: string) => api('/admin/core-backups/' + id + '/restore', { method: 'POST' }),
    onSuccess: () => {
      setRestoring(true);
      // Der Core startet neu: warten, bis er wieder antwortet, dann die Seite neu laden
      const timer = setInterval(() => {
        fetch('/api/v1/about').then((r) => { if (r.ok) { clearInterval(timer); window.location.reload(); } }).catch(() => undefined);
      }, 3000);
    },
  });

  const backups = list.data?.backups ?? [];
  const error = create.error ?? remove.error ?? restore.error ?? list.error;

  return (
    <section className="bg-rack border border-seam rounded-xl p-5 space-y-4" aria-label="Core-Sicherung">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-ink flex items-center gap-2">
            <DatabaseBackup className="size-4 text-amber" aria-hidden />
            Core-Sicherung &amp; Reparatur
          </h2>
          <p className="text-sm text-dim mt-1">
            Sichert Server-Liste, Einstellungen, Benutzer und Schlüssel des Cores (nicht die Spieldaten – die haben eigene Backups). Vor jedem Update passiert das automatisch.
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => check.mutate()} busy={check.isPending}>
            <ShieldCheck className="size-4" aria-hidden /> Prüfen
          </Button>
          <Button variant="primary" onClick={() => create.mutate()} busy={create.isPending} disabled={restoring}>Jetzt sichern</Button>
        </div>
      </div>

      {restoring && <p className="text-sm text-amber">Sicherung wird eingespielt – der Core startet neu, diese Seite lädt danach von selbst.</p>}
      {list.data?.pendingRestore && !restoring && <p className="text-sm text-amber">Eine Wiederherstellung ist vorgemerkt und wird beim nächsten Start des Cores eingespielt.</p>}

      {check.data && (
        <ul className="rounded-lg border border-seam divide-y divide-seam text-sm">
          {check.data.checks.map((c) => (
            <li key={c.name} className="px-4 py-2.5 flex gap-3">
              <span className={c.ok ? 'text-led-run' : 'text-led-crash'} aria-label={c.ok ? 'in Ordnung' : 'Problem'}>{c.ok ? '✓' : '✗'}</span>
              <div>
                <div className="text-ink">{c.name}</div>
                <div className="text-xs text-dim break-all">{c.detail}</div>
                {!c.ok && c.fix && <div className="text-xs text-amber mt-0.5">So beheben: {c.fix}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {backups.length === 0 ? (
        <p className="text-sm text-dim">Es gibt noch keine Sicherung.</p>
      ) : (
        <ul className="rounded-lg border border-seam divide-y divide-seam text-sm">
          {backups.map((b) => (
            <li key={b.id} className="px-4 py-2.5 flex flex-wrap items-center gap-3">
              <div className="flex-1 min-w-48">
                <div className="text-ink">{when(b.createdAt)} <span className="text-dim">· {b.reason}</span></div>
                <div className="text-xs text-dim">Core {b.version} · {kb(b.sizeBytes)}</div>
              </div>
              <Button
                disabled={restoring || restore.isPending}
                onClick={() => {
                  if (window.confirm(`Sicherung vom ${when(b.createdAt)} zurückspielen?\n\nDer jetzige Stand wird vorher selbst gesichert. Der Core startet neu, laufende Spiele werden kurz beendet.`)) restore.mutate(b.id);
                }}
              >
                Wiederherstellen
              </Button>
              <Button disabled={restoring} onClick={() => { if (window.confirm('Diese Sicherung löschen?')) remove.mutate(b.id); }}>Löschen</Button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-dim">
        Wenn der Core gar nicht mehr startet: Dienst beenden, dann in der Eingabeaufforderung <span className="font-mono">nexuscore.exe backups</span> und <span className="font-mono">nexuscore.exe restore latest</span>.
        Fehlen Programmdateien: den Installer erneut starten und „Reparieren“ wählen.
      </p>
      {error && <ErrorBox>{message(error)}</ErrorBox>}
    </section>
  );
}
