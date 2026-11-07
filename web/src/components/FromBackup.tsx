import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileArchive, HelpCircle, Upload } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { uploadFile } from '../lib/upload';
import { formatMb } from '../lib/status';
import type { EggDetail } from '../lib/types';
import { Button, ErrorBox, Field, Select, Spinner } from './ui';
import { t, tn } from '../lib/i18n';

interface DetectedVar { env: string; value: string; source: string; options?: string[] }
interface Candidate { eggId: string; name: string; score: number; markers: string[]; matched: string[]; variables: DetectedVar[]; warnings: string[]; importBytes: number }
interface Analysis { file: string; bytes: number; entries: number; totalBytes: number; candidates: Candidate[]; confident: boolean }

/** Was der Erstellungsdialog aus dem Backup mitnimmt. */
export interface BackupPreset {
  eggId: string;
  file: string;
  /** Anzeigename der Datei, ohne den Upload-Vorsatz. */
  label: string;
  values: Record<string, string>;
  /** Variablen, deren Wert aus dem Backup stammt (fuer den Hinweis am Feld). */
  sources: Record<string, string>;
  minDiskGb: number;
  warnings: string[];
}

/** Herkunft eines erkannten Wertes: Datei, oder ein Code mit @ aus der Erkennung. */
export function sourceLabel(s: string) {
  return s.startsWith('@') ? t(`backup.source.${s.slice(1)}`) : s;
}

export function displayName(file: string) {
  return file.replace(/^upload-u[0-9a-f]{8}-\d+-/, '');
}

const GB = 1024 ** 3;

/**
 * Backup hochladen oder aus dem Import-Ordner waehlen, dann erkennt das
 * Panel Spiel und Einstellungen. Ist es sich nicht sicher, fragt es per
 * Auswahlliste nach statt zu raten.
 */
