import { useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Play, Square, RotateCcw, Zap, ArrowUpCircle, Package, CheckCircle2, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLive } from '../lib/live';
import { usePower, POWER_LABEL, type PowerAction } from '../lib/power';
import { POWER_ALLOWED, STATUS, formatMb } from '../lib/status';
import type { ServerDetail, ServerStatus, TimelineEvent } from '../lib/types';
import { Console, type ConsoleHandle } from '../components/Console';
import { ServerSettings } from '../components/ServerSettings';
import { LogFiles } from '../components/LogFiles';
import { GameLive, useGameStatus } from '../components/GameLive';
import { ModpackCard, useModpack } from '../components/ModpackCard';
import { Players } from '../components/Players';
import { NetHistory } from '../components/NetHistory';
import { FileManager } from '../components/FileManager';
import { BackupManager } from '../components/BackupManager';
import { ScheduleManager } from '../components/ScheduleManager';
import { SubusersManager } from '../components/SubusersManager';
import { Spark } from '../components/Spark';
import { Address } from './ServerList';
import { Button, ErrorBox, Field, Input, Led, Spinner } from '../components/ui';
import { t, fmtDateTime } from '../lib/i18n';
import { Bar } from '../components/Dashboard';
import { Tooltip, InfoTip } from '../components/Tooltip';

const POWER_TOOLTIPS: Record<PowerAction, string> = {
  start: 'Startet den Server-Container und führt anstehende Updates aus.',
  restart: 'Fährt den Server sauber herunter, speichert Spieldaten und startet ihn neu.',
  stop: 'Sendet den sauberen Stopp-Befehl an die Konsole und speichert alle Spieldaten.',
  kill: 'Notfall-Abwürgen per SIGKILL! Sofortiger Abbruch ohne Daten-Speichern. Nur nutzen wenn der Server hängt!',
};

const STATUS_TOOLTIPS: Record<ServerStatus, string> = {
  running: 'Server läuft stabil, nimmt Verbindungen an und ist spielbereit.',
  starting: 'Server fährt hoch und bereitet Dateien oder Steam-Updates vor.',
  stopping: 'Server speichert Chunks & Welten und fährt sauber herunter.',
  offline: 'Server ist gestoppt (0% CPU, 0 MB RAM). Spieldaten sind sicher gesichert.',
  crashed: 'Prozess wurde unerwartet beendet. Siehe Konsole und Zeitachse für Details.',
  installing: 'Server wird initialisiert oder lädt Spieldateien herunter.',
  install_failed: 'Installation ist fehlgeschlagen. Siehe Log oder Neu installieren.',
  suspended: 'Server wurde von einem Administrator gesperrt.',
};

type Tab = 'konsole' | 'spieler' | 'dateien' | 'backups' | 'zeitplaene' | 'mitnutzer' | 'logs' | 'zeitachse' | 'einstellungen';

export function ServerPage() {
  const { id = '' } = useParams();
  const { data, isLoading, error } = useQuery({
    queryKey: ['server', id],
    queryFn: () => api<ServerDetail>(`/servers/${id}`),
  });

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox>{(error as ApiError).status === 404 ? t('server.notFound') : (error as Error).message}</ErrorBox>;
  return <Loaded detail={data!} />;
}

