import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Sliders, Gamepad2, Cpu, AlertTriangle, FileText, Eye, EyeOff, Copy, Check, Moon, Terminal } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMb } from '../lib/status';
import type { EggVariable, ServerDetail, ServerStatus } from '../lib/types';
import { Button, ErrorBox, Field, Input, Select, Spinner } from './ui';
import { VariableField, visible } from './VariableField';
import { ImportSection } from './ImportSection';
import { MotdEditor } from './MotdEditor';
import { ModpackCard } from './ModpackCard';
import { ConfigFilesManager } from './ConfigFilesManager';
import { copyText } from '../lib/clipboard';
import { t } from '../lib/i18n';

type StartupVar = EggVariable & { value: string; isSet: boolean };
interface StartupInfo {
  startup: string;
  images: Array<{ key: string; label: string; image: string; default: boolean; current: boolean }>;
  variables: StartupVar[];
}

const STOPPED: ServerStatus[] = ['offline', 'crashed', 'install_failed'];

/**
 * Einstellungen eines Servers. Reihenfolge nach Haeufigkeit: Spiel-
 * Einstellungen aendert man oft, Ports selten, Loeschen fast nie.
 * Was einen neuen Container braucht, geht nur im gestoppten Zustand -
 * das sagt die Seite vorher, nicht erst als Fehler nach dem Klick.
 */
type SettingsSection = 'spiel' | 'configs' | 'ressourcen' | 'danger';

export function ServerSettings({ detail, status }: { detail: ServerDetail; status: ServerStatus }) {
  const { server, permissions } = detail;
  const has = (f: string) => permissions.includes(f);
  const { me } = useAuth();
  const isOwnerOrAdmin = me?.user.role === 'admin' || me?.user.id === server.ownerId;
  const stopped = STOPPED.includes(status);
  const [section, setSection] = useState<SettingsSection>('spiel');

  return (
    <div className="max-w-4xl space-y-6">
      {/* Sub-Navigation Reiter in den Einstellungen */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-seam pb-3">
        <button
          type="button"
          onClick={() => setSection('spiel')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition ${
            section === 'spiel'
              ? 'bg-amber text-black font-semibold shadow'
              : 'text-dim hover:text-ink hover:bg-rack-2/60'
          }`}
        >
          <Gamepad2 className="size-4" />
          Spiel-Optionen
        </button>

        <button
          type="button"
          onClick={() => setSection('configs')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition ${
            section === 'configs'
              ? 'bg-amber text-black font-semibold shadow'
              : 'text-dim hover:text-ink hover:bg-rack-2/60'
          }`}
        >
          <Sliders className="size-4" />
          Konfigurationsdateien
        </button>

        <button
          type="button"
          onClick={() => setSection('ressourcen')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition ${
            section === 'ressourcen'
              ? 'bg-amber text-black font-semibold shadow'
              : 'text-dim hover:text-ink hover:bg-rack-2/60'
          }`}
        >
          <Cpu className="size-4" />
          Leistung & Ports
        </button>

        {isOwnerOrAdmin && (
          <button
            type="button"
            onClick={() => setSection('danger')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs sm:text-sm font-medium transition ${
              section === 'danger'
                ? 'bg-red-500/90 text-white font-semibold shadow'
                : 'text-dim hover:text-red-400 hover:bg-rack-2/60'
            }`}
          >
            <AlertTriangle className="size-4" />
            Erweitert
          </button>
        )}
      </div>

      {!stopped && (has('startup.update') || has('allocation.assign') || isOwnerOrAdmin) && section !== 'configs' && (
        <p className="rounded-md border border-led-start/40 bg-led-start/10 px-3 py-2 text-sm">
          {t('settings.stopFirst')}
        </p>
      )}

      {/* Sektion 1: Spiel-Optionen & Allgemein */}
      {section === 'spiel' && (
        <div className="space-y-8 max-w-2xl">
          <General detail={detail} />
          {server.egg?.gameKind === 'minecraft' && has('startup.read') && <ModpackCard serverId={server.id} canUpdate={has('startup.update') && has('backup.create')} />}
          {server.egg?.gameKind === 'minecraft' && has('startup.read') && <MotdEditor serverId={server.id} serverName={server.name} stopped={stopped} canEdit={has('startup.update')} />}
          {has('startup.read') && <Startup serverId={server.id} stopped={stopped} canImage={has('startup.image')} />}
        </div>
      )}

      {/* Sektion 2: Konfigurationsdateien (Formular-Editor) */}
      {section === 'configs' && (
        <ConfigFilesManager serverId={server.id} canWrite={has('file.write')} stopped={stopped} />
      )}

      {/* Sektion 3: Leistung & Ports */}
      {section === 'ressourcen' && (
        <div className="space-y-8 max-w-2xl">
          {isOwnerOrAdmin && <Resources detail={detail} stopped={stopped} />}
          {has('allocation.read') && <Ports detail={detail} stopped={stopped} canAssign={has('allocation.assign')} />}
        </div>
      )}

      {/* Sektion 4: Erweitert / Gefahrenzone */}
      {section === 'danger' && isOwnerOrAdmin && (
        <div className="space-y-8 max-w-2xl">
          <ImportSection serverId={server.id} stopped={stopped} />
          <Danger detail={detail} status={status} />
        </div>
      )}
    </div>
  );
}