export function FromBackup({ onReady }: { onReady: (p: BackupPreset) => void }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const folder = useQuery({ queryKey: ['imports'], queryFn: () => api<{ folder: string | null; files: Array<{ name: string; bytes: number; modified: string }> }>('/imports') });

  const analyze = useMutation({
    mutationFn: (file: string) => api<Analysis>('/imports/analyze', { method: 'POST', body: { file } }),
    onSuccess: (a) => setAnalysis(a),
    onError: (e) => setError((e as Error).message),
  });

  async function upload(f: File) {
    setError(null);
    setProgress(0);
    const r = await uploadFile<{ file: string }>('/imports/upload', f, setProgress);
    setProgress(null);
    if (!r.data) { setError(r.error); return; }
    setUploaded(r.data.file);
    analyze.mutate(r.data.file);
  }

  function reset() {
    if (uploaded) void api(`/imports/${encodeURIComponent(uploaded)}`, { method: 'DELETE' }).catch(() => {});
    setUploaded(null); setAnalysis(null); setError(null);
    void folder.refetch();
  }

  if (analysis) return <Result a={analysis} onReset={reset} onReady={onReady} />;

  const busy = progress !== null || analyze.isPending;
  return (
    <div className="space-y-5">
      <p className="text-sm text-dim">
        {t('backup.intro')}
      </p>

      <div className="rounded-lg border border-dashed border-seam p-6 text-center space-y-3"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !busy) void upload(f); }}>
        <FileArchive className="size-8 mx-auto text-dim" aria-hidden />
        <p className="text-sm">{t('backup.dropHere')}</p>
        <input ref={input} type="file" accept=".zip" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        <Button variant="primary" disabled={busy} onClick={() => input.current?.click()}><Upload className="size-4" /> {t('backup.choose')}</Button>
        <p className="text-xs text-dim">{t('backup.sizeHint')}</p>
        {progress !== null && (
          <div className="flex items-center gap-3 max-w-sm mx-auto" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={t('import.upload')}>
            <div className="h-2 flex-1 rounded-full bg-rack-2 overflow-hidden"><div className="h-full bg-amber transition-all" style={{ width: `${progress}%` }} /></div>
            <span className="text-sm tabular-nums text-dim">{progress} %</span>
          </div>
        )}
        {analyze.isPending && <p className="text-sm text-dim" role="status">{t('backup.analyzing')}</p>}
      </div>

      <section className="rounded-lg border border-seam p-4 space-y-3">
        <p className="text-sm">
          <span className="font-medium">{t('import.folder')}</span>
          {folder.data?.folder && <span className="text-dim"> – {tn('backup.folderHint', { path: <code className="font-mono text-[13px]">{folder.data.folder}</code> })}</span>}
        </p>
        {folder.isLoading ? <Spinner /> : !folder.data?.files.length ? <p className="text-sm text-dim">{t('import.folderEmpty')}</p> : (
          <ul className="divide-y divide-seam">
            {folder.data.files.map((f) => (
              <li key={f.name} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 truncate font-mono text-[13px]">{displayName(f.name)}</span>
                <span className="flex items-center gap-3 shrink-0">
                  <span className="text-dim tabular-nums">{formatMb(Math.round(f.bytes / 1024 / 1024))}</span>
                  <Button disabled={busy} onClick={() => { setError(null); analyze.mutate(f.name); }}>{t('backup.analyze')}</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {error && <ErrorBox>{error}</ErrorBox>}
    </div>
  );
}

function Result({ a, onReset, onReady }: { a: Analysis; onReset: () => void; onReady: (p: BackupPreset) => void }) {
  const [eggId, setEggId] = useState<string>(a.confident ? a.candidates[0]!.eggId : '');
  const cand = a.candidates.find((c) => c.eggId === eggId) ?? null;
  const [choices, setChoices] = useState<Record<string, string>>({});
  const egg = useQuery({ queryKey: ['egg', eggId], enabled: !!eggId, queryFn: () => api<{ egg: EggDetail }>(`/eggs/${eggId}`) });

  if (!a.candidates.length) {
    return (
      <div className="space-y-4">
        <ErrorBox>
          {tn('backup.nothing', { file: <span className="font-mono">{displayName(a.file)}</span>, entries: a.entries, size: formatMb(Math.round(a.totalBytes / 1024 / 1024)) })}
        </ErrorBox>
        <Button onClick={onReset}>{t('backup.other')}</Button>
      </div>
    );
  }

  const label = (env: string) => egg.data?.egg.variables.find((v) => v.env === env)?.label ?? env;
  const secret = (env: string) => egg.data?.egg.variables.find((v) => v.env === env)?.secret ?? false;
  const value = (d: DetectedVar) => choices[d.env] ?? d.value;

  function next() {
    if (!cand) return;
    const values: Record<string, string> = {};
    const sources: Record<string, string> = {};
    for (const d of cand.variables) { values[d.env] = value(d); sources[d.env] = d.source; }
    // Platz fuer Spieldateien plus Backup-Inhalt, mit Luft
    const base = egg.data?.egg.resources ? 10 : 5;
    const minDiskGb = Math.ceil((cand.importBytes * 1.5) / GB) + base;
    onReady({ eggId: cand.eggId, file: a.file, label: displayName(a.file), values, sources, minDiskGb, warnings: cand.warnings });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate"><FileArchive className="inline size-4 mr-1.5 text-dim" aria-hidden /><span className="font-mono">{displayName(a.file)}</span> <span className="text-dim">· {formatMb(Math.round(a.bytes / 1024 / 1024))}</span></span>
        <button type="button" className="text-dim hover:text-ink shrink-0" onClick={onReset}>{t('backup.other')}</button>
      </div>

      {a.confident ? (
        <div className="rounded-lg border border-led-run/40 bg-led-run/10 p-4 flex gap-3">
          <CheckCircle2 className="size-5 text-led-run shrink-0 mt-0.5" aria-hidden />
          <div className="text-sm">
            <p className="font-medium text-ink">{t('backup.detected', { game: a.candidates[0]!.name })}</p>
            <p className="text-dim">{t('backup.basedOn', { list: a.candidates[0]!.markers.join(', ') })}</p>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-led-start/40 bg-led-start/10 p-4 flex gap-3">
          <HelpCircle className="size-5 text-led-start shrink-0 mt-0.5" aria-hidden />
          <p className="text-sm">{t('backup.unsure')}</p>
        </div>
      )}

      {(!a.confident || a.candidates.length > 1) && (
        <Field label={t('backup.game')} htmlFor="bk-egg" hint={t('backup.sorted')}>
          <Select id="bk-egg" value={eggId} onChange={(e) => { setEggId(e.target.value); setChoices({}); }}>
            {!eggId && <option value="">{t('common.pleaseChoose')}</option>}
            {a.candidates.map((c, i) => (
              <option key={c.eggId} value={c.eggId}>{c.name}{i === 0 && a.confident ? ` (${t('backup.detectedShort')})` : ''} – {t('backup.found', { list: [...c.markers, ...c.matched.filter((m) => !c.markers.includes(m))].slice(0, 4).join(', ') })}</option>
            ))}
          </Select>
        </Field>
      )}

      {cand && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">{t('backup.taken')}</h2>
          {egg.isLoading ? <Spinner /> : cand.variables.length === 0 ? (
            <p className="text-sm text-dim">{t('backup.noValues')}</p>
          ) : (
            <dl className="rounded-lg border border-seam divide-y divide-seam text-sm">
              {cand.variables.map((d) => (
                <div key={d.env} className="grid sm:grid-cols-[12rem_1fr] gap-x-4 gap-y-1 px-4 py-2.5 items-center">
                  <dt className="text-dim">{label(d.env)}</dt>
                  <dd>
                    {d.options ? (
                      <div className="space-y-1">
                        <Select aria-label={label(d.env)} value={value(d)} onChange={(e) => setChoices((p) => ({ ...p, [d.env]: e.target.value }))}>
                          {d.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </Select>
                        <p className="text-xs text-led-start">{t('backup.several')}</p>
                      </div>
                    ) : (
                      <span className="font-mono text-[13px]">{secret(d.env) ? '••••••••' : value(d)}</span>
                    )}
                    <span className="block text-xs text-dim">{t('backup.source.label', { source: sourceLabel(d.source) })}</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {cand.warnings.map((w) => (
            <p key={w} className="text-sm text-led-start flex gap-2"><AlertTriangle className="size-4 shrink-0 mt-0.5" aria-hidden />{w}</p>
          ))}
          <p className="text-sm text-dim">{t('backup.willImport', { list: cand.matched.join(', '), size: formatMb(Math.round(cand.importBytes / 1024 / 1024)) })}</p>
        </section>
      )}

      <div className="flex justify-end">
        <Button variant="primary" disabled={!cand || egg.isLoading} onClick={next}>{t('common.next')}</Button>
      </div>
      {egg.error && <ErrorBox>{(egg.error as ApiError).message}</ErrorBox>}
    </div>
  );
}
