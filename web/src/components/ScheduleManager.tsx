import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button } from './ui';
import {
  Calendar,
  RotateCcw,
  Archive,
  Terminal,
  Play,
  Trash,
  Plus,
  Clock,
  CheckCircle2,
  AlertTriangle,
  X,
  Sparkles,
} from 'lucide-react';

export interface Schedule {
  id: string;
  server_id: string;
  name: string;
  action: 'restart' | 'backup' | 'command';
  payload: string | null;
  cron: string | null;
  interval_minutes: number | null;
  active: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  last_status: 'pending' | 'success' | 'failed';
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export function ScheduleManager({
  serverId,
  canEdit,
}: {
  serverId: string;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<Schedule | null>(null);
  const [runMessage, setRunMessage] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<{ ok: boolean; schedules: Schedule[] }>({
    queryKey: ['schedules', serverId],
    queryFn: () => api(`/servers/${serverId}/schedules`),
  });

  const schedules = data?.schedules ?? [];

  // 1. Zeitplan löschen
  const deleteMut = useMutation({
    mutationFn: (scheduleId: string) =>
      api(`/servers/${serverId}/schedules/${scheduleId}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules', serverId] }),
  });

  // 2. Zeitplan umschalten (Aktiv/Inaktiv)
  const toggleMut = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api(`/servers/${serverId}/schedules/${id}`, {
        method: 'PATCH',
        body: { active },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['schedules', serverId] }),
  });

  // 3. Zeitplan manuell sofort ausführen
  const runMut = useMutation({
    mutationFn: (scheduleId: string) =>
      api<{ ok: boolean; result: { ok: boolean; action: string; error?: string } }>(
        `/servers/${serverId}/schedules/${scheduleId}/run`,
        { method: 'POST' }
      ),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['schedules', serverId] });
      if (res.result.ok) {
        setRunMessage(`Aktion "${res.result.action}" erfolgreich ausgeführt!`);
      } else {
        setRunMessage(`Ausführung fehlgeschlagen: ${res.result.error || 'Unbekannter Fehler'}`);
      }
      setTimeout(() => setRunMessage(null), 4000);
    },
    onError: (err) => {
      setRunMessage(`Fehler: ${(err as Error).message}`);
      setTimeout(() => setRunMessage(null), 4000);
    },
  });

  function getActionBadge(action: string) {
    switch (action) {
      case 'restart':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber/15 text-amber border border-amber/30">
            <RotateCcw className="size-3" />
            Server-Neustart
          </span>
        );
      case 'backup':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <Archive className="size-3" />
            Backup erstellen
          </span>
        );
      case 'command':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-cyan-500/15 text-cyan-400 border border-cyan-500/30">
            <Terminal className="size-3" />
            Konsolenbefehl
          </span>
        );
      default:
        return <span>{action}</span>;
    }
  }

  return (
    <div className="space-y-6">
      {/* Kopfzeile */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 bg-rack-1 border border-seam rounded-xl shadow-sm">
        <div>
          <h2 className="text-base font-semibold text-ink flex items-center gap-2">
            <Calendar className="size-5 text-emerald-400" />
            Geplante Aufgaben & Zeitpläne
          </h2>
          <p className="text-xs text-dim mt-0.5 max-w-xl">
            Automatisiere regelmäßige Server-Neustarts, Backups oder Befehle (z. B. Welt speichern, Nachrichten)
            nach festen Uhrzeiten oder Intervallen.
          </p>
        </div>

        {canEdit && (
          <Button
            variant="primary"
            onClick={() => {
              setEditingSchedule(null);
              setModalOpen(true);
            }}
            className="shrink-0"
          >
            <Plus className="size-4 mr-1.5" />
            Neuer Zeitplan
          </Button>
        )}
      </div>

      {runMessage && (
        <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-xs flex items-center justify-between">
          <span>{runMessage}</span>
          <button onClick={() => setRunMessage(null)} className="hover:underline">
            Ausblenden
          </button>
        </div>
      )}

      {/* Zeitplan-Liste */}
      {isLoading ? (
        <div className="p-12 text-center text-sm text-dim animate-pulse">Lade Zeitpläne...</div>
      ) : error ? (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs rounded-xl">
          Fehler beim Laden: {(error as Error).message}
        </div>
      ) : schedules.length === 0 ? (
        <div className="p-10 border border-dashed border-seam rounded-xl text-center space-y-3 bg-rack-0/40">
          <Calendar className="size-8 text-slate-600 mx-auto" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-ink">Noch keine Zeitpläne eingerichtet</p>
            <p className="text-xs text-dim max-w-sm mx-auto">
              Richte z. B. einen täglichen nächtlichen Neustart um 04:00 Uhr oder regelmäßige Backups ein.
            </p>
          </div>
          {canEdit && (
            <Button
              variant="quiet"
              onClick={() => {
                setEditingSchedule(null);
                setModalOpen(true);
              }}
              className="mt-2 text-xs"
            >
              <Plus className="size-3.5 mr-1" />
              Ersten Zeitplan anlegen
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-4">
          {schedules.map((s) => (
            <div
              key={s.id}
              className={`p-4 rounded-xl border transition-all bg-rack-1 flex flex-col md:flex-row md:items-center justify-between gap-4 ${
                s.active ? 'border-seam' : 'border-seam/50 opacity-60'
              }`}
            >
              <div className="space-y-2 min-w-0">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="font-semibold text-sm text-ink">{s.name}</span>
                  {getActionBadge(s.action)}
                  {!s.active && (
                    <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                      Pausiert
                    </span>
                  )}
                </div>

                {s.action === 'command' && s.payload && (
                  <div className="text-xs font-mono text-cyan-300 bg-rack-0/70 px-2.5 py-1 rounded border border-seam inline-block">
                    &gt; {s.payload}
                  </div>
                )}

                <div className="flex items-center gap-4 text-xs text-dim flex-wrap">
                  <span className="flex items-center gap-1">
                    <Clock className="size-3.5 text-slate-500" />
                    {s.cron
                      ? `Täglich um ${s.cron} Uhr`
                      : s.interval_minutes
                      ? `Alle ${s.interval_minutes >= 60 ? `${s.interval_minutes / 60} Std.` : `${s.interval_minutes} Min.`}`
                      : 'Individuell'}
                  </span>

                  {s.next_run_at && s.active && (
                    <span className="text-slate-400">
                      Nächster Lauf:{' '}
                      <span className="text-ink font-medium">
                        {new Date(s.next_run_at).toLocaleString('de-DE', {
                          day: '2-digit',
                          month: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </span>
                  )}

                  {s.last_run_at && (
                    <span className="flex items-center gap-1">
                      {s.last_status === 'success' ? (
                        <CheckCircle2 className="size-3.5 text-emerald-400" />
                      ) : s.last_status === 'failed' ? (
                        <AlertTriangle className="size-3.5 text-rose-400" />
                      ) : null}
                      Zuletzt:{' '}
                      {new Date(s.last_run_at).toLocaleString('de-DE', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  )}
                </div>

                {s.last_error && (
                  <div className="text-xs text-rose-400 italic">
                    Fehler: {s.last_error}
                  </div>
                )}
              </div>

              {canEdit && (
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="quiet"
                    className="h-8 text-xs px-2.5"
                    onClick={() => runMut.mutate(s.id)}
                    disabled={runMut.isPending}
                    title="Jetzt sofort testweise ausführen"
                  >
                    <Play className="size-3 mr-1 text-emerald-400" />
                    Ausführen
                  </Button>

                  <Button
                    variant="quiet"
                    className="h-8 text-xs px-2.5"
                    onClick={() => toggleMut.mutate({ id: s.id, active: !s.active })}
                    disabled={toggleMut.isPending}
                  >
                    {s.active ? 'Pausieren' : 'Aktivieren'}
                  </Button>

                  <Button
                    variant="quiet"
                    className="h-8 text-xs px-2.5 text-rose-400 hover:text-rose-300"
                    onClick={() => {
                      if (window.confirm(`Zeitplan "${s.name}" wirklich löschen?`)) {
                        deleteMut.mutate(s.id);
                      }
                    }}
                    disabled={deleteMut.isPending}
                  >
                    <Trash className="size-3" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Modal: Zeitplan erstellen / bearbeiten */}
      {modalOpen && (
        <ScheduleEditModal
          serverId={serverId}
          existing={editingSchedule}
          onClose={() => setModalOpen(false)}
          onSuccess={() => {
            queryClient.invalidateQueries({ queryKey: ['schedules', serverId] });
            setModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function ScheduleEditModal({
  serverId,
  existing,
  onClose,
  onSuccess,
}: {
  serverId: string;
  existing: Schedule | null;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [name, setName] = useState(existing?.name ?? 'Täglicher Server-Neustart');
  const [action, setAction] = useState<'restart' | 'backup' | 'command'>(existing?.action ?? 'restart');
  const [payload, setPayload] = useState(existing?.payload ?? '');
  const [timingType, setTimingType] = useState<'daily' | 'interval'>(
    existing?.interval_minutes ? 'interval' : 'daily'
  );
  const [dailyTime, setDailyTime] = useState(existing?.cron ?? '04:00');
  const [intervalHours, setIntervalHours] = useState(
    existing?.interval_minutes ? Math.max(1, Math.round(existing.interval_minutes / 60)) : 12
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        name,
        action,
        payload: action === 'command' ? payload : null,
        cron: timingType === 'daily' ? dailyTime : null,
        interval_minutes: timingType === 'interval' ? intervalHours * 60 : null,
        active: true,
      };

      if (existing) {
        return api(`/servers/${serverId}/schedules/${existing.id}`, {
          method: 'PATCH',
          body,
        });
      }
      return api(`/servers/${serverId}/schedules`, {
        method: 'POST',
        body,
      });
    },
    onSuccess,
    onError: (err) => setErrorMsg((err as Error).message),
  });

  function applyPreset(presetName: string, presetAction: 'restart' | 'backup' | 'command', presetPayload?: string, presetTime?: string, presetHours?: number) {
    setName(presetName);
    setAction(presetAction);
    if (presetPayload !== undefined) setPayload(presetPayload);
    if (presetTime) {
      setTimingType('daily');
      setDailyTime(presetTime);
    } else if (presetHours) {
      setTimingType('interval');
      setIntervalHours(presetHours);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-seam bg-rack-2/40">
          <div className="flex items-center gap-2">
            <Calendar className="size-4.5 text-emerald-400" />
            <h3 className="font-semibold text-ink text-sm">
              {existing ? 'Zeitplan bearbeiten' : 'Neuen Zeitplan anlegen'}
            </h3>
          </div>
          <button onClick={onClose} className="p-1 rounded text-dim hover:text-ink">
            <X className="size-4.5" />
          </button>
        </div>

        {errorMsg && (
          <div className="p-3 bg-rose-500/10 border-b border-rose-500/20 text-rose-400 text-xs">
            {errorMsg}
          </div>
        )}

        <div className="p-5 space-y-5 overflow-y-auto max-h-[75vh]">
          {/* Schnell-Vorlagen */}
          {!existing && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-dim flex items-center gap-1">
                <Sparkles className="size-3 text-emerald-400" />
                Schnell-Vorlagen per Klick:
              </label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => applyPreset('Täglicher Neustart', 'restart', '', '04:00')}
                  className="p-2.5 rounded-lg border border-seam bg-rack-0/50 hover:border-emerald-500/50 text-left text-xs transition-colors"
                >
                  <div className="font-medium text-ink flex items-center gap-1">
                    <RotateCcw className="size-3 text-amber" />
                    Neustart 04:00
                  </div>
                  <div className="text-[10px] text-dim mt-0.5">Jede Nacht sauber neu starten</div>
                </button>

                <button
                  type="button"
                  onClick={() => applyPreset('Backup alle 12h', 'backup', '', undefined, 12)}
                  className="p-2.5 rounded-lg border border-seam bg-rack-0/50 hover:border-emerald-500/50 text-left text-xs transition-colors"
                >
                  <div className="font-medium text-ink flex items-center gap-1">
                    <Archive className="size-3 text-emerald-400" />
                    Backup alle 12h
                  </div>
                  <div className="text-[10px] text-dim mt-0.5">Regelmäßige Datensicherung</div>
                </button>

                <button
                  type="button"
                  onClick={() => applyPreset('Welt speichern', 'command', 'save-all', undefined, 1)}
                  className="p-2.5 rounded-lg border border-seam bg-rack-0/50 hover:border-emerald-500/50 text-left text-xs transition-colors"
                >
                  <div className="font-medium text-ink flex items-center gap-1">
                    <Terminal className="size-3 text-cyan-400" />
                    save-all stündlich
                  </div>
                  <div className="text-[10px] text-dim mt-0.5">Befehl an Konsole senden</div>
                </button>
              </div>
            </div>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink">Bezeichnung</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-rack-0 border border-seam rounded-lg text-ink text-xs focus:outline-none focus:border-emerald-500"
              placeholder="z. B. Täglicher Neustart"
            />
          </div>

          {/* Aktion */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-ink">Aktion</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setAction('restart')}
                className={`p-2.5 rounded-lg border text-xs font-medium flex flex-col items-center gap-1.5 transition-all ${
                  action === 'restart'
                    ? 'border-amber/60 bg-amber/15 text-ink shadow-sm'
                    : 'border-seam bg-rack-0 text-dim hover:text-ink'
                }`}
              >
                <RotateCcw className="size-4 text-amber" />
                Neustart
              </button>

              <button
                type="button"
                onClick={() => setAction('backup')}
                className={`p-2.5 rounded-lg border text-xs font-medium flex flex-col items-center gap-1.5 transition-all ${
                  action === 'backup'
                    ? 'border-emerald-500/60 bg-emerald-500/15 text-ink shadow-sm'
                    : 'border-seam bg-rack-0 text-dim hover:text-ink'
                }`}
              >
                <Archive className="size-4 text-emerald-400" />
                Backup
              </button>

              <button
                type="button"
                onClick={() => setAction('command')}
                className={`p-2.5 rounded-lg border text-xs font-medium flex flex-col items-center gap-1.5 transition-all ${
                  action === 'command'
                    ? 'border-cyan-500/60 bg-cyan-500/15 text-ink shadow-sm'
                    : 'border-seam bg-rack-0 text-dim hover:text-ink'
                }`}
              >
                <Terminal className="size-4 text-cyan-400" />
                Befehl
              </button>
            </div>
          </div>

          {/* Falls Befehl */}
          {action === 'command' && (
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-ink">Konsolenbefehl</label>
              <input
                type="text"
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                className="w-full px-3 py-2 bg-rack-0 border border-seam rounded-lg text-ink font-mono text-xs focus:outline-none focus:border-cyan-500"
                placeholder="z. B. say Wartungsarbeiten in 10 Minuten"
              />
              <p className="text-[11px] text-dim">
                Wird direkt an die Konsole / stdin des laufenden Spielservers übergeben.
              </p>
            </div>
          )}

          {/* Taktung */}
          <div className="space-y-3 pt-2 border-t border-seam">
            <label className="text-xs font-medium text-ink">Zeitpunkt / Taktung</label>
            <div className="flex gap-4 text-xs text-ink">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="timing"
                  checked={timingType === 'daily'}
                  onChange={() => setTimingType('daily')}
                  className="text-emerald-500 focus:ring-0"
                />
                Täglich zu fester Uhrzeit
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="timing"
                  checked={timingType === 'interval'}
                  onChange={() => setTimingType('interval')}
                  className="text-emerald-500 focus:ring-0"
                />
                Im Zeitintervall
              </label>
            </div>

            {timingType === 'daily' ? (
              <div className="space-y-1.5">
                <label className="text-[11px] text-dim">Uhrzeit (HH:MM)</label>
                <input
                  type="time"
                  value={dailyTime}
                  onChange={(e) => setDailyTime(e.target.value)}
                  className="px-3 py-2 bg-rack-0 border border-seam rounded-lg text-ink text-xs focus:outline-none focus:border-emerald-500"
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <label className="text-[11px] text-dim">Alle wie viele Stunden?</label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={168}
                    value={intervalHours}
                    onChange={(e) => setIntervalHours(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-24 px-3 py-2 bg-rack-0 border border-seam rounded-lg text-ink text-xs focus:outline-none focus:border-emerald-500"
                  />
                  <span className="text-xs text-dim">Stunden</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Fußzeile */}
        <div className="p-4 border-t border-seam bg-rack-2/40 flex justify-end gap-2.5">
          <Button variant="quiet" onClick={onClose} disabled={saveMut.isPending}>
            Abbrechen
          </Button>
          <Button
            variant="primary"
            onClick={() => saveMut.mutate()}
            disabled={!name.trim() || saveMut.isPending}
            busy={saveMut.isPending}
          >
            {existing ? 'Änderungen speichern' : 'Zeitplan anlegen'}
          </Button>
        </div>
      </div>
    </div>
  );
}
