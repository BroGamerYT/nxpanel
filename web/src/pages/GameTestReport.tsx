import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  FlaskConical, CheckCircle2, XCircle, Clock, Play, RefreshCw,
  Terminal, Copy, Check, ChevronDown, ChevronRight, FileText,
  AlertTriangle, ShieldAlert, Square, RotateCcw, AlertCircle,
  SlidersHorizontal, Cpu, Layers, Zap, X, ChevronLeft,
} from 'lucide-react';
import { api } from '../lib/api';
import { Button, ErrorBox, Spinner } from '../components/ui';
import { copyText } from '../lib/clipboard';
import { MarkdownViewer } from '../components/MarkdownViewer';
import type { GameTestReportData, GameTestItem } from '../lib/types';

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

export function GameTestReport() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<'all' | 'success' | 'failed'>('all');
  const [expandedEgg, setExpandedEgg] = useState<string | null>(null);
  const [copiedMd, setCopiedMd] = useState(false);
  const [copiedLog, setCopiedLog] = useState<string | null>(null);
  const [showMdModal, setShowMdModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);

  const [cpuPercent, setCpuPercent] = useState<number>(() => {
    const s = localStorage.getItem('nxp_test_cpu');
    return s !== null ? Number(s) : 400; // 4 Kerne als Standard
  });
  const [ramMb, setRamMb] = useState<number>(() => {
    const s = localStorage.getItem('nxp_test_ram');
    return s !== null ? Number(s) : 8192; // 8 GB RAM als Standard
  });
  const [timeoutMinutes, setTimeoutMinutes] = useState<number>(() => {
    const s = localStorage.getItem('nxp_test_timeout');
    return s !== null ? Number(s) : 25; // 25 Min. als Standard
  });

  const { data, isLoading, error, refetch, isFetching } = useQuery<GameTestReportData>({
    queryKey: ['admin-test-report'],
    queryFn: () => api<GameTestReportData>('/admin/test-report'),
    refetchInterval: (query) => (query.state.data?.isRunning ? 3_000 : 15_000),
  });

  const startMutation = useMutation({
    mutationFn: (body?: { mode?: 'resume' | 'fresh' | 'retry-failed'; cpuPercent?: number; ramMb?: number; timeout?: number }) =>
      api('/admin/test-games', {
        method: 'POST',
        body: {
          mode: body?.mode ?? 'resume',
          cpuPercent: body?.cpuPercent ?? cpuPercent,
          ramMb: body?.ramMb ?? ramMb,
          timeout: body?.timeout ?? timeoutMinutes,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-test-report'] });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => api('/admin/test-games/stop', { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-test-report'] });
    },
  });

  const isRunning = Boolean(data?.isRunning);
  const json = data?.jsonReport;
  const results = json?.results ?? [];
  const total = json?.total ?? (data?.totalEggs ? data.totalEggs : results.length);
  const successCount = json?.success ?? results.filter((r) => r.status === 'SUCCESS').length;
  const failedCount = json?.failed ?? results.filter((r) => r.status !== 'SUCCESS').length;
  const pendingCount = Math.max(0, total - results.length);

  const filtered = results.filter((r) => {
    if (filter === 'success') return r.status === 'SUCCESS';
    if (filter === 'failed') return r.status !== 'SUCCESS';
    return true;
  });

  const handleCopyMd = async () => {
    if (!data?.markdownReport) return;
    await copyText(data.markdownReport);
    setCopiedMd(true);
    setTimeout(() => setCopiedMd(false), 2000);
  };

  const handleCopyLog = async (eggId: string, log: string) => {
    await copyText(log);
    setCopiedLog(eggId);
    setTimeout(() => setCopiedLog(null), 2000);
  };

  if (isLoading) return <Spinner />;
  if (error) return <ErrorBox>{(error as Error).message}</ErrorBox>;

  return (
    <div className="max-w-6xl space-y-6">
      <Link
        to="/admin"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-dim hover:text-amber transition-colors"
      >
        <ChevronLeft className="size-4" />
        Zurück zum Admin-Hub
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <FlaskConical className="size-6 text-amber" />
            <h1 className="text-2xl font-semibold tracking-tight">Spiele-Testbericht</h1>
            {isRunning && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber/20 text-amber border border-amber/40 animate-pulse">
                <span className="size-2 rounded-full bg-amber animate-ping" />
                {data?.currentEgg ? `Testet: ${data.currentEgg}` : 'Testlauf läuft...'}
              </span>
            )}
          </div>
          <p className="text-dim text-sm mt-1">
            Automatischer Installations- und Startstabilitäts-Test für alle Spiel-Vorlagen (Eggs). Tests setzen nach Deployments automatisch nahtlos fort.
          </p>

          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-rack-2 text-dim border border-seam">
              <Cpu className="size-3 text-cyan-400" />
              <span>{cpuPercent === 0 ? 'Alle Kerne (Ungedrosselt)' : `${cpuPercent / 100} Kerne (${cpuPercent}%)`}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-rack-2 text-dim border border-seam">
              <Layers className="size-3 text-emerald-400" />
              <span>{Math.round(ramMb / 1024)} GB RAM</span>
            </span>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-rack-2 text-dim border border-seam">
              <Clock className="size-3 text-dim" />
              <span>{timeoutMinutes} Min. Timeout</span>
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="quiet"
            onClick={() => setShowConfigModal(true)}
            disabled={isRunning}
            className="flex items-center gap-1.5 text-xs h-9 text-ink/90 hover:text-amber"
            title="CPU-Kerne, RAM und Timeout anpassen"
          >
            <SlidersHorizontal className="size-3.5 text-amber" />
            <span>Ressourcen anpassen</span>
          </Button>

          {data?.markdownReport && (
            <Button
              variant="quiet"
              onClick={() => setShowMdModal(true)}
              className="flex items-center gap-1.5 text-xs h-9"
              title="Vollständigen Markdown-Bericht anzeigen"
            >
              <FileText className="size-4" />
              <span>Markdown</span>
            </Button>
          )}

          <Button
            variant="quiet"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs h-9"
            title="Aktualisieren"
          >
            <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            <span>Aktualisieren</span>
          </Button>

          {isRunning ? (
            <Button
              variant="danger"
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              className="flex items-center gap-1.5 text-xs h-9"
              title="Laufenden Testprozess abbrechen"
            >
              <Square className="size-3.5 fill-current" />
              <span>{stopMutation.isPending ? 'Stoppt...' : 'Testlauf anhalten'}</span>
            </Button>
          ) : (
            <>
              {results.length > 0 ? (
                <>
                  <Button
                    variant="primary"
                    onClick={() => startMutation.mutate({ mode: 'resume' })}
                    disabled={startMutation.isPending}
                    className="flex items-center gap-1.5 text-xs h-9"
                    title="Überspringt bereits erfolgreiche Spiele und testet die verbleibenden weiter"
                  >
                    <Play className="size-3.5 fill-current" />
                    <span>Testlauf fortsetzen</span>
                  </Button>

                  {failedCount > 0 && (
                    <Button
                      variant="quiet"
                      onClick={() => startMutation.mutate({ mode: 'retry-failed' })}
                      disabled={startMutation.isPending}
                      className="flex items-center gap-1.5 text-xs h-9 text-rose-400 hover:text-rose-300"
                      title="Wiederholt nur die fehlgeschlagenen Spiele"
                    >
                      <AlertCircle className="size-3.5" />
                      <span>Fehler wiederholen</span>
                    </Button>
                  )}

                  <Button
                    variant="quiet"
                    onClick={() => {
                      if (window.confirm('Möchtest du wirklich alle vorherigen Testergebnisse verwerfen und komplett von vorne anfangen?')) {
                        startMutation.mutate({ mode: 'fresh' });
                      }
                    }}
                    disabled={startMutation.isPending}
                    className="flex items-center gap-1.5 text-xs h-9 text-dim hover:text-ink"
                    title="Komplett von vorn anfangen"
                  >
                    <RotateCcw className="size-3.5" />
                    <span>Komplett neu</span>
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  onClick={() => startMutation.mutate({ mode: 'resume' })}
                  disabled={startMutation.isPending}
                  className="flex items-center gap-1.5 text-xs h-9"
                >
                  <Play className="size-3.5 fill-current" />
                  <span>Testlauf starten</span>
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Fehlermeldung bei Start/Stopp-Fehlschlag */}
      {startMutation.isError && (
        <ErrorBox>{(startMutation.error as Error).message}</ErrorBox>
      )}
      {stopMutation.isError && (
        <ErrorBox>{(stopMutation.error as Error).message}</ErrorBox>
      )}

      {/* KPI Kacheln */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="p-4 rounded-lg bg-rack border border-seam">
          <div className="text-xs text-dim">Fortschritt</div>
          <div className="text-2xl font-semibold mt-1">
            {results.length} <span className="text-sm font-normal text-dim">/ {total}</span>
          </div>
          <div className="text-xs text-dim mt-0.5">
            {pendingCount > 0 ? `${pendingCount} ausstehend` : 'Alle getestet'}
          </div>
        </div>

        <div className="p-4 rounded-lg bg-rack border border-seam">
          <div className="text-xs text-dim flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5 text-emerald-400" />
            <span>Erfolgreich</span>
          </div>
          <div className="text-2xl font-semibold text-emerald-400 mt-1">
            {successCount}
          </div>
          <div className="text-xs text-dim mt-0.5">
            {results.length > 0 ? `${Math.round((successCount / results.length) * 100)} % Erfolgsquote` : '–'}
          </div>
        </div>

        <div className="p-4 rounded-lg bg-rack border border-seam">
          <div className="text-xs text-dim flex items-center gap-1.5">
            <XCircle className="size-3.5 text-rose-400" />
            <span>Fehler / Abbrüche</span>
          </div>
          <div className="text-2xl font-semibold text-rose-400 mt-1">
            {failedCount}
          </div>
          <div className="text-xs text-dim mt-0.5">
            {failedCount > 0 ? 'Bedarf Nachbesserung' : 'Keine Fehler'}
          </div>
        </div>

        <div className="p-4 rounded-lg bg-rack border border-seam">
          <div className="text-xs text-dim flex items-center gap-1.5">
            <Clock className="size-3.5 text-dim" />
            <span>Zuletzt aktualisiert</span>
          </div>
          <div className="text-sm font-semibold mt-2 text-ink truncate">
            {json?.updated ? new Date(json.updated).toLocaleTimeString('de-DE') : '–'}
          </div>
          <div className="text-xs text-dim mt-0.5 truncate">
            {json?.updated ? new Date(json.updated).toLocaleDateString('de-DE') : 'Noch kein Lauf'}
          </div>
        </div>
      </div>

      {/* Fortschrittsbalken */}
      {total > 0 && (
        <div className="space-y-1.5 bg-rack/40 border border-seam/80 p-3 rounded-lg">
          <div className="flex justify-between text-xs text-dim">
            <span>
              Fortschritt: <strong className="text-ink">{results.length}</strong> von {total} Vorlagen getestet
              {data?.currentEgg && isRunning ? (
                <span className="text-amber ml-2 font-medium">
                  (Aktuell: {data.currentEgg})
                </span>
              ) : null}
            </span>
            <span>{Math.round((results.length / total) * 100)} %</span>
          </div>
          <div className="h-2.5 w-full rounded-full bg-rack border border-seam overflow-hidden flex">
            <div
              style={{ width: `${(successCount / total) * 100}%` }}
              className="bg-emerald-500 transition-all duration-300"
              title={`${successCount} erfolgreich`}
            />
            <div
              style={{ width: `${(failedCount / total) * 100}%` }}
              className="bg-rose-500 transition-all duration-300"
              title={`${failedCount} fehlgeschlagen`}
            />
            {isRunning && (
              <div
                style={{ width: `${Math.max(2, (1 / total) * 100)}%` }}
                className="bg-amber animate-pulse"
                title="Aktuell in Prüfung"
              />
            )}
          </div>
        </div>
      )}

      {/* Live Log-Ausgabe wenn Testlauf aktiv */}
      {isRunning && (
        <div className="rounded-lg border border-amber/30 bg-amber/5 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs font-semibold text-amber">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-amber animate-pulse" />
              <span>
                Live-Ausgabe des aktuellen Testlaufs
                {data?.currentEgg && (
                  <span className="ml-2 font-normal text-ink">
                    — Testet aktuell: <strong className="text-amber font-semibold">{data.currentEgg}</strong>
                    {data.currentEggIndex && data.totalEggs ? ` (${data.currentEggIndex} von ${data.totalEggs})` : ''}
                  </span>
                )}
              </span>
            </div>
            <span className="font-mono text-[11px] text-dim">test-games.log</span>
          </div>
          <pre className="font-mono text-xs bg-black/70 text-ink/90 p-3 rounded-md overflow-x-auto max-h-48 border border-seam/60 leading-relaxed whitespace-pre-wrap">
            {data?.logTail || 'Testlauf wird vorbereitet...'}
          </pre>
        </div>
      )}

      {/* Filterleiste */}
      <div className="flex items-center justify-between gap-2 border-b border-seam pb-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'all' ? 'bg-rack-2 text-ink border border-seam' : 'text-dim hover:text-ink'
            }`}
          >
            Alle ({results.length})
          </button>
          <button
            type="button"
            onClick={() => setFilter('success')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'success' ? 'bg-rack-2 text-emerald-400 border border-seam' : 'text-dim hover:text-ink'
            }`}
          >
            Erfolgreich ({successCount})
          </button>
          <button
            type="button"
            onClick={() => setFilter('failed')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              filter === 'failed' ? 'bg-rack-2 text-rose-400 border border-seam' : 'text-dim hover:text-ink'
            }`}
          >
            Fehler ({failedCount})
          </button>
        </div>
      </div>

      {/* Spiele-Tabelle */}
      {filtered.length === 0 ? (
        <div className="p-8 text-center text-dim bg-rack rounded-lg border border-seam">
          {results.length === 0
            ? 'Noch kein Testbericht vorhanden. Klicken Sie oben auf "Testlauf starten", um die Vorlagen zu prüfen.'
            : 'Keine Spiele in dieser Kategorie gefunden.'}
        </div>
      ) : (
        <div className="rounded-lg border border-seam overflow-hidden bg-rack">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="border-b border-seam bg-rack-2/40 text-dim text-xs uppercase tracking-wider">
                  <th className="py-2.5 px-3">Spiel</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Installation</th>
                  <th className="py-2.5 px-3">Startphase</th>
                  <th className="py-2.5 px-3">Diagnose</th>
                  <th className="py-2.5 px-3 text-right">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-seam/60">
                {filtered.map((item) => {
                  const isSuccess = item.status === 'SUCCESS';
                  const isExpanded = expandedEgg === item.eggId;
                  const hasLogs = Boolean(item.logExcerpt?.trim());

                  return (
                    <tr
                      key={item.eggId}
                      className="hover:bg-rack-2/30 transition-colors group cursor-pointer"
                      onClick={() => hasLogs && setExpandedEgg(isExpanded ? null : item.eggId)}
                    >
                      <td className="py-3 px-3 font-medium text-ink flex items-center gap-2">
                        {hasLogs ? (
                          isExpanded ? <ChevronDown className="size-4 text-dim" /> : <ChevronRight className="size-4 text-dim" />
                        ) : (
                          <div className="size-4" />
                        )}
                        <span>{item.eggName}</span>
                      </td>

                      <td className="py-3 px-3">
                        {isSuccess ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                            <CheckCircle2 className="size-3.5" />
                            Erfolgreich
                          </span>
                        ) : item.status === 'TIMEOUT' ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-amber/10 text-amber border border-amber/30">
                            <Clock className="size-3.5" />
                            Timeout
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">
                            <XCircle className="size-3.5" />
                            Fehlgeschlagen
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-3 text-dim font-mono text-xs">
                        {formatDuration(item.installDurationSec)}
                      </td>

                      <td className="py-3 px-3 text-dim font-mono text-xs">
                        {formatDuration(item.runtimeDurationSec)}
                      </td>

                      <td className="py-3 px-3 max-w-md">
                        {item.errorSummary ? (
                          <span className="text-xs text-rose-300 font-mono line-clamp-2 bg-rose-950/40 px-2 py-1 rounded border border-rose-900/50">
                            {item.errorSummary}
                          </span>
                        ) : (
                          <span className="text-xs text-dim">–</span>
                        )}
                      </td>

                      <td className="py-3 px-3 text-right">
                        {hasLogs && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedEgg(isExpanded ? null : item.eggId);
                            }}
                            className="inline-flex items-center gap-1 text-xs text-dim hover:text-ink px-2 py-1 rounded bg-rack-2/60 hover:bg-rack-2 border border-seam"
                          >
                            <Terminal className="size-3" />
                            <span>{isExpanded ? 'Schließen' : 'Log'}</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Ausgeklappter Log-Viewer */}
      {expandedEgg && (
        (() => {
          const item = results.find((r) => r.eggId === expandedEgg);
          if (!item || !item.logExcerpt) return null;
          return (
            <div className="rounded-lg border border-seam bg-rack p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="size-4 text-amber" />
                  <span className="font-semibold text-sm">Konsolen- und Fehler-Log: {item.eggName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="quiet"
                    onClick={() => handleCopyLog(item.eggId, item.logExcerpt)}
                    className="flex items-center gap-1.5 text-xs h-7 px-2"
                  >
                    {copiedLog === item.eggId ? <Check className="size-3 text-emerald-400" /> : <Copy className="size-3" />}
                    <span>{copiedLog === item.eggId ? 'Kopiert' : 'Log kopieren'}</span>
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => setExpandedEgg(null)}
                    className="text-xs h-7 px-2"
                  >
                    Schließen
                  </Button>
                </div>
              </div>
              <pre className="font-mono text-xs bg-black/80 text-ink/90 p-3.5 rounded-md overflow-x-auto max-h-80 border border-seam leading-relaxed whitespace-pre-wrap">
                {item.logExcerpt}
              </pre>
            </div>
          );
        })()
      )}

      {/* Ressourcen-Konfigurations Modal */}
      {showConfigModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-rack border border-seam rounded-xl max-w-lg w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-4 border-b border-seam flex items-center justify-between">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="size-5 text-amber" />
                <h2 className="font-semibold text-base">Testlauf-Ressourcen anpassen</h2>
              </div>
              <button
                type="button"
                onClick={() => setShowConfigModal(false)}
                className="text-dim hover:text-ink p-1 rounded-md"
              >
                <X className="size-4" />
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="bg-amber/10 border border-amber/30 rounded-lg p-3 text-xs text-amber leading-relaxed">
                <strong>Host-Kapazität:</strong> Dein Server verfügt über <strong>14 CPU-Kerne</strong> und <strong>62 GB RAM</strong>. Jedes Spiel wird isoliert getestet und danach restlos gelöscht. Mehr Kerne & RAM beschleunigen die SteamCMD-Entpackung erheblich!
              </div>

              {/* CPU Kerne */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1.5 flex items-center gap-1.5">
                  <Cpu className="size-3.5 text-cyan-400" />
                  <span>CPU-Zuteilung je Testspiel</span>
                </label>
                <select
                  value={cpuPercent}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setCpuPercent(val);
                    localStorage.setItem('nxp_test_cpu', String(val));
                  }}
                  className="w-full bg-rack-2 border border-seam rounded-md px-3 py-2 text-sm text-ink focus:outline-none focus:border-amber"
                >
                  <option value={0}>⚡ Alle Kerne (14 Kerne ungedrosselt – Maximale Geschwindigkeit)</option>
                  <option value={800}>8 Kerne (800% CPU – Extrem schnell)</option>
                  <option value={600}>6 Kerne (600% CPU – Sehr schnell)</option>
                  <option value={400}>4 Kerne (400% CPU – Empfohlen)</option>
                  <option value={200}>2 Kerne (200% CPU – Moderat)</option>
                  <option value={100}>1 Kern (100% CPU – Sparsam / Minimal)</option>
                </select>
                <p className="text-[11px] text-dim mt-1">
                  Empfehlung: <strong>4 oder 8 Kerne</strong> (beschleunigt ARK und Enshrouded Downloads).
                </p>
              </div>

              {/* RAM Zuteilung */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1.5 flex items-center gap-1.5">
                  <Layers className="size-3.5 text-emerald-400" />
                  <span>Arbeitsspeicher (RAM-Limit)</span>
                </label>
                <select
                  value={ramMb}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setRamMb(val);
                    localStorage.setItem('nxp_test_ram', String(val));
                  }}
                  className="w-full bg-rack-2 border border-seam rounded-md px-3 py-2 text-sm text-ink focus:outline-none focus:border-amber"
                >
                  <option value={24576}>24 GB RAM (24.576 MB – Für riesige Cluster)</option>
                  <option value={16384}>16 GB RAM (16.384 MB – Optimal für ARK: SA)</option>
                  <option value={12288}>12 GB RAM (12.288 MB)</option>
                  <option value={8192}>8 GB RAM (8.192 MB – Empfohlen)</option>
                  <option value={4096}>4 GB RAM (4.096 MB – Minimum)</option>
                </select>
                <p className="text-[11px] text-dim mt-1">
                  Falls ein Spiel laut Vorlage mehr RAM benötigt (z. B. ARK min. 16 GB), wird automatisch der höhere Wert gewählt.
                </p>
              </div>

              {/* Timeout je Spiel */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1.5 flex items-center gap-1.5">
                  <Clock className="size-3.5 text-dim" />
                  <span>Maximaler Timeout pro Spiel</span>
                </label>
                <select
                  value={timeoutMinutes}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setTimeoutMinutes(val);
                    localStorage.setItem('nxp_test_timeout', String(val));
                  }}
                  className="w-full bg-rack-2 border border-seam rounded-md px-3 py-2 text-sm text-ink focus:outline-none focus:border-amber"
                >
                  <option value={60}>60 Minuten (Für extrem langsame Downloads)</option>
                  <option value={40}>40 Minuten</option>
                  <option value={25}>25 Minuten (Empfohlen für Ark & SteamCMD)</option>
                  <option value={15}>15 Minuten (Standard)</option>
                </select>
              </div>
            </div>

            <div className="p-4 border-t border-seam bg-rack-2/40 flex justify-end">
              <Button
                variant="primary"
                onClick={() => setShowConfigModal(false)}
                className="text-xs h-8 px-4"
              >
                Einstellungen übernehmen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Markdown-Bericht Modal */}
      {showMdModal && data?.markdownReport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
          <div className="bg-rack border border-seam rounded-xl max-w-4xl w-full max-h-[85vh] flex flex-col shadow-2xl">
            <div className="p-4 border-b border-seam flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="size-5 text-amber" />
                <h2 className="font-semibold text-base">Markdown-Testbericht (GAME-INSTALL-TESTS.md)</h2>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="quiet"
                  onClick={handleCopyMd}
                  className="flex items-center gap-1.5 text-xs h-8 px-2.5"
                >
                  {copiedMd ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
                  <span>{copiedMd ? 'Kopiert!' : 'Kopieren'}</span>
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => setShowMdModal(false)}
                  className="text-xs h-8 px-2.5"
                >
                  Schließen
                </Button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto flex-1 bg-black/30">
              <MarkdownViewer content={data.markdownReport} showRawToggle={true} showCopyButton={false} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
