import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderTree, HardDrive, ChevronRight, AlertTriangle, Folder, ChevronLeft } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { FileManager } from '../components/FileManager';
import { Button, ErrorBox, Spinner } from '../components/ui';

interface Root { id: string; label: string; path: string; available: boolean; readOnly?: boolean }
interface Usage { path: string; entries: { name: string; path: string; bytes: number; label?: string; orphan?: boolean }[]; partial: boolean }

const ALL = ['file.read', 'file.write', 'file.delete', 'file.archive'];
const READ_ONLY = ['file.read'];

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/**
 * Admin-Dateimanager: alle Ordner des Panels auf der VM (Spieldaten aller
 * Server, Backups, NAS) - wie der Instanz-Ordner bei AMP. Nur fuer Admins.
 */
export function AdminFiles() {
  const roots = useQuery({ queryKey: ['adminFileRoots'], queryFn: () => api<{ roots: Root[] }>('/admin/files') });
  const [rootId, setRootId] = useState<string | null>(null);
  const list = roots.data?.roots ?? [];
  const active = list.find((r) => r.id === rootId) ?? list.find((r) => r.available);

  return (
    <div className="space-y-5">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-dim hover:text-amber transition-colors"
      >
        <ChevronLeft className="size-4" />
        Zurück zum Admin-Hub
      </Link>

      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><FolderTree className="size-6 text-amber" aria-hidden />{t('adminFiles.title')}</h1>
        <p className="text-dim text-sm mt-1">{t('adminFiles.intro')}</p>
        <p className="text-dim text-sm mt-1">{t('adminFiles.serversHint')}</p>
      </div>

      {roots.isLoading && <Spinner />}
      {roots.error && <ErrorBox>{(roots.error as Error).message}</ErrorBox>}

      {list.length > 0 && (
        <div className="flex flex-wrap gap-2" role="tablist">
          {list.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={active?.id === r.id}
              disabled={!r.available}
              onClick={() => setRootId(r.id)}
              title={r.available ? r.path : t('adminFiles.notMounted', { path: r.path })}
              className={`rounded-md border px-3 py-2 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active?.id === r.id ? 'border-amber bg-amber/10 text-ink' : 'border-seam bg-rack/40 text-dim hover:text-ink'}`}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {r.label}
                {r.readOnly && <span className="rounded bg-rack px-1.5 py-0.5 text-[10px] font-mono text-dim border border-seam">{t('adminFiles.readOnly')}</span>}
              </span>
              <span className="block font-mono text-[11px] opacity-70">{r.path}</span>
            </button>
          ))}
        </div>
      )}

      {active && (
        <>
          <div className="flex items-start gap-2 rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-sm">
            <AlertTriangle className="size-4 text-amber shrink-0 mt-0.5" aria-hidden />
            <span>{active.readOnly ? t('adminFiles.readOnlyHint') : t('adminFiles.warning')}</span>
          </div>
          <UsagePanel key={`u-${active.id}`} root={active} />
          <FileManager key={active.id} serverId={`admin:${active.id}`} apiBase={`/admin/files/${active.id}`} permissions={active.readOnly ? READ_ONLY : ALL} />
        </>
      )}
    </div>
  );
}

/** Welche Ordner wie gross sind (wie "du"), zum Aufraeumen voller Platten. */
function UsagePanel({ root }: { root: Root }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const usage = useQuery({
    queryKey: ['adminFileUsage', root.id, path],
    queryFn: () => api<Usage>(`/admin/files/${root.id}/usage?path=${encodeURIComponent(path)}`),
    enabled: open,
    staleTime: 60_000,
  });
  const parts = path ? path.split('/') : [];
  const max = usage.data?.entries[0]?.bytes ?? 1;
  const total = usage.data?.entries.reduce((s, e) => s + e.bytes, 0) ?? 0;

  if (!open) {
    return (
      <Button type="button" variant="quiet" onClick={() => setOpen(true)}>
        <HardDrive className="size-4" aria-hidden />{t('adminFiles.showUsage')}
      </Button>
    );
  }
  return (
    <section className="rounded-lg border border-seam bg-rack/40 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium flex items-center gap-2"><HardDrive className="size-4 text-amber" aria-hidden />{t('adminFiles.usageTitle')}</h2>
        <Button type="button" variant="quiet" className="text-xs" onClick={() => setOpen(false)}>{t('adminFiles.hideUsage')}</Button>
      </div>
      <nav className="flex flex-wrap items-center gap-1 text-xs font-mono" aria-label="Pfad">
        <button className="text-amber hover:underline" onClick={() => setPath('')}>{root.label}</button>
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="size-3 text-dim" aria-hidden />
            <button className="text-amber hover:underline" onClick={() => setPath(parts.slice(0, i + 1).join('/'))}>{p}</button>
          </span>
        ))}
      </nav>
      {usage.isFetching && <Spinner label={t('adminFiles.measuring')} />}
      {usage.error && <ErrorBox>{(usage.error as Error).message}</ErrorBox>}
      {usage.data && !usage.isFetching && (
        <>
          <p className="text-xs text-dim">{t('adminFiles.usageTotal', { size: fmtBytes(total) })}{usage.data.partial ? ` · ${t('adminFiles.partial')}` : ''}</p>
          {usage.data.entries.length === 0 && <p className="text-sm text-dim">{t('adminFiles.noFolders')}</p>}
          <ul className="space-y-1">
            {usage.data.entries.slice(0, 30).map((e) => (
              <li key={e.path}>
                <button onClick={() => setPath(e.path)} className="w-full text-left group">
                  <div className="flex items-center justify-between text-sm gap-3">
                    <span className="flex items-center gap-1.5 truncate group-hover:text-amber"><Folder className="size-3.5 text-dim" aria-hidden />{e.name}{e.label && <span className={`text-xs ${e.orphan ? 'text-dim italic' : 'text-amber/90'}`}>{e.label}</span>}</span>
                    <span className="font-mono text-xs tabular-nums">{fmtBytes(e.bytes)}</span>
                  </div>
                  <div className="h-1.5 rounded bg-rack-2 mt-1 overflow-hidden">
                    <div className="h-full bg-amber/70" style={{ width: `${Math.max(1, (e.bytes / max) * 100)}%` }} />
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
