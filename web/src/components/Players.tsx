import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Crown, LogOut, ShieldCheck, UserMinus, UserPlus } from 'lucide-react';
import { api } from '../lib/api';
import { t, fmtDateTime } from '../lib/i18n';
import { Button, ErrorBox, Input, Select, Spinner } from './ui';
import type { GameStatusData } from './GameLive';

type Action = 'kick' | 'ban' | 'pardon' | 'op' | 'deop' | 'whitelist_add' | 'whitelist_remove';
interface Lists { bans: Array<{ name: string; id?: string | null; reason: string | null; created: string | null; by: string | null; until: string | null }>; whitelist: string[]; ops: string[]; source?: 'panel' }

const DURATIONS = [0, 60, 24 * 60, 7 * 24 * 60, 30 * 24 * 60];

/**
 * Spieler: wer ist online, kicken, bannen (mit Grund und Dauer), OP,
 * Whitelist. Befehle gehen ueber RCON; die Listen kommen aus den Dateien
 * des Servers und sind deshalb auch im gestoppten Zustand sichtbar.
 */
export function Players({ serverId, status, canCommand, running }: { serverId: string; status: GameStatusData | undefined; canCommand: boolean; running: boolean }) {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: ['player-lists', serverId], queryFn: () => api<Lists>(`/servers/${serverId}/players/lists`), refetchInterval: 15_000 });
  const [target, setTarget] = useState<{ name: string; id?: string | undefined; action: 'kick' | 'ban' } | null>(null);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(0);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: (b: { action: Action; name: string; id?: string | undefined; reason?: string; minutes?: number }) =>
      api<{ output: string }>(`/servers/${serverId}/players/action`, { method: 'POST', body: b }),
    onSuccess: (r) => {
      setMsg(r.output || t('common.savedDot')); setTarget(null); setReason(''); setMinutes(0);
      void qc.invalidateQueries({ queryKey: ['player-lists', serverId] });
      void qc.invalidateQueries({ queryKey: ['game-status', serverId] });
    },
  });
  const run = (action: Action, n: string, extra: { id?: string | undefined; reason?: string; minutes?: number } = {}) => { setMsg(null); act.mutate({ action, name: n, ...extra }); };
  const can = canCommand && running && !!status?.rcon;
  const allowed = new Set(status?.actions ?? []);
  // Minecraft spricht Spieler ueber den Namen an, ARK/Palworld ueber eine ID.
  const isMc = (status?.kind ?? 'minecraft') === 'minecraft';
  const online: Array<{ name: string; id?: string | undefined }> = status?.people
    ?? (status?.players ?? (status?.ping && !('error' in status.ping) ? status.ping.players.sample : []) ?? []).map((name) => ({ name }));
  const ops = new Set((lists.data?.ops ?? []).map((o) => o.toLowerCase()));
  const validName = /^[A-Za-z0-9_]{2,16}$/.test(name);

  return (
    <div className="space-y-6 max-w-4xl">
      {!running && <p className="rounded-md border border-seam bg-rack px-3 py-2 text-sm text-dim">{t('players.offline')}</p>}
      {lists.data?.source === 'panel' && <p className="text-xs text-dim">{t('players.panelBans')}</p>}
      {running && status && !status.rcon && status.kind !== 'source' && <p className="rounded-md border border-led-start/40 bg-led-start/10 px-3 py-2 text-sm">{t('players.noRcon')}</p>}

      <section className="space-y-2">
        <h2 className="font-medium">{t('players.online', { count: online.length })}</h2>
        {online.length === 0 ? <p className="text-sm text-dim">{t('players.nobody')}</p> : (
          <ul className="rounded-lg border border-seam divide-y divide-seam">
            {online.map(({ name: p, id }) => (
              <li key={id ?? p} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-2 font-medium">
                    <span aria-hidden className="grid place-items-center size-6 rounded bg-rack-2 text-[11px] font-semibold text-dim">{p.slice(0, 2).toUpperCase()}</span>
                    {p}{ops.has(p.toLowerCase()) && <Crown className="size-3.5 text-amber" aria-label="OP" />}
                    {id && <span className="font-mono text-[11px] text-dim truncate max-w-48" title={id}>{id}</span>}
                  </span>
                  {can && (
                    <span className="flex gap-1.5">
                      {allowed.has('kick') && <Button className="h-8" onClick={() => setTarget({ name: p, id, action: 'kick' })}><LogOut className="size-3.5" />{t('players.kick')}</Button>}
                      {allowed.has('ban') && <Button className="h-8" variant="danger" onClick={() => setTarget({ name: p, id, action: 'ban' })}><Ban className="size-3.5" />{t('players.ban')}</Button>}
                      {allowed.has('op') && <Button className="h-8" onClick={() => run(ops.has(p.toLowerCase()) ? 'deop' : 'op', p)}><Crown className="size-3.5" />{ops.has(p.toLowerCase()) ? t('players.deop') : t('players.op')}</Button>}
                      {!isMc && allowed.has('whitelist_add') && <Button className="h-8" onClick={() => run('whitelist_add', p, { id })}><ShieldCheck className="size-3.5" />{t('players.whitelistAdd')}</Button>}
                    </span>
                  )}
                </div>
                {target?.name === p && (
                  <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); run(target.action, p, { id, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(target.action === 'ban' && minutes ? { minutes } : {}) }); }}>
                    <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value.replace(/[\r\n]/g, ''))} maxLength={200} placeholder={t('players.reason')} className="flex-1 min-w-48 h-9" />
                    {target.action === 'ban' && (
                      <Select aria-label={t('players.duration')} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-40 h-9">
                        {DURATIONS.map((d) => <option key={d} value={d}>{t(`players.dur.${d}`)}</option>)}
                      </Select>
                    )}
                    <Button type="submit" variant={target.action === 'ban' ? 'danger' : 'primary'} busy={act.isPending}>{target.action === 'ban' ? t('players.ban') : t('players.kick')}</Button>
                    <Button type="button" onClick={() => setTarget(null)}>{t('common.cancel')}</Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {can && isMc && (
        <section className="space-y-2">
          <h2 className="font-medium">{t('players.byName')}</h2>
          <div className="flex flex-wrap gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value.trim())} placeholder={t('players.namePlaceholder')} maxLength={16} className="w-56" />
            <Button disabled={!validName} onClick={() => { run('whitelist_add', name); setName(''); }}><UserPlus className="size-4" />{t('players.whitelistAdd')}</Button>
            <Button disabled={!validName} onClick={() => { run('op', name); setName(''); }}><Crown className="size-4" />{t('players.op')}</Button>
            <Button disabled={!validName} variant="danger" onClick={() => { setTarget({ name, action: 'ban' }); }}><Ban className="size-4" />{t('players.ban')}</Button>
          </div>
          {target && !online.some((o) => o.name === target.name) && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); run('ban', target.name, { ...(reason.trim() ? { reason: reason.trim() } : {}), ...(minutes ? { minutes } : {}) }); setName(''); }}>
              <span className="text-sm">{target.name}:</span>
              <Input autoFocus value={reason} onChange={(e) => setReason(e.target.value.replace(/[\r\n]/g, ''))} maxLength={200} placeholder={t('players.reason')} className="flex-1 min-w-48 h-9" />
              <Select aria-label={t('players.duration')} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className="w-40 h-9">
                {DURATIONS.map((d) => <option key={d} value={d}>{t(`players.dur.${d}`)}</option>)}
              </Select>
              <Button type="submit" variant="danger" busy={act.isPending}>{t('players.ban')}</Button>
              <Button type="button" onClick={() => setTarget(null)}>{t('common.cancel')}</Button>
            </form>
          )}
        </section>
      )}
      {act.error && <ErrorBox>{(act.error as Error).message}</ErrorBox>}
      {msg && <p className="text-sm text-led-run font-mono" role="status">{msg}</p>}

      {lists.isLoading ? <Spinner /> : lists.data && (
        <div className={`grid gap-4 ${lists.data.source === 'panel' ? 'md:grid-cols-1 max-w-xl' : 'md:grid-cols-3'}`}>
          <ListBox title={t('players.bans')} icon={Ban} empty={t('players.noBans')}>
            {lists.data.bans.map((b) => (
              <li key={b.name} className="px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{b.name}</span>
                  {can && <button className="text-xs text-dim hover:text-ink" onClick={() => run('pardon', b.name, { id: b.id ?? undefined })}>{t('players.pardon')}</button>}
                </div>
                {b.reason && <p className="text-xs text-dim">{b.reason}</p>}
                {b.id && <p className="font-mono text-[11px] text-dim truncate" title={b.id}>{b.id}</p>}
                <p className="text-xs text-dim">{b.until ? t('players.until', { date: fmtDateTime(b.until, { dateStyle: 'short', timeStyle: 'short' }) }) : t('players.permanent')}{b.by ? ` · ${b.by}` : ''}</p>
              </li>
            ))}
          </ListBox>
          {lists.data.source !== 'panel' && <ListBox title={t('players.whitelist')} icon={ShieldCheck} empty={t('players.noWhitelist')}>
            {lists.data.whitelist.map((w) => (
              <li key={w} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
                <span>{w}</span>
                {can && <button aria-label={t('players.whitelistRemove')} className="text-dim hover:text-led-crash" onClick={() => run('whitelist_remove', w)}><UserMinus className="size-3.5" /></button>}
              </li>
            ))}
          </ListBox>}
          {lists.data.source !== 'panel' && <ListBox title={t('players.ops')} icon={Crown} empty={t('players.noOps')}>
            {lists.data.ops.map((o) => (
              <li key={o} className="px-3 py-2 text-sm flex items-center justify-between gap-2">
                <span>{o}</span>
                {can && <button className="text-xs text-dim hover:text-ink" onClick={() => run('deop', o)}>{t('players.deop')}</button>}
              </li>
            ))}
          </ListBox>}
        </div>
      )}
    </div>
  );
}

function ListBox({ title, icon: Icon, empty, children }: { title: string; icon: typeof Ban; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="rounded-lg border border-seam bg-rack overflow-hidden">
      <h3 className="flex items-center gap-2 px-3 py-2 text-sm font-medium border-b border-seam"><Icon className="size-3.5 text-dim" aria-hidden />{title}<span className="text-dim tabular-nums">{children.length}</span></h3>
      {children.length === 0 ? <p className="px-3 py-3 text-xs text-dim">{empty}</p> : <ul className="divide-y divide-seam max-h-80 overflow-auto">{children}</ul>}
    </section>
  );
}
