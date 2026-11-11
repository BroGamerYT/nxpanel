import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Plus, RefreshCw, Server, Trash2, ChevronLeft } from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox, Field, Input, Spinner } from '../components/ui';
import { t } from '../lib/i18n';
import type { HostRow } from '../lib/types';
import { useFeatures } from '../lib/features';

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
  // Ein Core ist selbst ein Host; andere Cores koppelt das Panel an sich
  const { has } = useFeatures();
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

      {has('gaming') && <GamingModeCard />}
      {has('limits') && <LimitsCard />}
      {has('hosts-add') && <AddHostForm />}
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

interface GamingState {
  active: boolean;
  mode: 'throttle' | 'stop';
  phase: 'off' | 'warning' | 'on';
  since: string | null;
  stopsAt: string | null;
  warnSeconds: number;
  affected: string[];
  canThrottle: boolean;
  maxWarnSeconds: number;
}

/**
 * Gaming-Modus: der Rechner gehoert fuer eine Weile dem Spiel am Rechner. Entweder werden die Server gedrosselt
 * (niedrige Prioritaet, die Spieler merken nichts) oder nach einer Vorwarnung in der Konsole gestoppt und danach
 * wieder gestartet.
 */
function GamingModeCard() {
  const qc = useQueryClient();
  const state = useQuery<GamingState>({ queryKey: ['gaming-mode'], queryFn: () => api('/admin/gaming-mode'), refetchInterval: 3000 });
  const [mode, setMode] = useState<'throttle' | 'stop'>('throttle');
  const [warn, setWarn] = useState(60);
  const [message, setMessage] = useState('');

  const toggle = useMutation({
    mutationFn: (active: boolean) =>
      api<{ restarted?: string[]; failed?: string[] }>('/admin/gaming-mode', {
        method: 'POST',
        body: { active, mode, warnSeconds: mode === 'stop' ? warn : 0, ...(message.trim() ? { message: message.trim() } : {}) },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['gaming-mode'] }),
  });

  const s = state.data;
  const stopsIn = s?.stopsAt ? Math.max(0, Math.round((Date.parse(s.stopsAt) - Date.now()) / 1000)) : null;
  const canThrottle = s?.canThrottle ?? true;

  return (
    <section className="space-y-4 rounded-lg border border-seam bg-rack p-5">
      <div>
        <h2 className="font-medium">Gaming-Modus</h2>
        <p className="text-sm text-dim mt-0.5">
          Du willst am Rechner spielen? Die Server werden entweder gedrosselt, oder nach einer Warnung an die Spieler gestoppt und danach wieder gestartet.
        </p>
      </div>

      {state.isLoading && <Spinner />}
      {state.error && <ErrorBox>{(state.error as Error).message}</ErrorBox>}

      {s?.active ? (
        <div className="rounded-md border border-amber/40 bg-amber/10 px-3 py-2 text-sm">
          <strong>Gaming-Modus ist an</strong> ({s.mode === 'throttle' ? 'Server gedrosselt' : 'Server gestoppt'})
          {s.phase === 'warning' && stopsIn !== null && <> – Vorwarnung läuft, Stopp in {stopsIn} s</>}
          {s.affected.length > 0 && <> · betrifft {s.affected.length} Server</>}
          {s.since && <span className="text-dim"> · seit {new Date(s.since).toLocaleTimeString()}</span>}
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 gap-3">
          <label className={`rounded-md border px-3 py-2 text-sm cursor-pointer ${mode === 'throttle' ? 'border-amber bg-amber/10' : 'border-seam'} ${canThrottle ? '' : 'opacity-50 cursor-not-allowed'}`}>
            <input type="radio" className="mr-2 accent-amber" checked={mode === 'throttle'} disabled={!canThrottle} onChange={() => setMode('throttle')} />
            <strong>Drosseln</strong>
            <span className="block text-dim text-xs mt-0.5">Niedrige Priorität. Die Server laufen weiter, das Spiel am Rechner bekommt Vorrang.</span>
          </label>
          <label className={`rounded-md border px-3 py-2 text-sm cursor-pointer ${mode === 'stop' ? 'border-amber bg-amber/10' : 'border-seam'}`}>
            <input type="radio" className="mr-2 accent-amber" checked={mode === 'stop'} onChange={() => setMode('stop')} />
            <strong>Stoppen mit Vorwarnung</strong>
            <span className="block text-dim text-xs mt-0.5">Die Spieler bekommen eine Meldung in der Konsole, danach werden die Server gestoppt und beim Beenden wieder gestartet.</span>
          </label>
        </div>
      )}

      {!s?.active && mode === 'stop' && (
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Vorwarnung in Sekunden" htmlFor="gm-warn" hint={`0 = sofort stoppen, höchstens ${s?.maxWarnSeconds ?? 300}`}>
            <Input id="gm-warn" type="number" min={0} max={s?.maxWarnSeconds ?? 300} value={warn} onChange={(e) => setWarn(Number(e.target.value))} />
          </Field>
          <Field label="Eigene Meldung (optional)" htmlFor="gm-msg" hint="Erscheint als „say …“ in der Konsole. Leer = Standardtext mit Zeitangabe.">
            <Input id="gm-msg" value={message} maxLength={200} onChange={(e) => setMessage(e.target.value)} placeholder="Der Server macht kurz Pause." />
          </Field>
        </div>
      )}

      {toggle.error && <ErrorBox>{(toggle.error as Error).message}</ErrorBox>}
      {toggle.data && (toggle.data.restarted?.length || toggle.data.failed?.length) ? (
        <p className="text-sm text-dim">
          {toggle.data.restarted?.length ?? 0} Server wieder gestartet{toggle.data.failed?.length ? `, ${toggle.data.failed.length} ließen sich nicht starten` : ''}.
        </p>
      ) : null}

      <div className="flex justify-end">
        {s?.active ? (
          <Button variant="primary" busy={toggle.isPending} onClick={() => toggle.mutate(false)}>Gaming-Modus beenden</Button>
        ) : (
          <Button variant="primary" busy={toggle.isPending} disabled={mode === 'throttle' && !canThrottle} onClick={() => toggle.mutate(true)}>Gaming-Modus einschalten</Button>
        )}
      </div>
    </section>
  );
}

