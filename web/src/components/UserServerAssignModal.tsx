import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Button, ErrorBox, Spinner } from './ui';
import type { AdminUserItem, AdminUserServerItem } from '../lib/types';
import {
  Server, Shield, Check, X, Terminal, Power, FolderTree,
  Archive, ChevronDown, ChevronUp, AlertCircle, Crown, Lock
} from 'lucide-react';

interface Props {
  user: AdminUserItem;
  onClose: () => void;
}

const PRESETS: Record<string, { label: string; desc: string; flags: string[] }> = {
  none: {
    label: 'Kein Zugriff',
    desc: 'Instanz ist für den Nutzer unsichtbar.',
    flags: [],
  },
  readonly: {
    label: 'Zuschauer (Nur Lesen)',
    desc: 'Konsole & Status mitlesen. KEIN Starten/Stoppen, keine Dateien.',
    flags: ['control.console', 'allocation.read', 'startup.read', 'backup.read', 'player.read', 'schedule.read'],
  },
  operator: {
    label: 'Operator (Steuerung)',
    desc: 'Starten, Stoppen, Neustarten, Konsole & Befehle senden.',
    flags: [
      'control.console', 'control.command', 'control.start', 'control.stop',
      'control.restart', 'allocation.read', 'startup.read', 'backup.read',
      'player.read', 'player.kick', 'player.ban', 'player.whitelist',
      'schedule.read', 'schedule.run',
    ],
  },
  manager: {
    label: 'Verwalter (Volle Pflege)',
    desc: 'Operator + Dateimanager, Backups und Zeitpläne.',
    flags: [
      'control.console', 'control.command', 'control.start', 'control.stop',
      'control.restart', 'file.read', 'file.write', 'file.delete', 'file.archive',
      'backup.read', 'backup.create', 'backup.restore', 'backup.delete', 'backup.download',
      'schedule.read', 'schedule.update', 'schedule.run', 'startup.read', 'startup.update',
      'player.read', 'player.kick', 'player.ban', 'player.whitelist', 'allocation.read',
    ],
  },
  coadmin: {
    label: 'Co-Admin',
    desc: 'Alles außer Server löschen und Eigentümer übertragen.',
    flags: [
      'control.console', 'control.command', 'control.start', 'control.stop',
      'control.restart', 'control.kill', 'file.read', 'file.write', 'file.delete',
      'file.archive', 'file.sftp', 'backup.read', 'backup.create', 'backup.restore',
      'backup.delete', 'backup.download', 'allocation.read', 'allocation.assign',
      'startup.read', 'startup.update', 'startup.image', 'schedule.read',
      'schedule.update', 'schedule.run', 'subuser.read', 'subuser.create',
      'subuser.update', 'subuser.delete', 'settings.rename', 'activity.read',
      'player.read', 'player.kick', 'player.ban', 'player.whitelist', 'player.ip_read',
    ],
  },
};

const IMPORTANT_FLAGS: Array<{ flag: string; label: string; icon: typeof Power }> = [
  { flag: 'control.console', label: 'Konsole mitlesen', icon: Terminal },
  { flag: 'control.command', label: 'Befehle senden', icon: Terminal },
  { flag: 'control.start', label: 'Starten', icon: Power },
  { flag: 'control.stop', label: 'Stoppen', icon: Power },
  { flag: 'control.restart', label: 'Neustarten', icon: Power },
  { flag: 'file.read', label: 'Dateien lesen', icon: FolderTree },
  { flag: 'file.write', label: 'Dateien ändern', icon: FolderTree },
  { flag: 'backup.create', label: 'Backups erstellen', icon: Archive },
];

