import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, Download, ExternalLink, FileUp, KeyRound, Search } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { Button, ErrorBox, Input, Spinner } from './ui';

export type PackSource = 'curseforge' | 'modrinth' | 'ftb';
export interface PackHit {
  source: PackSource; ref: string; name: string; summary: string; icon: string | null; downloads: number; url: string;
  mcVersions: string[]; loaders: string[]; latest: { id: string; name: string; mcVersion: string | null } | null;
  manualDownload?: boolean;
  preset: { values: Record<string, string>; java: number; ramMb: number };
}
interface SearchResult { hits: PackHit[]; errors: Partial<Record<PackSource, string>>; curseforge: 'ok' | 'no_key' }

/** Was der Erstellen-Dialog aus der Auswahl macht. */
export interface ModpackChoice {
  name: string;
  label: string;
  values: Record<string, string>;
  java: number;
  ramMb: number;
  /** Eigene Pack-Datei, die nach dem Anlegen hochgeladen wird. */
  file?: File;
}

export const SOURCE_LABEL: Record<PackSource, string> = { curseforge: 'CurseForge', modrinth: 'Modrinth', ftb: 'FTB' };
const SOURCE_COLOR: Record<PackSource, string> = {
  curseforge: 'bg-[#f16436]/15 text-[#f58a63]',
  modrinth: 'bg-[#1bd96a]/15 text-[#4ee68f]',
  ftb: 'bg-[#4b8cf7]/15 text-[#7aa9fa]',
};

export function formatDownloads(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} Mio.`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} Tsd.`;
  return String(n);
}