interface LimitsState {
  enforce: boolean;
  supported: boolean;
  driver: string;
}

/**
 * Harte Grenzen fuer Arbeitsspeicher und CPU (Windows-Job-Objects ueber das Hilfsprogramm nxjob.exe).
 * Aus der Voreinstellung: ein Spiel, das mehr braucht als eingetragen, wuerde sonst abstuerzen.
 */
function LimitsCard() {
  const qc = useQueryClient();
  const limits = useQuery<LimitsState>({ queryKey: ['limits'], queryFn: () => api('/admin/limits') });
  const save = useMutation({
    mutationFn: (enforce: boolean) => api('/admin/limits', { method: 'POST', body: { enforce } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['limits'] }),
  });
  const s = limits.data;
  return (
    <section className="space-y-3 rounded-lg border border-seam bg-rack p-5">
      <div>
        <h2 className="font-medium">Ressourcen-Grenzen</h2>
        <p className="text-sm text-dim mt-0.5">
          Setzt den eingetragenen Arbeitsspeicher und die CPU-Zuteilung jedes Servers als harte Grenze durch. Ohne Schalter laufen die Server wie bisher ohne Grenze – sie werden aber immer mit dem Core beendet.
        </p>
      </div>
      {limits.isLoading && <Spinner />}
      {limits.error && <ErrorBox>{(limits.error as Error).message}</ErrorBox>}
      {s && !s.supported && (
        <p className="text-sm text-dim">
          Auf diesem Rechner nicht verfügbar: Dafür braucht es den Windows-Treiber und das gebaute Hilfsprogramm <code className="font-mono">nxjob.exe</code> (Treiber: {s.driver}).
        </p>
      )}
      {s && (
        <label className={`flex items-start gap-2 text-sm ${s.supported ? 'cursor-pointer' : 'opacity-50'}`}>
          <input type="checkbox" className="mt-0.5 size-4 accent-amber" checked={s.enforce} disabled={!s.supported || save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
          <span>
            Grenzen durchsetzen
            <span className="block text-dim text-xs mt-0.5">
              Wirkt ab dem nächsten Start eines Servers. Ein Server, der mehr Speicher braucht als eingetragen, wird dann beendet – Grenzen also erst hoch genug einstellen.
            </span>
          </span>
        </label>
      )}
      {save.error && <ErrorBox>{(save.error as Error).message}</ErrorBox>}
    </section>
  );
}