function Loaded({ detail }: { detail: ServerDetail }) {
  const { server, permissions } = detail;
  const has = (f: string) => permissions.includes(f);
  const [tab, setTab] = useState<Tab>(has('control.console') ? 'konsole' : 'zeitachse');
  const consoleRef = useRef<ConsoleHandle>(null);

  const live = useLive(server.id, (lines, meta) => consoleRef.current?.write(lines, meta));
  const status: ServerStatus = live.status ?? server.status;
  const game = useGameStatus(server.id, !!server.egg?.gameKind && status === 'running');
  const power = usePower(server.id);
  const [confirmKill, setConfirmKill] = useState(false);
  const reinstall = useMutation({ mutationFn: () => api(`/servers/${server.id}/reinstall`, { method: 'POST' }) });

  const qc = useQueryClient();
  const modpack = useModpack(server.id, has('startup.read'));
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const updateModpackMutation = useMutation({
    mutationFn: () => api(`/servers/${server.id}/modpack/update`, { method: 'POST', body: {} }),
    onSuccess: () => {
      setShowUpdateModal(false);
      void qc.invalidateQueries({ queryKey: ['modpack', server.id] });
    },
  });

  const modpackInfo = modpack.data;
  const isModpack = !!(modpackInfo?.source || server.modpackName);
  const modpackDisplayName = modpackInfo?.pack?.name || server.modpackName;
  const modpackDisplayVersion = modpackInfo?.current?.name || (server.modpackVersion ? `v${server.modpackVersion}` : null);
  const liveVersionName = (game.data as any)?.ping?.version?.name || game.data?.version;
  const gameDisplayVersion = modpackInfo?.current?.mcVersion || liveVersionName || (server.gameVersion && server.gameVersion !== 'LATEST' ? server.gameVersion : null) || server.gameVersion;
  const serverTypeDisplay = server.serverType && !server.serverType.includes('AUTO_CURSEFORGE') ? server.serverType : null;

  const isUpdatingPack = !!modpackInfo?.job && modpackInfo.job.step !== 'done' && modpackInfo.job.step !== 'failed';
  const canUpdate = (has('startup.update') && has('backup.create')) || has('settings.reinstall');

  const primary = server.ports?.find((p) => p.is_primary) ?? server.ports?.[0];
  const last = live.stats.at(-1);
  const consoleMode = server.egg?.consoleMode ?? 'full';

  const actions: Array<{ a: PowerAction; icon: typeof Play; variant: 'primary' | 'quiet' | 'danger' }> = [
    { a: 'start', icon: Play, variant: 'primary' },
    { a: 'restart', icon: RotateCcw, variant: 'quiet' },
    { a: 'stop', icon: Square, variant: 'quiet' },
    { a: 'kill', icon: Zap, variant: 'danger' },
  ];

  function run(a: PowerAction) {
    if (a === 'kill' && !confirmKill) { setConfirmKill(true); return; }
    setConfirmKill(false);
    power.mutate(a);
  }

  return (
    <div className="max-w-6xl space-y-5">
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-dim hover:text-ink"><ChevronLeft className="size-4" /> {t('server.back')}</Link>

      {/* Kopf: die LED-Leiste zeigt den Zustand ueber die ganze Breite - auch aus dem Augenwinkel erkennbar */}
      <header className="rounded-lg border border-seam bg-rack overflow-hidden">
        <div className={`h-1 ${STATUS[status].led} ${STATUS[status].busy ? 'led-busy' : ''}`} />
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight truncate">{server.name}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-1.5 text-sm text-dim">
              <Tooltip content={STATUS_TOOLTIPS[status] ?? STATUS[status].label} side="bottom">
                <span className="inline-flex items-center gap-2 text-ink cursor-help">
                  <Led status={status} />{STATUS[status].label}
                </span>
              </Tooltip>
              {server.egg && <span>{server.egg.name}</span>}
              {isModpack ? (
                <>
                  <Tooltip content="Aktives Modpack für diesen Server" side="bottom">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-amber/15 text-amber font-medium cursor-help">
                      <Package className="size-3.5" aria-hidden />
                      <span className="truncate max-w-[240px]">{modpackDisplayName}</span>
                      {modpackDisplayVersion && <span className="font-mono opacity-90">({modpackDisplayVersion})</span>}
                    </span>
                  </Tooltip>
                  {gameDisplayVersion && (
                    <Tooltip content="Installierte Spielversion" side="bottom">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-rack-2 text-ink font-mono border border-seam cursor-help">
                        MC {gameDisplayVersion}
                      </span>
                    </Tooltip>
                  )}
                </>
              ) : (
                (gameDisplayVersion || serverTypeDisplay) && (
                  <Tooltip content="Spiel- / Server-Version" side="bottom">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-rack-2 text-ink font-mono border border-seam cursor-help">
                      {serverTypeDisplay ? `${serverTypeDisplay} ` : ''}{gameDisplayVersion ?? ''}
                    </span>
                  </Tooltip>
                )
              )}
              {primary && <Address port={primary.port} host={server.publicHost} />}
              {!live.connected && <span className="text-led-start">{t('server.connecting')}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {canUpdate && status !== 'install_failed' && (
              <Tooltip content={modpackInfo?.updateAvailable ? `Neues Update verfügbar: ${modpackInfo.latest?.name}` : 'Prüft Modpacks und Spielserver auf Updates'} side="bottom">
                <Button
                  variant={modpackInfo?.updateAvailable ? 'primary' : 'quiet'}
                  disabled={isUpdatingPack || status === 'installing'}
                  busy={isUpdatingPack || updateModpackMutation.isPending}
                  onClick={() => setShowUpdateModal(true)}
                  className={modpackInfo?.updateAvailable ? 'ring-2 ring-amber/50 animate-pulse' : ''}
                >
                  <ArrowUpCircle className="size-4" />
                  {isUpdatingPack
                    ? `${t(`pack.step.${modpackInfo?.job?.step}`)}`
                    : modpackInfo?.updateAvailable
                    ? `${t('server.update')}: ${modpackInfo.latest?.name}`
                    : t('server.update')}
                </Button>
              </Tooltip>
            )}
            {status === 'install_failed' && has('settings.reinstall') && (
              <Tooltip content="Startet die Server-Installation von Grund auf neu" side="bottom">
                <Button variant="primary" busy={reinstall.isPending} onClick={() => reinstall.mutate()}>
                  <RotateCcw className="size-4" /> {t('server.reinstall')}
                </Button>
              </Tooltip>
            )}
            {status !== 'install_failed' && actions.filter(({ a }) => has(`control.${a}`)).map(({ a, icon: Icon, variant }) => (
              <Tooltip
                key={a}
                content={a === 'kill' && confirmKill ? 'Bestätige den sofortigen Notfall-Kill ohne Speichern' : POWER_TOOLTIPS[a]}
                side="bottom"
              >
                <Button
                  variant={a === 'kill' && confirmKill ? 'danger' : variant}
                  disabled={!POWER_ALLOWED[a].includes(status) || power.isPending}
                  busy={power.isPending && power.variables === a}
                  onClick={() => run(a)}
                  onBlur={() => a === 'kill' && setConfirmKill(false)}
                >
                  <Icon className="size-4" /> {a === 'kill' && confirmKill ? t('power.killConfirm') : POWER_LABEL[a]}
                </Button>
              </Tooltip>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-8 gap-y-3 border-t border-seam px-5 py-3">
        {(status === 'running' || status === 'starting' || status === 'stopping') && (
          <>
            <div className="flex items-start gap-1">
              <Spark tone="cpu" label="CPU" values={live.stats.map((s) => s.cpuPercent)} max={server.limits.cpuPercent}
                value={last ? t('server.cpuOf', { used: last.cpuPercent.toFixed(0), max: server.limits.cpuPercent }) : '–'} />
              <InfoTip text="CPU-Auslastung bezogen auf die zugewiesenen Kerne. 100% = 1 Kern, 400% = 4 Kerne." side="top" className="mt-0.5" />
            </div>
            <div className="flex items-start gap-1">
              <Spark tone="ram" label="RAM" values={live.stats.map((s) => s.memMb)} max={server.limits.ramMb}
                value={last ? t('server.ramOf', { used: formatMb(last.memMb), max: formatMb(server.limits.ramMb) }) : '–'} />
              <InfoTip text="Aktiver Arbeitsspeicherverbrauch des Spiels im Verhältnis zum Limit." side="top" className="mt-0.5" />
            </div>
          </>
        )}
          <DiskUse used={server.diskUsedMb ?? null} max={server.limits.diskMb} />
          <NetHistory serverId={server.id} />
        </div>
        {server.egg?.gameKind && status === 'running' && game.data?.running && (
          <div className="border-t border-seam px-5 py-3"><GameLive data={game.data} /></div>
        )}
        {server.egg?.gameKind === 'minecraft' && has('startup.read') && (
          <ModpackCard serverId={server.id} canUpdate={has('startup.update') && has('backup.create')} compact />
        )}
      </header>

      {power.error && <ErrorBox>{(power.error as Error).message}</ErrorBox>}
      {reinstall.error && <ErrorBox>{(reinstall.error as Error).message}</ErrorBox>}
      {live.lastError && <ErrorBox>{live.lastError}</ErrorBox>}

      {showUpdateModal && (
        <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) setShowUpdateModal(false); }}>
          <div className="bg-rack border border-seam rounded-lg max-w-lg w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <ArrowUpCircle className="size-5 text-amber" />
                <h2 className="text-lg font-semibold">{t('server.updateTitle')}</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowUpdateModal(false)}
                className="text-dim hover:text-ink text-sm px-2 py-1 rounded"
              >
                ✕
              </button>
            </div>

            {isModpack ? (
              <div className="space-y-3">
                <div className="bg-rack-2/60 border border-seam rounded p-3 text-sm space-y-1">
                  <div className="font-medium text-ink flex items-center gap-1.5">
                    <Package className="size-4 text-amber" />
                    {modpackDisplayName}
                  </div>
                  <div className="text-dim text-xs flex gap-3 pt-1">
                    <span>{t('pack.installed')}: <strong className="text-ink">{modpackDisplayVersion || '–'}</strong></span>
                    {modpackInfo?.latest?.name && (
                      <span>{t('pack.newest')}: <strong className="text-ink">{modpackInfo.latest.name}</strong></span>
                    )}
                  </div>
                </div>

                {modpackInfo?.updateAvailable ? (
                  <>
                    <p className="text-sm text-dim">
                      {t('server.updateModpackConfirm', { version: modpackInfo.latest?.name ?? '' })}
                    </p>
                    {modpackInfo.mcChange && (
                      <p className="text-sm text-led-install flex items-start gap-1.5">
                        <AlertTriangle className="size-4 mt-0.5 shrink-0" />
                        {t('pack.mcChange', { from: modpackInfo.current?.mcVersion ?? '', to: modpackInfo.latest?.mcVersion ?? '' })}
                      </p>
                    )}
                    <div className="flex justify-end gap-2 pt-2">
                      <Button onClick={() => setShowUpdateModal(false)}>{t('common.cancel')}</Button>
                      <Button
                        variant="primary"
                        busy={updateModpackMutation.isPending}
                        onClick={() => updateModpackMutation.mutate()}
                      >
                        <ArrowUpCircle className="size-4" />
                        {t('pack.updateNow')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-led-run flex items-center gap-2">
                      <CheckCircle2 className="size-4" />
                      {t('server.updateUpToDate', { version: modpackDisplayVersion || modpackInfo?.current?.name || 'aktuell' })}
                    </p>
                    <div className="flex justify-end gap-2 pt-2">
                      <Button onClick={() => { void modpack.refetch(); setShowUpdateModal(false); }}>
                        {t('common.close')}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-dim">
                  {t('server.updateRestartNote')}
                </p>
                <div className="text-sm text-dim space-y-1">
                  <div>Spiel: <strong className="text-ink">{server.egg?.name}</strong></div>
                  {gameDisplayVersion && <div>Version: <strong className="text-ink">{gameDisplayVersion}</strong></div>}
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <Button onClick={() => setShowUpdateModal(false)}>{t('common.close')}</Button>
                  {has('control.restart') && (
                    <Button variant="primary" onClick={() => { setShowUpdateModal(false); run('restart'); }}>
                      <RotateCcw className="size-4" />
                      {t('server.updateManual')}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <nav className="flex gap-1 border-b border-seam" role="tablist">
        {([
          ['konsole', 'server.tab.console', 'control.console'],
          ...(server.egg?.gameKind ? [['spieler', 'server.tab.players', 'control.console'] as const] : []),
          ['dateien', 'server.tab.files', 'file.read'],
          ['backups', 'server.tab.backups', 'backup.read'],
          ['zeitplaene', 'server.tab.schedules', 'schedule.read'],
          ['mitnutzer', 'server.tab.subusers', 'subuser.read'],
          ['logs', 'server.tab.logs', 'control.console'],
          ['zeitachse', 'server.tab.timeline', null],
          ['einstellungen', 'server.tab.settings', null],
        ] as const)
          .filter(([, , flag]) => !flag || has(flag))
          .map(([key, label]) => (
            <button
              key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
              className={`px-3 h-10 text-sm -mb-px border-b-2 ${tab === key ? 'border-amber text-ink' : 'border-transparent text-dim hover:text-ink'}`}
            >
              {t(label)}
            </button>
          ))}
      </nav>

      {/* Konsole bleibt eingehaengt, damit beim Tab-Wechsel nichts verloren geht */}
      <div hidden={tab !== 'konsole'}>
        {has('control.console') && (
          <Console
            ref={consoleRef}
            canCommand={live.canCommand && (status === 'running' || status === 'starting')}
            readonlyReason={
              consoleMode !== 'full' ? t('console.noCommands')
                : !live.canCommand ? t('console.onlyRead')
                : t('console.notRunning')
            }
            onCommand={live.sendCommand}
            hints={server.egg?.hints ?? []}
          />
        )}
      </div>
      {tab === 'dateien' && <FileManager serverId={server.id} permissions={permissions} />}
      {tab === 'backups' && <BackupManager serverId={server.id} status={status} permissions={permissions} />}
      {tab === 'zeitplaene' && <ScheduleManager serverId={server.id} canEdit={has('schedule.update')} />}
      {tab === 'mitnutzer' && <SubusersManager serverId={server.id} canManage={has('subuser.create') || has('subuser.update')} />}
      {tab === 'logs' && <LogFiles serverId={server.id} />}
      {tab === 'spieler' && <Players serverId={server.id} status={game.data} canCommand={has('control.command') || has('player.kick') || has('player.ban')} running={status === 'running'} />}
      {tab === 'zeitachse' && <Timeline serverId={server.id} live={live.events} />}
      {tab === 'einstellungen' && <ServerSettings detail={detail} status={status} />}
    </div>
  );
}

/** Belegter Speicher - gemessen alle paar Minuten, darum ohne Verlauf. */
function DiskUse({ used, max }: { used: number | null; max: number }) {
  const pct = used === null ? 0 : used / max;
  return (
    <div className="min-w-44">
      <div className="flex items-center gap-1 text-xs text-dim">
        <span>{t('res.disk')}</span>
        <InfoTip text="Belegter SSD-Speicherplatz für Welten, Saves, Mods und Logs." side="top" />
      </div>
      <div className="text-sm font-medium tabular-nums">{used === null ? t('disk.notMeasured') : t('server.ramOf', { used: formatMb(used), max: formatMb(max) })}</div>
      <Bar pct={pct} className="mt-1.5 w-40" />
      {used !== null && used > max && <div className="text-xs text-led-crash mt-1">{t('disk.overLimit')}</div>}
    </div>
  );
}

/** Art des Ereignisses -> Schluessel in der Sprachdatei (event.*). */
const KIND_KEY: Record<string, string> = {
  status_change: 'status', crash: 'crash', restart_attempt: 'restart', restart_skipped: 'noRestart',
  install_start: 'install', install_done: 'install', install_failed: 'install', create_failed: 'create',
  server_created: 'created', power_failed: 'error', start_failed: 'startError',
  import_start: 'import', import_done: 'import', import_failed: 'import', container_rebuilt: 'container', rebuild_failed: 'container', disk_warning: 'diskWarning',
};

function renderEventSummary(e: TimelineEvent): string {
  const p = e.payload as { code?: string; params?: Record<string, string | number> } | null;
  const code = p?.code;
  if (code) {
    const key = `events.msg.${code}`;
    const translated = t(key, p?.params);
    if (translated !== key) return translated;
  }
  return e.summary;
}

function Timeline({ serverId, live }: { serverId: string; live: TimelineEvent[] }) {
  const { data, isLoading } = useQuery({
    queryKey: ['events', serverId],
    queryFn: () => api<{ events: TimelineEvent[] }>(`/servers/${serverId}/events?limit=100`),
  });
  if (isLoading) return <Spinner />;
  const seen = new Set<number>();
  const all = [...live, ...(data?.events ?? [])].filter((e) => !seen.has(e.id) && seen.add(e.id));
  if (!all.length) return <p className="text-dim text-sm">{t('timeline.empty')}</p>;

  return (
    <ol className="relative border-l border-seam ml-2 space-y-4">
      {all.map((e) => (
        <li key={e.id} className="pl-5 relative">
          <span className={`absolute -left-[5px] top-1.5 size-2.5 rounded-full ${e.severity === 'error' ? 'bg-led-crash' : e.severity === 'warn' ? 'bg-led-start' : 'bg-led-stop'}`} />
          <div className="flex flex-wrap items-baseline gap-x-3 text-sm">
            <time className="text-dim tabular-nums" dateTime={e.ts}>{fmtDateTime(e.ts, { dateStyle: 'short', timeStyle: 'medium' })}</time>
            <span className="text-dim">{KIND_KEY[e.kind] ? t(`event.${KIND_KEY[e.kind]}`) : e.kind}</span>
            {e.actor && <span className="text-dim">{t('timeline.by', { name: e.actor })}</span>}
          </div>
          <p className="text-sm text-ink mt-0.5">{renderEventSummary(e)}</p>
          {Array.isArray((e.payload as { lastLines?: string[] } | null)?.lastLines) && (
            <details className="mt-1.5">
              <summary className="text-xs text-dim cursor-pointer hover:text-ink">{t('timeline.lastLines')}</summary>
              <pre className="mt-1.5 max-h-60 overflow-auto rounded-md bg-[#0F141C] border border-seam p-3 text-xs font-mono text-ink/90">
                {(e.payload as { lastLines: string[] }).lastLines.join('\n')}
              </pre>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}
