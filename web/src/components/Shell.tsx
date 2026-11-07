import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Server, LogOut, Plus, Network as NetIcon, Users, Search, Shield, History, FlaskConical, Blocks, HelpCircle } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import { seenVersion, type About } from '../lib/version';
import { t, fmtDateTime } from '../lib/i18n';
import { LanguagePicker } from './LanguagePicker';
import { CommandPalette } from './CommandPalette';
import { Spinner } from './ui';

/** Versionsnummer unten links; Punkt, solange "Was ist neu" fuer diese Version noch nicht geoeffnet wurde. */
function VersionLink() {
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
      className="hidden md:flex items-center gap-2 px-3 py-1 text-xs text-dim hover:text-ink">
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
 * Rahmen: schmale Leiste links (am Handy oben). Bewusst wenig Navigation -
 * im Panel dreht sich alles um Server, der Rest kommt in spaeteren Phasen dazu.
 */
export function Shell() {
  const { me, logout } = useAuth();
  const canCreate = me?.permissions['server.create'];
  const [searchOpen, setSearchOpen] = useState(false);

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

  return (
    <div className="min-h-full md:grid md:grid-cols-[220px_1fr]">
      <aside className="flex md:flex-col items-center md:items-stretch gap-1 border-b md:border-b-0 md:border-r border-seam bg-rack px-3 py-2 md:py-4 md:h-screen md:sticky md:top-0">
        <div className="flex items-center gap-2.5 px-2 md:mb-4">
          <img src="/logo.svg" alt="" className="size-7" />
          <span className="font-semibold tracking-tight">NexusPanel</span>
        </div>

        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="flex items-center justify-between gap-2 rounded-md px-3 h-9 text-sm text-dim hover:text-ink hover:bg-rack-2/60 border border-seam/60 bg-rack-2/30 mb-2 transition-colors text-left"
          title="Globale Suche (Strg+K)"
        >
          <span className="flex items-center gap-2.5">
            <Search className="size-4 text-dim" />
            <span className="hidden sm:inline">{t('nav.search')}</span>
          </span>
          <kbd className="hidden md:inline-flex items-center px-1.5 py-0.5 text-[10px] font-mono rounded bg-rack border border-seam text-dim">
            Strg K
          </kbd>
        </button>

        <nav className="flex md:flex-col gap-1 flex-1 justify-end md:justify-start">
          <NavLink to="/" end className={link}><Server className="size-4" /> <span className="hidden sm:inline">{t('nav.servers')}</span></NavLink>
          {canCreate && <NavLink to="/neu" className={link}><Plus className="size-4" /> <span className="hidden sm:inline">{t('nav.create')}</span></NavLink>}
          <NavLink to="/community" className={link}><Users className="size-4" /> <span className="hidden sm:inline">{t('nav.community')}</span></NavLink>
          {me?.permissions['admin.nodes'] && <NavLink to="/netzwerk" className={link}><NetIcon className="size-4" /> <span className="hidden sm:inline">{t('nav.network')}</span></NavLink>}
          {me?.permissions['admin.users'] && <NavLink to="/admin/users" className={link}><Shield className="size-4" /> <span className="hidden sm:inline">Nutzer</span></NavLink>}
          {me?.permissions['admin.audit'] && <NavLink to="/admin/audit" className={link}><History className="size-4" /> <span className="hidden sm:inline">Audit-Log</span></NavLink>}
          {me?.user.role === 'admin' && <NavLink to="/admin/testbericht" className={link}><FlaskConical className="size-4 text-amber" /> <span className="hidden sm:inline">Testbericht</span></NavLink>}
          {me?.user.role === 'admin' && <NavLink to="/admin/integrationen" className={link}><Blocks className="size-4 text-sky-400" /> <span className="hidden sm:inline">Integrationen</span></NavLink>}
          <NavLink to="/hilfe" className={link}><HelpCircle className="size-4 text-amber" /> <span className="hidden sm:inline">{t('nav.help')}</span></NavLink>
        </nav>
        <div className="md:border-t md:border-seam md:pt-3 flex md:flex-col gap-1">
          <div className="hidden md:block px-3 text-sm">
            <div className="text-ink">{me?.user.username}</div>
            <div className="text-dim text-xs">{t(`role.${me?.user.role ?? 'user'}`)}</div>
          </div>
          <VersionLink />
          <LanguagePicker className="hidden md:inline-flex px-3 py-1" />
          <button onClick={() => void logout()} className="flex items-center gap-2.5 rounded-md px-3 h-9 text-sm text-dim hover:text-ink hover:bg-rack-2/60">
            <LogOut className="size-4" /> <span className="hidden sm:inline">{t('nav.logout')}</span>
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
