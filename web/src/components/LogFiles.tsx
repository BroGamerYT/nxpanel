import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileText, RefreshCw, Search } from 'lucide-react';
import { api, currentToken, refreshSession } from '../lib/api';
import { classify } from '../lib/loglevel';
import { formatMb } from '../lib/status';
import { t, fmtDateTime } from '../lib/i18n';
import { ErrorBox, Spinner } from './ui';

interface LogFile { path: string; name: string; bytes: number; modified: string }
interface LogContent { path: string; bytes: number; modified: string; lines: string[]; truncated: boolean }

function size(b: number) { return b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : formatMb(Math.round(b / 1048576)); }

/**
 * Logdateien des Spiels - die neueste ist vorausgewaehlt. Anders als die
 * Konsole zeigt das auch Laeufe von gestern oder vor dem Absturz.
 */
export function LogFiles({ serverId }: { serverId: string }) {
  // "Live": die neueste Datei wird laufend nachgeladen, und beginnt das Spiel
  // eine neue Logdatei (Neustart), springt die Ansicht von selbst dorthin.
  const [live, setLive] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const files = useQuery({ queryKey: ['logs', serverId], queryFn: () => api<{ files: LogFile[] }>(`/servers/${serverId}/logs`),
    refetchInterval: live && picked === null ? 10_000 : false });
  const [q, setQ] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const newest = files.data?.files[0]?.path ?? null;
  const current = picked ?? newest;
  const following = live && current === newest;
  const content = useQuery({
    queryKey: ['logfile', serverId, current],
    enabled: !!current,
    queryFn: () => api<LogContent>(`/servers/${serverId}/logs/file?path=${encodeURIComponent(current!)}&lines=3000`),
    refetchInterval: following ? 3_000 : false,
  });
  const pre = useRef<HTMLPreElement>(null);
  const atBottom = useRef(true);
  // Beim Mitlaufen unten bleiben - ausser man hat selbst hochgescrollt.
  useEffect(() => {
    const el = pre.current;
    if (el && following && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [content.data, following]);

  const shown = useMemo(() => (content.data?.lines ?? [])
    .map((text, i) => ({ text, i, level: classify(text) }))
    .filter((l) => (!onlyProblems || l.level !== 'info') && (!q || l.text.toLowerCase().includes(q.toLowerCase()))), [content.data, q, onlyProblems]);

  async function download() {
    if (!current) return;
    // Mit Anmeldung herunterladen: Token holen, Datei als Blob laden, speichern.
    await refreshSession();
    const r = await fetch(`/api/v1/servers/${serverId}/logs/file?path=${encodeURIComponent(current)}&download=1`, { headers: { Authorization: `Bearer ${currentToken()}` } });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = url; a.download = current.split('/').pop() ?? 'log.txt'; a.click();
    URL.revokeObjectURL(url);
  }

  if (files.isLoading) return <Spinner />;
  if (files.error) return <ErrorBox>{(files.error as Error).message}</ErrorBox>;
  if (!files.data?.files.length) return <p className="text-sm text-dim">{t('logs.none')}</p>;

  return (
    <div className="grid lg:grid-cols-[16rem_1fr] gap-3">
      <aside className="rounded-lg border border-seam bg-rack overflow-hidden self-start">
        <div className="flex items-center justify-between px-3 py-2 border-b border-seam">
          <h3 className="text-sm font-medium">{t('logs.files')}</h3>
          <button type="button" onClick={() => void files.refetch()} aria-label={t('logs.refresh')} className="text-dim hover:text-ink"><RefreshCw className="size-3.5" /></button>
        </div>
        <ol className="max-h-[60vh] overflow-auto divide-y divide-seam">
          {files.data.files.map((f, i) => (
            <li key={f.path}>
              <button type="button" onClick={() => setPicked(i === 0 ? null : f.path)} aria-current={current === f.path}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-rack-2 ${current === f.path ? 'bg-rack-2' : ''}`}>
                <span className="flex items-center gap-1.5 font-mono text-[12.5px] truncate"><FileText className="size-3.5 text-dim shrink-0" aria-hidden />{f.name}</span>
                <span className="block text-xs text-dim mt-0.5">
                  {fmtDateTime(f.modified, { dateStyle: 'short', timeStyle: 'short' })} · {size(f.bytes)}{i === 0 && <span className="text-led-run"> · {t('logs.newest')}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>

      <section className="rounded-lg border border-seam bg-[#0F141C] overflow-hidden min-w-0">
        <div className="flex flex-wrap items-center gap-2 border-b border-seam bg-rack px-3 py-2">
          <div className="relative flex-1 min-w-40">
            <Search className="size-3.5 text-dim absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('console.search')} placeholder={t('console.searchPlaceholder')}
              className="w-full h-7 rounded-md bg-rack-2 border border-seam pl-8 pr-2 text-xs text-ink placeholder:text-dim/70 focus:border-amber focus:outline-none" />
          </div>
          <label className="inline-flex items-center gap-1.5 text-xs text-dim">
            <input type="checkbox" className="accent-amber" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />{t('logs.onlyProblems')}
          </label>
          <button type="button" onClick={() => setLive(!live)} aria-pressed={following} title={t('logs.liveHint')}
            className={`h-7 px-2.5 rounded-md border text-xs inline-flex items-center gap-1.5 ${following ? 'border-led-run/60 text-led-run' : 'border-seam text-dim hover:text-ink'}`}>
            <span className={`size-1.5 rounded-full ${following ? 'bg-led-run led-busy' : 'bg-dim'}`} aria-hidden />{t('logs.live')}
          </button>
          <button type="button" onClick={() => void content.refetch()} className="h-7 px-2.5 rounded-md border border-seam text-xs text-dim hover:text-ink inline-flex items-center gap-1.5"><RefreshCw className="size-3.5" />{t('logs.reload')}</button>
          <button type="button" onClick={() => void download()} className="h-7 px-2.5 rounded-md border border-seam text-xs text-dim hover:text-ink inline-flex items-center gap-1.5"><Download className="size-3.5" />{t('logs.download')}</button>
        </div>
        {content.isLoading ? <div className="p-4"><Spinner /></div> : content.error ? <div className="p-3"><ErrorBox>{(content.error as Error).message}</ErrorBox></div> : (
          <>
            {content.data?.truncated && <p className="px-3 pt-2 text-xs text-dim">{t('logs.truncated', { count: content.data.lines.length })}</p>}
            <pre ref={pre} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
              className="h-[60vh] overflow-auto px-3 py-2 font-mono text-[12.5px] leading-[1.45] text-ink/90">
              {shown.map((l) => (
                <div key={l.i} className={l.level === 'error' ? 'text-[#FF6B6F]' : l.level === 'warn' ? 'text-[#F2C94C]' : ''}>{l.text}</div>
              ))}
              {shown.length === 0 && <span className="text-dim">{t('logs.noMatch')}</span>}
            </pre>
          </>
        )}
      </section>
    </div>
  );
}
