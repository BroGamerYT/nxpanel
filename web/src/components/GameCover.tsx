import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Shuffle, Sparkles, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import type { CoverInfo } from '../lib/types';
import { Button, ErrorBox } from './ui';

/** Gleiche Liste und gleicher Wuerfel wie src/eggs/cover.ts - fuer den Fall, dass ein Bild nicht laedt. */
const BRANDING = [
  'banner.png', 'icon-256.png',
  ...['amber-classic', 'arctic-cyan', 'crimson-forge', 'cyber-emerald', 'plasma-violet', 'stealth-mono']
    .flatMap((th) => [`themes/${th}/banner.png`, `themes/${th}/icon-256.png`]),
];
function brandingFor(seed: string): CoverInfo {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const p = BRANDING[h % BRANDING.length]!;
  return { src: `/branding/${p}`, fit: p.includes('banner') ? 'banner' : 'icon', source: 'branding' };
}

/**
 * Titelbild eines Spiels im Steam-Format (460x215). Banner fuellen die Flaeche,
 * Symbole stehen mittig auf dunklem Grund. Laedt das Bild nicht (Steam nicht
 * erreichbar), springt es auf ein Panel-Motiv um.
 */
export function GameCover({ cover, seed, className = '' }: { cover: CoverInfo | undefined; seed: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  // Eigene Bilder koennen quadratisch sein (Logo) - die nicht anschneiden, sondern mittig zeigen.
  const [square, setSquare] = useState(false);
  useEffect(() => { setFailed(false); setSquare(false); }, [cover?.src]);
  const c = !cover || failed ? brandingFor(seed) : cover;
  const fit = c.fit === 'icon' || square ? 'icon' : 'banner';
  return (
    <div className={`relative aspect-[460/215] overflow-hidden bg-gradient-to-br from-rack-2 to-[#07090d] ${className}`}>
      <img src={c.src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)}
        onLoad={(e) => { const i = e.currentTarget; if (c.source === 'custom' && i.naturalWidth / i.naturalHeight < 1.6) setSquare(true); }}
        className={fit === 'banner' ? 'absolute inset-0 size-full object-cover' : 'absolute inset-0 m-auto h-4/5 w-auto object-contain drop-shadow-lg'} />
    </div>
  );
}

/** Admin: Titelbild eines Spiels waehlen - automatisch, Steam, zufaelliges oder festes Panel-Motiv, eigenes Bild. */
export function CoverPicker({ eggId, eggName, choice, hasSteam, onClose }: { eggId: string; eggName: string; choice: string; hasSteam: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const file = useRef<HTMLInputElement>(null);
  const set = useMutation({
    mutationFn: (body: { choice: string } | { upload: string }) => api(`/admin/eggs/${eggId}/cover`, { method: 'PUT', body }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['eggs'] }); void qc.invalidateQueries({ queryKey: ['servers'] }); onClose(); },
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Grosse Bilder vorher auf 920x430 bringen - spart Platz und Upload. */
  async function upload(f: File) {
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode();
    const scale = Math.min(1, 920 / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    set.mutate({ upload: c.toDataURL('image/webp', 0.88) });
  }

  const opt = (key: string, label: string, Icon: typeof Sparkles) => (
    <button type="button" onClick={() => set.mutate({ choice: key })} aria-pressed={choice === key}
      className={`inline-flex items-center gap-2 rounded-md border px-3 h-9 text-sm ${choice === key ? 'border-amber text-amber' : 'border-seam hover:border-dim'}`}>
      <Icon className="size-4" aria-hidden /> {label}
    </button>
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={t('cover.title', { game: eggName })} className="bg-rack-1 border border-seam rounded-lg p-5 max-w-2xl w-full shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold">{t('cover.title', { game: eggName })}</h3>
            <p className="text-sm text-dim mt-0.5">{t('cover.hint')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="text-dim hover:text-ink"><X className="size-5" /></button>
        </div>
        <div className="flex flex-wrap gap-2">
          {opt('auto', t('cover.auto'), Sparkles)}
          {hasSteam && opt('steam', t('cover.steam'), ImagePlus)}
          {opt('random', t('cover.random'), Shuffle)}
          <Button type="button" onClick={() => file.current?.click()} busy={set.isPending}><Upload className="size-4" aria-hidden /> {t('cover.upload')}</Button>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
        </div>
        <div>
          <p className="text-sm text-dim mb-2">{t('cover.branding')}</p>
          <ul className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {BRANDING.map((p) => {
              const key = `branding:${p}`;
              return (
                <li key={p}>
                  <button type="button" onClick={() => set.mutate({ choice: key })} aria-pressed={choice === key} aria-label={p}
                    className={`block w-full rounded-md overflow-hidden border-2 ${choice === key ? 'border-amber' : 'border-transparent hover:border-seam'}`}>
                    <GameCover cover={{ src: `/branding/${p}`, fit: p.includes('banner') ? 'banner' : 'icon', source: 'branding' }} seed={p} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        {set.error && <ErrorBox>{(set.error as Error).message}</ErrorBox>}
      </div>
    </div>
  );
}
