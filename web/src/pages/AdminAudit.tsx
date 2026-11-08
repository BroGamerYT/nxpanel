import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  History,
  Search,
  Shield,
  Play,
  Square,
  RotateCcw,
  Zap,
  Moon,
  Archive,
  Trash2,
  Lock,
  Unlock,
  Sliders,
  Settings,
  Plus,
  RefreshCw,
  ArrowUpCircle,
  FlaskConical,
  UserPlus,
  UserCheck,
  UserX,
  FileText,
  FileEdit,
  Download,
  ExternalLink,
  Copy,
  Check,
  X,
  Filter,
  Activity,
  Layers,
  Cpu,
  Server,
  Eye,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button, Input, Spinner } from '../components/ui';
import type { AuditEntry } from '../lib/types';
import { t } from '../lib/i18n';

interface AuditStats {
  totalToday: number;
  totalAll: number;
  uniqueActorsToday: number;
  uniqueServersToday: number;
}

interface AuditResponse {
  entries: AuditEntry[];
  nextBefore: number | null;
  stats?: AuditStats;
}

type CategoryKey = 'all' | 'power' | 'backup' | 'update' | 'settings' | 'files' | 'users' | 'system';

interface ActionMeta {
  label: string;
  icon: typeof History;
  color: string;
  badgeBg: string;
  category: CategoryKey;
}

