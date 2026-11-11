import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  Lock,
  LockOpen,
  Download,
  RotateCcw,
  Trash,
  Plus,
  RefreshCw,
  CircleCheck,
  CircleX,
  ShieldCheck,
  ShieldAlert,
  Clock,
  CheckCircle2,
  AlertTriangle,
  FileCheck,
  Cloud,
} from 'lucide-react';
import { api, currentToken, refreshSession } from '../lib/api';
import { useFeatures } from '../lib/features';
import { t } from '../lib/i18n';
import type { BackupItem, ServerStatus, BackupSchedule, BackupVerificationDetails, ActiveTask } from '../lib/types';
import { Button, ErrorBox, Spinner } from './ui';

function formatBytes(bytes: number): string {
  const b = Number(bytes);
  if (b === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return `${parseFloat((b / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function BackupManager({
  serverId,
  status,
  permissions,
}: {
  serverId: string;
  status: ServerStatus;
  permissions: string[];
}) {
  const qc = useQueryClient();
  const features = useFeatures();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [selectedVerifyBackup, setSelectedVerifyBackup] = useState<BackupItem | null>(null);

  const [customName, setCustomName] = useState('');
  const [ignorePatterns, setIgnorePatterns] = useState('');
  const [restoreTarget, setRestoreTarget] = useState<BackupItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BackupItem | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Formularstatus fuer Auto-Backup Zeitplan
  const [scheduleForm, setScheduleForm] = useState<BackupSchedule>({
    enabled: false,
    intervalHours: 24,
    retention: 5,
    verify: true,
    lastAutoBackupAt: null,
  });

  const canRead = permissions.includes('backup.read');
  const canCreate = permissions.includes('backup.create');
  const canRestore = permissions.includes('backup.restore');
  const canDelete = permissions.includes('backup.delete');
  const canDownload = permissions.includes('backup.download');

  const { data, isLoading, error, refetch, isFetching } = useQuery<{ backups: BackupItem[] }>({
    queryKey: ['backups', serverId],
    queryFn: () => api<{ backups: BackupItem[] }>(`/servers/${serverId}/backups`),
    enabled: canRead,
    refetchInterval: (query) => {
      const list = query.state.data?.backups ?? [];
      const hasActive = list.some((b) => b.status === 'running' || b.status === 'restoring');
      return hasActive ? 2500 : false;
    },
  });

  const { data: scheduleData } = useQuery<{ schedule: BackupSchedule }>({
    queryKey: ['backup-schedule', serverId],
    queryFn: () => api<{ schedule: BackupSchedule }>(`/servers/${serverId}/backup-schedule`),
    enabled: canRead,
  });

  const { data: tasksData } = useQuery<{ tasks: ActiveTask[] }>({
    queryKey: ['active-tasks', serverId],
    queryFn: () => api<{ tasks: ActiveTask[] }>(`/servers/${serverId}/tasks/active`),
    enabled: canRead,
    refetchInterval: (query) => {
      const list = query.state.data?.tasks ?? [];
      const hasBackup = list.some((t) => t.type === 'backup');
      return hasBackup ? 1500 : 8000;
    },
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['backups', serverId] });
  };

  const createMut = useMutation({
    mutationFn: (body: { name?: string; ignoredFiles?: string[] }) =>
      api(`/servers/${serverId}/backups`, {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      setShowCreateModal(false);
      setCustomName('');
      setIgnorePatterns('');
      invalidate();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const restoreMut = useMutation({
    mutationFn: (backupId: string) =>
      api(`/servers/${serverId}/backups/${backupId}/restore`, {
        method: 'POST',
      }),
    onSuccess: () => {
      setRestoreTarget(null);
      invalidate();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const deleteMut = useMutation({
    mutationFn: (backupId: string) =>
      api(`/servers/${serverId}/backups/${backupId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const lockMut = useMutation({
    mutationFn: ({ backupId, locked }: { backupId: string; locked: boolean }) =>
      api(`/servers/${serverId}/backups/${backupId}`, {
        method: 'PATCH',
        body: { locked },
      }),
    onSuccess: () => invalidate(),
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const verifyMut = useMutation({
    mutationFn: (backupId: string) =>
      api<{ ok: boolean; result: BackupVerificationDetails }>(`/servers/${serverId}/backups/${backupId}/verify`, {
        method: 'POST',
      }),
    onSuccess: (res, backupId) => {
      invalidate();
      const updated = data?.backups.find((b) => b.id === backupId);
      if (updated) {
        setSelectedVerifyBackup({
          ...updated,
          verification_status: res.result.status,
          verified_at: res.result.verifiedAt,
          verification_details: res.result,
        });
      }
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const scheduleMut = useMutation({
    mutationFn: (body: Partial<BackupSchedule>) =>
      api(`/servers/${serverId}/backup-schedule`, {
        method: 'PUT',
        body,
      }),
    onSuccess: () => {
      setShowScheduleModal(false);
      void qc.invalidateQueries({ queryKey: ['backup-schedule', serverId] });
    },
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const syncNasMut = useMutation({
    mutationFn: (backupId: string) =>
      api(`/servers/${serverId}/backups/${backupId}/sync-nas`, {
        method: 'POST',
      }),
    onSuccess: () => invalidate(),
    onError: (err) => setErrorMsg((err as Error).message),
  });

  const handleDownload = async (backupId: string, filename: string) => {
    try {
      await refreshSession();
      const res = await fetch(`/api/v1/servers/${serverId}/backups/${backupId}/download`, {
        headers: { Authorization: `Bearer ${currentToken()}` },
      });
      if (!res.ok) throw new Error('Download fehlgeschlagen');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setErrorMsg((err as Error).message);
    }
  };

  const isStopped = ['offline', 'crashed', 'install_failed'].includes(status);

  if (!canRead) {
    return <p className="text-sm text-dim">Keine Leseberechtigung für Backups.</p>;
  }

  const backups = data?.backups ?? [];
  const currentSchedule = scheduleData?.schedule;

  return (
    <div className="space-y-4">
      {errorMsg && (
        <div className="relative">
          <ErrorBox>{errorMsg}</ErrorBox>
          <button
            onClick={() => setErrorMsg(null)}
            className="absolute right-3 top-2.5 text-dim hover:text-ink text-xs"
          >
            ✕
          </button>
        </div>
      )}
      {error && <ErrorBox>{(error as Error).message}</ErrorBox>}

      {/* Kopfbereich */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-ink">{t('backups.title')}</h2>
          <button
            onClick={() => void refetch()}
            disabled={isFetching}
            className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/70"
            title="Neu laden"
          >
            <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Button: Zeitplan & Retention */}
          {canCreate && (
            <Button
              variant="quiet"
              className="h-8 text-xs px-3 border border-seam bg-rack-2/40 hover:bg-rack-2/80 text-ink"
              onClick={() => {
                if (currentSchedule) {
                  setScheduleForm({
                    enabled: currentSchedule.enabled,
                    intervalHours: currentSchedule.intervalHours,
                    retention: currentSchedule.retention,
                    verify: currentSchedule.verify,
                    lastAutoBackupAt: currentSchedule.lastAutoBackupAt,
                  });
                }
                setShowScheduleModal(true);
              }}
            >
              <Clock className="size-3.5 mr-1.5 text-dim" />
              {currentSchedule?.enabled ? (
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-emerald-400" />
                  <span>Auto-Backup (alle {currentSchedule.intervalHours}h)</span>
                </span>
              ) : (
                'Auto-Backup einrichten'
              )}
            </Button>
          )}

          {canCreate && (
            <Button
              variant="primary"
              className="h-8 text-xs px-3"
              onClick={() => setShowCreateModal(true)}
            >
              <Plus className="size-3.5 mr-1.5" />
              {t('backups.create')}
            </Button>
          )}
        </div>
      </div>

      {/* Backup-Tabelle */}
      <div className="border border-seam rounded-lg overflow-hidden bg-rack-1/50">
        {isLoading ? (
          <div className="py-12 flex justify-center">
            <Spinner />
          </div>
        ) : backups.length === 0 ? (
          <div className="py-12 text-center text-dim text-sm">{t('backups.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            {/* table-fixed: feste Spaltenbreiten, der lange Name wird gekuerzt statt die Tabelle zu verbreitern - kein Querscrollen. */}
            <table className="w-full table-fixed text-left text-sm">
              <thead className="bg-rack-2/40 border-b border-seam text-xs text-dim font-medium uppercase tracking-wider">
                <tr>
                  <th className="py-2.5 px-4">{t('backups.name')}</th>
                  <th className="py-2.5 px-3 w-32">{t('backups.status')}</th>
                  <th className="py-2.5 px-3 w-28 hidden md:table-cell">Integrität</th>
                  <th className="py-2.5 px-3 w-24 text-right">{t('backups.size')}</th>
                  <th className="py-2.5 px-3 w-36 hidden 2xl:table-cell text-right">
                    {t('backups.created')}
                  </th>
                  <th className="py-2.5 px-4 w-52 text-right">Aktionen</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-seam">
                {backups.map((b) => (
                  <tr key={b.id} className="hover:bg-rack-2/30 transition-colors">
                    {/* Name & Dateiname */}
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-2 min-w-0" title={b.name}>
                        <Archive className="size-4 text-purple-400 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-sm text-ink font-medium flex items-center gap-1.5 min-w-0">
                            <span className="truncate">{b.name}</span>
                            {b.locked && (
                              <span className="shrink-0" title={t('backups.lockedHint')}>
                                <Lock className="size-3 text-amber shrink-0" />
                              </span>
                            )}
                            {b.nas_stored && (
                              <span
                                className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20"
                                title="Auf UGREEN NAS (Tailscale) gesichert"
                              >
                                <Cloud className="size-2.5" />
                                <span>NAS</span>
                              </span>
                            )}
                            {tasksData?.tasks.some((t) => t.id === `nas-sync-${b.id}`) && (
                              <span
                                className="shrink-0 inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 border border-blue-500/30 animate-pulse"
                                title="Wird aktuell auf das UGREEN NAS übertragen"
                              >
                                <Cloud className="size-2.5" />
                                <span>NAS Sync...</span>
                              </span>
                            )}
                          </div>
                          {/* Zweite Zeile: wann erstellt - die Datei heisst fast wie das Backup, der volle Name steht im Tooltip. */}
                          <div className="text-xs text-dim truncate" title={b.filename}>
                            <span className="2xl:hidden">{formatDate(b.created_at)}</span>
                            <span className="hidden 2xl:inline">{b.filename}</span>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Status */}
                    <td className="py-2.5 px-3">
                      {b.status === 'running' && (() => {
                        const activeTask = tasksData?.tasks.find(
                          (t) => t.id === `backup-${b.id}` || t.id === `nas-sync-${b.id}`
                        );
                        return (
                          <div className="space-y-0.5">
                            <span className="inline-flex items-center gap-1.5 text-xs text-amber font-medium">
                              <span className="size-2 rounded-full bg-amber animate-pulse" />
                              {t('backups.status_running')}
                              {activeTask?.progressPercent !== undefined && ` (${activeTask.progressPercent} %)`}
                            </span>
                            {activeTask?.subtitle && (
                              <p className="text-[10px] text-dim truncate max-w-[200px]" title={activeTask.subtitle}>
                                {activeTask.subtitle}
                              </p>
                            )}
                          </div>
                        );
                      })()}
                      {b.status === 'restoring' && (
                        <span className="inline-flex items-center gap-1.5 text-xs text-blue-400 font-medium">
                          <span className="size-2 rounded-full bg-blue-400 animate-pulse" />
                          {t('backups.status_restoring')}
                        </span>
                      )}
                      {b.status === 'completed' && (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
                          <CircleCheck className="size-3.5" />
                          {t('backups.status_completed')}
                        </span>
                      )}
                      {b.status === 'failed' && (
                        <span
                          className="inline-flex items-center gap-1 text-xs text-led-crash cursor-help"
                          title={b.error || t('backups.error')}
                        >
                          <CircleX className="size-3.5" />
                          {t('backups.status_failed')}
                        </span>
                      )}
                    </td>

                    {/* Integrität / Validierung */}
                    <td className="py-2.5 px-3 hidden md:table-cell">
                      {b.status === 'completed' ? (
                        b.verification_status === 'valid' ? (
                          <button
                            type="button"
                            onClick={() => setSelectedVerifyBackup(b)}
                            className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 transition-colors"
                            title="Integrität & Spieldaten validiert. Klick für Prüfbericht."
                          >
                            <ShieldCheck className="size-3.5 text-emerald-400" />
                            <span>Geprüft</span>
                          </button>
                        ) : b.verification_status === 'corrupted' ? (
                          <button
                            type="button"
                            onClick={() => setSelectedVerifyBackup(b)}
                            className="inline-flex items-center gap-1 text-[11px] font-mono px-2 py-0.5 rounded bg-crimson/15 text-crimson border border-crimson/40 hover:bg-crimson/25 transition-colors"
                            title={`Integritätsprüfung fehlgeschlagen: ${b.verification_details?.error || 'Fehler'}. Klick für Details.`}
                          >
                            <ShieldAlert className="size-3.5 text-crimson" />
                            <span>Beschädigt</span>
                          </button>
                        ) : (
                          <span className="text-xs text-dim">Ungeprüft</span>
                        )
                      ) : (
                        <span className="text-xs text-dim">-</span>
                      )}
                    </td>

                    {/* Größe */}
                    <td className="py-2.5 px-3 text-xs font-mono text-dim text-right tabular-nums">
                      {b.status === 'completed' ? formatBytes(b.bytes) : '-'}
                    </td>

                    {/* Erstellt */}
                    <td className="py-2.5 px-3 text-xs text-dim text-right hidden 2xl:table-cell whitespace-nowrap">
                      {formatDate(b.created_at)}
                    </td>

                    {/* Aktionen */}
                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Integrität manuell prüfen */}
                        {b.status === 'completed' && (
                          <button
                            onClick={() => verifyMut.mutate(b.id)}
                            disabled={verifyMut.isPending && verifyMut.variables === b.id}
                            title="Integrität & Spieldaten prüfen"
                            className="p-1 rounded text-dim hover:text-emerald-400 hover:bg-rack-2/60 transition-colors"
                          >
                            {verifyMut.isPending && verifyMut.variables === b.id ? (
                              <RefreshCw className="size-4 animate-spin text-emerald-400" />
                            ) : (
                              <FileCheck className="size-4" />
                            )}
                          </button>
                        )}

                        {/* Auf UGREEN NAS synchronisieren */}
                        {canCreate && features.has('nas') && b.status === 'completed' && !b.nas_stored && (
                          <button
                            onClick={() => syncNasMut.mutate(b.id)}
                            disabled={syncNasMut.isPending && syncNasMut.variables === b.id}
                            title="Auf UGREEN NAS sichern"
                            className="p-1 rounded text-dim hover:text-blue-400 hover:bg-rack-2/60 transition-colors"
                          >
                            {syncNasMut.isPending && syncNasMut.variables === b.id ? (
                              <RefreshCw className="size-4 animate-spin text-blue-400" />
                            ) : (
                              <Cloud className="size-4" />
                            )}
                          </button>
                        )}

                        {canDownload && b.status === 'completed' && (
                          <button
                            onClick={() => handleDownload(b.id, b.filename)}
                            title={t('backups.download')}
                            className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/60"
                          >
                            <Download className="size-4" />
                          </button>
                        )}
                        {canRestore && b.status === 'completed' && (
                          <button
                            onClick={() => setRestoreTarget(b)}
                            title={t('backups.restore')}
                            className="p-1 rounded text-dim hover:text-amber hover:bg-rack-2/60"
                          >
                            <RotateCcw className="size-4" />
                          </button>
                        )}
                        {canCreate && (
                          <button
                            onClick={() => lockMut.mutate({ backupId: b.id, locked: !b.locked })}
                            title={b.locked ? t('backups.unlock') : t('backups.lock')}
                            className="p-1 rounded text-dim hover:text-ink hover:bg-rack-2/60"
                          >
                            {b.locked ? (
                              <Lock className="size-4 text-amber" />
                            ) : (
                              <LockOpen className="size-4" />
                            )}
                          </button>
                        )}
                        {canDelete && (
                          <button
                            onClick={() => setDeleteTarget(b)}
                            disabled={b.locked}
                            title={b.locked ? t('backups.cannotDeleteLocked') : t('backups.delete')}
                            className={`p-1 rounded ${
                              b.locked
                                ? 'text-dim/30 cursor-not-allowed'
                                : 'text-dim hover:text-crimson hover:bg-rack-2/60'
                            }`}
                          >
                            <Trash className="size-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal: Backup Manuell Erstellen */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-md w-full shadow-xl space-y-4">
            <h3 className="text-base font-semibold text-ink">{t('backups.createTitle')}</h3>
            <div>
              <label className="block text-xs font-medium text-dim mb-1">
                {t('backups.nameOptional')}
              </label>
              <input
                type="text"
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="z. B. Vor-Gross-Update"
                className="w-full bg-rack-2 border border-seam rounded px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-amber"
              />
              <span className="text-[11px] text-dim block mt-1">
                Leer lassen für automatischen Namen mit Spiel und Zeitstempel.
              </span>
            </div>

            <div>
              <label className="block text-xs font-medium text-dim mb-1">
                {t('backups.ignoredFiles')}
              </label>
              <textarea
                value={ignorePatterns}
                onChange={(e) => setIgnorePatterns(e.target.value)}
                placeholder="logs/*&#10;*.tmp"
                rows={3}
                className="w-full bg-rack-2 border border-seam rounded px-3 py-1.5 text-xs font-mono text-ink focus:outline-none focus:border-amber"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="quiet"
                className="h-8 text-xs px-3"
                onClick={() => setShowCreateModal(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                className="h-8 text-xs px-3"
                onClick={() => {
                  const ignored = ignorePatterns
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  createMut.mutate({
                    name: customName.trim() || undefined,
                    ignoredFiles: ignored,
                  });
                }}
                busy={createMut.isPending}
              >
                {t('backups.create')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Automatische Backups & Aufbewahrung (Retention) */}
      {showScheduleModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-lg w-full shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-seam pb-3">
              <div className="flex items-center gap-2">
                <Clock className="size-4 text-emerald-400" />
                <h3 className="text-base font-semibold text-ink">
                  Automatische Sicherungen & Aufbewahrung
                </h3>
              </div>
              <button
                onClick={() => setShowScheduleModal(false)}
                className="text-dim hover:text-ink text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-dim">
              NexusPanel kann deinen Gameserver in regelmäßigen Abständen automatisch sichern und ältere, nicht gesperrte Backups automatisch rotieren.
            </p>

            <div className="space-y-4 pt-1">
              {/* Schalter: Aktivieren */}
              <label className="flex items-center justify-between p-3 rounded-lg border border-seam bg-rack-2/40 cursor-pointer">
                <div>
                  <div className="text-sm font-medium text-ink">Automatische Backups aktivieren</div>
                  <div className="text-xs text-dim">Sichert den Server regelmäßig im Hintergrund</div>
                </div>
                <input
                  type="checkbox"
                  checked={scheduleForm.enabled}
                  onChange={(e) => setScheduleForm({ ...scheduleForm, enabled: e.target.checked })}
                  className="size-4 accent-amber"
                />
              </label>

              {scheduleForm.enabled && (
                <>
                  {/* Intervall */}
                  <div>
                    <label className="block text-xs font-medium text-dim mb-1">
                      Sicherungs-Intervall
                    </label>
                    <select
                      value={scheduleForm.intervalHours}
                      onChange={(e) =>
                        setScheduleForm({ ...scheduleForm, intervalHours: Number(e.target.value) })
                      }
                      className="w-full bg-rack-2 border border-seam rounded px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-amber"
                    >
                      <option value={6}>Alle 6 Stunden</option>
                      <option value={12}>Alle 12 Stunden</option>
                      <option value={24}>Täglich (alle 24 Stunden)</option>
                      <option value={48}>Alle 2 Tage (48 Stunden)</option>
                      <option value={168}>Einmal pro Woche (168 Stunden)</option>
                    </select>
                  </div>

                  {/* Aufbewahrungs-Grenze (Retention) */}
                  <div>
                    <label className="block text-xs font-medium text-dim mb-1">
                      Aufbewahrungs-Limit (Retention)
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={scheduleForm.retention}
                        onChange={(e) =>
                          setScheduleForm({
                            ...scheduleForm,
                            retention: Math.max(1, Number(e.target.value)),
                          })
                        }
                        className="w-24 bg-rack-2 border border-seam rounded px-3 py-1.5 text-sm text-ink font-mono focus:outline-none focus:border-amber"
                      />
                      <span className="text-xs text-dim">
                        Backups behalten. Ältere ungesperrte Backups werden automatisch gelöscht.
                      </span>
                    </div>
                  </div>

                  {/* Schalter: Automatische Integritaetspruefung */}
                  <label className="flex items-center justify-between p-3 rounded-lg border border-seam bg-rack-2/40 cursor-pointer">
                    <div>
                      <div className="text-sm font-medium text-ink">Integrität & Spieldaten prüfen</div>
                      <div className="text-xs text-dim">
                        Validiert das Archiv und Spielstände direkt nach der Erstellung
                      </div>
                    </div>
                    <input
                      type="checkbox"
                      checked={scheduleForm.verify}
                      onChange={(e) =>
                        setScheduleForm({ ...scheduleForm, verify: e.target.checked })
                      }
                      className="size-4 accent-amber"
                    />
                  </label>
                </>
              )}

              {currentSchedule?.lastAutoBackupAt && (
                <div className="text-xs text-dim pt-1 font-mono">
                  Zuletzt automatisch gesichert: {formatDate(currentSchedule.lastAutoBackupAt)}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-seam">
              <Button
                variant="quiet"
                className="h-8 text-xs px-3"
                onClick={() => setShowScheduleModal(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                className="h-8 text-xs px-3"
                onClick={() => scheduleMut.mutate(scheduleForm)}
                busy={scheduleMut.isPending}
              >
                Einstellungen speichern
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Pruefbericht & Integritaetsdetails */}
      {selectedVerifyBackup && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-lg w-full shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-seam pb-3">
              <div className="flex items-center gap-2">
                {selectedVerifyBackup.verification_status === 'valid' ? (
                  <ShieldCheck className="size-5 text-emerald-400" />
                ) : (
                  <ShieldAlert className="size-5 text-crimson" />
                )}
                <h3 className="text-base font-semibold text-ink">
                  Integritätsbericht: {selectedVerifyBackup.name}
                </h3>
              </div>
              <button
                onClick={() => setSelectedVerifyBackup(null)}
                className="text-dim hover:text-ink text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              {/* Hauptstatus */}
              <div
                className={`p-3 rounded-lg border ${
                  selectedVerifyBackup.verification_status === 'valid'
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                    : 'bg-crimson/10 border-crimson/30 text-crimson'
                }`}
              >
                <div className="font-semibold text-sm flex items-center gap-2">
                  {selectedVerifyBackup.verification_status === 'valid' ? (
                    <>
                      <CheckCircle2 className="size-4 text-emerald-400" />
                      <span>Backup ist funktionsfähig und vollständig intakt</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="size-4 text-crimson" />
                      <span>Backup ist beschädigt oder unvollständig</span>
                    </>
                  )}
                </div>
                {selectedVerifyBackup.verification_details?.error && (
                  <div className="mt-1 font-mono text-xs">
                    {selectedVerifyBackup.verification_details.error}
                  </div>
                )}
              </div>

              {/* Detailpunkte */}
              <div className="bg-rack-2/40 border border-seam rounded-lg divide-y divide-seam">
                <div className="p-2.5 flex items-center justify-between">
                  <span className="text-dim">SHA-256 Prüfsumme:</span>
                  <span className="font-mono text-ink">
                    {selectedVerifyBackup.verification_details?.sha256Match
                      ? '✓ Gültig (stimmt mit Erstellung überein)'
                      : '✕ Abweichung / Nicht übereinstimmend'}
                  </span>
                </div>

                <div className="p-2.5 flex items-center justify-between">
                  <span className="text-dim">Archiv-Dekodierung (Zstd / TAR):</span>
                  <span className="font-mono text-ink">
                    {selectedVerifyBackup.verification_details?.archiveIntact
                      ? '✓ Fehlerfrei dekodierbar'
                      : '✕ Archiv beschädigt'}
                  </span>
                </div>

                <div className="p-2.5 flex items-center justify-between">
                  <span className="text-dim">Enthaltene Dateien & Ordner:</span>
                  <span className="font-mono text-ink font-semibold">
                    {selectedVerifyBackup.verification_details?.filesCount ?? 0} Einträge
                  </span>
                </div>

                {selectedVerifyBackup.verification_details?.criticalFilesFound &&
                  selectedVerifyBackup.verification_details.criticalFilesFound.length > 0 && (
                    <div className="p-2.5">
                      <span className="text-dim block mb-1">Gefundene Spieldaten & Konfigurationen:</span>
                      <div className="flex flex-wrap gap-1">
                        {selectedVerifyBackup.verification_details.criticalFilesFound.map((f) => (
                          <span
                            key={f}
                            className="px-1.5 py-0.5 rounded bg-rack-3 border border-seam font-mono text-[11px] text-ink"
                          >
                            ✓ {f}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                {selectedVerifyBackup.verified_at && (
                  <div className="p-2.5 flex items-center justify-between">
                    <span className="text-dim">Geprüft am:</span>
                    <span className="text-dim font-mono">
                      {formatDate(selectedVerifyBackup.verified_at)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="quiet"
                className="h-8 text-xs px-3"
                onClick={() => setSelectedVerifyBackup(null)}
              >
                Schließen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Backup Wiederherstellen */}
      {restoreTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-md w-full shadow-xl space-y-4">
            <h3 className="text-base font-semibold text-ink">{t('backups.restore')}</h3>

            {!isStopped ? (
              <div className="p-3 bg-amber/10 border border-amber/30 text-amber text-xs rounded-md">
                {t('backups.mustStop')}
              </div>
            ) : (
              <p className="text-sm text-dim">
                {t('backups.restoreConfirm', { name: restoreTarget.name })}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="quiet"
                className="h-8 text-xs px-3"
                onClick={() => setRestoreTarget(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                className="h-8 text-xs px-3"
                onClick={() => restoreMut.mutate(restoreTarget.id)}
                disabled={!isStopped}
                busy={restoreMut.isPending}
              >
                {t('backups.restore')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Backup Löschen */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-rack-1 border border-seam rounded-lg p-5 max-w-md w-full shadow-xl space-y-4">
            <h3 className="text-base font-semibold text-ink">{t('backups.delete')}</h3>
            <p className="text-sm text-dim">
              {t('backups.deleteConfirm', { name: deleteTarget.name })}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button
                variant="quiet"
                className="h-8 text-xs px-3"
                onClick={() => setDeleteTarget(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                className="h-8 text-xs px-3"
                onClick={() => deleteMut.mutate(deleteTarget.id)}
                busy={deleteMut.isPending}
              >
                {t('backups.delete')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
