import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Terminal,
  RefreshCw,
  Search,
  Download,
  Copy,
  Check,
  Server,
  Database,
  Layers,
  Activity,
  AlertCircle,
  AlertTriangle,
  Info,
  Sliders,
  Filter,
  ChevronLeft,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button, Input, Spinner } from '../components/ui';

interface LogItem {
  id: number;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  raw: string;
}

interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  isPanel: boolean;
}

interface HostLogsResponse {
  container: string;
  containers: ContainerInfo[];
  logs: LogItem[];
  count: number;
  total: number;
}

export function AdminHostLogs() {
  const [selectedContainer, setSelectedContainer] = useState('nxp-panel');
  const [lineLimit, setLineLimit] = useState(300);
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'error' | 'warn' | 'info'>('all');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [copied, setCopied] = useState(false);
  const logBottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { data, isLoading, refetch, isFetching } = useQuery<HostLogsResponse>({
    queryKey: ['adminHostLogs', selectedContainer, lineLimit, search],
    queryFn: () => {
      const p = new URLSearchParams({
        container: selectedContainer,
        lines: String(lineLimit),
      });
      if (search.trim()) p.set('search', search.trim());
      return api(`/admin/host-logs?${p.toString()}`);
    },
    refetchInterval: autoRefresh ? 3500 : false,
  });

  const logs = data?.logs ?? [];
  const containers = data?.containers ?? [];

  const filteredLogs = logs.filter((item) => {
    if (levelFilter === 'all') return true;
    return item.level === levelFilter;
  });

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;

  useEffect(() => {
    if (autoScroll && logBottomRef.current) {
      logBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs.length, autoScroll]);

  const handleCopy = () => {
    const text = filteredLogs.map((l) => (l.timestamp ? `[${l.timestamp}] ${l.message}` : l.raw)).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const text = filteredLogs.map((l) => (l.timestamp ? `[${l.timestamp}] ${l.message}` : l.raw)).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nexuslogs-${selectedContainer}-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-dim hover:text-amber transition-colors"
      >
        <ChevronLeft className="size-4" />
        Zurück zum Admin-Hub
      </Link>

      {/* Kopfbereich */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2.5">
            <Terminal className="size-6 text-emerald-400" aria-hidden />
            Nexus-Logs &amp; Host-Protokoll
          </h1>
          <p className="text-dim text-sm mt-0.5">
            Echtzeit-Logprotokoll der Docker-Container, Hintergrunddienste und des Panel-Backends auf dem Host.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="quiet"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`text-xs h-8 px-2.5 flex items-center gap-1.5 ${autoRefresh ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'text-dim'}`}
          >
            <span className={`size-2 rounded-full ${autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-dim'}`} />
            Live: {autoRefresh ? 'Ein' : 'Aus'}
          </Button>

          <Button
            variant="quiet"
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-xs h-8 px-2.5 flex items-center gap-1.5"
            title="Jetzt neu laden"
          >
            <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin text-amber' : ''}`} />
            Aktualisieren
          </Button>

          <Button
            variant="quiet"
            onClick={handleCopy}
            disabled={filteredLogs.length === 0}
            className="text-xs h-8 px-2.5 flex items-center gap-1.5"
            title="In Zwischenablage kopieren"
          >
            {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
            {copied ? 'Kopiert!' : 'Kopieren'}
          </Button>

          <Button
            variant="quiet"
            onClick={handleDownload}
            disabled={filteredLogs.length === 0}
            className="text-xs h-8 px-2.5 flex items-center gap-1.5"
            title="Logdatei herunterladen"
          >
            <Download className="size-3.5" />
            Download
          </Button>
        </div>
      </div>

      {/* Container Auswahl & Filterleiste */}
      <div className="bg-rack border border-seam rounded-lg p-3 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Container Auswahlliste */}
          <div className="flex items-center gap-2 overflow-x-auto pb-1 md:pb-0">
            <span className="text-xs text-dim font-medium uppercase tracking-wider shrink-0 flex items-center gap-1">
              <Layers className="size-3.5" /> Quelle:
            </span>
            {containers.map((c) => {
              const isActive = c.name === selectedContainer || c.id === selectedContainer;
              return (
                <button
                  key={c.id || c.name}
                  onClick={() => setSelectedContainer(c.name)}
                  className={`px-2.5 py-1 rounded-md text-xs font-mono transition-colors border shrink-0 flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-amber/15 text-amber border-amber/40 font-semibold'
                      : 'bg-rack-2/40 text-dim hover:text-ink border-seam'
                  }`}
                >
                  {c.name.includes('panel') ? (
                    <Server className="size-3 text-amber" />
                  ) : c.name.includes('postgres') || c.name.includes('redis') ? (
                    <Database className="size-3 text-sky-400" />
                  ) : (
                    <Activity className="size-3 text-emerald-400" />
                  )}
                  {c.name}
                </button>
              );
            })}
          </div>

          {/* Zeilenlimit */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-dim">Zeilen:</span>
            {[100, 300, 500, 1000].map((num) => (
              <button
                key={num}
                onClick={() => setLineLimit(num)}
                className={`px-2 py-0.5 rounded text-xs transition-colors border ${
                  lineLimit === num
                    ? 'bg-ink text-black font-semibold border-ink'
                    : 'bg-rack-2/40 text-dim hover:text-ink border-seam'
                }`}
              >
                {num}
              </button>
            ))}
          </div>
        </div>

        {/* Suchfeld & Level-Filter */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2.5 pt-2 border-t border-seam/60">
          <div className="relative w-full sm:w-80">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-dim pointer-events-none" />
            <Input
              type="text"
              placeholder="Log-Ausgabe durchsuchen..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 text-xs py-1 h-8"
            />
          </div>

          <div className="flex items-center gap-1.5 w-full sm:w-auto justify-end">
            <span className="text-xs text-dim mr-1 flex items-center gap-1">
              <Filter className="size-3" /> Level:
            </span>
            <button
              onClick={() => setLevelFilter('all')}
              className={`px-2.5 py-1 rounded text-xs transition-colors border ${
                levelFilter === 'all'
                  ? 'bg-slate-700 text-ink border-slate-500 font-medium'
                  : 'text-dim hover:text-ink border-transparent'
              }`}
            >
              Alle ({logs.length})
            </button>
            <button
              onClick={() => setLevelFilter('error')}
              className={`px-2.5 py-1 rounded text-xs transition-colors border flex items-center gap-1 ${
                levelFilter === 'error'
                  ? 'bg-rose-500/20 text-rose-400 border-rose-500/40 font-medium'
                  : 'text-dim hover:text-rose-400 border-transparent'
              }`}
            >
              <AlertCircle className="size-3 text-rose-400" />
              Fehler ({errorCount})
            </button>
            <button
              onClick={() => setLevelFilter('warn')}
              className={`px-2.5 py-1 rounded text-xs transition-colors border flex items-center gap-1 ${
                levelFilter === 'warn'
                  ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 font-medium'
                  : 'text-dim hover:text-amber-400 border-transparent'
              }`}
            >
              <AlertTriangle className="size-3 text-amber-400" />
              Warnungen ({warnCount})
            </button>
            <button
              onClick={() => setLevelFilter('info')}
              className={`px-2.5 py-1 rounded text-xs transition-colors border flex items-center gap-1 ${
                levelFilter === 'info'
                  ? 'bg-sky-500/20 text-sky-400 border-sky-500/40 font-medium'
                  : 'text-dim hover:text-sky-400 border-transparent'
              }`}
            >
              <Info className="size-3 text-sky-400" />
              Info
            </button>
          </div>
        </div>
      </div>

      {/* Terminal Log-Fenster */}
      <div className="relative rounded-lg border border-seam bg-[#0d1117] font-mono text-xs overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-seam/80 text-[11px] text-dim">
          <div className="flex items-center gap-2">
            <span className="inline-block size-2 rounded-full bg-emerald-500" />
            <span className="font-semibold text-ink">{selectedContainer}</span>
            <span>•</span>
            <span>{filteredLogs.length} Zeilen angezeigt</span>
          </div>

          <label className="flex items-center gap-1.5 cursor-pointer hover:text-ink select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded border-seam bg-rack text-amber focus:ring-0 size-3"
            />
            Auto-Scroll nach unten
          </label>
        </div>

        <div className="p-3 max-h-[600px] min-h-[350px] overflow-y-auto space-y-1">
          {isLoading ? (
            <div className="py-20 flex flex-col items-center justify-center gap-2 text-dim">
              <Spinner />
              <span>Lade Logdaten von {selectedContainer}...</span>
            </div>
          ) : filteredLogs.length === 0 ? (
            <div className="py-20 text-center text-dim text-sm">
              Keine Log-Einträge für die aktuellen Filter gefunden.
            </div>
          ) : (
            filteredLogs.map((item) => {
              let color = 'text-slate-300';
              let badgeBg = 'bg-slate-800 text-slate-400';

              if (item.level === 'error') {
                color = 'text-rose-300 bg-rose-500/5';
                badgeBg = 'bg-rose-500/20 text-rose-300 font-bold';
              } else if (item.level === 'warn') {
                color = 'text-amber-300 bg-amber-500/5';
                badgeBg = 'bg-amber-500/20 text-amber-300';
              } else if (item.level === 'debug') {
                color = 'text-slate-500';
                badgeBg = 'bg-slate-800 text-slate-500';
              }

              return (
                <div
                  key={item.id}
                  className={`flex items-start gap-2.5 px-2 py-0.5 rounded leading-relaxed hover:bg-white/[0.03] transition-colors ${color}`}
                >
                  <span className="text-dim/40 select-none w-10 shrink-0 text-right text-[10px]">
                    {item.id}
                  </span>

                  {item.timestamp && (
                    <span className="text-dim/60 shrink-0 text-[10px] select-none">
                      {item.timestamp.replace(/^(\d{4}-\d{2}-\d{2}T|\d{4}-\d{2}-\d{2}\s)/, '').replace(/Z$/, '')}
                    </span>
                  )}

                  <span className={`text-[9px] uppercase px-1.5 py-0.2 rounded shrink-0 select-none ${badgeBg}`}>
                    {item.level}
                  </span>

                  <span className="break-all whitespace-pre-wrap flex-1">
                    {item.message}
                  </span>
                </div>
              );
            })
          )}
          <div ref={logBottomRef} />
        </div>
      </div>
    </div>
  );
}