function useInvalidate(server: ServerDetail['server']) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['server', server.shortId] });
    void qc.invalidateQueries({ queryKey: ['server', server.id] });
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['startup', server.id] });
  };
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-medium">{title}</h2>
        {hint && <p className="text-sm text-dim mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Saved({ show }: { show: boolean }) {
  return show ? <span className="text-sm text-led-run" role="status">{t('common.saved')}</span> : null;
}

function RconCard({ detail }: { detail: ServerDetail }) {
  const { server } = detail;
  const rconPort = server.rcon?.port ?? server.ports?.find((p) => p.ref === 'rcon')?.port ?? null;
  const rconPass = server.rcon?.password ?? server.variables?.RCON_PASSWORD ?? server.variables?.ADMIN_PASSWORD ?? server.variables?.RCON_PASS ?? null;
  const [showPassword, setShowPassword] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  if (!rconPort && !rconPass) return null;

  const handleCopy = async (field: string, text: string) => {
    await copyText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const host = server.publicHost ?? '127.0.0.1';

  return (
    <div className="rounded-lg border border-seam bg-rack p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="size-4 text-amber" />
          <h3 className="text-sm font-semibold text-ink">RCON-Verbindungsdaten</h3>
        </div>
        <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          Aktiv
        </span>
      </div>
      <p className="text-xs text-dim">
        Wird für die Live-Spielerliste, Kick/Ban, In-Game Admin-Login (<code className="text-amber">/rcon login</code>) und externe RCON-Tools genutzt.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
        <div className="rounded bg-rack-2 border border-seam p-2.5 space-y-1">
          <span className="text-xs text-dim block">Host & Port</span>
          <div className="flex items-center justify-between">
            <span className="text-sm font-mono text-ink">
              {host}:{rconPort ?? '–'}
            </span>
            {rconPort && (
              <button
                type="button"
                onClick={() => handleCopy('port', `${host}:${rconPort}`)}
                title="Adresse kopieren"
                className="p-1 text-dim hover:text-ink rounded transition-colors"
              >
                {copiedField === 'port' ? <Check className="size-3.5 text-led-up" /> : <Copy className="size-3.5" />}
              </button>
            )}
          </div>
        </div>

        <div className="rounded bg-rack-2 border border-seam p-2.5 space-y-1">
          <span className="text-xs text-dim block">RCON-Passwort</span>
          <div className="flex items-center justify-between">
            <span className="text-sm font-mono text-ink">
              {rconPass ? (showPassword ? rconPass : '••••••••••••') : '–'}
            </span>
            {rconPass && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                  className="p-1 text-dim hover:text-ink rounded transition-colors"
                >
                  {showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleCopy('pass', rconPass)}
                  title="Passwort kopieren"
                  className="p-1 text-dim hover:text-ink rounded transition-colors"
                >
                  {copiedField === 'pass' ? <Check className="size-3.5 text-led-up" /> : <Copy className="size-3.5" />}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function General({ detail }: { detail: ServerDetail }) {
  const { server, permissions } = detail;
  const has = (f: string) => permissions.includes(f);
  const invalidate = useInvalidate(server);
  const [name, setName] = useState(server.name);
  const save = useMutation({ mutationFn: (body: Record<string, unknown>) => api(`/servers/${server.id}`, { method: 'PATCH', body }), onSuccess: invalidate });

  return (
    <Section title={t('settings.general')}>
      <Field label={t('settings.name')} htmlFor="name">
        <div className="flex gap-2">
          <Input id="name" value={name} onChange={(e) => setName(e.target.value)} disabled={!has('settings.rename')} maxLength={64} />
          <Button disabled={!has('settings.rename') || name.trim() === server.name || !name.trim()} busy={save.isPending} onClick={() => save.mutate({ name })}>{t('common.save')}</Button>
        </div>
      </Field>

      <div className="space-y-4 pt-2">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1 accent-amber size-4" checked={server.autoRestart} disabled={!has('startup.update') || save.isPending}
            onChange={(e) => save.mutate({ autoRestart: e.target.checked })} />
          <span>
            <span className="block text-ink">{t('settings.autoRestart')}</span>
            <span className="block text-dim">{t('settings.autoRestartHint')}</span>
          </span>
        </label>

        <div className="rounded-lg border border-seam bg-rack/40 p-3.5 space-y-2">
          <div className="flex items-center gap-2">
            <Moon className="size-4 text-sky-400" />
            <span className="text-sm font-medium text-ink">Auto-Sleep (Ruhemodus bei Leerlauf)</span>
          </div>
          <p className="text-xs text-dim">
            Fährt den Server automatisch herunter, wenn für die gewählte Zeitdauer keine Spieler online sind. Gibt 100% RAM und CPU sofort frei. Der Server kann jederzeit per Klick auf „Starten“ wieder aufgeweckt werden.
          </p>
          <div className="flex items-center gap-3 pt-1 max-w-xs">
            <Select
              id="auto-sleep-select"
              value={String(server.autoSleepMinutes ?? 0)}
              disabled={!has('startup.update') || save.isPending}
              onChange={(e) => save.mutate({ autoSleepMinutes: Number(e.target.value) })}
            >
              <option value="0">Deaktiviert (Server bleibt immer an)</option>
              <option value="15">Nach 15 Minuten ohne Spieler</option>
              <option value="30">Nach 30 Minuten ohne Spieler (Empfohlen)</option>
              <option value="60">Nach 60 Minuten ohne Spieler (1 Stunde)</option>
              <option value="120">Nach 120 Minuten ohne Spieler (2 Stunden)</option>
            </Select>
            <Saved show={save.isSuccess} />
          </div>
        </div>

        <RconCard detail={detail} />
      </div>

      {save.error && <ErrorBox>{(save.error as Error).message}</ErrorBox>}
    </Section>
  );
}

function Startup({ serverId, stopped, canImage }: { serverId: string; stopped: boolean; canImage: boolean }) {
  const { data, isLoading } = useQuery({ queryKey: ['startup', serverId], queryFn: () => api<StartupInfo>(`/servers/${serverId}/startup`) });
  if (isLoading || !data) return <Spinner />;
  return <StartupForm info={data} serverId={serverId} stopped={stopped} canImage={canImage} />;
}

function StartupForm({ info, serverId, stopped, canImage }: { info: StartupInfo; serverId: string; stopped: boolean; canImage: boolean }) {
  const qc = useQueryClient();
  const initial = useMemo(() => Object.fromEntries(info.variables.map((v) => [v.env, v.value])), [info]);
  const [vals, setVals] = useState<Record<string, string>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const current = info.images.find((i) => i.current)?.key ?? '';
  const [imageKey, setImageKey] = useState(current);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setVals(initial); setImageKey(current); }, [initial, current]);

  const editable = info.variables.filter((v) => v.editable);
  const dirtyVars = Object.fromEntries(Object.entries(vals).filter(([k, v]) => v !== initial[k] && editable.some((e) => e.env === k)));
  const dirty = Object.keys(dirtyVars).length > 0 || imageKey !== current;

  const save = useMutation({
    mutationFn: () => api<{ changed: string[] }>(`/servers/${serverId}/startup`, { method: 'PATCH', body: {
      ...(Object.keys(dirtyVars).length ? { variables: dirtyVars } : {}),
      ...(imageKey !== current ? { imageKey } : {}),
    } }),
    onSuccess: () => { setErrors({}); setSaved(true); setTimeout(() => setSaved(false), 2500); void qc.invalidateQueries({ queryKey: ['startup', serverId] }); void qc.invalidateQueries({ queryKey: ['events', serverId] }); },
    onError: (e) => { if (e instanceof ApiError && e.issues) setErrors(Object.fromEntries(e.issues.map((i) => [i.variable ?? '', i.message]))); },
  });

  const shown = info.variables.filter((v) => visible(v, vals));
  return (
    <Section title={t('settings.game')} hint={t('settings.gameHint')}>
      {shown.map((v) => (
        <VariableField key={v.env} v={v.editable ? v : { ...v, label: t('settings.setByPanel', { label: v.label }), required: true }} value={vals[v.env] ?? ''} error={errors[v.env]} disabled={!v.editable || !stopped}
          secretSet={v.secret && v.isSet} onChange={(val) => setVals((p) => ({ ...p, [v.env]: val }))} />
      ))}
      {info.images.length > 1 && (
        <Field label={t('settings.runtime')} htmlFor="image" hint={t('settings.runtimeHint')}>
          <Select id="image" value={imageKey} disabled={!canImage || !stopped} onChange={(e) => setImageKey(e.target.value)}>
            {info.images.map((i) => <option key={i.key} value={i.key}>{i.label}{i.default ? ` (${t('common.default')})` : ''}</option>)}
          </Select>
        </Field>
      )}
      {save.error && !(save.error instanceof ApiError && save.error.issues) && <ErrorBox>{(save.error as Error).message}</ErrorBox>}
      <div className="flex items-center justify-end gap-3">
        <Saved show={saved} />
        {dirty && <Button onClick={() => { setVals(initial); setImageKey(current); setErrors({}); }}>{t('common.discard')}</Button>}
        <Button variant="primary" disabled={!dirty || !stopped} busy={save.isPending} onClick={() => save.mutate()}>{t('settings.saveGame')}</Button>
      </div>
    </Section>
  );
}

function Resources({ detail, stopped }: { detail: ServerDetail; stopped: boolean }) {
  const { server } = detail;
  const invalidate = useInvalidate(server);
  const [ram, setRam] = useState(server.limits.ramMb);
  const [cpu, setCpu] = useState(server.limits.cpuPercent);
  const [disk, setDisk] = useState(server.limits.diskMb);
  const [note, setNote] = useState<string | null>(null);
  const ramOptions = useMemo(() => [...new Set([1024, 2048, 3072, 4096, 4608, 6144, 8192, 10240, 12288, 16384, 24576, 32768, server.limits.ramMb])].sort((a, b) => a - b), [server.limits.ramMb]);
  const diskOptions = useMemo(() => [...new Set([5120, 10240, 20480, 40960, 61440, 102400, 204800, server.limits.diskMb])].sort((a, b) => a - b), [server.limits.diskMb]);
  const cpuOptions = useMemo(() => [...new Set([100, 200, 300, 400, 600, 800, server.limits.cpuPercent])].sort((a, b) => a - b), [server.limits.cpuPercent]);
  const dirty = ram !== server.limits.ramMb || cpu !== server.limits.cpuPercent || disk !== server.limits.diskMb;

  const save = useMutation({
    mutationFn: () => api<{ restartNeeded: boolean }>(`/servers/${server.id}/resources`, { method: 'PATCH', body: { ramMb: ram, cpuPercent: cpu, diskMb: disk } }),
    onSuccess: (r) => { invalidate(); setNote(r.restartNeeded ? t('settings.savedRestart') : t('common.savedDot')); },
  });

  return (
    <Section title={t('settings.resources')} hint={stopped ? undefined : t('settings.resourcesLive')}>
      <div className="grid sm:grid-cols-3 gap-4">
        <Field label={t('res.ram')} htmlFor="ram">
          <Select id="ram" value={ram} onChange={(e) => setRam(Number(e.target.value))}>
            {ramOptions.map((r) => <option key={r} value={r}>{formatMb(r)}</option>)}
          </Select>
        </Field>
        <Field label={t('res.cpu')} htmlFor="cpu">
          <Select id="cpu" value={cpu} onChange={(e) => setCpu(Number(e.target.value))}>
            {cpuOptions.map((c) => <option key={c} value={c}>{t('res.cores', { count: c / 100 })}</option>)}
          </Select>
        </Field>
        <Field label={t('res.disk')} htmlFor="disk">
          <Select id="disk" value={disk} onChange={(e) => setDisk(Number(e.target.value))}>
            {diskOptions.map((d) => <option key={d} value={d}>{formatMb(d)}</option>)}
          </Select>
        </Field>
      </div>
      {save.error && <ErrorBox>{(save.error as Error).message}</ErrorBox>}
      {note && <p className="text-sm text-led-run" role="status">{note}</p>}
      <div className="flex justify-end">
        <Button variant="primary" disabled={!dirty} busy={save.isPending} onClick={() => { setNote(null); save.mutate(); }}>{t('settings.saveResources')}</Button>
      </div>
    </Section>
  );
}

const REF_KEY: Record<string, string> = { game: 'ports.ref.game', rcon: 'ports.ref.rcon', query: 'ports.ref.query', web: 'ports.ref.web' };

function Ports({ detail, stopped, canAssign }: { detail: ServerDetail; stopped: boolean; canAssign: boolean }) {
  const { server } = detail;
  const invalidate = useInvalidate(server);
  const [ref, setRef] = useState('');
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'both'>('tcp');
  const [confirm, setConfirm] = useState(false);
  const ports = server.ports ?? [];
  const host = server.publicHost || location.hostname;

  const reallocate = useMutation({ mutationFn: () => api(`/servers/${server.id}/reallocate`, { method: 'POST' }), onSuccess: () => { setConfirm(false); invalidate(); } });
  const add = useMutation({ mutationFn: () => api(`/servers/${server.id}/allocations`, { method: 'POST', body: { ref, protocol } }), onSuccess: () => { setRef(''); invalidate(); } });
  const remove = useMutation({ mutationFn: (port: number) => api(`/servers/${server.id}/allocations/${port}`, { method: 'DELETE' }), onSuccess: invalidate });
  const err = reallocate.error ?? add.error ?? remove.error;

  return (
    <Section title={t('ports.title')} hint={t('ports.hint')}>
      <div className="rounded-lg border border-seam divide-y divide-seam">
        {ports.map((p) => (
          <div key={`${p.port}-${p.protocol}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="font-mono text-[13px]">{host}:{p.port}<span className="text-dim">/{p.protocol}</span></span>
            <span className="flex items-center gap-3">
              <span className="text-dim">{REF_KEY[p.ref ?? ''] ? t(REF_KEY[p.ref ?? '']!) : p.ref ?? '–'}{p.is_primary ? ` · ${t('ports.primary')}` : ''}</span>
              {canAssign && !p.is_primary && !['rcon', 'query', 'web'].includes(p.ref ?? '') && (
                <button aria-label={t('ports.remove', { port: p.port })} disabled={!stopped || remove.isPending} onClick={() => remove.mutate(p.port)}
                  className="text-dim hover:text-led-crash disabled:opacity-40"><Trash2 className="size-4" /></button>
              )}
            </span>
          </div>
        ))}
      </div>
      {canAssign && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <Field label={t('ports.extra')} htmlFor="ref">
              <Input id="ref" value={ref} onChange={(e) => setRef(e.target.value.toLowerCase())} placeholder={t('ports.extraPlaceholder')} className="w-56" />
            </Field>
            <Select aria-label={t('ports.protocol')} value={protocol} onChange={(e) => setProtocol(e.target.value as typeof protocol)} className="w-28">
              <option value="tcp">TCP</option><option value="udp">UDP</option><option value="both">TCP+UDP</option>
            </Select>
            <Button disabled={!stopped || !/^[a-z][a-z0-9_]{1,23}$/.test(ref)} busy={add.isPending} onClick={() => add.mutate()}>{t('common.add')}</Button>
          </div>
          <div className="flex items-center gap-3">
            <Button disabled={!stopped} busy={reallocate.isPending} variant={confirm ? 'danger' : 'quiet'}
              onClick={() => (confirm ? reallocate.mutate() : setConfirm(true))} onBlur={() => setConfirm(false)}>
              {confirm ? t('ports.reallocateConfirm') : t('ports.reallocate')}
            </Button>
            <span className="text-sm text-dim">{t('ports.reallocateHint')}</span>
          </div>
        </div>
      )}
      {err && <ErrorBox>{(err as Error).message}</ErrorBox>}
    </Section>
  );
}

function Danger({ detail, status }: { detail: ServerDetail; status: ServerStatus }) {
  const { server } = detail;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  const remove = useMutation({
    mutationFn: () => api(`/servers/${server.id}${[...STOPPED, 'suspended'].includes(status) ? '' : '?force=true'}`, { method: 'DELETE' }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['servers'] }); navigate('/'); },
  });
  return (
    <section className="space-y-3 rounded-lg border border-led-crash/40 p-4">
      <h2 className="font-medium">{t('danger.title')}</h2>
      <p className="text-sm text-dim">{t('danger.text')}</p>
      <div className="flex gap-2">
        <Input aria-label={t('danger.confirmLabel')} value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={server.name} />
        <Button variant="danger" disabled={confirm !== server.name} busy={remove.isPending} onClick={() => remove.mutate()}>{t('common.delete')}</Button>
      </div>
      {remove.error && <ErrorBox>{(remove.error as Error).message}</ErrorBox>}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm pt-2">
        {server.image && (<><dt className="text-dim">Image</dt><dd className="font-mono text-[13px] break-all">{server.image}</dd></>)}
        <dt className="text-dim">{t('danger.shortId')}</dt><dd className="font-mono text-[13px]">{server.shortId}</dd>
      </dl>
    </section>
  );
}
