import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, ExternalLink, Loader2, Package } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, ErrorBox } from './ui';
import { SOURCE_LABEL, type PackSource } from './ModpackSearch';

interface PackVersion { id: string; name: string; mcVersion: string | null; date: string | null }
interface Job { step: 'stopping' | 'backup' | 'updating' | 'starting' | 'done' | 'failed'; message?: string; to: string }
interface PackState {
  pack?: { name: string; icon: string | null; url: string } | null;
  source?: PackSource; ref?: string;
  current?: PackVersion | null; latest?: PackVersion | null;
  unpinned?: boolean; updateAvailable?: boolean; mcChange?: boolean;
  error?: string; job?: Job | null;
}

export function useModpack(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['modpack', serverId],
    queryFn: () => api<PackState>(`/servers/${serverId}/modpack`),
    enabled,
    // Waehrend eines Updates oft nachsehen, sonst selten
    refetchInterval: (q) => {
      const step = q.state.data?.job?.step;
      return step && step !== 'done' && step !== 'failed' ? 3000 : 10 * 60_000;
    },
  });
}

const STEPS: Job['step'][] = ['stopping', 'backup', 'updating', 'starting'];

/**
 * Modpack des Servers: installierte und neueste Version, Update mit einem
 * Klick (Backup vorher). `compact` ist das schmale Band im Serverkopf - es
 * erscheint nur, wenn es etwas zu tun gibt.
 */
export function ModpackCard({ serverId, canUpdate, compact = false }: { serverId: string; canUpdate: boolean; compact?: boolean }) {
  const qc = useQueryClient();
  const { data } = useModpack(serverId, true);
  const [confirm, setConfirm] = useState(false);
  const update = useMutation({
    mutationFn: () => api(`/servers/${serverId}/modpack/update`, { method: 'POST', body: {} }),
    onSuccess: () => { setConfirm(false); void qc.invalidateQueries({ queryKey: ['modpack', serverId] }); },
  });
  if (!data || (!data.source && !data.job)) return null;

  const job = data.job;
  const running = !!job && job.step !== 'done' && job.step !== 'failed';
  if (compact && !data.updateAvailable && !running && job?.step !== 'failed') return null;

  const progress = running && (
    <div className="flex items-center gap-2 text-sm">
      <Loader2 className="size-4 animate-spin text-amber" aria-hidden />
      <span>{t(`pack.step.${job.step}`)}</span>
      <span className="text-dim">({STEPS.indexOf(job.step) + 1}/{STEPS.length})</span>
    </div>
  );

  const canAct = !!(data.updateAvailable || (data.unpinned && data.latest));
  const button = canUpdate && canAct && !running && (
    confirm ? (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm">{t('pack.confirm')}</span>
        <Button variant="primary" busy={update.isPending} onClick={() => update.mutate()}>{t('pack.updateNow')}</Button>
        <Button onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
      </div>
    ) : (
      <Button variant="primary" onClick={() => setConfirm(true)}><ArrowUpCircle className="size-4" aria-hidden />{data.unpinned && !data.updateAvailable ? t('pack.pin', { version: data.latest?.name ?? '' }) : t('pack.update', { version: data.latest?.name ?? '' })}</Button>
    )
  );

  if (compact) {
    return (
      <div className="border-t border-seam px-5 py-3 flex flex-wrap items-center justify-between gap-3 bg-amber/5">
        <div className="flex items-center gap-2 text-sm min-w-0">
          <Package className="size-4 text-amber shrink-0" aria-hidden />
          {running ? progress : job?.step === 'failed'
            ? <span className="text-led-crash">{t('pack.failed', { message: job.message ?? '' })}</span>
            : <span className="truncate">{t('pack.available', { pack: data.pack?.name ?? data.ref ?? '', from: data.current?.name ?? '?', to: data.latest?.name ?? '' })}</span>}
        </div>
        {button}
        {update.error && <ErrorBox>{(update.error as Error).message}</ErrorBox>}
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-seam bg-rack p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="size-12 rounded-md bg-rack-2 overflow-hidden shrink-0 grid place-items-center">
          {data.pack?.icon ? <img src={data.pack.icon} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <Package className="size-5 text-dim" aria-hidden />}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium flex flex-wrap items-center gap-2">
            {data.pack?.name ?? data.ref}
            {data.source && <span className="text-[11px] px-1.5 py-0.5 rounded bg-rack-2 text-dim">{SOURCE_LABEL[data.source]}</span>}
            {data.pack?.url && <a href={data.pack.url} target="_blank" rel="noreferrer noopener" className="text-dim hover:text-amber" aria-label={t('pack.openPage')}><ExternalLink className="size-3.5" /></a>}
          </h2>
          {data.error ? <p className="text-sm text-led-install">{data.error}</p> : (
            <dl className="text-sm text-dim grid grid-cols-[auto_1fr] gap-x-3 mt-1">
              <dt>{t('pack.installed')}</dt><dd className="text-ink">{data.unpinned ? t('pack.unpinned') : `${data.current?.name ?? '?'}${data.current?.mcVersion ? ` · MC ${data.current.mcVersion}` : ''}`}</dd>
              <dt>{t('pack.newest')}</dt><dd className="text-ink">{data.latest ? `${data.latest.name}${data.latest.mcVersion ? ` · MC ${data.latest.mcVersion}` : ''}` : '–'}</dd>
            </dl>
          )}
        </div>
      </div>
      {!data.error && !data.updateAvailable && !data.unpinned && !running && job?.step !== 'failed' && (
        <p className="text-sm text-led-run flex items-center gap-1.5"><CheckCircle2 className="size-4" aria-hidden />{t('pack.upToDate')}</p>
      )}
      {data.unpinned && <p className="text-sm text-led-install flex items-start gap-1.5"><AlertTriangle className="size-4 mt-0.5 shrink-0" aria-hidden />{t('pack.unpinnedHint')}</p>}
      {data.mcChange && <p className="text-sm text-led-install flex items-start gap-1.5"><AlertTriangle className="size-4 mt-0.5 shrink-0" aria-hidden />{t('pack.mcChange', { from: data.current?.mcVersion ?? '', to: data.latest?.mcVersion ?? '' })}</p>}
      {progress}
      {job?.step === 'done' && <p className="text-sm text-led-run">{job.message}</p>}
      {job?.step === 'failed' && <p className="text-sm text-led-crash">{t('pack.failed', { message: job.message ?? '' })}</p>}
      {data.updateAvailable && !canUpdate && <p className="text-sm text-dim">{t('pack.noRight')}</p>}
      {button}
      {data.updateAvailable && <p className="text-xs text-dim">{t('pack.updateNote')}</p>}
      {update.error && <ErrorBox>{(update.error as Error).message}</ErrorBox>}
    </section>
  );
}
