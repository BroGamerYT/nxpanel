import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { GameCover } from '../components/GameCover';
import { Search, Copy, Check, LayoutGrid, List as ListIcon, ArrowDown, ArrowUp, Package, FlaskConical } from 'lucide-react';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useAuth } from '../lib/auth';
import { STATUS, formatMb, formatRate } from '../lib/status';
import type { DashboardData, ServerListItem, ServerLive, ServerStatus } from '../lib/types';
import { Dashboard, Bar } from '../components/Dashboard';
import { ErrorBox, Input, Led, Select, Spinner, StatusLabel } from '../components/ui';
import { t } from '../lib/i18n';
import { Tooltip } from '../components/Tooltip';

/**
 * Serverliste als dichte Tabelle statt Kacheln: bei 20 Servern will man
 * Status, Spiel und Adresse auf einen Blick vergleichen, nicht scrollen.
 * Der Status wird alle 5 s aufgefrischt.
 */
export function ServerList() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'alle' | ServerStatus>('alle');
  const [game, setGame] = useState('alle');

  const { data, isLoading, error } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerListItem[] }>('/servers'),
    refetchInterval: 5_000,
  });

  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/dashboard'), refetchInterval: 5_000 });
  const [view, setView] = useState<View>(loadView);
  const pick = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* egal */ } };
  const servers = data?.servers ?? [];
  const liveOf = (id: string) => dash.data?.perServer[id];
  const games = useMemo(() => [...new Set(servers.map((s) => s.eggName))].sort(), [servers]);
  const shown = servers.filter((s) =>
    (statusFilter === 'alle' || s.status === statusFilter) &&
    (game === 'alle' || s.eggName === game) &&
    (!q || `${s.name} ${s.eggName} ${s.ownerName} ${s.primaryPort ?? ''}`.toLowerCase().includes(q.toLowerCase())),
  );
  const running = servers.filter((s) => s.status === 'running').length;

  return (
    <div className="max-w-6xl">
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('servers.title')}</h1>
          {servers.length > 0 && <p className="text-dim text-sm mt-1">{t('servers.runningOf', { running, count: servers.length })}</p>}
        </div>
        <div className="flex items-center gap-2">
        <div role="radiogroup" aria-label={t('servers.view')} className="inline-flex rounded-md border border-seam bg-rack p-0.5">
          {([['list', ListIcon, 'servers.viewList'], ['tiles', LayoutGrid, 'servers.viewTiles']] as const).map(([v, Icon, label]) => (
            <button key={v} role="radio" aria-checked={view === v} title={t(label)} onClick={() => pick(v)}
              className={`grid place-items-center size-8 rounded ${view === v ? 'bg-rack-2 text-ink' : 'text-dim hover:text-ink'}`}>
              <Icon className="size-4" aria-hidden /><span className="sr-only">{t(label)}</span>
            </button>
          ))}
        </div>
        {me?.user.role === 'admin' && (
          <Link
            to="/admin/testbericht"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-md border border-seam bg-rack hover:bg-rack-2 text-ink text-sm font-medium transition-colors"
            title="Spiele-Testbericht aller Egg-Vorlagen ansehen"
          >
            <FlaskConical className="size-4 text-amber" />
            <span className="hidden sm:inline">Testbericht</span>
          </Link>
        )}
        {me?.permissions['server.create'] && (
          <Link to="/neu" className="inline-flex items-center h-9 px-3.5 rounded-md bg-amber text-amber-ink font-semibold text-sm hover:brightness-110">
            {t('servers.create')}
          </Link>
        )}
        </div>
      </header>

      {dash.data && servers.length > 0 && <Dashboard data={dash.data} />}

      {servers.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          <div className="relative flex-1 min-w-52">
            <Search className="size-4 text-dim absolute left-3 top-1/2 -translate-y-1/2" aria-hidden />
            <Input aria-label={t('common.search')} placeholder={t('servers.searchPlaceholder')} value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <Select aria-label={t('servers.col.status')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="w-auto">
            <option value="alle">{t('servers.allStates')}</option>
            {(Object.keys(STATUS) as ServerStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
          </Select>
          {games.length > 1 && (
            <Select aria-label={t('servers.col.game')} value={game} onChange={(e) => setGame(e.target.value)} className="w-auto">
              <option value="alle">{t('servers.allGames')}</option>
              {games.map((g) => <option key={g}>{g}</option>)}
            </Select>
          )}
        </div>
      )}

      {isLoading && <Spinner />}
      {error && <ErrorBox>{t('servers.loadError', { message: (error as Error).message })}</ErrorBox>}

      {!isLoading && servers.length === 0 && (
        <div className="rounded-lg border border-dashed border-seam px-6 py-12 text-center">
          <p className="text-ink font-medium">{t('servers.empty')}</p>
          <p className="text-dim text-sm mt-1">
            {me?.permissions['server.create'] ? t('servers.emptyCreate') : t('servers.emptyInvite')}
          </p>
        </div>
      )}

      {shown.length > 0 && view === 'tiles' && (
        <ul className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {shown.map((s) => <li key={s.id}><Tile s={s} live={liveOf(s.id)} diskMb={dash.data?.diskUsed[s.id]} /></li>)}
        </ul>
      )}

      {shown.length > 0 && view === 'list' && (
        <div className="rounded-lg border border-seam overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-rack text-dim text-left">
              <tr>
                <th className="font-medium px-4 py-2.5">{t('servers.col.name')}</th>
                <th className="font-medium px-4 py-2.5 hidden sm:table-cell">{t('servers.col.game')}</th>
                <th className="font-medium px-4 py-2.5 hidden md:table-cell">{t('servers.col.address')}</th>
                <th className="font-medium px-4 py-2.5 hidden lg:table-cell">{t('servers.col.load')}</th>
                <th className="font-medium px-4 py-2.5 hidden xl:table-cell">{t('res.disk')}</th>
                <th className="font-medium px-4 py-2.5 hidden lg:table-cell">{t('servers.col.owner')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seam">
              {shown.map((s) => (
                <tr key={s.id} className="hover:bg-rack/70">
                  <td className="px-4 py-3">
                    <Link to={`/server/${s.shortId}`} className="flex items-center gap-3 group">
                      <Tooltip content={STATUS[s.status]?.label ?? s.status} side="right">
                        <span className="cursor-help inline-flex"><Led status={s.status} /></span>
                      </Tooltip>
                      <GameCover cover={s.cover} seed={s.eggId ?? s.id} className="w-16 rounded shrink-0 hidden sm:block" />
                      <span className="min-w-0">
                        <span className="block font-medium group-hover:text-amber truncate">{s.name}</span>
                        <span className="block text-xs text-dim">{STATUS[s.status].label}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-dim hidden sm:table-cell">
                    <div className="min-w-0">
                      <span className="block text-ink font-medium">{s.eggName}</span>
                      {s.modpackName ? (
                        <span className="inline-flex items-center gap-1 text-xs text-amber font-medium truncate max-w-[220px]" title={s.modpackName}>
                          <Package className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">{s.modpackName}</span>
                          {s.modpackVersion && <span className="text-dim font-mono">v{s.modpackVersion}</span>}
                        </span>
                      ) : null}
                      {s.gameVersion ? (
                        <span className="block text-xs text-dim font-mono">
                          {s.serverType ? `${s.serverType} ` : ''}{s.gameVersion}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">{s.primaryPort ? <Address port={s.primaryPort} host={s.publicHost} /> : <span className="text-dim">–</span>}</td>
                  <td className="px-4 py-3 text-dim hidden lg:table-cell tabular-nums"><LoadCell s={s} live={liveOf(s.id)} /></td>
                  <td className="px-4 py-3 text-dim hidden xl:table-cell tabular-nums">{dash.data?.diskUsed[s.id] !== undefined ? t('server.ramOf', { used: formatMb(dash.data.diskUsed[s.id]!), max: formatMb(s.diskMb) }) : formatMb(s.diskMb)}</td>
                  <td className="px-4 py-3 text-dim hidden lg:table-cell">{s.isOwner ? t('servers.you') : s.ownerName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {servers.length > 0 && shown.length === 0 && <p className="text-dim text-sm">{t('servers.noMatch')}</p>}
    </div>
  );
}

type View = 'list' | 'tiles';
const VIEW_KEY = 'nxp.serverView';
function loadView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'list'; } catch { return 'list'; }
}

/** Liste: zugeteilter RAM, bei laufenden Servern davor der Verbrauch. */
function LoadCell({ s, live }: { s: ServerListItem; live: ServerLive | undefined }) {
  if (!live) return <>{formatMb(s.ramMb)}</>;
  return (
    <span className="inline-flex items-center gap-3">
      <span>{live.cpuPercent.toFixed(0)} %</span>
      <span>{t('server.ramOf', { used: formatMb(live.memMb), max: formatMb(s.ramMb) })}</span>
    </span>
  );
}

function Tile({ s, live, diskMb }: { s: ServerListItem; live: ServerLive | undefined; diskMb: number | undefined }) {
  const st = STATUS[s.status];
  return (
    <Link to={`/server/${s.shortId}`} className="block rounded-lg border border-seam bg-rack overflow-hidden hover:border-amber/60 group">
      <GameCover cover={s.cover} seed={s.eggId ?? s.id} />
      <div className={`h-1 ${st.led} ${st.busy ? 'led-busy' : ''}`} />
      <div className="p-4 space-y-3">
        <div className="min-w-0">
          <p className="font-medium truncate group-hover:text-amber">{s.name}</p>
          <div className="text-xs text-dim mt-0.5 flex flex-wrap items-center gap-1.5">
            <Tooltip content={st.label} side="top">
              <span className="inline-flex items-center gap-1.5 cursor-help"><Led status={s.status} />{st.label}</span>
            </Tooltip>
            <span>·</span>
            <span>{s.eggName}</span>
            {s.gameVersion && (
              <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-rack-2 text-ink">
                {s.serverType ? `${s.serverType} ` : ''}{s.gameVersion}
              </span>
            )}
          </div>
          {s.modpackName && (
            <p className="text-xs text-amber flex items-center gap-1 mt-1 truncate" title={s.modpackName}>
              <Package className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{s.modpackName}</span>
              {s.modpackVersion && <span className="text-dim font-mono text-[11px] shrink-0">v{s.modpackVersion}</span>}
            </p>
          )}
        </div>
        {s.primaryPort && <p className="font-mono text-[13px] text-dim">{(s.publicHost || window.location.hostname)}:{s.primaryPort}</p>}
        <div className="space-y-2 text-xs">
          <div>
            <div className="flex justify-between text-dim"><span>{t('res.cpu')}</span><span className="tabular-nums">{live ? `${live.cpuPercent.toFixed(0)} % / ${s.cpuPercent} %` : '–'}</span></div>
            <Bar pct={live ? live.cpuPercent / s.cpuPercent : 0} className="mt-1" />
          </div>
          <div>
            <div className="flex justify-between text-dim"><span>{t('res.ram')}</span><span className="tabular-nums">{live ? t('server.ramOf', { used: formatMb(live.memMb), max: formatMb(s.ramMb) }) : formatMb(s.ramMb)}</span></div>
            <Bar pct={live ? live.memMb / s.ramMb : 0} className="mt-1" />
          </div>
          <div>
            <div className="flex justify-between text-dim"><span>{t('res.disk')}</span><span className="tabular-nums">{diskMb !== undefined ? t('server.ramOf', { used: formatMb(diskMb), max: formatMb(s.diskMb) }) : formatMb(s.diskMb)}</span></div>
            <Bar pct={diskMb !== undefined ? diskMb / s.diskMb : 0} className="mt-1" />
          </div>
          {live && (
            <div className="flex gap-4 text-dim tabular-nums">
              <span className="inline-flex items-center gap-1"><ArrowDown className="size-3 text-led-install" aria-label={t('dash.down')} />{formatRate(live.rxRate)}</span>
              <span className="inline-flex items-center gap-1"><ArrowUp className="size-3 text-amber" aria-label={t('dash.up')} />{formatRate(live.txRate)}</span>
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

/** Adresse zum Kopieren - genau das, was man Mitspielern schickt. */
export function Address({ port, host }: { port: number; host?: string | null }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  // Oeffentliche Adresse des Hosts, sonst die, unter der das Panel gerade offen ist.
  const addr = `${host || window.location.hostname}:${port}`;
  return (
    <button
      type="button"
      onClick={async () => {
        setState((await copyText(addr)) ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1800);
      }}
      className="inline-flex items-center gap-1.5 font-mono text-[13px] text-ink hover:text-amber"
      title={state === 'fail' ? t('copy.failTitle') : t('copy.address')}
    >
      {addr}
      {state === 'ok' ? <Check className="size-3.5 text-led-run" /> : state === 'fail' ? <span className="text-xs text-led-crash">{t('copy.failShort')}</span> : <Copy className="size-3.5 text-dim" />}
    </button>
  );
}