// Zuordnung von Aktionscodes zu deutschen Bezeichnungen, Icons und Farben
function getActionMeta(action: string): ActionMeta {
  if (action === 'server.power.start') {
    return { label: 'Server gestartet', icon: Play, color: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', badgeBg: 'bg-emerald-500/15 text-emerald-400', category: 'power' };
  }
  if (action === 'server.power.stop') {
    return { label: 'Server gestoppt', icon: Square, color: 'text-slate-300 border-slate-600 bg-slate-800/40', badgeBg: 'bg-slate-700/30 text-slate-300', category: 'power' };
  }
  if (action === 'server.power.restart') {
    return { label: 'Server neu gestartet', icon: RotateCcw, color: 'text-amber-400 border-amber-500/40 bg-amber-500/10', badgeBg: 'bg-amber-500/15 text-amber-400', category: 'power' };
  }
  if (action === 'server.power.kill') {
    return { label: 'Server abgewürgt', icon: Zap, color: 'text-rose-400 border-rose-500/40 bg-rose-500/10', badgeBg: 'bg-rose-500/15 text-rose-400', category: 'power' };
  }
  if (action === 'server.auto_sleep') {
    return { label: 'Ruhezustand aktiviert', icon: Moon, color: 'text-cyan-400 border-cyan-500/40 bg-cyan-500/10', badgeBg: 'bg-cyan-500/15 text-cyan-400', category: 'power' };
  }
  if (action === 'backup.create') {
    return { label: 'Backup erstellt', icon: Archive, color: 'text-sky-400 border-sky-500/40 bg-sky-500/10', badgeBg: 'bg-sky-500/15 text-sky-400', category: 'backup' };
  }
  if (action === 'backup.restore') {
    return { label: 'Backup wiederhergestellt', icon: RotateCcw, color: 'text-amber-400 border-amber-500/40 bg-amber-500/10', badgeBg: 'bg-amber-500/15 text-amber-400', category: 'backup' };
  }
  if (action === 'backup.delete') {
    return { label: 'Backup gelöscht', icon: Trash2, color: 'text-rose-400 border-rose-500/40 bg-rose-500/10', badgeBg: 'bg-rose-500/15 text-rose-400', category: 'backup' };
  }
  if (action === 'backup.lock' || action === 'backup.unlock') {
    return { label: action === 'backup.lock' ? 'Backup gesperrt' : 'Backup entsperrt', icon: action === 'backup.lock' ? Lock : Unlock, color: 'text-indigo-400 border-indigo-500/40 bg-indigo-500/10', badgeBg: 'bg-indigo-500/15 text-indigo-400', category: 'backup' };
  }
  if (action === 'server.update_game' || action === 'modpack.update') {
    return { label: '1-Klick-Update', icon: ArrowUpCircle, color: 'text-amber border-amber/40 bg-amber/10', badgeBg: 'bg-amber/15 text-amber', category: 'update' };
  }
  if (action === 'server.create') {
    return { label: 'Server angelegt', icon: Plus, color: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', badgeBg: 'bg-emerald-500/15 text-emerald-400', category: 'update' };
  }
  if (action === 'server.reinstall') {
    return { label: 'Server neu installiert', icon: RefreshCw, color: 'text-amber border-amber/40 bg-amber/10', badgeBg: 'bg-amber/15 text-amber', category: 'update' };
  }
  if (action === 'server.delete') {
    return { label: 'Server gelöscht', icon: Trash2, color: 'text-rose-400 border-rose-500/40 bg-rose-500/10', badgeBg: 'bg-rose-500/15 text-rose-400', category: 'update' };
  }
  if (action === 'server.startup_update') {
    return { label: 'Einstellungen geändert', icon: Sliders, color: 'text-purple-400 border-purple-500/40 bg-purple-500/10', badgeBg: 'bg-purple-500/15 text-purple-400', category: 'settings' };
  }
  if (action === 'server.resources') {
    return { label: 'Leistung angepasst', icon: Cpu, color: 'text-purple-400 border-purple-500/40 bg-purple-500/10', badgeBg: 'bg-purple-500/15 text-purple-400', category: 'settings' };
  }
  if (action.startsWith('server.port') || action === 'server.reallocate') {
    return { label: 'Ports verwaltet', icon: Settings, color: 'text-purple-400 border-purple-500/40 bg-purple-500/10', badgeBg: 'bg-purple-500/15 text-purple-400', category: 'settings' };
  }
  if (action === 'server.update') {
    return { label: 'Server-Optionen geändert', icon: Sliders, color: 'text-purple-400 border-purple-500/40 bg-purple-500/10', badgeBg: 'bg-purple-500/15 text-purple-400', category: 'settings' };
  }
  if (action.startsWith('file.')) {
    return { label: 'Datei bearbeitet', icon: FileEdit, color: 'text-blue-400 border-blue-500/40 bg-blue-500/10', badgeBg: 'bg-blue-500/15 text-blue-400', category: 'files' };
  }
  if (action.startsWith('user.') || action.startsWith('subuser.')) {
    return { label: 'Nutzerverwaltung', icon: UserCheck, color: 'text-teal-400 border-teal-500/40 bg-teal-500/10', badgeBg: 'bg-teal-500/15 text-teal-400', category: 'users' };
  }
  if (action.startsWith('games.test')) {
    return { label: 'Spiele-Testlauf', icon: FlaskConical, color: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10', badgeBg: 'bg-emerald-500/15 text-emerald-400', category: 'system' };
  }
  if (action === 'docker.prune') {
    return { label: 'Docker aufgeräumt', icon: Trash2, color: 'text-slate-300 border-slate-600 bg-slate-800/40', badgeBg: 'bg-slate-700/30 text-slate-300', category: 'system' };
  }
  return { label: action, icon: Activity, color: 'text-dim border-seam bg-rack-2', badgeBg: 'bg-rack-2 text-dim', category: 'system' };
}

// Lesbare Zusammenfassung der Details formatieren
function formatSummaryDetails(meta: any): string | null {
  if (!meta || typeof meta !== 'object') return null;

  if (meta.idleMinutes !== undefined) {
    return `${meta.idleMinutes}m inaktiv (Schwelle: ${meta.autoSleepMinutes ?? 15}m)`;
  }
  if (meta.bytes !== undefined) {
    const gb = (meta.bytes / (1024 * 1024 * 1024)).toFixed(2);
    return `Größe: ${gb} GB`;
  }
  if (meta.backup !== undefined) {
    return `${meta.backup ? 'Mit Sicherheits-Backup' : 'Ohne Backup'}${meta.startAfter ? ', sofortiger Neustart' : ''}`;
  }
  if (meta.changed && Array.isArray(meta.changed) && meta.changed.length > 0) {
    return `Geändert: ${meta.changed.join(', ')}`;
  }
  if (meta.mode) {
    return `Modus: ${meta.mode}${meta.ramMb ? `, ${meta.ramMb} MB RAM` : ''}`;
  }
  if (meta.ramMb || meta.cpuPercent || meta.diskMb) {
    const parts = [];
    if (meta.ramMb) parts.push(`${(meta.ramMb / 1024).toFixed(0)} GB RAM`);
    if (meta.cpuPercent) parts.push(`${meta.cpuPercent} % CPU`);
    if (meta.diskMb) parts.push(`${(meta.diskMb / 1024).toFixed(0)} GB SSD`);
    return parts.join(' · ');
  }
  if (meta.port) {
    return `Port: ${meta.port}${meta.ref ? ` (${meta.ref})` : ''}`;
  }
  if (meta.path) {
    return `Datei: ${meta.path}`;
  }

  const str = JSON.stringify(meta);
  return str.length > 60 ? str.slice(0, 57) + '…' : str;
}

export function AdminAudit() {
  const [searchTerm, setSearchTerm] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryKey>('all');
  const [selectedServer, setSelectedServer] = useState<string>('all');
  const [hideSystemActions, setHideSystemActions] = useState(false);
  const [limit, setLimit] = useState(150);
  const [selectedEntry, setSelectedEntry] = useState<AuditEntry | null>(null);
  const [copiedJson, setCopiedJson] = useState(false);

  const { data, isLoading, refetch } = useQuery<AuditResponse>({
    queryKey: ['admin-audit', limit],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('limit', String(limit));
      return api(`/admin/audit?${p.toString()}`);
    },
  });

  const rawEntries = data?.entries ?? [];
  const stats = data?.stats;

  // Einzigartige Server und Akteure fuer Dropdowns
  const uniqueServers = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of rawEntries) {
      if (e.server_id && e.server_name) {
        map.set(e.server_id, e.server_name);
      }
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [rawEntries]);

  // Client-seitige Filterung
  const filteredEntries = useMemo(() => {
    return rawEntries.filter((entry) => {
      // 1. System-Filter
      if (hideSystemActions && (entry.actor_name === 'system' || entry.action === 'server.auto_sleep')) {
        return false;
      }

      // 2. Kategorie-Filter
      const meta = getActionMeta(entry.action);
      if (categoryFilter !== 'all' && meta.category !== categoryFilter) {
        return false;
      }

      // 3. Server-Filter
      if (selectedServer !== 'all' && entry.server_id !== selectedServer) {
        return false;
      }

      // 4. Freitext-Suche
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const actionMatch = entry.action.toLowerCase().includes(q) || meta.label.toLowerCase().includes(q);
        const actorMatch = (entry.actor_name ?? '').toLowerCase().includes(q);
        const serverMatch = (entry.server_name ?? '').toLowerCase().includes(q);
        const metaMatch = entry.metadata ? JSON.stringify(entry.metadata).toLowerCase().includes(q) : false;
        if (!actionMatch && !actorMatch && !serverMatch && !metaMatch) {
          return false;
        }
      }

      return true;
    });
  }, [rawEntries, hideSystemActions, categoryFilter, selectedServer, searchTerm]);

  // CSV-Export generieren
  const exportCsv = () => {
    const headers = ['ID', 'Zeitpunkt', 'Akteur', 'IP-Adresse', 'Aktion', 'Aktionsname', 'Server', 'Details'];
    const rows = filteredEntries.map((e) => {
      const meta = getActionMeta(e.action);
      const detail = e.metadata ? JSON.stringify(e.metadata).replace(/"/g, '""') : '';
      return [
        e.id,
        `"${new Date(e.created_at).toLocaleString('de-DE')}"`,
        `"${e.actor_name ?? 'System'}"`,
        `"${e.ip ?? ''}"`,
        `"${e.action}"`,
        `"${meta.label}"`,
        `"${e.server_name ?? ''}"`,
        `"${detail}"`,
      ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nexuspanel-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // JSON-Export generieren
  const exportJson = () => {
    const jsonStr = JSON.stringify(filteredEntries, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `nexuspanel-audit-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyDetailsJson = () => {
    if (!selectedEntry?.metadata) return;
    navigator.clipboard.writeText(JSON.stringify(selectedEntry.metadata, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  return (
    <div className="max-w-7xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-6 rounded-2xl border border-seam bg-rack shadow-sm">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3 text-ink">
            <History className="size-7 text-amber" />
            Audit-Protokoll & Sicherheits-Log
          </h1>
          <p className="text-sm text-dim mt-1.5 max-w-2xl leading-relaxed">
            Lückenlose chronologische Aufzeichnung aller Server-Befehle, Updates, Backups, Leistungs- und Konfigurationsänderungen.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="quiet" onClick={() => void refetch()} title="Protokoll neu laden">
            <RefreshCw className="size-4" />
            Aktualisieren
          </Button>
          <Button variant="quiet" onClick={exportCsv} title="Als CSV-Tabelle herunterladen">
            <Download className="size-4" />
            CSV
          </Button>
          <Button variant="quiet" onClick={exportJson} title="Als JSON-Datei herunterladen">
            <Download className="size-4" />
            JSON
          </Button>
        </div>
      </div>

      {/* Top Statistik-Karten */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-seam bg-rack space-y-1">
          <div className="text-xs text-dim flex items-center gap-1.5 font-medium">
            <Activity className="size-3.5 text-amber" />
            Aktionen heute
          </div>
          <div className="text-2xl font-bold text-ink">
            {stats?.totalToday ?? rawEntries.filter((e) => new Date(e.created_at).toDateString() === new Date().toDateString()).length}
          </div>
          <div className="text-[11px] text-dim">
            von {stats?.totalAll ?? rawEntries.length} im Protokoll
          </div>
        </div>

        <div className="p-4 rounded-xl border border-seam bg-rack space-y-1">
          <div className="text-xs text-dim flex items-center gap-1.5 font-medium">
            <UserCheck className="size-3.5 text-emerald-400" />
            Aktive Akteure
          </div>
          <div className="text-2xl font-bold text-ink">
            {stats?.uniqueActorsToday ?? new Set(rawEntries.map((e) => e.actor_name).filter(Boolean)).size}
          </div>
          <div className="text-[11px] text-dim">
            Benutzer & System-Dienste
          </div>
        </div>

        <div className="p-4 rounded-xl border border-seam bg-rack space-y-1">
          <div className="text-xs text-dim flex items-center gap-1.5 font-medium">
            <Server className="size-3.5 text-cyan-400" />
            Betroffene Server
          </div>
          <div className="text-2xl font-bold text-ink">
            {stats?.uniqueServersToday ?? uniqueServers.length}
          </div>
          <div className="text-[11px] text-dim">
            Instanzen verwaltet
          </div>
        </div>

        <div className="p-4 rounded-xl border border-seam bg-rack space-y-1">
          <div className="text-xs text-dim flex items-center gap-1.5 font-medium">
            <Shield className="size-3.5 text-purple-400" />
            Gefilterte Einträge
          </div>
          <div className="text-2xl font-bold text-ink">
            {filteredEntries.length}
          </div>
          <div className="text-[11px] text-dim">
            aktuelle Ansicht
          </div>
        </div>
      </div>

      {/* Filter-Kategorien Tabs */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-seam pb-3 overflow-x-auto">
        {(
          [
            ['all', 'Alle Aktionen', Layers],
            ['power', 'Power & Betrieb', Play],
            ['backup', 'Backups', Archive],
            ['update', 'Updates & Install', ArrowUpCircle],
            ['settings', 'Einstellungen', Sliders],
            ['files', 'Dateien', FileEdit],
            ['users', 'Benutzer & Rechte', UserCheck],
            ['system', 'System & Tests', FlaskConical],
          ] as const
        ).map(([key, label, Icon]) => {
          const count = key === 'all'
            ? rawEntries.length
            : rawEntries.filter((e) => getActionMeta(e.action).category === key).length;
          const isActive = categoryFilter === key;

          return (
            <button
              key={key}
              type="button"
              onClick={() => setCategoryFilter(key)}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isActive
                  ? 'bg-amber text-black font-semibold shadow-sm'
                  : 'bg-rack-2/60 text-dim hover:text-ink hover:bg-rack-2'
              }`}
            >
              <Icon className="size-3.5" />
              <span>{label}</span>
              <span className={`px-1.5 py-0.2 rounded-full text-[10px] ${
                isActive ? 'bg-black/20 text-black' : 'bg-rack-0 text-dim'
              }`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Such- und Selektionsleiste */}
      <div className="flex flex-wrap items-center gap-3 bg-rack p-4 rounded-xl border border-seam">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="size-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-dim pointer-events-none" />
          <Input
            placeholder="Aktion, Akteur, Server oder Details durchsuchen …"
            className="pl-10 h-9 text-xs"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-dim hover:text-ink text-xs p-1"
            >
              ✕
            </button>
          )}
        </div>

        {/* Server Dropdown Filter */}
        {uniqueServers.length > 0 && (
          <select
            value={selectedServer}
            onChange={(e) => setSelectedServer(e.target.value)}
            className="h-9 px-3 text-xs rounded-md bg-rack-2 border border-seam text-ink focus:outline-none focus:border-amber"
          >
            <option value="all">Alle Server ({uniqueServers.length})</option>
            {uniqueServers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        )}

        {/* System-Aktionen ausblenden Checkbox */}
        <label className="flex items-center gap-2 text-xs text-dim hover:text-ink cursor-pointer select-none px-2 py-1.5 rounded hover:bg-rack-2/50 transition">
          <input
            type="checkbox"
            checked={hideSystemActions}
            onChange={(e) => setHideSystemActions(e.target.checked)}
            className="rounded border-seam bg-abyss text-amber focus:ring-amber"
          />
          <span>System-Aktionen verbergen</span>
        </label>
      </div>

      {/* Audit Liste */}
      {isLoading ? (
        <div className="py-16 flex justify-center">
          <Spinner />
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="p-12 text-center rounded-2xl border border-dashed border-seam bg-rack/40 text-dim space-y-2">
          <Shield className="size-12 mx-auto text-dim opacity-30" />
          <p className="text-base font-medium text-ink">Keine Protokolleinträge gefunden</p>
          <p className="text-xs text-dim">
            Passe deine Suche oder den Kategorie-Filter oben an, um Ereignisse anzuzeigen.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-seam bg-rack shadow-sm">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-seam bg-rack-2/40 text-dim text-xs font-semibold uppercase tracking-wider">
                <th className="px-5 py-3.5">Zeitpunkt</th>
                <th className="px-5 py-3.5">Akteur</th>
                <th className="px-5 py-3.5">Aktion</th>
                <th className="px-5 py-3.5">Server</th>
                <th className="px-5 py-3.5">Details</th>
                <th className="px-5 py-3.5 text-right">Aktion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seam">
              {filteredEntries.map((entry) => {
                const dateObj = new Date(entry.created_at);
                const date = dateObj.toLocaleString('de-DE', {
                  day: '2-digit',
                  month: '2-digit',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });
                const meta = getActionMeta(entry.action);
                const Icon = meta.icon;
                const detailsSummary = formatSummaryDetails(entry.metadata);

                return (
                  <tr
                    key={entry.id}
                    onClick={() => setSelectedEntry(entry)}
                    className="hover:bg-rack-2/40 transition-colors cursor-pointer group"
                  >
                    {/* Zeitpunkt */}
                    <td className="px-5 py-3.5 text-xs text-dim whitespace-nowrap font-mono">
                      {date}
                    </td>

                    {/* Akteur */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <div className="font-medium text-ink flex items-center gap-2.5">
                        <span className={`size-6 rounded-full text-[10px] font-bold flex items-center justify-center shrink-0 ${
                          entry.actor_name === 'system'
                            ? 'bg-cyan-500/15 text-cyan-400'
                            : 'bg-amber/15 text-amber'
                        }`}>
                          {(entry.actor_name ?? 'Sys').slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <div className="text-xs font-semibold text-ink leading-tight">
                            {entry.actor_name ?? 'System'}
                          </div>
                          {entry.ip && (
                            <div className="text-[10px] font-mono text-dim/70 leading-tight">
                              {entry.ip}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Aktion Badge */}
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border ${meta.color}`}>
                          <Icon className="size-3.5 shrink-0" />
                          <span>{meta.label}</span>
                        </span>
                      </div>
                    </td>

                    {/* Server */}
                    <td className="px-5 py-3.5 text-xs whitespace-nowrap">
                      {entry.server_name ? (
                        <div className="font-medium text-ink flex items-center gap-1.5">
                          <Server className="size-3.5 text-dim" />
                          <span>{entry.server_name}</span>
                        </div>
                      ) : (
                        <span className="text-dim">–</span>
                      )}
                    </td>

                    {/* Details */}
                    <td className="px-5 py-3.5 text-xs text-dim max-w-sm truncate">
                      {detailsSummary ? (
                        <span className="font-mono text-slate-300 bg-rack-2/70 px-2 py-0.5 rounded border border-seam/80 inline-block truncate max-w-xs">
                          {detailsSummary}
                        </span>
                      ) : (
                        <span className="text-dim/60">–</span>
                      )}
                    </td>

                    {/* Info Button */}
                    <td className="px-5 py-3.5 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEntry(entry);
                        }}
                        className="px-2.5 py-1 rounded text-xs font-medium bg-rack-2 text-dim group-hover:text-amber group-hover:bg-rack-3 transition-colors inline-flex items-center gap-1"
                      >
                        <Eye className="size-3.5" />
                        <span>Details</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Audit Detail Modal */}
      {selectedEntry && (
        <div
          className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedEntry(null);
          }}
        >
          <div className="bg-rack border border-seam rounded-2xl max-w-2xl w-full p-6 space-y-5 shadow-2xl animate-in fade-in zoom-in-95">
            {/* Modal Header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getActionMeta(selectedEntry.action).color}`}>
                  {(() => {
                    const Icon = getActionMeta(selectedEntry.action).icon;
                    return <Icon className="size-6" />;
                  })()}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                    {getActionMeta(selectedEntry.action).label}
                  </h2>
                  <p className="text-xs font-mono text-amber mt-0.5">
                    {selectedEntry.action}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedEntry(null)}
                className="size-8 rounded-lg flex items-center justify-center text-dim hover:text-ink hover:bg-rack-2 transition-colors"
              >
                ✕
              </button>
            </div>

            {/* Übersicht-Grid */}
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="p-3 rounded-xl bg-rack-2/60 border border-seam space-y-1">
                <span className="text-dim font-medium">Zeitpunkt</span>
                <p className="font-mono text-ink font-semibold">
                  {new Date(selectedEntry.created_at).toLocaleString('de-DE')}
                </p>
              </div>

              <div className="p-3 rounded-xl bg-rack-2/60 border border-seam space-y-1">
                <span className="text-dim font-medium">Akteur</span>
                <p className="text-ink font-semibold flex items-center gap-1.5">
                  <UserCheck className="size-3.5 text-amber" />
                  {selectedEntry.actor_name ?? 'System'}
                  {selectedEntry.ip && (
                    <span className="font-mono text-dim text-[11px]">({selectedEntry.ip})</span>
                  )}
                </p>
              </div>

              {selectedEntry.server_name && (
                <div className="p-3 rounded-xl bg-rack-2/60 border border-seam space-y-1 col-span-2">
                  <span className="text-dim font-medium">Server</span>
                  <div className="flex items-center justify-between">
                    <p className="text-ink font-semibold flex items-center gap-1.5">
                      <Server className="size-3.5 text-cyan-400" />
                      {selectedEntry.server_name}
                    </p>
                    {selectedEntry.server_id && (
                      <Link
                        to={`/server/${selectedEntry.server_id}`}
                        className="text-amber hover:underline inline-flex items-center gap-1 text-[11px]"
                      >
                        Zum Server <ExternalLink className="size-3" />
                      </Link>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Metadaten Ansicht */}
            {selectedEntry.metadata ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-xs font-semibold text-ink">
                  <span>Aufgezeichnete Parameter (Metadaten)</span>
                  <button
                    type="button"
                    onClick={copyDetailsJson}
                    className="inline-flex items-center gap-1 text-dim hover:text-ink text-[11px]"
                  >
                    {copiedJson ? (
                      <>
                        <Check className="size-3.5 text-emerald-400" />
                        <span className="text-emerald-400">Kopiert</span>
                      </>
                    ) : (
                      <>
                        <Copy className="size-3.5" />
                        <span>JSON kopieren</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="p-4 rounded-xl bg-abyss border border-seam text-xs font-mono text-slate-300 overflow-x-auto max-h-56 leading-relaxed select-text">
                  {JSON.stringify(selectedEntry.metadata, null, 2)}
                </pre>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-rack-2/30 border border-dashed border-seam text-center text-xs text-dim">
                Keine zusätzlichen Parameter zu dieser Aktion hinterlegt.
              </div>
            )}

            {/* Schließen Button */}
            <div className="flex justify-end pt-2">
              <Button onClick={() => setSelectedEntry(null)}>
                Schließen
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
