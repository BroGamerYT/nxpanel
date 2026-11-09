import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GameCover } from '../components/GameCover';
import { Search, Copy, Check, LayoutGrid, List as ListIcon, ArrowDown, ArrowUp, Package, FlaskConical, RotateCcw, AlertTriangle, Star, Tag, Play, Square, Activity, CheckSquare, Square as SquareIcon, X } from 'lucide-react';
import { api } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { useAuth } from '../lib/auth';
import { POWER_ALLOWED, STATUS, formatMb, formatRate, formatUptime } from '../lib/status';
import { usePower, POWER_LABEL, type PowerAction } from '../lib/power';
import { useGlobalLive } from '../lib/live';
import { toast } from '../lib/toast';
import type { DashboardData, ServerListItem, ServerLive, ServerStatus } from '../lib/types';
import { Dashboard, Bar } from '../components/Dashboard';
import { DashboardSidebar } from '../components/DashboardSidebar';
import { Button, ErrorBox, Input, Led, Select, Spinner, StatusLabel } from '../components/ui';
import { t } from '../lib/i18n';
import { Tooltip } from '../components/Tooltip';

/**
 * Serverliste als dichte Tabelle statt Kacheln: bei 20 Servern will man
 * Status, Spiel und Adresse auf einen Blick vergleichen, nicht scrollen.
 * Der Status wird alle 5 s aufgefrischt.
 */
