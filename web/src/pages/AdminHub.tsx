import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Shield,
  Users,
  History,
  Terminal,
  FolderTree,
  Network,
  Server,
  FlaskConical,
  Blocks,
  Activity,
  ArrowRight,
  Cpu,
  Layers,
  CheckCircle2,
  Clock,
  Sparkles,
  ExternalLink,
} from 'lucide-react';
import { api } from '../lib/api';
import { useFeatures } from '../lib/features';
import { useAuth } from '../lib/auth';
import { Spinner } from '../components/ui';
import { CoreUpdateCard } from '../components/CoreUpdateCard';

interface AdminOverviewData {
  version: string;
  build: { version: string; build: number | null; dev: boolean };
  uptimeSeconds: number;
  stats: {
    users: number;
    serversTotal: number;
    serversRunning: number;
    containersTotal: number;
    containersRunning: number;
    auditToday: number;
  };
}

export function AdminHub() {
  const { me } = useAuth();
  const features = useFeatures();
  const isAdmin = me?.user.role === 'admin';

  const { data, isLoading } = useQuery<AdminOverviewData>({
    queryKey: ['adminOverview'],
    queryFn: () => api('/admin/overview'),
    refetchInterval: 10000,
  });

  const stats = data?.stats;

  const fmtUptime = (seconds?: number) => {
    if (!seconds) return '–';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d} T ${h} Std`;
    if (h > 0) return `${h} Std ${m} Min`;
    return `${m} Min`;
  };

  const modules = [
    {
      title: 'Benutzer & Rechte',
      path: '/admin/users',
      feature: 'users',
      perm: 'admin.users',
      icon: Users,
      color: 'text-amber',
      bgColor: 'bg-amber/10 border-amber/30',
      description: 'Benutzerkonten anlegen, Rollen & Berechtigungen verwalten, 2FA zurücksetzen und Steam-Konten zuweisen.',
      badge: stats ? `${stats.users} Benutzer` : undefined,
      category: 'Sicherheit & Identität',
    },
    {
      title: 'Audit- & Sicherheits-Log',
      path: '/admin/audit',
      feature: 'audit',
      perm: 'admin.audit',
      icon: History,
      color: 'text-sky-400',
      bgColor: 'bg-sky-500/10 border-sky-500/30',
      description: 'Lückenloses Aktivitätsprotokoll aller administrativen Eingriffe, Logins, Serverstarts und IP-Adressen.',
      badge: stats ? `${stats.auditToday} heute` : undefined,
      category: 'Sicherheit & Identität',
    },
    {
      title: 'Host-Logs & NexusLogs',
      path: '/admin/host-logs',
      feature: 'hostlogs',
      perm: 'admin.audit',
      icon: Terminal,
      color: 'text-emerald-400',
      bgColor: 'bg-emerald-500/10 border-emerald-500/30',
      description: 'Echtzeit-Live-Logs aller Docker-Container, Hintergrunddienste und des Panel-Backends auf dem Host.',
      badge: 'Live',
      category: 'System & Diagnose',
    },
    {
      title: 'Spiele-Testbericht',
      path: '/admin/testbericht',
      feature: 'testreport',
      perm: 'admin.test_report',
      icon: FlaskConical,
      color: 'text-purple-400',
      bgColor: 'bg-purple-500/10 border-purple-500/30',
      description: 'Automatisierte Installations- und Startprüfungen für alle Spiel-Eggs zur Qualitätssicherung.',
      badge: 'Automatisierbar',
      category: 'System & Diagnose',
    },
    {
      title: 'Dateien (VM-Instanz)',
      path: '/admin/dateien',
      feature: 'adminfiles',
      perm: 'admin.files',
      icon: FolderTree,
      color: 'text-amber-400',
      bgColor: 'bg-amber-500/10 border-amber-500/30',
      description: 'Zentraler VM-Dateimanager für alle Spieldaten der Server, Backups und verbundene Netzlaufwerke (NAS).',
      badge: 'Host-Dateisystem',
      category: 'Speicher & Daten',
    },
    {
      title: 'Netzwerk & Allokationen',
      path: '/netzwerk',
      feature: 'network',
      perm: 'admin.nodes',
      icon: Network,
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500/10 border-cyan-500/30',
      description: 'Verwaltung der IP-Adressen, Portfreigaben sowie automatische DNS-Synchronisation mit Cloudflare und Hetzner.',
      badge: 'Ports & DNS',
      category: 'Infrastruktur',
    },
    {
      title: 'Hosts & Server-Nodes',
      path: '/admin/hosts',
      feature: 'hosts',
      perm: 'admin.nodes',
      icon: Server,
      color: 'text-blue-400',
      bgColor: 'bg-blue-500/10 border-blue-500/30',
      description: 'Physische Server-Hosts und Remote-Nodes überwachen, NexusCore-Agenten verwalten und koppeln.',
      badge: 'Multi-Node',
      category: 'Infrastruktur',
    },
    {
      title: 'Integrationen & Dienste',
      path: '/admin/integrationen',
      feature: 'integrations',
      perm: 'admin.integrations',
      icon: Blocks,
      color: 'text-rose-400',
      bgColor: 'bg-rose-500/10 border-rose-500/30',
      description: 'Externe Schnittstellen konfigurieren: Discord-Webhook-Benachrichtigungen und Playit.gg-Tunnel.',
      badge: 'Webhooks & Tunnel',
      category: 'Infrastruktur',
    },
  ];

  // Der Core bietet nur einen Teil der Bereiche an (Funktionsliste unter /about)
  const visibleModules = modules.filter(
    (m) => features.has(m.feature) && (isAdmin || !m.perm || Boolean(me?.permissions[m.perm])),
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-seam pb-5">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber/15 text-amber border border-amber/30 mb-2">
            <Shield className="size-3.5" />
            Admin-Kontrollzentrum
          </div>
          <h1 className="text-3xl font-bold tracking-tight">System-Administration</h1>
          <p className="text-dim text-sm mt-1">
            Zentrale Schaltstelle zur Verwaltung aller Systeme, Benutzer, Logs, Netzwerke und Server-Ressourcen.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="px-3 py-1.5 rounded-lg border border-seam bg-rack text-xs font-mono text-dim flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>v{data?.version ?? '0.26.1'}</span>
            {data?.build?.build && <span className="text-amber">Build {data.build.build}</span>}
          </div>
        </div>
      </div>

      {/* KPI Kacheln */}
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="bg-rack border border-seam rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-dim font-medium uppercase tracking-wider">Spielserver</div>
            <div className="text-2xl font-bold mt-1 text-ink flex items-baseline gap-1.5">
              <span>{stats?.serversRunning ?? 0}</span>
              <span className="text-xs font-normal text-dim">von {stats?.serversTotal ?? 0} online</span>
            </div>
          </div>
          <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Activity className="size-5" />
          </div>
        </div>

        <div className="bg-rack border border-seam rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-dim font-medium uppercase tracking-wider">Docker Container</div>
            <div className="text-2xl font-bold mt-1 text-ink flex items-baseline gap-1.5">
              <span>{stats?.containersRunning ?? 0}</span>
              <span className="text-xs font-normal text-dim">von {stats?.containersTotal ?? 0} aktiv</span>
            </div>
          </div>
          <div className="p-3 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
            <Layers className="size-5" />
          </div>
        </div>

        <div className="bg-rack border border-seam rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-dim font-medium uppercase tracking-wider">Benutzerkonten</div>
            <div className="text-2xl font-bold mt-1 text-ink">
              {stats?.users ?? 0}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-amber/10 border border-amber/20 text-amber">
            <Users className="size-5" />
          </div>
        </div>

        <div className="bg-rack border border-seam rounded-xl p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-dim font-medium uppercase tracking-wider">System-Laufzeit</div>
            <div className="text-xl font-bold mt-1 text-ink truncate">
              {fmtUptime(data?.uptimeSeconds)}
            </div>
          </div>
          <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400">
            <Clock className="size-5" />
          </div>
        </div>
      </div>

      {isAdmin && <CoreUpdateCard />}

      {/* Module Kacheln */}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold tracking-tight text-ink flex items-center gap-2">
          <Sparkles className="size-4 text-amber" />
          Verfügbare Administrations-Module
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visibleModules.map((m) => {
            const Icon = m.icon;
            return (
              <Link
                key={m.path}
                to={m.path}
                className="group relative bg-rack hover:bg-rack-2/80 border border-seam hover:border-amber/50 rounded-xl p-5 transition-all flex flex-col justify-between shadow-sm hover:shadow-md"
              >
                <div>
                  <div className="flex items-start justify-between gap-3 mb-3">
                    <div className={`p-2.5 rounded-lg border ${m.bgColor} ${m.color}`}>
                      <Icon className="size-5" />
                    </div>
                    {m.badge && (
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-md bg-rack-2 border border-seam text-dim group-hover:text-ink transition-colors">
                        {m.badge}
                      </span>
                    )}
                  </div>

                  <h3 className="text-base font-semibold text-ink group-hover:text-amber transition-colors flex items-center gap-1.5">
                    {m.title}
                  </h3>

                  <p className="text-xs text-dim mt-2 leading-relaxed line-clamp-3">
                    {m.description}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-seam/60 flex items-center justify-between text-xs font-medium text-dim group-hover:text-amber transition-colors">
                  <span className="text-[11px] text-dim/70 uppercase tracking-wider">{m.category}</span>
                  <span className="flex items-center gap-1">
                    Öffnen
                    <ArrowRight className="size-3.5 group-hover:translate-x-0.5 transition-transform" />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
