import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ExternalLink, FileUp, Globe, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, ErrorBox, Input, Spinner } from './ui';

interface CatalogEntry {
  name: string;
  category: string;
  steamId: number | null;
  runtime: string;
  ports: string;
  rating: string;
  url: string;
  rawUrl: string;
  repo: string;
  path: string;
  installed: boolean;
}

const CATEGORIES = ['all', 'SteamCMD', 'Standalone', 'Minecraft', 'Voice', 'Chatbots'] as const;

/**
 * Admin: Spielvorlage (Egg) als JSON einspielen ODER direkt den gesamten
 * Online-Katalog (260+ Spiele aus pelican-eggs / Pterodactyl) durchsuchen
 * und per Klick herunterladen, automatisch anpassen & importieren.
 */
export function EggImport() {
  const qc = useQueryClient();
  const ref = useRef<HTMLInputElement>(null);
  const [openCatalog, setOpenCatalog] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [directUrl, setDirectUrl] = useState('');
  const [result, setResult] = useState<{ name: string; warnings: string[] } | null>(null);

  const impFile = useMutation({
    mutationFn: async (file: File) => {
      let body: unknown;
      try { body = JSON.parse(await file.text()); } catch { throw new Error(t('eggImport.notJson')); }
      return api<{ name: string; warnings: string[] }>('/admin/eggs', { method: 'POST', body });
    },
    onSuccess: (r) => {
      setResult(r);
      void qc.invalidateQueries({ queryKey: ['eggs'] });
      void qc.invalidateQueries({ queryKey: ['eggCatalog'] });
    },
  });

  const impUrl = useMutation({
    mutationFn: async (vars: { url: string; steamId?: number | null; category?: string }) => {
      return api<{ name: string; warnings: string[] }>('/admin/eggs/import-url', {
        method: 'POST',
        body: vars,
      });
    },
    onSuccess: (r) => {
      setResult(r);
      setDirectUrl('');
      void qc.invalidateQueries({ queryKey: ['eggs'] });
      void qc.invalidateQueries({ queryKey: ['eggCatalog'] });
    },
  });

  const catalog = useQuery({
    queryKey: ['eggCatalog', search, category],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (category !== 'all') params.set('category', category);
      return api<{ items: CatalogEntry[] }>(`/admin/eggs/catalog?${params.toString()}`);
    },
    enabled: openCatalog,
  });

  const activeError = (impFile.error ?? impUrl.error) as Error | null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Button
          type="button"
          variant={openCatalog ? 'primary' : 'quiet'}
          onClick={() => { setOpenCatalog((v) => !v); setResult(null); impFile.reset(); impUrl.reset(); }}
        >
          {openCatalog ? <X className="size-4" aria-hidden /> : <Globe className="size-4" aria-hidden />}
          {openCatalog ? t('eggImport.catalogClose') : t('eggImport.catalogButton')}
        </Button>

        <Button
          type="button"
          busy={impFile.isPending}
          onClick={() => { setResult(null); impFile.reset(); impUrl.reset(); ref.current?.click(); }}
        >
          <FileUp className="size-4" aria-hidden />
          {t('eggImport.button')}
        </Button>

        <span className="text-dim text-xs sm:text-sm">{t('eggImport.hint')}</span>
        <input
          ref={ref}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) impFile.mutate(f);
            e.target.value = '';
          }}
        />
      </div>

      {result && (
        <div className="rounded-md border border-led-run/40 bg-led-run/10 px-3 py-2 text-sm">
          <p className="font-medium text-led-run">{t('eggImport.done', { name: result.name })}</p>
          {result.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-dim text-xs mt-1 space-y-0.5">
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}
        </div>
      )}

      {activeError && <ErrorBox>{activeError.message}</ErrorBox>}

      {openCatalog && (
        <div className="rounded-lg border border-seam bg-rack p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium text-sm flex items-center gap-2">
              <Globe className="size-4 text-amber" aria-hidden />
              {t('eggImport.catalogTitle')}
            </h3>
            <div className="flex flex-wrap gap-1">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    category === c ? 'bg-amber text-amber-ink' : 'bg-rack-2 text-dim hover:text-ink'
                  }`}
                >
                  {c === 'all' ? t('eggImport.catalogAll') : c}
                </button>
              ))}
            </div>
          </div>

          <div className="relative">
            <Search className="size-4 text-dim absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('eggImport.catalogSearch')}
              className="pl-9"
            />
          </div>

          {catalog.isLoading ? (
            <div className="py-6 flex justify-center"><Spinner /></div>
          ) : catalog.error ? (
            <ErrorBox>{(catalog.error as Error).message}</ErrorBox>
          ) : (catalog.data?.items.length ?? 0) === 0 ? (
            <p className="text-dim text-sm py-4 text-center">{t('eggImport.catalogEmpty')}</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-seam rounded-md border border-seam bg-rack-2/40">
              {catalog.data!.items.map((item) => {
                const isImportingThis = impUrl.isPending && impUrl.variables?.url === item.url;
                return (
                  <li key={item.rawUrl} className="px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-rack-2/80">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{item.name}</span>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-rack border border-seam text-dim">
                          {item.category}
                        </span>
                        {item.runtime && (
                          <span className={`text-[11px] px-1.5 py-0.5 rounded border ${
                            /proton|wine/i.test(item.runtime)
                              ? 'border-amber/40 text-amber bg-amber/10'
                              : 'border-seam text-dim bg-rack'
                          }`}>
                            {item.runtime}
                          </span>
                        )}
                        {item.rating === 'Steam-Konto' && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border border-amber/40 text-amber bg-amber/10">
                            Steam-Login
                          </span>
                        )}
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          title="Auf GitHub ansehen"
                          className="text-dim hover:text-amber inline-flex items-center"
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      </div>
                      {item.ports && (
                        <p className="text-xs text-dim truncate mt-0.5">
                          Ports: {item.ports}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0">
                      {item.installed ? (
                        <span className="inline-flex items-center gap-1 text-xs text-led-run font-medium px-2.5 py-1 rounded bg-led-run/10 border border-led-run/30">
                          <Check className="size-3.5" aria-hidden />
                          {t('eggImport.catalogInstalled')}
                        </span>
                      ) : (
                        <Button
                          type="button"
                          variant="quiet"
                          busy={isImportingThis}
                          disabled={impUrl.isPending}
                          onClick={() => {
                            setResult(null);
                            impUrl.mutate({ url: item.url, steamId: item.steamId, category: item.category });
                          }}
                        >
                          <Download className="size-3.5" aria-hidden />
                          {t('eggImport.catalogInstall')}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t border-seam">
            <Input
              value={directUrl}
              onChange={(e) => setDirectUrl(e.target.value)}
              placeholder={t('eggImport.catalogDirectUrl')}
              className="flex-1 min-w-[240px] text-xs"
            />
            <Button
              type="button"
              disabled={!directUrl.trim() || impUrl.isPending}
              busy={impUrl.isPending && impUrl.variables?.url === directUrl.trim()}
              onClick={() => {
                setResult(null);
                impUrl.mutate({ url: directUrl.trim() });
              }}
            >
              <Download className="size-4" aria-hidden />
              {t('eggImport.catalogDirectBtn')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