export function UserServerAssignModal({ user, onClose }: Props) {
  const qc = useQueryClient();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);

  // Lokale Zustände für jeden Server
  const [serverPerms, setServerPerms] = useState<Record<string, string[]>>({});
  const [serverIsOwner, setServerIsOwner] = useState<Record<string, boolean>>({});

  const { data, isLoading } = useQuery<{ servers: AdminUserServerItem[] }>({
    queryKey: ['admin-user-servers', user.id],
    queryFn: async () => {
      const res = await api<{ servers: AdminUserServerItem[] }>(`/admin/users/${user.id}/servers`);
      const permsMap: Record<string, string[]> = {};
      const ownerMap: Record<string, boolean> = {};
      for (const s of res.servers) {
        permsMap[s.id] = [...s.permissions];
        ownerMap[s.id] = s.isOwner;
      }
      setServerPerms(permsMap);
      setServerIsOwner(ownerMap);
      return res;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ serverId, isOwner, permissions }: { serverId: string; isOwner?: boolean; permissions?: string[] }) => {
      return api(`/admin/users/${user.id}/servers/${serverId}`, {
        method: 'PUT',
        body: JSON.stringify({ isOwner, permissions }),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-user-servers', user.id] });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setSuccessMsg('Rechte erfolgreich aktualisiert!');
      setTimeout(() => setSuccessMsg(null), 3000);
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const [isSavingAll, setIsSavingAll] = useState(false);

  function getActivePreset(serverId: string, isOwner: boolean, flags: string[]): string {
    if (isOwner) return 'owner';
    if (!flags || flags.length === 0) return 'none';

    const flagSet = new Set(flags);
    for (const [key, p] of Object.entries(PRESETS)) {
      if (key === 'none') continue;
      if (p.flags.length === flagSet.size && p.flags.every((f) => flagSet.has(f))) {
        return key;
      }
    }
    return 'custom';
  }

  async function handleSaveAll() {
    if (!servers.length) return;
    setErrorMsg(null);
    setIsSavingAll(true);
    try {
      for (const s of servers) {
        const isOwner = serverIsOwner[s.id] ?? false;
        const permissions = serverPerms[s.id] ?? [];
        await api(`/admin/users/${user.id}/servers/${s.id}`, {
          method: 'PUT',
          body: JSON.stringify({ isOwner, permissions }),
        });
      }
      qc.invalidateQueries({ queryKey: ['admin-user-servers', user.id] });
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setSuccessMsg('Alle Server-Berechtigungen erfolgreich gespeichert!');
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Fehler beim Speichern aller Server');
    } finally {
      setIsSavingAll(false);
    }
  }

  function handlePresetChange(serverId: string, presetKey: string) {
    if (presetKey === 'owner') {
      setServerIsOwner((prev) => ({ ...prev, [serverId]: true }));
      return;
    }

    setServerIsOwner((prev) => ({ ...prev, [serverId]: false }));
    const targetPreset = PRESETS[presetKey];
    if (targetPreset) {
      setServerPerms((prev) => ({ ...prev, [serverId]: [...targetPreset.flags] }));
    }
  }

  function handleFlagToggle(serverId: string, flag: string) {
    const current = serverPerms[serverId] ?? [];
    const next = current.includes(flag) ? current.filter((f) => f !== flag) : [...current, flag];
    setServerPerms((prev) => ({ ...prev, [serverId]: next }));
  }

  function handleSaveServer(s: AdminUserServerItem) {
    setErrorMsg(null);
    const isOwner = serverIsOwner[s.id] ?? false;
    const permissions = serverPerms[s.id] ?? [];
    saveMutation.mutate({ serverId: s.id, isOwner, permissions });
  }

  const servers = data?.servers ?? [];

  return (
    <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-3 sm:p-6 backdrop-blur-md">
      <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-seam bg-rack-2/50 shrink-0">
          <div className="flex items-center gap-3">
            <span className="size-8 rounded-full bg-amber/20 text-amber font-semibold text-xs flex items-center justify-center">
              {user.username.slice(0, 2).toUpperCase()}
            </span>
            <div>
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                Instanzen & Rechte für <span className="text-amber">{user.username}</span>
              </h3>
              <p className="text-xs text-dim">
                Weise dem Benutzer bestehende Server zu und bestimme pro Server exakt seine Berechtigungen (z. B. ARK nur lesen, Minecraft voller Zugriff).
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-dim hover:text-ink">
            <X className="size-5" />
          </button>
        </div>

        {/* Feedback Messages */}
        {errorMsg && (
          <div className="px-6 pt-4">
            <ErrorBox>{errorMsg}</ErrorBox>
          </div>
        )}
        {successMsg && (
          <div className="px-6 pt-4">
            <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 text-sm flex items-center gap-2">
              <Check className="size-4" />
              {successMsg}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
          {isLoading ? (
            <Spinner />
          ) : servers.length === 0 ? (
            <div className="p-8 text-center text-dim border border-dashed border-seam rounded-xl">
              Keine Server auf diesem Host angelegt.
            </div>
          ) : (
            <div className="space-y-3">
              {servers.map((s) => {
                const isOwner = serverIsOwner[s.id] ?? s.isOwner;
                const flags = serverPerms[s.id] ?? s.permissions;
                const activePreset = getActivePreset(s.id, isOwner, flags);
                const isExpanded = expandedServerId === s.id;

                return (
                  <div
                    key={s.id}
                    className={`rounded-xl border transition-all ${
                      isOwner
                        ? 'border-amber/50 bg-amber/5'
                        : flags.length > 0
                        ? 'border-seam bg-rack-2/40'
                        : 'border-seam/60 bg-rack-1/40 opacity-75'
                    }`}
                  >
                    {/* Server Row Header */}
                    <div className="p-4 flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0 flex items-center gap-3">
                        <Server className={`size-5 shrink-0 ${isOwner ? 'text-amber' : flags.length > 0 ? 'text-emerald-400' : 'text-dim'}`} />
                        <div>
                          <div className="font-semibold text-sm text-ink flex items-center gap-2">
                            <span>{s.name}</span>
                            <span className="text-[11px] font-normal px-2 py-0.5 rounded bg-rack-2 text-dim border border-seam">
                              {s.eggName}
                            </span>
                          </div>
                          <div className="text-xs text-dim flex items-center gap-2 mt-0.5">
                            <span>Status: {s.status}</span>
                            <span>·</span>
                            <span>Besitzer: {s.ownerName}</span>
                          </div>
                        </div>
                      </div>

                      {/* Controls */}
                      <div className="flex flex-wrap items-center gap-2">
                        {/* Preset Selector */}
                        <select
                          value={activePreset}
                          onChange={(e) => handlePresetChange(s.id, e.target.value)}
                          className="h-8 rounded-md bg-rack-2 border border-seam px-2.5 text-xs text-ink focus:border-amber focus:outline-none"
                        >
                          <option value="none">Kein Zugriff</option>
                          <option value="readonly">Zuschauer (Nur Lesen)</option>
                          <option value="operator">Operator (Steuerung)</option>
                          <option value="manager">Verwalter (Dateien & Backups)</option>
                          <option value="coadmin">Co-Admin</option>
                          <option value="owner">👑 Hauptbesitzer</option>
                          {activePreset === 'custom' && <option value="custom">Individuell ({flags.length} Rechte)</option>}
                        </select>

                        {/* Expand Details Button */}
                        {!isOwner && (
                          <button
                            type="button"
                            onClick={() => setExpandedServerId(isExpanded ? null : s.id)}
                            className="p-1.5 rounded text-dim hover:text-ink hover:bg-rack-2 text-xs flex items-center gap-1"
                            title="Rechte-Matrix aufklappen"
                          >
                            {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
                          </button>
                        )}

                        {/* Save Button */}
                        <Button
                          variant="primary"
                          className="h-8 px-3 text-xs"
                          busy={saveMutation.isPending && saveMutation.variables?.serverId === s.id}
                          onClick={() => handleSaveServer(s)}
                        >
                          Speichern
                        </Button>
                      </div>
                    </div>

                    {/* Quick Badge Summary */}
                    <div className="px-4 pb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
                      {isOwner ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber/20 text-amber font-medium">
                          <Crown className="size-3" />
                          Hauptbesitzer (Vollzugriff)
                        </span>
                      ) : flags.length === 0 ? (
                        <span className="text-dim">Kein Zugriff auf diesen Server</span>
                      ) : (
                        <>
                          <span className="text-emerald-400 font-medium">
                            {PRESETS[activePreset]?.label ?? `Individuell (${flags.length} Rechte)`}:
                          </span>
                          {flags.slice(0, 5).map((f) => (
                            <span key={f} className="px-1.5 py-0.5 rounded bg-rack-2 text-dim font-mono text-[10px]">
                              {f.replace('control.', '').replace('file.', 'dateien:').replace('backup.', 'backup:')}
                            </span>
                          ))}
                          {flags.length > 5 && (
                            <span className="text-dim">+{flags.length - 5} weitere</span>
                          )}
                        </>
                      )}
                    </div>

                    {/* Aufgeklappte Checkbox-Matrix */}
                    {isExpanded && !isOwner && (
                      <div className="p-4 border-t border-seam/60 bg-rack-2/20 space-y-3">
                        <div className="text-xs font-semibold uppercase tracking-wider text-dim">
                          Häufige Berechtigungen für {s.name}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          {IMPORTANT_FLAGS.map(({ flag, label, icon: Icon }) => {
                            const checked = flags.includes(flag);
                            return (
                              <label
                                key={flag}
                                className={`flex items-center gap-2 p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                                  checked
                                    ? 'bg-amber/15 border-amber/50 text-ink'
                                    : 'bg-rack-1 border-seam/50 text-dim hover:text-ink'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => handleFlagToggle(s.id, flag)}
                                  className="size-3.5 rounded border-seam accent-amber"
                                />
                                <Icon className="size-3.5 text-dim shrink-0" />
                                <span className="truncate">{label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4 border-t border-seam bg-rack-2/50 shrink-0">
          <Button variant="quiet" onClick={onClose}>
            Schließen
          </Button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-dim hidden sm:inline">
              Änderungen werden pro Server oder für alle gleichzeitig übernommen.
            </span>
            <Button
              variant="primary"
              busy={isSavingAll}
              onClick={handleSaveAll}
              disabled={servers.length === 0}
              className="flex items-center gap-1.5"
            >
              <Check className="size-4" />
              Alle Server speichern
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