export function ModpackSearch({ onPick }: { onPick: (c: ModpackChoice) => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [source, setSource] = useState<'all' | PackSource>('all');
  useEffect(() => { const id = setTimeout(() => setDebounced(q.trim()), 400); return () => clearTimeout(id); }, [q]);

  const search = useQuery({
    queryKey: ['modpacks', debounced, source],
    queryFn: () => api<SearchResult>(`/modpacks/search?q=${encodeURIComponent(debounced)}&source=${source}`),
    enabled: debounced.length >= 2,
    staleTime: 5 * 60_000,
  });
  const cf = useQuery({ queryKey: ['cf-key'], queryFn: () => api<{ configured: boolean }>('/modpacks/curseforge') });

  return (
    <div className="space-y-5">
      <Guide cfConfigured={!!cf.data?.configured} searching={debounced.length >= 2} />

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="size-4 text-dim absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
          <Input autoFocus aria-label={t('pack.search')} placeholder={t('pack.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
        </div>
        <div role="group" aria-label={t('pack.source')} className="flex rounded-md border border-seam overflow-hidden shrink-0 text-sm">
          {(['all', 'curseforge', 'modrinth', 'ftb'] as const).map((s) => (
            <button key={s} type="button" onClick={() => setSource(s)} aria-pressed={source === s}
              className={`px-3 h-10 ${source === s ? 'bg-rack-2 text-amber' : 'text-dim hover:text-ink'}`}>
              {s === 'all' ? t('pack.all') : SOURCE_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {search.data?.curseforge === 'no_key' && (source === 'all' || source === 'curseforge') && (
        <p className="text-sm text-led-install flex items-start gap-2"><KeyRound className="size-4 mt-0.5 shrink-0" aria-hidden />{t('pack.noCfKey')}</p>
      )}
      {search.isFetching && <Spinner label={t('pack.searching')} />}
      {search.error && <ErrorBox>{(search.error as Error).message}</ErrorBox>}
      {search.data && Object.entries(search.data.errors).map(([src, msg]) => (
        <p key={src} className="text-xs text-dim">{t('pack.sourceDown', { source: SOURCE_LABEL[src as PackSource], message: msg ?? '' })}</p>
      ))}
      {search.data && search.data.hits.length === 0 && !search.isFetching && <p className="text-sm text-dim">{t('pack.noHits')}</p>}

      {search.data && search.data.hits.length > 0 && (
        <ul className="space-y-2">
          {search.data.hits.map((h) => (
            <li key={`${h.source}:${h.ref}`}>
              <div className="flex gap-3 rounded-lg border border-seam bg-rack p-3 hover:border-amber/60">
                <div className="size-16 rounded-md bg-rack-2 overflow-hidden shrink-0 grid place-items-center">
                  {h.icon ? <img src={h.icon} alt="" loading="lazy" className="size-full object-cover" referrerPolicy="no-referrer" /> : <Download className="size-6 text-dim" aria-hidden />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{h.name}</span>
                    <span className={`text-[11px] px-1.5 py-0.5 rounded ${SOURCE_COLOR[h.source]}`}>{SOURCE_LABEL[h.source]}</span>
                    {h.loaders.map((l) => <span key={l} className="text-[11px] px-1.5 py-0.5 rounded bg-rack-2 text-dim capitalize">{l}</span>)}
                  </div>
                  <p className="text-sm text-dim line-clamp-2 mt-0.5">{h.summary}</p>
                  <p className="text-xs text-dim mt-1 flex flex-wrap gap-x-3">
                    {h.mcVersions[0] && <span>Minecraft {h.mcVersions[0]}</span>}
                    {h.latest?.name && <span>{t('pack.version')}: {h.latest.name}</span>}
                    <span>{formatDownloads(h.downloads)} {t('pack.downloads')}</span>
                    <a href={h.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-amber">{t('pack.openPage')}<ExternalLink className="size-3" aria-hidden /></a>
                  </p>
                  {h.manualDownload && <p className="text-xs text-led-install mt-1 flex items-center gap-1"><AlertTriangle className="size-3" aria-hidden />{t('pack.manualDownload')}</p>}
                </div>
                <Button variant="primary" className="self-center shrink-0" disabled={!h.latest}
                  onClick={() => onPick({ name: h.name.slice(0, 64), label: `${h.name} (${SOURCE_LABEL[h.source]}${h.latest?.name ? `, ${h.latest.name}` : ''})`, ...h.preset })}>
                  {t('common.choose')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <OwnPack onPick={onPick} />
    </div>
  );
}

/** Anleitung mit Links - zugeklappt, sobald man sucht, bleibt aber erreichbar. */
function Guide({ cfConfigured, searching }: { cfConfigured: boolean; searching: boolean }) {
  const { me } = useAuth();
  const isAdmin = me?.user.role === 'admin';
  const [open, setOpen] = useState(!cfConfigured);
  // Beim Suchen zuklappen, damit die Treffer oben stehen
  useEffect(() => { setOpen(!cfConfigured && !searching); }, [cfConfigured, searching]);
  const link = (href: string, label: string) => <a href={href} target="_blank" rel="noreferrer noopener" className="text-amber hover:underline inline-flex items-center gap-0.5">{label}<ExternalLink className="size-3" aria-hidden /></a>;

  return (
    <section className="rounded-lg border border-seam bg-rack/60">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center justify-between px-4 py-3 text-sm">
        <span className="font-medium">{t('pack.guideTitle')}</span>
        <ChevronDown className={`size-4 text-dim transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="px-4 pb-4 text-sm text-dim space-y-4">
          <p>{t('pack.guideIntro')}</p>
          <div>
            <h3 className="text-ink font-medium mb-1">CurseForge {cfConfigured ? <span className="text-led-run text-xs ml-1">✓ {t('pack.cfReady')}</span> : null}</h3>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>{t('pack.cf1')} {link('https://console.curseforge.com/', 'console.curseforge.com')}</li>
              <li>{t('pack.cf2')}</li>
              <li>{t('pack.cf3')}</li>
            </ol>
            {isAdmin ? <CurseForgeKey configured={cfConfigured} /> : !cfConfigured && <p className="mt-1">{t('pack.cfAskAdmin')}</p>}
          </div>
          <div>
            <h3 className="text-ink font-medium mb-1">Modrinth</h3>
            <p>{t('pack.mr')} {link('https://modrinth.com/modpacks', 'modrinth.com/modpacks')}</p>
          </div>
          <div>
            <h3 className="text-ink font-medium mb-1">Feed the Beast (FTB)</h3>
            <p>{t('pack.ftb')} {link('https://www.feed-the-beast.com/modpacks', 'feed-the-beast.com/modpacks')}</p>
          </div>
          <div>
            <h3 className="text-ink font-medium mb-1">{t('pack.ownTitle')}</h3>
            <ul className="list-disc pl-5 space-y-0.5">
              <li><span className="text-ink">Prism Launcher</span> ({link('https://prismlauncher.org/', 'prismlauncher.org')}): {t('pack.prism')}</li>
              <li><span className="text-ink">Modrinth App</span> ({link('https://modrinth.com/app', 'modrinth.com/app')}): {t('pack.mrApp')}</li>
              <li><span className="text-ink">CurseForge App</span>: {t('pack.cfApp')}</li>
              <li><span className="text-ink">FTB App</span> ({link('https://www.feed-the-beast.com/app', 'feed-the-beast.com/app')}): {t('pack.ftbApp')}</li>
            </ul>
          </div>
          <p className="text-xs">{t('pack.pinNote')}</p>
        </div>
      )}
    </section>
  );
}

function CurseForgeKey({ configured }: { configured: boolean }) {
  const qc = useQueryClient();
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: (apiKey: string | null) => apiKey ? api('/admin/modpacks/curseforge', { method: 'PUT', body: { apiKey } }) : api('/admin/modpacks/curseforge', { method: 'DELETE' }),
    onSuccess: () => { setKey(''); void qc.invalidateQueries({ queryKey: ['cf-key'] }); void qc.invalidateQueries({ queryKey: ['modpacks'] }); },
  });
  return (
    <div className="mt-2 space-y-1">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) save.mutate(key.trim()); }}>
        <Input type="password" autoComplete="off" aria-label={t('pack.cfKey')} placeholder={configured ? t('pack.cfKeyReplace') : t('pack.cfKeyPlaceholder')} value={key} onChange={(e) => setKey(e.target.value)} />
        <Button type="submit" busy={save.isPending} disabled={!key.trim()}>{t('common.save')}</Button>
        {configured && <Button type="button" variant="danger" onClick={() => save.mutate(null)}>{t('common.delete')}</Button>}
      </form>
      <p className="text-xs">{t('pack.cfKeyNote')}</p>
      {save.error && <ErrorBox>{(save.error as Error).message}</ErrorBox>}
    </div>
  );
}

/** Eigene Pack-Datei (.mrpack aus Prism/Modrinth App, .zip aus CurseForge-App/Prism). */
function OwnPack({ onPick }: { onPick: (c: ModpackChoice) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  function pick(f: File) {
    setErr(null);
    const lower = f.name.toLowerCase();
    if (!lower.endsWith('.mrpack') && !lower.endsWith('.zip')) { setErr(t('pack.ownWrongType')); return; }
    const isMr = lower.endsWith('.mrpack');
    const fileName = `modpack-${Date.now().toString(36)}.${isMr ? 'mrpack' : 'zip'}`;
    const base = f.name.replace(/\.(mrpack|zip)$/i, '').replace(/[_-]+/g, ' ').trim().slice(0, 64) || 'Modpack';
    onPick({
      name: base,
      label: `${f.name} (${t('pack.ownFile')})`,
      values: isMr
        ? { TYPE: 'MODRINTH', MODRINTH_MODPACK: `/data/${fileName}` }
        : { TYPE: 'AUTO_CURSEFORGE', CF_SLUG: 'custom', CF_MODPACK_ZIP: `/data/${fileName}` },
      java: 21,
      ramMb: 8192,
      file: new File([f], fileName, { type: f.type || 'application/octet-stream' }),
    });
  }
  return (
    <section className="rounded-lg border border-dashed border-seam p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{t('pack.ownTitle')}</p>
          <p className="text-dim">{t('pack.ownHint')}</p>
        </div>
        <Button type="button" onClick={() => ref.current?.click()}><FileUp className="size-4" aria-hidden />{t('pack.ownPick')}</Button>
        <input ref={ref} type="file" accept=".mrpack,.zip" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
      </div>
      {err && <p className="text-led-crash mt-2">{err}</p>}
    </section>
  );
}
