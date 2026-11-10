import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Plus, RefreshCw, Server, Trash2, ChevronLeft } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input, Spinner } from '../components/ui';
import { t } from '../lib/i18n';
import type { HostRow } from '../lib/types';

/**
 * Hosts (nur Admins): der lokale Rechner und die gekoppelten NexusCores.
 *
 * Ein Core-Host ist ein Rechner, auf dem der Core laeuft und die
 * Gameserver starten koennen. Der Core wird ueber seine Adresse und sein
 * Token gekoppelt - das Token wird verschluesselt gespeichert und nie
 * wieder angezeigt.
 */
export function Hosts() {
  const qc = useQueryClient();
  const hosts = useQuery({
    queryKey: ['hosts'],
    queryFn: () => api<{ hosts: HostRow[] }>('/admin/hosts'),
    refetchInterval: 10_000,
  });

  const check = useMutation({
    mutationFn: (id: string) => api(`/admin/hosts/${id}/check`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hosts'] }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/admin/hosts/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['hosts'] }),
  });

  return (
    <div className="max-w-5xl space-y-10">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-dim hover:text-amber transition-colors"
      >
        <ChevronLeft className="size-4" />
        Zurück zum Admin-Hub
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{t('hosts.title')}</h1>
        <p className="text-dim text-sm mt-1">{t('hosts.intro')}</p>
      </header>

      {hosts.isLoading && <Spinner />}
      {hosts.error && <ErrorBox>{(hosts.error as Error).message}</ErrorBox>}

      <section className="space-y-3">
        <h2 className="font-medium">{t('hosts.list')}</h2>
        {hosts.data && hosts.data.hosts.length === 0 && <p className="text-sm text-dim">{t('hosts.none')}</p>}
        {hosts.data?.hosts.map((host) => (
          <HostCard
            key={host.id}
            host={host}
            busy={check.isPending || remove.isPending}
            onCheck={() => check.mutate(host.id)}
            onRemove={() => {
              if (confirm(t('hosts.removeConfirm'))) remove.mutate(host.id);
            }}
          />
        ))}
        {check.error && <ErrorBox>{(check.error as Error).message}</ErrorBox>}
        {remove.error && <ErrorBox>{(remove.error as Error).message}</ErrorBox>}
      </section>

      <AddHostForm />
    </div>
  );
}

function HostCard({
  host,
  busy,
  onCheck,
  onRemove,
}: {
  host: HostRow;
  busy: boolean;
  onCheck: () => void;
  onRemove: () => void;
}) {
  const statusColor =
    host.status === 'online'
      ? 'bg-led-run'
      : host.status === 'unreachable'
        ? 'bg-led-crash'
        : host.status === 'offline'
          ? 'bg-led-stop'
          : 'bg-led-start';

  const ramPct = host.ramTotalMb > 0 ? Math.round((host.ramUsedMb / host.ramTotalMb) * 100) : 0;

  return (
    <div className="rounded-lg border border-seam bg-rack p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-2.5 rounded-full shrink-0 ${statusColor}`} aria-hidden />
            <span className="font-medium truncate">{host.name}</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded bg-rack-2 border border-seam text-dim font-mono">
              {host.type === 'core' ? t('hosts.typeCore') : t('hosts.typeLocal')}
            </span>
          </div>
          <div className="text-xs text-dim mt-1 font-mono truncate">
            {host.address ?? t('hosts.localAddress')}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="quiet" busy={busy} onClick={onCheck} title={t('hosts.check')}>
            <RefreshCw className="size-3.5" /> {t('hosts.check')}
          </Button>
          {host.type === 'core' && (
            <Button variant="quiet" busy={busy} onClick={onRemove} title={t('hosts.remove')}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 text-xs">
        <div>
          <dt className="text-dim uppercase tracking-wider">{t('hosts.runtime')}</dt>
          <dd className="mt-0.5 font-mono">{host.runtime}</dd>
        </div>
        <div>
          <dt className="text-dim uppercase tracking-wider">{t('hosts.cpu')}</dt>
          <dd className="mt-0.5">{host.cpuPercent.toFixed(1)} %</dd>
        </div>
        <div>
          <dt className="text-dim uppercase tracking-wider">{t('hosts.ram')}</dt>
          <dd className="mt-0.5">
            {host.ramUsedMb} / {host.ramTotalMb} MB
            {host.ramTotalMb > 0 && <span className="text-dim"> ({ramPct} %)</span>}
          </dd>
        </div>
        <div>
          <dt className="text-dim uppercase tracking-wider">{t('hosts.servers')}</dt>
          <dd className="mt-0.5 flex items-center gap-1">
            <Server className="size-3.5 text-dim" /> {host.servers}
          </dd>
        </div>
      </dl>

      {host.lastSeenAt && (
        <p className="text-[11px] text-dim mt-3 flex items-center gap-1">
          <HardDrive className="size-3" /> {t('hosts.lastSeen')}: {new Date(host.lastSeenAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function AddHostForm() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [pin, setPin] = useState('');

  const create = useMutation({
    mutationFn: () =>
      api<{ host: HostRow }>('/admin/hosts', {
        method: 'POST',
        body: {
          name: name.trim(),
          address: address.trim(),
          token,
          ...(pin.trim() ? { pin: pin.trim() } : {}),
        },
      }),
    onSuccess: () => {
      setName('');
      setAddress('');
      setToken('');
      setPin('');
      void qc.invalidateQueries({ queryKey: ['hosts'] });
    },
  });

  return (
    <section className="space-y-5 rounded-lg border border-seam bg-rack p-5">
      <div>
        <h2 className="font-medium flex items-center gap-2">
          <Plus className="size-5 text-amber" /> {t('hosts.addTitle')}
        </h2>
        <p className="text-sm text-dim mt-0.5">{t('hosts.addIntro')}</p>
      </div>

      <div className="grid sm:grid-cols-2 gap-5">
        <Field label={t('hosts.name')} htmlFor="hostName">
          <Input id="hostName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Spiel-PC" />
        </Field>
        <Field label={t('hosts.address')} htmlFor="hostAddress" hint={t('hosts.addressHint')}>
          <Input
            id="hostAddress"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="http://192.168.1.50:8443"
          />
        </Field>
        <Field label={t('hosts.token')} htmlFor="hostToken" hint={t('hosts.tokenHint')}>
          <Input id="hostToken" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="NEXUSCORE_TOKEN" />
        </Field>
        <Field label={t('hosts.pin')} htmlFor="hostPin" hint={t('hosts.pinHint')}>
          <Input id="hostPin" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="ABC-DEF" />
        </Field>
      </div>

      {create.error && <ErrorBox>{(create.error as Error).message}</ErrorBox>}

      <div className="flex justify-end">
        <Button
          variant="primary"
          busy={create.isPending}
          disabled={!name.trim() || !address.trim() || !token}
          onClick={() => create.mutate()}
        >
          {t('hosts.add')}
        </Button>
      </div>
    </section>
  );
}
