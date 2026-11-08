import { Suspense, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Server, LogOut, Plus, Network as NetIcon, Users, Search, Shield, History,
  FlaskConical, Blocks, HelpCircle, FolderTree, Bell, Menu, X, AlertTriangle, CheckCircle2, Info, CheckCheck,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { seenVersion, type About } from '../lib/version';
import { t, fmtDateTime } from '../lib/i18n';
import { LanguagePicker } from './LanguagePicker';
import { CommandPalette } from './CommandPalette';
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
  const [seen, setSeen] = useState(seenVersion());
  useEffect(() => {
    const f = () => setSeen(seenVersion());
    window.addEventListener('nxp-version-seen', f);
    return () => window.removeEventListener('nxp-version-seen', f);
  }, []);
  if (!data) return null;
  const fresh = seen !== data.version;
  const hasUpdate = Boolean(data.update?.hasUpdate);
  const built = data.builtAt ? fmtDateTime(data.builtAt, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <Link to="/hilfe?tab=neu" title={built ? t('version.builtTitle', { date: built }) : t('version.whatsNew')}
      className={`${mobile ? 'flex' : 'hidden md:flex'} items-center gap-2 px-3 py-1 text-xs text-dim hover:text-ink`}>
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
    </Link>
  );
}

/**
 * Rahmen: schmale Leiste links (am Handy oben mit ausklappbarem Burger-Menue).
 */
export function Shell() {
  const { me, logout } = useAuth();
  const canCreate = me?.permissions['server.create'];
  const [searchOpen, setSearchOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
    `flex items-center gap-2.5 rounded-md px-3 h-9 text-sm ${isActive ? 'bg-rack-2 text-ink' : 'text-dim hover:text-ink hover:bg-rack-2/60'}`;

  const closeMobile = () => setMobileMenuOpen(false);

  return (
    <div className="min-h-full md:grid md:grid-cols-[220px_1fr]">
      <aside className="flex flex-col border-b md:border-b-0 md:border-r border-seam bg-rack px-3 py-2.5 md:py-4 md:h-screen md:sticky md:top-0 z-30">
        <div className="flex items-center justify-between gap-2 px-1 md:px-2 md:mb-4">
          <Link to="/" onClick={closeMobile} className="flex items-center gap-2.5">
            <img src="/logo.svg" alt="" className="size-7" />
            <span className="font-semibold tracking-tight">NexusPanel</span>
          </Link>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="md:hidden flex items-center justify-center size-8 rounded-md text-dim hover:text-ink hover:bg-rack-2/60"
              title="Globale Suche (Strg+K)"
            >
              <Search className="size-4" />
            </button>
            <NotificationBell />
            <button
              type="button"
              onClick={() => setMobileMenuOpen((v) => !v)}
              className="md:hidden flex items-center justify-center size-8 rounded-md text-dim hover:text-ink hover:bg-rack-2/60"
              aria-label="Menü"
            >
              {mobileMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="hidden md:flex items-center justify-between gap-2 rounded-md px-3 h-9 text-sm text-dim hover:text-ink hover:bg-rack-2/60 border border-seam/60 bg-rack-2/30 mb-2 transition-colors text-left"
          title="Globale Suche (Strg+K)"
        >
          <span className="flex items-center gap-2.5">
            <Search className="size-4 text-dim" />
            <span>{t('nav.search')}</span>
          </span>
          <kbd className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-rack border border-seam text-dim">
            Strg K
          </kbd>
        </button>

        <nav className={`${mobileMenuOpen ? 'flex' : 'hidden'} md:flex flex-col gap-1 flex-1 pt-2 md:pt-0 border-t md:border-t-0 border-seam mt-2 md:mt-0`}>
          <NavLink to="/" end onClick={closeMobile} className={link}><Server className="size-4" /> <span>{t('nav.servers')}</span></NavLink>
          {canCreate && <NavLink to="/neu" onClick={closeMobile} className={link}><Plus className="size-4" /> <span>{t('nav.create')}</span></NavLink>}
          <NavLink to="/community" onClick={closeMobile} className={link}><Users className="size-4" /> <span>{t('nav.community')}</span></NavLink>
          {me?.permissions['admin.nodes'] && <NavLink to="/netzwerk" onClick={closeMobile} className={link}><NetIcon className="size-4" /> <span>{t('nav.network')}</span></NavLink>}
          {me?.permissions['admin.users'] && <NavLink to="/admin/users" onClick={closeMobile} className={link}><Shield className="size-4" /> <span>Nutzer</span></NavLink>}
          {me?.permissions['admin.audit'] && <NavLink to="/admin/audit" onClick={closeMobile} className={link}><History className="size-4" /> <span>Audit-Log</span></NavLink>}
          {me?.user.role === 'admin' && <NavLink to="/admin/dateien" onClick={closeMobile} className={link}><FolderTree className="size-4" /> <span>{t('nav.adminFiles')}</span></NavLink>}
          {me?.user.role === 'admin' && <NavLink to="/admin/testbericht" onClick={closeMobile} className={link}><FlaskConical className="size-4 text-amber" /> <span>Testbericht</span></NavLink>}
          {me?.user.role === 'admin' && <NavLink to="/admin/integrationen" onClick={closeMobile} className={link}><Blocks className="size-4 text-sky-400" /> <span>Integrationen</span></NavLink>}
          <NavLink to="/hilfe" onClick={closeMobile} className={link}><HelpCircle className="size-4 text-amber" /> <span>{t('nav.help')}</span></NavLink>
        </nav>

        <div className={`${mobileMenuOpen ? 'flex' : 'hidden'} md:flex flex-col gap-1 border-t border-seam pt-3 mt-2 md:mt-0`}>
          <div className="px-3 text-sm">
            <div className="text-ink">{me?.user.username}</div>
            <div className="text-dim text-xs">{t(`role.${me?.user.role ?? 'user'}`)}</div>
          </div>
          <VersionLink mobile={mobileMenuOpen} />
          <LanguagePicker className="inline-flex px-3 py-1" />
          <button onClick={() => void logout()} className="flex items-center gap-2.5 rounded-md px-3 h-9 text-sm text-dim hover:text-ink hover:bg-rack-2/60">
            <LogOut className="size-4" /> <span>{t('nav.logout')}</span>
          </button>
        </div>
      </aside>
      <main className="min-w-0 px-4 md:px-8 py-6 md:py-8">
        {/* Seiten laden nach (siehe main.tsx) - die Seitenleiste bleibt dabei stehen */}
        <Suspense fallback={<Spinner />}>
          <Outlet />
        </Suspense>
      </main>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}
