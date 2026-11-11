import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate, useLocation } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Server, LogOut, Plus, Users, Search, Shield,
  HelpCircle, Bell, Menu, X, AlertTriangle, CheckCircle2, Info, CheckCheck, Eye,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { useFeatures } from '../lib/features';
import { seenVersion, type About } from '../lib/version';
import { t, fmtDateTime } from '../lib/i18n';
import { LanguagePicker } from './LanguagePicker';
import { CommandPalette } from './CommandPalette';
import { GlobalTaskProgress } from './GlobalTaskProgress';
import { UserAvatar } from './UserAvatar';
import { Spinner } from './ui';

interface NotificationItem {
  id: number;
  serverId: string;
  serverName: string;
  shortId: string;
  ts: string;
  kind: string;
  severity: 'info' | 'warn' | 'error';
  summary: string;
}

const NOTIF_SEEN_KEY = 'nxp.notifSeenId';

function NotificationBell() {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [seenId, setSeenId] = useState<number>(() => Number(localStorage.getItem(NOTIF_SEEN_KEY) ?? 0));
  const ref = useRef<HTMLDivElement>(null);

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: NotificationItem[] }>('/notifications'),
    refetchInterval: 20_000,
  });

  const items = data?.items ?? [];
  const maxId = items.reduce((m, i) => Math.max(m, i.id), 0);
  const unread = items.filter((i) => i.id > seenId).length;

  const markAllRead = () => {
    if (maxId > 0) {
      localStorage.setItem(NOTIF_SEEN_KEY, String(maxId));
      setSeenId(maxId);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center size-8 rounded-md text-dim hover:text-ink hover:bg-rack-2/60 transition-colors"
        title={t('notif.title')}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-amber text-abyss text-[10px] font-bold flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed md:absolute right-2 md:right-auto md:left-0 top-12 md:top-10 z-50 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-seam bg-rack shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-seam bg-rack-2/40">
            <span className="text-xs font-semibold text-ink">{t('notif.title')}</span>
            {unread > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="inline-flex items-center gap-1 text-[11px] text-amber hover:underline"
              >
                <CheckCheck className="size-3.5" /> {t('notif.markAllRead')}
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto divide-y divide-seam/60">
            {items.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-dim">{t('notif.empty')}</div>
            ) : (
              items.map((item) => {
                const isUnread = item.id > seenId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      markAllRead();
                      setOpen(false);
                      nav(`/server/${item.shortId || item.serverId}`);
                    }}
                    className={`w-full text-left px-3 py-2.5 hover:bg-rack-2/60 transition-colors flex items-start gap-2.5 ${isUnread ? 'bg-amber/5' : ''}`}
                  >
                    {item.severity === 'error' ? (
                      <AlertTriangle className="size-4 text-rose shrink-0 mt-0.5" />
                    ) : item.severity === 'warn' ? (
                      <AlertTriangle className="size-4 text-amber shrink-0 mt-0.5" />
                    ) : item.kind === 'install_done' || item.kind === 'backup_done' ? (
                      <CheckCircle2 className="size-4 text-mint shrink-0 mt-0.5" />
                    ) : (
                      <Info className="size-4 text-sky-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-ink truncate">{item.serverName}</span>
                        <span className="text-[10px] text-dim shrink-0">
                          {fmtDateTime(item.ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-xs text-dim line-clamp-2 mt-0.5">{item.summary}</div>
                    </div>
                    {isUnread && <span className="size-2 rounded-full bg-amber shrink-0 mt-1.5" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Versionsnummer unten links; Punkt, solange "Was ist neu" fuer diese Version noch nicht geoeffnet wurde. */
function VersionLink({ mobile = false }: { mobile?: boolean }) {
  const { data } = useQuery({ queryKey: ['about'], queryFn: () => api<About>('/about'), staleTime: 5 * 60_000 });
  const features = useFeatures();
  const [seen, setSeen] = useState(seenVersion());
  useEffect(() => {
    const f = () => setSeen(seenVersion());
    window.addEventListener('nxp-version-seen', f);
    return () => window.removeEventListener('nxp-version-seen', f);
  }, []);
  if (!data) return null;
  // "Was ist neu" liegt auf der Hilfe-Seite. Gibt es sie nicht, ist die Version nur Text,
  // und der Punkt "neu" liesse sich nie wegklicken.
  const canOpen = features.has('help');
  const fresh = canOpen && seen !== data.version;
  const hasUpdate = Boolean(data.update?.hasUpdate);
  const built = data.builtAt ? fmtDateTime(data.builtAt, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
  const className = `${mobile ? 'flex' : 'hidden lg:flex'} items-center gap-2 px-3 py-1 text-xs text-dim hover:text-ink`;
  const title = built ? t('version.builtTitle', { date: built }) : t('version.whatsNew');
  const content = (
    <>
      <span className="font-mono">v{data.version}</span>
      <span>{data.dev ? 'dev' : t('version.build', { build: data.build ?? '' })}</span>
      {hasUpdate ? (
        <span className="ml-auto inline-flex items-center gap-1 text-amber font-semibold bg-amber/15 px-1.5 py-0.5 rounded text-[11px]">
          <span className="size-1.5 rounded-full bg-amber animate-pulse" aria-hidden />
          {t('version.update')}
        </span>
      ) : fresh ? (
        <span className="ml-auto inline-flex items-center gap-1 text-amber"><span className="size-1.5 rounded-full bg-amber" aria-hidden />{t('version.new')}</span>
      ) : null}
    </>
  );
  return canOpen ? (
    <Link to="/hilfe?tab=neu" title={title} className={className}>{content}</Link>
  ) : (
    <div title={title} className={className}>{content}</div>
  );
}

/**
 * Rahmen: responsive Seitenleiste (Handy: Drawer, Tablet: kompakte Icon-Leiste, Desktop: volle Breite).
 */
export function Shell() {
  const nav = useNavigate();
  const loc = useLocation();
  const { me, logout, impersonatorAdmin, stopImpersonation } = useAuth();
  const canCreate = me?.permissions['server.create'];
  const features = useFeatures();
  const hasAdminAccess = Boolean(
    me?.user.role === 'admin' || Object.keys(me?.permissions ?? {}).some((k) => k.startsWith('admin.'))
  );
  const isAdminActive =
    loc.pathname === '/admin' ||
    loc.pathname.startsWith('/admin/') ||
    loc.pathname === '/netzwerk' ||
    loc.pathname.startsWith('/netzwerk/');
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Live-Präsenz: meldet automatisch alle 20s und bei Routenwechsel, wo sich der Nutzer aufhaelt
  useEffect(() => {
    if (!me) return;
    const sendPing = () => {
      const match = loc.pathname.match(/^\/server\/([0-9a-f-]{36})/i);
      const serverId = match ? match[1] : undefined;
      void api('/presence/ping', {
        method: 'POST',
        body: { path: loc.pathname, serverId },
      }).catch(() => {});
    };

    sendPing();
    const interval = setInterval(sendPing, 20_000);
    return () => clearInterval(interval);
  }, [loc.pathname, me]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const link = ({ isActive }: { isActive: boolean }) =>
    `flex items-center md:justify-center lg:justify-start gap-2.5 rounded-md px-3 h-10 md:h-9 text-sm transition-colors ${
      isActive ? 'bg-rack-2 text-ink font-medium' : 'text-dim hover:text-ink hover:bg-rack-2/60'
    }`;

  const closeMobile = () => setMobileMenuOpen(false);

  return (
    <div className="min-h-full flex flex-col">
      {/* Impersonation-Banner wenn aktiv */}
      {impersonatorAdmin && me && me.user.id !== impersonatorAdmin.id && me.user.username !== impersonatorAdmin.username && (
        <div className="sticky top-0 z-50 bg-amber text-black px-4 py-2.5 text-xs font-semibold flex flex-wrap items-center justify-between gap-3 shadow-lg border-b border-black/20">
          <div className="flex items-center gap-2">
            <Eye className="size-4 shrink-0" />
            <span>
              Du betrachtest das Panel isoliert als <strong className="underline">{me?.user.username}</strong> ({t(`role.${me?.user.role ?? 'user'}`)}). Alle Instanzen, Server & Rechte entsprechen exakt diesem Nutzer.
            </span>
          </div>
          <button
            type="button"
            onClick={async () => {
              await stopImpersonation();
              nav('/admin/users');
            }}
            className="px-3 py-1 rounded bg-black text-amber hover:bg-black/85 font-bold transition-all text-xs shrink-0 cursor-pointer ml-auto"
          >
            Sichtprüfung beenden (Zurück zu {impersonatorAdmin.username}) ✕
          </button>
        </div>
      )}

      <div className="flex-1 md:grid md:grid-cols-[68px_1fr] lg:grid-cols-[220px_1fr]">
        {/* Desktop & Tablet Sidebar */}
      <aside className="hidden md:flex flex-col border-r border-seam bg-rack px-2 lg:px-3 py-4 md:h-screen md:sticky md:top-0 z-30">
        <div className="flex items-center justify-center lg:justify-between gap-2 px-1 lg:px-2 mb-4">
          <Link to="/" className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="" className="size-7 shrink-0" />
            <span className="font-semibold tracking-tight hidden lg:inline">NexusPanel</span>
          </Link>
          <div className="hidden lg:block">
            <NotificationBell />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex items-center justify-center lg:justify-between gap-2 rounded-md px-2 lg:px-3 h-9 text-sm text-dim hover:text-ink hover:bg-rack-2/60 border border-seam/60 bg-rack-2/30 mb-2 transition-colors text-left"
          title="Globale Suche (Strg+K)"
        >
          <span className="flex items-center gap-2.5">
            <Search className="size-4 text-dim shrink-0" />
            <span className="hidden lg:inline">{t('nav.search')}</span>
          </span>
          <kbd className="hidden lg:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-rack border border-seam text-dim">
            Strg K
          </kbd>
        </button>

        <div className="md:flex lg:hidden justify-center my-1">
          <NotificationBell />
        </div>

        <nav className="flex flex-col gap-1 flex-1 pt-2 border-t md:border-t-0 border-seam">
          <NavLink to="/" end className={link} title={t('nav.servers')}>
            <Server className="size-4 shrink-0" /> <span className="hidden lg:inline">{t('nav.servers')}</span>
          </NavLink>
          {canCreate && (
            <NavLink to="/neu" className={link} title={t('nav.create')}>
              <Plus className="size-4 shrink-0" /> <span className="hidden lg:inline">{t('nav.create')}</span>
            </NavLink>
          )}
          <NavLink to="/community" className={link} title={t('nav.community')}>
            <Users className="size-4 shrink-0" /> <span className="hidden lg:inline">{t('nav.community')}</span>
          </NavLink>
          {hasAdminAccess && features.has('admin') && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `flex items-center md:justify-center lg:justify-start gap-2.5 rounded-md px-3 h-10 md:h-9 text-sm transition-colors ${
                  isActive || isAdminActive ? 'bg-rack-2 text-ink font-medium' : 'text-dim hover:text-ink hover:bg-rack-2/60'
                }`
              }
              title="Admin-Hub"
            >
              <Shield className="size-4 text-amber shrink-0" />
              <span className="hidden lg:inline font-semibold text-amber">Admin-Hub</span>
            </NavLink>
          )}
          {features.has('help') && (<NavLink to="/hilfe" className={link} title={t('nav.help')}>
            <HelpCircle className="size-4 text-amber shrink-0" /> <span className="hidden lg:inline">{t('nav.help')}</span>
          </NavLink>)}
        </nav>

        <div className="flex flex-col gap-1 border-t border-seam pt-3">
          <NavLink
            to="/account"
            className="flex items-center md:justify-center lg:justify-start gap-2.5 px-3 py-1.5 rounded-lg text-sm text-dim hover:text-ink hover:bg-rack-2/60 transition-colors group"
            title="Mein Konto & Profil"
          >
            <UserAvatar avatar={me?.user.avatar} username={me?.user.username ?? 'User'} size="xs" />
            <div className="hidden lg:block min-w-0 flex-1 text-left">
              <div className="text-ink truncate font-semibold text-xs leading-tight group-hover:text-amber transition-colors">
                {me?.user.username}
              </div>
              <div className="text-dim text-[10px] leading-tight flex items-center gap-1">
                <span>{t(`role.${me?.user.role ?? 'user'}`)}</span>
                {me?.user.steamId && <span className="text-cyan-400">• Steam</span>}
              </div>
            </div>
          </NavLink>
          <VersionLink />
          <div className="hidden lg:block">
            <LanguagePicker className="inline-flex px-3 py-1" />
          </div>
          <button
            onClick={() => void logout()}
            className="flex items-center md:justify-center lg:justify-start gap-2.5 rounded-md px-3 h-9 text-sm text-dim hover:text-ink hover:bg-rack-2/60"
            title={t('nav.logout')}
          >
            <LogOut className="size-4 shrink-0" /> <span className="hidden lg:inline">{t('nav.logout')}</span>
          </button>
        </div>
      </aside>

      {/* Mobile Top Navigation Bar */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between border-b border-seam bg-rack/95 backdrop-blur-md px-4 py-2.5">
        <Link to="/" className="flex items-center gap-2">
          <img src="/logo.svg" alt="" className="size-7" />
          <span className="font-semibold tracking-tight text-ink">NexusPanel</span>
        </Link>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex items-center justify-center size-8 rounded-md text-dim hover:text-ink hover:bg-rack-2/60"
            title="Globale Suche"
          >
            <Search className="size-4" />
          </button>
          <NotificationBell />
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="flex items-center justify-center size-8 rounded-md text-dim hover:text-ink hover:bg-rack-2/60"
            aria-label="Menü öffnen"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </header>

      {/* Mobile Slide-over Drawer & Backdrop */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div
            className="fixed inset-0 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
            onClick={closeMobile}
          />
          <div className="fixed inset-y-0 left-0 w-72 max-w-[85vw] bg-rack border-r border-seam p-4 flex flex-col justify-between shadow-2xl animate-in slide-in-from-left duration-200">
            <div>
              <div className="flex items-center justify-between mb-5 pb-3 border-b border-seam">
                <Link to="/" onClick={closeMobile} className="flex items-center gap-2.5">
                  <img src="/logo.svg" alt="" className="size-7" />
                  <span className="font-semibold tracking-tight text-base">NexusPanel</span>
                </Link>
                <button
                  type="button"
                  onClick={closeMobile}
                  className="p-1 rounded-md text-dim hover:text-ink hover:bg-rack-2"
                >
                  <X className="size-5" />
                </button>
              </div>

              <nav className="flex flex-col gap-1">
                <NavLink to="/" end onClick={closeMobile} className={link}>
                  <Server className="size-4 shrink-0" /> <span>{t('nav.servers')}</span>
                </NavLink>
                {canCreate && (
                  <NavLink to="/neu" onClick={closeMobile} className={link}>
                    <Plus className="size-4 shrink-0" /> <span>{t('nav.create')}</span>
                  </NavLink>
                )}
                <NavLink to="/community" onClick={closeMobile} className={link}>
                  <Users className="size-4 shrink-0" /> <span>{t('nav.community')}</span>
                </NavLink>
                {hasAdminAccess && features.has('admin') && (
                  <NavLink
                    to="/admin"
                    onClick={closeMobile}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-md px-3 h-10 text-sm transition-colors ${
                        isActive || isAdminActive ? 'bg-rack-2 text-ink font-medium' : 'text-dim hover:text-ink hover:bg-rack-2/60'
                      }`
                    }
                  >
                    <Shield className="size-4 text-amber shrink-0" />
                    <span className="font-semibold text-amber">Admin-Hub</span>
                  </NavLink>
                )}
                {features.has('help') && (<NavLink to="/hilfe" onClick={closeMobile} className={link}>
                  <HelpCircle className="size-4 text-amber shrink-0" /> <span>{t('nav.help')}</span>
                </NavLink>)}
              </nav>
            </div>

            <div className="flex flex-col gap-2 border-t border-seam pt-4">
              <NavLink
                to="/account"
                onClick={closeMobile}
                className="flex items-center gap-3 px-3 py-2 rounded-xl bg-rack-2/40 border border-seam text-ink hover:border-amber transition-colors"
              >
                <UserAvatar avatar={me?.user.avatar} username={me?.user.username ?? 'User'} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-ink font-semibold text-sm leading-tight">{me?.user.username}</div>
                  <div className="text-dim text-xs leading-tight">{t(`role.${me?.user.role ?? 'user'}`)}</div>
                </div>
              </NavLink>
              <VersionLink mobile />
              <LanguagePicker className="inline-flex px-3 py-1" />
              <button
                onClick={() => {
                  closeMobile();
                  void logout();
                }}
                className="flex items-center gap-2.5 rounded-md px-3 h-10 text-sm text-dim hover:text-ink hover:bg-rack-2/60 mt-1"
              >
                <LogOut className="size-4" /> <span>{t('nav.logout')}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="min-w-0 px-3 sm:px-6 lg:px-8 py-4 sm:py-6 lg:py-8 w-full max-w-[1800px] mx-auto">
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
      <GlobalTaskProgress />
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </div>
  );
}
