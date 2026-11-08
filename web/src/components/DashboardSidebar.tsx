import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  Info,
  Layers,
  MemoryStick,
  RefreshCw,
  Star,
  X,
  Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, t } from '../lib/i18n';
import { formatMb } from '../lib/status';
import type { ServerListItem, ServerLive } from '../lib/types';
import { Bar } from './Dashboard';
import { Led } from './ui';

export interface DashboardActivityItem {
  id: number;
  serverId: string;
  serverName: string;
  shortId: string;
  ts: string;
  kind: string;
  severity: 'info' | 'warn' | 'error';
  summary: string;
  payload?: Record<string, unknown> | null;
}

interface DashboardSidebarProps {
  servers: ServerListItem[];
  liveMap: Map<string, ServerLive>;
  onClose: () => void;
}

function timeAgo(iso: string): string {
  try {
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return `${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h`;
    return `${Math.floor(diffH / 24)}d`;
  } catch {
    return '';
  }
}

export function DashboardSidebar({ servers, liveMap, onClose }: DashboardSidebarProps) {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['dashboardActivity'],
    queryFn: () => api<{ items: DashboardActivityItem[] }>('/dashboard/activity'),
    refetchInterval: 15_000,
  });

  const favorites = servers.filter((s) => s.isFavorite);

  // Top RAM-Verbraucher unter den laufenden Servern
  const activeResources = servers
    .filter((s) => s.status === 'running')
    .map((s) => {
      const live = liveMap.get(s.id);
      return {
        id: s.id,
        shortId: s.shortId,
        name: s.name,
        ramMb: s.ramMb,
        usedMemMb: live?.memMb ?? 0,
        cpuPercent: live?.cpuPercent ?? 0,
        cpuLimit: s.cpuPercent,
      };
    })
    .sort((a, b) => b.usedMemMb - a.usedMemMb)
    .slice(0, 4);

  const items = data?.items ?? [];

  return (
    <aside className="w-80 xl:w-88 2xl:w-96 shrink-0 space-y-4">
      {/* 1. Header der Sidebar */}
      <div className="rounded-lg border border-seam bg-rack p-4 space-y-3">
        <div className="flex items-center justify-between gap-2 border-b border-seam/60 pb-3">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-amber" />
            <h2 className="font-semibold text-sm text-ink">Live-Aktivitäten</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refetch()}
              disabled={isFetching}
              className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/60 transition-colors"
              title="Feed aktualisieren"
            >
              <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/60 transition-colors"
              title="Sidebar einklappen"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        {/* 2. Favoriten (Schnellzugriff) falls vorhanden */}
        {favorites.length > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between text-xs text-dim font-medium">
              <span className="flex items-center gap-1.5">
                <Star className="size-3 text-amber fill-amber" /> Favoriten
              </span>
              <span className="font-mono text-[11px]">{favorites.length}</span>
            </div>
            <div className="space-y-1.5">
              {favorites.map((fav) => {
                const live = liveMap.get(fav.id);
                return (
                  <Link
                    key={fav.id}
                    to={`/server/${fav.shortId}`}
                    className="flex items-center justify-between gap-2 p-2 rounded-md bg-rack-2/40 hover:bg-rack-2/80 border border-seam/60 text-xs transition-colors group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Led status={fav.status} />
                      <span className="font-medium text-ink truncate group-hover:text-amber">
                        {fav.name}
                      </span>
                    </div>
                    {live ? (
                      <span className="font-mono text-[11px] text-dim shrink-0">
                        {live.cpuPercent.toFixed(0)}% · {formatMb(live.memMb)}
                      </span>
                    ) : (
                      <span className="text-[11px] text-dim shrink-0 capitalize">{fav.status}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. Ressourcen-Ranking (Top laufende Server) */}
        {activeResources.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-seam/60">
            <div className="flex items-center justify-between text-xs text-dim font-medium">
              <span className="flex items-center gap-1.5">
                <MemoryStick className="size-3 text-emerald-400" /> Top RAM-Verbrauch
              </span>
              <span className="font-mono text-[11px]">{activeResources.length} aktiv</span>
            </div>
            <div className="space-y-2">
              {activeResources.map((srv) => (
                <Link
                  key={srv.id}
                  to={`/server/${srv.shortId}`}
                  className="block p-2 rounded-md bg-rack-2/30 hover:bg-rack-2/60 border border-seam/40 text-xs space-y-1 transition-colors group"
                >
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-medium text-ink truncate group-hover:text-amber">
                      {srv.name}
                    </span>
                    <span className="font-mono text-[11px] text-dim shrink-0">
                      {formatMb(srv.usedMemMb)} / {formatMb(srv.ramMb)}
                    </span>
                  </div>
                  <Bar
                    pct={srv.ramMb > 0 ? srv.usedMemMb / srv.ramMb : 0}
                    className="h-1 bg-rack-1"
                  />
                </Link>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 4. Letzte Ereignisse & Meldungen */}
      <div className="rounded-lg border border-seam bg-rack p-4 space-y-3">
        <div className="flex items-center justify-between text-xs font-semibold text-dim uppercase tracking-wider">
          <span className="flex items-center gap-1.5">
            <Clock className="size-3.5" /> Ereignis-Protokoll
          </span>
          <span className="font-mono text-[11px] font-normal lowercase">live</span>
        </div>

        {isLoading ? (
          <div className="py-6 text-center text-xs text-dim">Lade Aktivitäten...</div>
        ) : items.length === 0 ? (
          <p className="text-xs text-dim py-4 text-center">Bisher keine Ereignisse erfasst.</p>
        ) : (
          <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1 divide-y divide-seam/40">
            {items.map((it) => (
              <Link
                key={it.id}
                to={`/server/${it.shortId}`}
                className="pt-2 first:pt-0 block hover:bg-rack-2/30 p-1.5 rounded transition-colors group"
              >
                <div className="flex items-start justify-between gap-1.5 text-xs">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={`size-1.5 rounded-full shrink-0 ${
                        it.severity === 'error'
                          ? 'bg-led-crash'
                          : it.severity === 'warn'
                          ? 'bg-amber'
                          : 'bg-emerald-400'
                      }`}
                    />
                    <span className="font-medium text-ink truncate group-hover:text-amber">
                      {it.serverName}
                    </span>
                  </div>
                  <time className="font-mono text-[10px] text-dim shrink-0 tabular-nums">
                    {timeAgo(it.ts)}
                  </time>
                </div>
                <p className="text-[11px] text-dim line-clamp-2 mt-0.5 pl-3 group-hover:text-ink/80 leading-snug">
                  {it.summary}
                </p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
