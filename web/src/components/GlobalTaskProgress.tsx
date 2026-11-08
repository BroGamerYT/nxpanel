import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import {
  Archive,
  ArrowUpCircle,
  DownloadCloud,
  Play,
  Square,
  ChevronDown,
  ChevronUp,
  Activity,
  ArrowRight,
  RefreshCw,
} from 'lucide-react';
import { api } from '../lib/api';
import type { ActiveTask } from '../lib/types';

export function GlobalTaskProgress() {
  const [minimized, setMinimized] = useState(false);

  const { data } = useQuery<{ tasks: ActiveTask[] }>({
    queryKey: ['activeTasks'],
    queryFn: () => api<{ tasks: ActiveTask[] }>('/tasks/active'),
    refetchInterval: (q) => (q.state.data?.tasks?.length ? 2000 : 8000),
  });

  const tasks = data?.tasks ?? [];

  if (tasks.length === 0) return null;

  // Icon je nach Aufgabentyp
  function getTaskIcon(type: ActiveTask['type']) {
    switch (type) {
      case 'backup':
        return <Archive className="size-4 text-sky-400 shrink-0" />;
      case 'game_update':
      case 'modpack_update':
        return <ArrowUpCircle className="size-4 text-amber shrink-0 animate-bounce" />;
      case 'install':
        return <DownloadCloud className="size-4 text-emerald-400 shrink-0 animate-pulse" />;
      case 'starting':
        return <Play className="size-4 text-emerald-400 shrink-0" />;
      case 'stopping':
        return <Square className="size-4 text-slate-400 shrink-0" />;
      default:
        return <Activity className="size-4 text-amber shrink-0" />;
    }
  }

  // Minimized Mode (kleine schwebende Pille unten rechts)
  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2.5 px-3.5 py-2 rounded-full border border-amber/50 bg-rack-1/95 text-ink shadow-[0_8px_30px_rgb(0,0,0,0.5)] backdrop-blur-xl hover:border-amber transition-all duration-200 group select-none"
        title="Hintergrund-Aufgaben anzeigen"
      >
        <span className="relative flex size-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber opacity-75" />
          <span className="relative inline-flex rounded-full size-2.5 bg-amber" />
        </span>
        <RefreshCw className="size-3.5 text-amber animate-spin" />
        <span className="text-xs font-medium">
          {tasks.length} {tasks.length === 1 ? 'Aufgabe aktiv' : 'Aufgaben aktiv'}
        </span>
        <ChevronUp className="size-3.5 text-dim group-hover:text-ink transition-transform" />
      </button>
    );
  }

  // Ausgeklapptes HUD Panel
  return (
    <div className="fixed bottom-4 right-4 z-40 w-88 max-w-[calc(100vw-2rem)] rounded-2xl border border-amber/40 bg-rack/95 text-ink shadow-[0_20px_50px_rgba(0,0,0,0.7)] backdrop-blur-xl overflow-hidden transition-all duration-300 animate-in fade-in slide-in-from-bottom-3">
      {/* Kopfzeile */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-rack-2/60 border-b border-seam/80 select-none">
        <div className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber opacity-75" />
            <span className="relative inline-flex rounded-full size-2 bg-amber" />
          </span>
          <span className="text-xs font-semibold text-ink">
            Hintergrund-Aufgaben ({tasks.length})
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMinimized(true)}
          className="size-6 flex items-center justify-center rounded text-dim hover:text-ink hover:bg-rack-2 transition-colors"
          title="Minimieren"
        >
          <ChevronDown className="size-4" />
        </button>
      </div>

      {/* Aufgaben-Liste */}
      <div className="max-h-72 overflow-y-auto divide-y divide-seam/60 p-1">
        {tasks.map((task) => (
          <div key={task.id} className="p-3 space-y-2 hover:bg-rack-2/30 transition-colors rounded-xl">
            {/* Header: Icon, Server, Titel */}
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                {getTaskIcon(task.type)}
                <div className="min-w-0">
                  <span className="inline-block px-1.5 py-0.2 rounded text-[10px] font-medium bg-amber/15 text-amber border border-amber/30 truncate max-w-[130px]">
                    {task.serverName}
                  </span>
                  <div className="text-xs font-semibold text-ink truncate mt-0.5">
                    {task.title}
                  </div>
                </div>
              </div>

              {task.shortId && (
                <Link
                  to={`/server/${task.shortId}`}
                  className="shrink-0 inline-flex items-center gap-1 text-[11px] text-dim hover:text-amber transition-colors mt-0.5"
                  title="Zum Server wechseln"
                >
                  <span>Server</span>
                  <ArrowRight className="size-3" />
                </Link>
              )}
            </div>

            {/* Untertitel / Status */}
            {task.subtitle && (
              <p className="text-[11px] text-dim leading-tight">
                {task.subtitle}
              </p>
            )}

            {/* Fortschrittsbalken */}
            {task.progressPercent !== undefined ? (
              <div className="space-y-1">
                <div className="flex justify-between items-center text-[10px] font-mono text-dim">
                  <span>Fortschritt</span>
                  <span className="text-amber font-semibold">{task.progressPercent} %</span>
                </div>
                <div className="w-full h-1.5 bg-rack-2 rounded-full overflow-hidden border border-seam/60">
                  <div
                    className="h-full bg-gradient-to-r from-amber to-amber/80 transition-all duration-300 rounded-full"
                    style={{ width: `${task.progressPercent}%` }}
                  />
                </div>
              </div>
            ) : (
              /* Indeterminate Bar */
              <div className="w-full h-1 bg-rack-2 rounded-full overflow-hidden">
                <div className="h-full w-1/3 bg-amber/80 rounded-full animate-pulse" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
