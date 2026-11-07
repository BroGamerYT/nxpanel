import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { api, apiBlobUrl, ApiError } from '../lib/api';
import { t } from '../lib/i18n';
import { MC_COLORS, MC_FORMATS, McText, joinMotd, splitMotd, stripCodes } from '../lib/mc';
import { Button, ErrorBox } from './ui';

/**
 * MOTD-Editor: zwei Zeilen mit Farben und Formatierung, Vorschau wie in
 * der Minecraft-Serverliste, dazu das Servericon. Die MOTD ist eine
 * normale Spiel-Einstellung (Variable MOTD) - gespeichert wird sie wie
 * die anderen, also im gestoppten Zustand. Das Icon geht jederzeit.
 */
export function MotdEditor({ serverId, serverName, stopped, canEdit }: { serverId: string; serverName: string; stopped: boolean; canEdit: boolean }) {
  const qc = useQueryClient();
  const startup = useQuery({ queryKey: ['startup', serverId], queryFn: () => api<{ variables: Array<{ env: string; value: string }> }>(`/servers/${serverId}/startup`) });
  const current = startup.data?.variables.find((v) => v.env === 'MOTD')?.value ?? '';
  const [lines, setLines] = useState<[string, string]>(['', '']);
  const [focus, setFocus] = useState<0 | 1>(0);
  const refs = [useRef<HTMLInputElement>(null), useRef<HTMLInputElement>(null)];
  const [iconKey, setIconKey] = useState(0);
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  // Per fetch statt <img src>: das Icon braucht die Anmeldung (Bearer-Token).
  useEffect(() => {
    let url: string | null = null, gone = false;
    void apiBlobUrl(`/servers/${serverId}/mc/icon`).then((u) => { if (gone) { if (u) URL.revokeObjectURL(u); return; } url = u; setIconUrl(u); });
    return () => { gone = true; if (url) URL.revokeObjectURL(url); };
  }, [serverId, iconKey]);
  useEffect(() => { setLines(splitMotd(current)); }, [current]);

  const value = joinMotd(lines[0], lines[1]);
  const dirty = value !== current;
  const save = useMutation({
    mutationFn: () => api(`/servers/${serverId}/startup`, { method: 'PATCH', body: { variables: { MOTD: value } } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['startup', serverId] }); },
  });
  const icon = useMutation({
    mutationFn: (png: string | null) => png ? api(`/servers/${serverId}/mc/icon`, { method: 'PUT', body: { png } }) : api(`/servers/${serverId}/mc/icon`, { method: 'DELETE' }),
    onSuccess: () => { setIconKey((k) => k + 1); },
  });

  /** Code an der Cursorposition einfuegen (oder um die Auswahl). */
  function insert(code: string) {
    const el = refs[focus]?.current ?? null;
    const text = lines[focus];
    const start = el?.selectionStart ?? text.length, end = el?.selectionEnd ?? text.length;
    const next = start !== end && code !== '§r'
      ? text.slice(0, start) + code + text.slice(start, end) + '§r' + text.slice(end)
      : text.slice(0, start) + code + text.slice(end);
    const nl: [string, string] = [...lines]; nl[focus] = next; setLines(nl);
    requestAnimationFrame(() => { el?.focus(); const pos = start + code.length; el?.setSelectionRange(pos, pos); });
  }

  /** Bild auf 64x64 bringen (Minecraft nimmt nur genau diese Groesse). */
  async function pickIcon(file: File) {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    await img.decode();
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const s = Math.min(img.width, img.height);
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 64, 64);
    URL.revokeObjectURL(img.src);
    icon.mutate(c.toDataURL('image/png'));
  }

  const visible = (l: string) => stripCodes(l).length;
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium">{t('motd.title')}</h2>
        <p className="text-sm text-dim mt-0.5">{t('motd.hint')}</p>
      </div>

      {/* Vorschau wie in der Serverliste */}
      <div className="rounded-md bg-[#1E1E1E] border border-black/60 p-2 flex gap-3 font-[Minecraft,ui-monospace,monospace] text-[15px] leading-tight" aria-label={t('motd.preview')}>
        {iconUrl
          ? <img src={iconUrl} alt="" className="size-16 [image-rendering:pixelated] shrink-0" />
          : <div className="size-16 shrink-0 bg-[#3a3a3a] grid place-items-center text-[10px] text-[#888]">64×64</div>}
        <div className="min-w-0 pt-0.5">
          <div className="text-white">{serverName}</div>
          <div className="truncate"><McText text={lines[0] || ' '} /></div>
          <div className="truncate"><McText text={lines[1] || ' '} /></div>
        </div>
      </div>

      {canEdit && (
        <>
          <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={t('motd.toolbar')}>
            {MC_COLORS.map((c) => (
              <button key={c.code} type="button" title={`§${c.code}`} aria-label={`${t('motd.color')} ${c.name}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(`§${c.code}`)}
                className="size-6 rounded border border-seam hover:scale-110 transition-transform" style={{ background: c.hex }} />
            ))}
            <span className="w-2" />
            {MC_FORMATS.map((f) => (
              <button key={f.code} type="button" title={`§${f.code}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(`§${f.code}`)}
                className="h-6 px-2 rounded border border-seam text-xs text-dim hover:text-ink">{t(`motd.fmt.${f.key}`)}</button>
            ))}
          </div>
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-2">
              <input ref={refs[i]} value={lines[i as 0 | 1]} onFocus={() => setFocus(i as 0 | 1)} disabled={!stopped}
                onChange={(e) => { const nl: [string, string] = [...lines]; nl[i as 0 | 1] = e.target.value.replace(/[\r\n]/g, ''); setLines(nl); }}
                aria-label={t('motd.line', { n: i + 1 })} placeholder={t('motd.line', { n: i + 1 })}
                className="flex-1 h-10 rounded-md bg-rack-2 border border-seam px-3 font-mono text-[13px] text-ink focus:border-amber focus:outline-none disabled:opacity-55" />
              <span className={`w-14 text-right text-xs tabular-nums ${visible(lines[i as 0 | 1]) > 45 ? 'text-led-start' : 'text-dim'}`} title={t('motd.visibleChars')}>{visible(lines[i as 0 | 1])}/45</span>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex gap-2">
              <label className={`inline-flex items-center gap-2 h-9 px-3.5 rounded-md text-sm border border-seam bg-rack-2 hover:bg-seam cursor-pointer ${icon.isPending ? 'opacity-50' : ''}`}>
                <ImageUp className="size-4" />{t('motd.icon')}
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void pickIcon(f); e.target.value = ''; }} />
              </label>
              {iconUrl && <Button onClick={() => icon.mutate(null)} aria-label={t('motd.iconRemove')}><Trash2 className="size-4" /></Button>}
            </div>
            <div className="flex items-center gap-3">
              {!stopped && <span className="text-xs text-dim">{t('motd.stopFirst')}</span>}
              {dirty && <Button onClick={() => setLines(splitMotd(current))}>{t('common.discard')}</Button>}
              <Button variant="primary" disabled={!dirty || !stopped} busy={save.isPending} onClick={() => save.mutate()}>{t('motd.save')}</Button>
            </div>
          </div>
          {(save.error || icon.error) && <ErrorBox>{((save.error ?? icon.error) as ApiError).message}</ErrorBox>}
        </>
      )}
    </section>
  );
}