export function ServerList() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'alle' | ServerStatus>('alle');
  const [game, setGame] = useState('alle');
  const [tagFilter, setTagFilter] = useState('alle');

  const { data, isLoading, error } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api<{ servers: ServerListItem[] }>('/servers'),
    refetchInterval: 15_000,
  });

  // Panelweiter Live-Strom: bei jedem Ereignis die Listen sofort auffrischen,
  // statt stur alle 5 s nachzufragen. Das Polling oben bleibt als Sicherheitsnetz.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState<PowerAction | null>(null);
  useGlobalLive(() => {
    void qc.invalidateQueries({ queryKey: ['servers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  });

  const toggleAutoStart = useMutation({
    mutationFn: ({ id, autoRestart }: { id: string; autoRestart: boolean }) =>
      api(`/servers/${id}`, { method: 'PATCH', body: { autoRestart } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['servers'] }),
  });

  const toggleFavorite = useMutation({
    mutationFn: ({ id, isFavorite }: { id: string; isFavorite: boolean }) =>
      api(`/servers/${id}`, { method: 'PATCH', body: { isFavorite } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['servers'] }),
  });

  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/dashboard'), refetchInterval: 15_000 });
  const [view, setView] = useState<View>(loadView);
  const pick = (v: View) => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* egal */ } };
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(loadSidebar);
  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    try { localStorage.setItem(SIDEBAR_KEY, String(open)); } catch { /* egal */ }
  };

  const servers = data?.servers ?? [];
  const liveOf = (id: string) => dash.data?.perServer[id];
  const liveMap = useMemo(() => {
    const map = new Map<string, ServerLive>();
    for (const s of servers) {
      const l = liveOf(s.id);
      if (l) map.set(s.id, l);
    }
    return map;
  }, [servers, dash.data]);
  const games = useMemo(() => [...new Set(servers.map((s) => s.eggName))].sort(), [servers]);
  const allTags = useMemo(() => [...new Set(servers.flatMap((s) => s.tags ?? []))].sort(), [servers]);
  const shown = servers.filter((s) =>
    (statusFilter === 'alle' || s.status === statusFilter) &&
    (game === 'alle' || s.eggName === game) &&
    (tagFilter === 'alle' || (s.tags ?? []).includes(tagFilter)) &&
    (!q || `${s.name} ${s.eggName} ${s.ownerName} ${s.primaryPort ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase().includes(q.toLowerCase())),
  );
  const running = servers.filter((s) => s.status === 'running').length;

  // ---- Bulk-Auswahl & Massenaktionen ----
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  const allShownSelected = shown.length > 0 && shown.every((s) => selected.has(s.id));
  const toggleSelectAll = () =>
    setSelected(allShownSelected ? new Set() : new Set(shown.map((s) => s.id)));

  const bulkAction = async (action: PowerAction) => {
    // Nur Server, die diese Aktion erlauben und deren Recht vorhanden ist
    const targets = shown.filter(
      (s) => selected.has(s.id) && s.permissions.includes(`control.${action}`) && POWER_ALLOWED[action].includes(s.status)
    );
    if (targets.length === 0) {
      toast.warn(t('servers.bulkNone', { action: POWER_LABEL[action] }));
      return;
    }
    setBulkBusy(action);
    try {
      const results = await Promise.allSettled(
        targets.map((s) => api(`/servers/${s.id}/power`, { method: 'POST', body: { action } }))
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (failed === 0) toast.success(t('servers.bulkDone', { action: POWER_LABEL[action], count: ok }));
      else toast.warn(t('servers.bulkPartial', { action: POWER_LABEL[action], ok, failed }));
      setSelected(new Set());
    } catch (err) {
      toast.error(t('servers.bulkError'), err instanceof Error ? err.message : undefined);
    } finally {
      setBulkBusy(null);
      void qc.invalidateQueries({ queryKey: ['servers'] });
    }
  };

  return (
    <div className="max-w-[1720px] w-full">
      <header className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('servers.title')}</h1>
          {servers.length > 0 && <p className="text-dim text-sm mt-1">{t('servers.runningOf', { running, count: servers.length })}</p>}
        </div>
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => toggleSidebar(!sidebarOpen)}
          className={`inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
            sidebarOpen
              ? 'border-amber/50 bg-amber/15 text-amber'
              : 'border-seam bg-rack hover:bg-rack-2 text-dim hover:text-ink'
          }`}
          title="Aktivitäten- & Schnellzugriffs-Sidebar ein-/ausklappen"
        >
          <Activity className="size-4" />
          <span className="hidden sm:inline">Aktivitäten</span>
        </button>
        <div role="radiogroup" aria-label={t('servers.view')} className="inline-flex rounded-md border border-seam bg-rack p-0.5">
          {([['list', ListIcon, 'servers.viewList'], ['tiles', LayoutGrid, 'servers.viewTiles']] as const).map(([v, Icon, label]) => (
            <button key={v} role="radio" aria-checked={view === v} title={t(label)} onClick={() => pick(v)}
              className={`grid place-items-center size-8 rounded ${view === v ? 'bg-rack-2 text-ink' : 'text-dim hover:text-ink'}`}>
              <Icon className="size-4" aria-hidden /><span className="sr-only">{t(label)}</span>
            </button>
          ))}
        </div>
        {Boolean(me?.permissions['admin.test_report'] ?? (me?.user.role === 'admin')) && (
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

      <div className="flex gap-6 items-start">
        <div className="flex-1 min-w-0">
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
              {allTags.length > 0 && (
                <Select aria-label="Tag" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className="w-auto">
                  <option value="alle">{t('servers.allTags')}</option>
                  {allTags.map((tg) => <option key={tg} value={tg}>#{tg}</option>)}
                </Select>
              )}
            </div>
          )}

          {isLoading && <Spinner />}
          {error && <ErrorBox>{t('servers.loadError', { message: (error as Error).message })}</ErrorBox>}

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2 mb-4">
              <span className="text-sm text-ink font-medium mr-1">
                {t('servers.bulkSelected', { count: selected.size })}
              </span>
              <Button variant="primary" busy={bulkBusy === 'start'} onClick={() => void bulkAction('start')}>
                <Play className="size-3.5" /> {POWER_LABEL.start}
              </Button>
              <Button variant="quiet" busy={bulkBusy === 'restart'} onClick={() => void bulkAction('restart')}>
                <RotateCcw className="size-3.5" /> {POWER_LABEL.restart}
              </Button>
              <Button variant="quiet" busy={bulkBusy === 'stop'} onClick={() => void bulkAction('stop')}>
                <Square className="size-3.5" /> {POWER_LABEL.stop}
              </Button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="ml-auto inline-flex items-center gap-1 text-sm text-dim hover:text-ink"
              >
                <X className="size-3.5" /> {t('servers.bulkClear')}
              </button>
            </div>
          )}

          {!isLoading && servers.length === 0 && (
            <div className="rounded-xl border border-dashed border-seam/80 bg-rack/30 px-6 py-16 text-center">
              <div className="mx-auto mb-4 grid place-items-center size-14 rounded-2xl bg-rack-2/60 border border-seam">
                <Package className="size-7 text-amber" aria-hidden />
              </div>
              <h2 className="text-ink font-semibold text-lg">{t('servers.empty')}</h2>
              <p className="text-dim text-sm mt-1.5 max-w-md mx-auto">
                {me?.permissions['server.create'] ? t('servers.emptyCreate') : t('servers.emptyInvite')}
              </p>
              {me?.permissions['server.create'] && (
                <Link to="/neu" className="inline-flex items-center gap-2 h-10 px-4 mt-5 rounded-md bg-amber text-amber-ink font-semibold text-sm hover:brightness-110">
                  <Play className="size-4" /> {t('servers.create')}
                </Link>
              )}
            </div>
          )}

          {shown.length > 0 && view === 'tiles' && (
            <ul className={`grid gap-3.5 ${sidebarOpen ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'}`}>
              {shown.map((s) => (
                <li key={s.id}>
                  <Tile
                    s={s}
                    live={liveOf(s.id)}
                    diskMb={dash.data?.diskUsed[s.id]}
                    onToggleAutoStart={(autoRestart) => toggleAutoStart.mutate({ id: s.id, autoRestart })}
                    onToggleFavorite={(isFavorite) => toggleFavorite.mutate({ id: s.id, isFavorite })}
                    onSelectTag={(tg) => setTagFilter((prev) => (prev === tg ? 'alle' : tg))}
                  />
                </li>
              ))}
            </ul>
          )}

          {shown.length > 0 && view === 'list' && (
            <div className="rounded-lg border border-seam overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-rack text-dim text-left">
                  <tr>
                    <th className="px-3 py-2.5 w-8">
                      <button
                        type="button"
                        onClick={toggleSelectAll}
                        title={allShownSelected ? t('servers.bulkClear') : t('servers.bulkSelectAll')}
                        aria-label={allShownSelected ? t('servers.bulkClear') : t('servers.bulkSelectAll')}
                        className="text-dim hover:text-amber"
                      >
                        {allShownSelected ? <CheckSquare className="size-4 text-amber" /> : <SquareIcon className="size-4" />}
                      </button>
                    </th>
                    <th className="font-medium px-3 py-2.5">{t('servers.col.name')}</th>
                    <th className="font-medium px-3 py-2.5 hidden sm:table-cell">{t('servers.col.game')}</th>
                    <th className="font-medium px-3 py-2.5 hidden md:table-cell whitespace-nowrap">{t('servers.col.address')}</th>
                    <th className="font-medium px-3 py-2.5 hidden lg:table-cell whitespace-nowrap">{t('servers.col.load')}</th>
                    <th className="font-medium px-3 py-2.5 hidden xl:table-cell whitespace-nowrap">{t('res.disk')}</th>
                    <th className="font-medium px-3 py-2.5 text-right whitespace-nowrap">{t('files.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-seam">
                  {shown.map((s) => (
                    <tr key={s.id} className={`hover:bg-rack/70 ${selected.has(s.id) ? 'bg-amber/5' : ''}`}>
                      <td className="px-3 py-2.5">
                        <button
                          type="button"
                          onClick={() => toggleSelect(s.id)}
                          aria-label={t('servers.bulkSelectOne', { name: s.name })}
                          className="text-dim hover:text-amber"
                        >
                          {selected.has(s.id) ? <CheckSquare className="size-4 text-amber" /> : <SquareIcon className="size-4" />}
                        </button>
                      </td>
                      <td className="px-3 py-2.5 max-w-[240px]">
                        <div className="flex items-center gap-2 min-w-0">
                          <button
                            type="button"
                            onClick={() => toggleFavorite.mutate({ id: s.id, isFavorite: !s.isFavorite })}
                            title={s.isFavorite ? t('servers.favRemove') : t('servers.favAdd')}
                            className={`shrink-0 p-1 rounded hover:bg-rack-2 transition-colors ${s.isFavorite ? 'text-amber' : 'text-dim/40 hover:text-dim'}`}
                          >
                            <Star className={`size-4 ${s.isFavorite ? 'fill-amber' : ''}`} />
                          </button>
                          <Link to={`/server/${s.shortId}`} className="flex items-center gap-2.5 group min-w-0 flex-1">
                            <Tooltip content={s.status === 'running' && s.startedAt ? `${STATUS[s.status]?.label ?? s.status} (seit ${formatUptime(s.startedAt)})` : (STATUS[s.status]?.label ?? s.status)} side="right">
                              <span className="cursor-help inline-flex shrink-0"><Led status={s.status} /></span>
                            </Tooltip>
                            <GameCover cover={s.cover} seed={s.eggId ?? s.id} className="w-12 rounded shrink-0 hidden sm:block" />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium group-hover:text-amber truncate" title={s.name}>{s.name}</span>
                              {s.unstartable || (s.status === 'crashed' && (s.crashCount ?? 0) >= 5) ? (
                                <span className="inline-flex items-center gap-1 text-xs font-semibold text-led-crash">
                                  <AlertTriangle className="size-3 shrink-0" />
                                  {t('status.unstartable')}
                                </span>
                              ) : (s.crashCount ?? 0) > 0 && (s.status === 'crashed' || s.status === 'starting') ? (
                                <span className="block text-xs text-amber font-medium">
                                  {STATUS[s.status].label} · {t('status.autoStartAttempt', { count: s.crashCount ?? 0 })}
                                </span>
                              ) : (
                                <span className="block text-xs text-dim">
                                  {STATUS[s.status].label}
                                  {s.status === 'running' && s.startedAt ? ` · seit ${formatUptime(s.startedAt)}` : ''}
                                  {!s.isOwner && s.ownerName ? ` · ${s.ownerName}` : ''}
                                </span>
                              )}
                              {s.tags && s.tags.length > 0 && (
                                <span className="flex flex-wrap gap-1 mt-1">
                                  {s.tags.map((tg) => (
                                    <button
                                      key={tg}
                                      type="button"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        setTagFilter((prev) => (prev === tg ? 'alle' : tg));
                                      }}
                                      className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-rack-2 text-dim hover:text-amber border border-seam"
                                    >
                                      #{tg}
                                    </button>
                                  ))}
                                </span>
                              )}
                            </span>
                          </Link>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-dim hidden sm:table-cell max-w-[180px]">
                        <div className="min-w-0">
                          <span className="block text-ink font-medium truncate">{s.eggName}</span>
                          {s.modpackName ? (
                            <span className="inline-flex items-center gap-1 text-xs text-amber font-medium truncate max-w-[170px]" title={s.modpackName}>
                              <Package className="size-3 shrink-0" aria-hidden />
                              <span className="truncate">{s.modpackName}</span>
                              {s.modpackVersion && <span className="text-dim font-mono shrink-0">v{s.modpackVersion}</span>}
                            </span>
                          ) : null}
                          {s.gameVersion ? (
                            <span className="block text-xs text-dim font-mono truncate">
                              {s.serverType ? `${s.serverType} ` : ''}{/^\d+(\.\d+)+$/.test(s.gameVersion) ? `v${s.gameVersion}` : s.gameVersion}
                            </span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 hidden md:table-cell whitespace-nowrap">{s.primaryPort ? <Address port={s.primaryPort} host={s.publicHost} subdomain={s.subdomain} srvRecordEnabled={s.srvRecordEnabled} eggName={s.eggName} /> : <span className="text-dim">–</span>}</td>
                      <td className="px-3 py-2.5 text-dim hidden lg:table-cell tabular-nums whitespace-nowrap"><LoadCell s={s} live={liveOf(s.id)} /></td>
                      <td className="px-3 py-2.5 text-dim hidden xl:table-cell tabular-nums whitespace-nowrap">{dash.data?.diskUsed[s.id] !== undefined ? t('server.ramOf', { used: formatMb(dash.data.diskUsed[s.id]!), max: formatMb(s.diskMb) }) : formatMb(s.diskMb)}</td>
                      <td className="px-3 py-2.5 text-right whitespace-nowrap">
                        <QuickPowerButtons s={s} compact />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {servers.length > 0 && shown.length === 0 && <p className="text-dim text-sm mt-3">{t('servers.noMatch')}</p>}
        </div>

        {sidebarOpen && servers.length > 0 && (
          <>
            {/* Desktop Sticky Sidebar */}
            <div className="hidden lg:block sticky top-6">
              <DashboardSidebar
                servers={servers}
                liveMap={liveMap}
                onClose={() => toggleSidebar(false)}
              />
            </div>

            {/* Mobile / Tablet Drawer */}
            <div className="fixed inset-0 z-50 lg:hidden">
              <div
                className="fixed inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in"
                onClick={() => toggleSidebar(false)}
              />
              <div className="fixed inset-y-0 right-0 w-80 max-w-[85vw] bg-rack border-l border-seam p-4 shadow-2xl z-50 overflow-y-auto animate-in slide-in-from-right duration-200">
                <DashboardSidebar
                  servers={servers}
                  liveMap={liveMap}
                  onClose={() => toggleSidebar(false)}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QuickPowerButtons({ s, compact = false }: { s: ServerListItem; compact?: boolean }) {
  const power = usePower(s.id);
  if (s.status === 'install_failed' || s.suspended) return null;

  const buttons: Array<{ a: PowerAction; icon: typeof Play; activeClass: string }> = [
    { a: 'start', icon: Play, activeClass: 'bg-amber text-amber-ink border-amber font-semibold hover:brightness-110' },
    { a: 'restart', icon: RotateCcw, activeClass: 'bg-rack-2 text-ink border-seam hover:border-amber/60 hover:text-amber' },
    { a: 'stop', icon: Square, activeClass: 'bg-rack-2 text-ink border-seam hover:border-rose/60 hover:text-rose' },
  ];

  const allowedButtons = buttons.filter((b) => s.permissions.includes(`control.${b.a}`));
  if (allowedButtons.length === 0) return null;

  return (
    <div
      className={`flex items-center gap-1.5 ${compact ? 'justify-end' : 'pt-1'}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {allowedButtons.map(({ a, icon: Icon, activeClass }) => {
        const enabled = POWER_ALLOWED[a].includes(s.status) && !power.isPending;
        const isBusy = power.isPending && power.variables === a;
        return (
          <button
            key={a}
            type="button"
            disabled={!enabled}
            title={POWER_LABEL[a]}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              power.mutate(a);
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded border text-xs transition-all ${
              compact ? 'h-7 px-2' : 'flex-1 h-8 px-2.5'
            } ${
              enabled
                ? activeClass
                : 'bg-rack-2/40 text-dim/40 border-seam/50 cursor-not-allowed'
            }`}
          >
            <Icon className={`size-3.5 shrink-0 ${isBusy ? 'animate-spin' : ''}`} />
            {!compact && <span className="truncate">{POWER_LABEL[a]}</span>}
            {compact && a === 'start' && <span className="hidden sm:inline">{POWER_LABEL[a]}</span>}
          </button>
        );
      })}
    </div>
  );
}

type View = 'list' | 'tiles';
const VIEW_KEY = 'nxp.serverView';
function loadView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'tiles' ? 'tiles' : 'list'; } catch { return 'list'; }
}

const SIDEBAR_KEY = 'nxp.dashSidebar';
function loadSidebar(): boolean {
  try {
    const saved = localStorage.getItem(SIDEBAR_KEY);
    if (saved !== null) return saved === 'true';
    return typeof window !== 'undefined' && window.innerWidth >= 1280;
  } catch {
    return true;
  }
}

/** Liste: zugeteilter RAM, bei laufenden Servern davor der Verbrauch. */
function LoadCell({ s, live }: { s: ServerListItem; live: ServerLive | undefined }) {
  if (!live) return <>{formatMb(s.ramMb)}</>;
  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap">
      <span className="text-ink font-medium">{live.cpuPercent.toFixed(0)} %</span>
      <span>·</span>
      <span>{t('server.ramOf', { used: formatMb(live.memMb), max: formatMb(s.ramMb) })}</span>
    </span>
  );
}

function Tile({
  s,
  live,
  diskMb,
  onToggleAutoStart,
  onToggleFavorite,
  onSelectTag,
}: {
  s: ServerListItem;
  live: ServerLive | undefined;
  diskMb: number | undefined;
  onToggleAutoStart: (next: boolean) => void;
  onToggleFavorite: (next: boolean) => void;
  onSelectTag: (tag: string) => void;
}) {
  const st = STATUS[s.status];
  const isUnstartable = !!(s.unstartable || (s.status === 'crashed' && (s.crashCount ?? 0) >= 5));
  const autoRestart = s.autoRestart ?? true;
  const canToggleAuto = s.permissions.includes('startup.update') || s.permissions.includes('control.start');

  return (
    <Link
      to={`/server/${s.shortId}`}
      className={`block rounded-lg border bg-rack overflow-hidden hover:border-amber/60 group ${
        isUnstartable ? 'border-led-crash/60 ring-1 ring-led-crash/30' : 'border-seam'
      }`}
    >
      <div className="relative">
        <GameCover cover={s.cover} seed={s.eggId ?? s.id} />
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onToggleFavorite(!s.isFavorite);
          }}
          title={s.isFavorite ? t('servers.favRemove') : t('servers.favAdd')}
          className={`absolute top-2 right-2 size-7 rounded-md flex items-center justify-center backdrop-blur-sm border transition-colors ${
            s.isFavorite
              ? 'bg-abyss/80 text-amber border-amber/40'
              : 'bg-abyss/60 text-dim hover:text-ink border-seam/60'
          }`}
        >
          <Star className={`size-3.5 ${s.isFavorite ? 'fill-amber' : ''}`} />
        </button>
      </div>
      <div className={`h-1 ${st.led} ${st.busy ? 'led-busy' : ''}`} />
      <div className="p-4 space-y-3">
        <div className="min-w-0">
          <div className="flex items-start justify-between gap-2">
            <p className="font-medium truncate group-hover:text-amber">{s.name}</p>
            {canToggleAuto && (
              <Tooltip content={t('status.autoStartHint')} side="top">
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onToggleAutoStart(!autoRestart);
                  }}
                  className={`shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border transition-colors ${
                    autoRestart
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20'
                      : 'bg-rack-2 text-dim border-seam hover:text-ink'
                  }`}
                >
                  <RotateCcw className="size-3" />
                  {autoRestart ? t('status.autoStartOn') : t('status.autoStartOff')}
                </button>
              </Tooltip>
            )}
          </div>
          <div className="text-xs text-dim mt-1 flex flex-wrap items-center gap-1.5">
            {isUnstartable ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-led-crash/15 text-led-crash border border-led-crash/40 font-semibold">
                <AlertTriangle className="size-3 shrink-0" />
                {t('status.unstartable')}
              </span>
            ) : (
              <Tooltip content={s.status === 'running' && s.startedAt ? `Gestartet: ${new Date(s.startedAt).toLocaleString()} · Laufzeit: ${formatUptime(s.startedAt)}` : st.label} side="top">
                <span className="inline-flex items-center gap-1.5 cursor-help">
                  <Led status={s.status} />
                  <span>{st.label}</span>
                  {s.status === 'running' && s.startedAt && (
                    <span className="text-[11px] text-emerald-400 font-mono">
                      ({formatUptime(s.startedAt)})
                    </span>
                  )}
                </span>
              </Tooltip>
            )}
            {!isUnstartable && (s.crashCount ?? 0) > 0 && (s.status === 'crashed' || s.status === 'starting') && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber/15 text-amber font-medium">
                {t('status.autoStartAttempt', { count: s.crashCount ?? 0 })}
              </span>
            )}
            <span>·</span>
            <span>{s.eggName}</span>
            {s.gameVersion && (
              <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-rack-2 text-ink">
                {s.serverType ? `${s.serverType} ` : ''}{/^\d+(\.\d+)+$/.test(s.gameVersion) ? `v${s.gameVersion}` : s.gameVersion}
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
          {s.tags && s.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {s.tags.map((tg) => (
                <button
                  key={tg}
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectTag(tg);
                  }}
                  className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-rack-2 text-dim hover:text-amber border border-seam"
                >
                  <Tag className="size-2.5" /> {tg}
                </button>
              ))}
            </div>
          )}
        </div>
        {s.primaryPort && <p className="font-mono text-[13px] text-dim">{(s.publicHost || window.location.hostname)}:{s.primaryPort}</p>}
        <QuickPowerButtons s={s} />
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
export function Address({
  port,
  host,
  subdomain,
  srvRecordEnabled,
  eggName,
}: {
  port: number;
  host?: string | null;
  subdomain?: string | null;
  srvRecordEnabled?: boolean;
  eggName?: string | null;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');

  const isSrv = Boolean(
    srvRecordEnabled !== false &&
    eggName &&
    (/minecraft|paper|purpur|fabric|forge/i.test(eggName) || /teamspeak|ts3/i.test(eggName) || /terraria/i.test(eggName))
  );

  let addr = `${host || window.location.hostname}:${port}`;
  let isSub = false;

  if (subdomain) {
    const baseDomain = host && !/^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : '';
    const fqdn = subdomain.includes('.') ? subdomain : (baseDomain ? `${subdomain}.${baseDomain}` : subdomain);
    if (isSrv) {
      addr = fqdn;
      isSub = true;
    } else {
      addr = `${fqdn}:${port}`;
      isSub = true;
    }
  }

  return (
    <button
      type="button"
      onClick={async () => {
        setState((await copyText(addr)) ? 'ok' : 'fail');
        setTimeout(() => setState('idle'), 1800);
      }}
      className="inline-flex items-center gap-1.5 font-mono text-[13px] text-ink hover:text-amber"
      title={state === 'fail' ? t('copy.failTitle') : (isSub && isSrv ? 'Direktadresse (SRV ohne Port)' : t('copy.address'))}
    >
      <span className={isSub ? 'text-amber font-semibold' : ''}>{addr}</span>
      {isSub && isSrv && (
        <span className="text-[10px] px-1 py-0.2 rounded bg-emerald-500/20 text-emerald-400 font-sans border border-emerald-500/30">
          SRV
        </span>
      )}
      {state === 'ok' ? <Check className="size-3.5 text-led-run" /> : state === 'fail' ? <span className="text-xs text-led-crash">{t('copy.failShort')}</span> : <Copy className="size-3.5 text-dim" />}
    </button>
  );
}
