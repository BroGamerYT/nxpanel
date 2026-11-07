import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, Input, ErrorBox, Spinner } from './ui';
import type { SubuserItem, PermissionsCatalog } from '../lib/types';
import {
  Users, UserPlus, Shield, Trash2, Edit2, Check, X, Terminal,
  FolderTree, Archive, Calendar, UserCheck, Settings, AlertTriangle, Key
} from 'lucide-react';

interface Props {
  serverId: string;
  canManage: boolean;
}

const CATEGORIES = [
  {
    id: 'control',
    name: 'Steuerung & Konsole',
    icon: Terminal,
    prefixes: ['control.'],
  },
  {
    id: 'files',
    name: 'Dateimanager',
    icon: FolderTree,
    prefixes: ['file.'],
  },
  {
    id: 'backups',
    name: 'Backups',
    icon: Archive,
    prefixes: ['backup.'],
  },
  {
    id: 'schedules',
    name: 'Zeitpläne & Automation',
    icon: Calendar,
    prefixes: ['schedule.'],
  },
  {
    id: 'players',
    name: 'Spieler & Moderation',
    icon: UserCheck,
    prefixes: ['player.'],
  },
  {
    id: 'settings',
    name: 'Einstellungen & Mitnutzer',
    icon: Settings,
    prefixes: ['settings.', 'subuser.', 'allocation.', 'startup.', 'activity.'],
  },
];

export function SubusersManager({ serverId, canManage }: Props) {
  const qc = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<SubuserItem | null>(null);
  const [targetUsername, setTargetUsername] = useState('');
  const [selectedFlags, setSelectedFlags] = useState<string[]>([]);
  const [activePreset, setActivePreset] = useState<string | null>('zuschauer');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [deleteUserId, setDeleteUserId] = useState<string | null>(null);

  const { data: subuserData, isLoading: loadingSubusers } = useQuery<{ subusers: SubuserItem[] }>({
    queryKey: ['subusers', serverId],
    queryFn: () => api(`/servers/${serverId}/subusers`),
  });

  const { data: catalogData } = useQuery<PermissionsCatalog>({
    queryKey: ['permissions-catalog', serverId],
    queryFn: () => api(`/servers/${serverId}/subusers/permissions`),
  });

  const addMutation = useMutation({
    mutationFn: (body: { user: string; permissions: string[] }) =>
      api(`/servers/${serverId}/subusers`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subusers', serverId] });
      closeModal();
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ userId, permissions }: { userId: string; permissions: string[] }) =>
      api(`/servers/${serverId}/subusers/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ permissions }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subusers', serverId] });
      closeModal();
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (userId: string) =>
      api(`/servers/${serverId}/subusers/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subusers', serverId] });
      setDeleteUserId(null);
    },
  });

  function openAddModal() {
    setEditingUser(null);
    setTargetUsername('');
    setActivePreset('operator');
    if (catalogData?.presets['operator']) {
      setSelectedFlags([...catalogData.presets['operator'].flags]);
    } else {
      setSelectedFlags(['control.console', 'control.start', 'control.stop']);
    }
    setErrorMsg(null);
    setModalOpen(true);
  }

  function openEditModal(sub: SubuserItem) {
    setEditingUser(sub);
    setTargetUsername(sub.username);
    setSelectedFlags([...sub.permissions]);
    setActivePreset(null);
    setErrorMsg(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingUser(null);
    setTargetUsername('');
    setSelectedFlags([]);
    setErrorMsg(null);
  }

  function applyPreset(presetKey: string) {
    setActivePreset(presetKey);
    if (catalogData?.presets[presetKey]) {
      setSelectedFlags([...catalogData.presets[presetKey].flags]);
    }
  }

  function toggleFlag(flag: string) {
    setActivePreset(null);
    if (selectedFlags.includes(flag)) {
      setSelectedFlags(selectedFlags.filter((f) => f !== flag));
    } else {
      setSelectedFlags([...selectedFlags, flag]);
    }
  }

  function toggleCategory(catFlags: string[]) {
    setActivePreset(null);
    const allSelected = catFlags.every((f) => selectedFlags.includes(f));
    if (allSelected) {
      setSelectedFlags(selectedFlags.filter((f) => !catFlags.includes(f)));
    } else {
      setSelectedFlags(Array.from(new Set([...selectedFlags, ...catFlags])));
    }
  }

  function handleSave() {
    if (!editingUser && !targetUsername.trim()) {
      setErrorMsg('Bitte Benutzername oder E-Mail eingeben.');
      return;
    }
    if (selectedFlags.length === 0) {
      setErrorMsg('Bitte mindestens eine Berechtigung zuweisen.');
      return;
    }

    if (editingUser) {
      updateMutation.mutate({ userId: editingUser.userId, permissions: selectedFlags });
    } else {
      addMutation.mutate({ user: targetUsername.trim(), permissions: selectedFlags });
    }
  }

  if (loadingSubusers) return <Spinner />;

  const subusers = subuserData?.subusers ?? [];
  const catalog = catalogData ?? { flags: [], labels: {}, presets: {} };

  return (
    <div className="space-y-6">
      {/* Kopfbereich */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-5 rounded-xl border border-seam bg-rack">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2 text-ink">
            <Users className="size-5 text-amber" />
            Mitnutzer & Berechtigungen
          </h2>
          <p className="text-sm text-dim mt-1">
            Erlaube anderen Nutzern den Zugriff auf diesen Server mit feingranularen Rechten (z. B. nur Start/Stop, ohne Backups oder Einstellungen).
          </p>
        </div>
        {canManage && (
          <Button variant="primary" onClick={openAddModal}>
            <UserPlus className="size-4" />
            Mitnutzer einladen
          </Button>
        )}
      </div>

      {/* Mitnutzer Tabelle */}
      {subusers.length === 0 ? (
        <div className="p-8 text-center rounded-xl border border-dashed border-seam text-dim">
          <Users className="size-10 mx-auto mb-2 opacity-30" />
          <p className="text-sm">Bisher sind keine Mitnutzer für diese Instanz eingetragen.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-seam bg-rack">
          <table className="w-full text-left border-collapse text-sm">
            <thead>
              <tr className="border-b border-seam bg-rack-2/40 text-dim text-xs font-medium uppercase tracking-wider">
                <th className="px-5 py-3.5">Benutzer</th>
                <th className="px-5 py-3.5">Berechtigungen</th>
                <th className="px-5 py-3.5">Dabei seit</th>
                <th className="px-5 py-3.5 text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seam">
              {subusers.map((sub) => {
                const flagCount = sub.permissions.length;
                return (
                  <tr key={sub.userId} className="hover:bg-rack-2/30 transition-colors">
                    <td className="px-5 py-4">
                      <div className="font-medium text-ink flex items-center gap-2">
                        <span className="size-7 rounded-full bg-amber/20 text-amber font-semibold text-xs flex items-center justify-center">
                          {sub.username.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <div>{sub.username}</div>
                          <div className="text-xs text-dim">{sub.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-1.5 max-w-md">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-rack-2 text-ink border border-seam">
                          <Shield className="size-3 text-emerald-400" />
                          {flagCount} Rechte aktiv
                        </span>
                        {sub.permissions.slice(0, 3).map((f) => (
                          <span key={f} className="text-[11px] px-1.5 py-0.5 rounded bg-rack-2/60 text-dim">
                            {catalog.labels[f] ?? f}
                          </span>
                        ))}
                        {flagCount > 3 && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-rack-2/40 text-dim">
                            +{flagCount - 3} weitere
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-dim text-xs">
                      {new Date(sub.since).toLocaleDateString('de-DE')}
                    </td>
                    <td className="px-5 py-4 text-right">
                      {canManage && (
                        <div className="flex items-center justify-end gap-1.5">
                          <Button variant="quiet" onClick={() => openEditModal(sub)} title="Rechte bearbeiten">
                            <Edit2 className="size-3.5" />
                            Bearbeiten
                          </Button>
                          <Button
                            variant="danger"
                            onClick={() => setDeleteUserId(sub.userId)}
                            title="Mitnutzer entfernen"
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Modal: Mitnutzer hinzufügen / bearbeiten */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-3 sm:p-6 backdrop-blur-md">
          <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-seam bg-rack-2/50 shrink-0">
              <div className="flex items-center gap-2.5">
                <Shield className="size-5 text-amber" />
                <h3 className="text-base font-semibold text-ink">
                  {editingUser ? `Rechte für ${editingUser.username} anpassen` : 'Neuen Mitnutzer einladen'}
                </h3>
              </div>
              <button onClick={closeModal} className="text-dim hover:text-ink">
                <X className="size-5" />
              </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1">
              {errorMsg && <ErrorBox>{errorMsg}</ErrorBox>}

              {!editingUser && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1.5">
                    Benutzername oder E-Mail
                  </label>
                  <Input
                    placeholder="z. B. simon oder simon@example.com"
                    value={targetUsername}
                    onChange={(e) => setTargetUsername(e.target.value)}
                    autoFocus
                  />
                  <p className="text-xs text-dim mt-1">Das Konto muss bereits auf dem Panel existieren.</p>
                </div>
              )}

              {/* Presets */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-2">
                  Schnellvorlagen (Presets)
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {Object.entries(catalog.presets).map(([key, p]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => applyPreset(key)}
                      className={`px-3 py-2 rounded-lg border text-xs font-medium transition-all text-left ${
                        activePreset === key
                          ? 'border-amber bg-amber/15 text-amber font-semibold'
                          : 'border-seam bg-rack-2/40 text-dim hover:text-ink hover:border-seam/80'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span>{p.label}</span>
                        {activePreset === key && <Check className="size-3.5" />}
                      </div>
                      <div className="text-[10px] text-dim/70 mt-0.5">{p.flags.length} Rechte</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Berechtigungs-Matrix nach Kategorien */}
              <div className="space-y-4">
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim">
                  Detaillierte Berechtigungen ({selectedFlags.length} ausgewählt)
                </label>

                <div className="space-y-3">
                  {CATEGORIES.map((cat) => {
                    const CatIcon = cat.icon;
                    const catFlags = catalog.flags.filter((flag) =>
                      cat.prefixes.some((p) => flag.startsWith(p))
                    );
                    if (catFlags.length === 0) return null;

                    const allCatSelected = catFlags.every((f) => selectedFlags.includes(f));
                    const someCatSelected = catFlags.some((f) => selectedFlags.includes(f));

                    return (
                      <div key={cat.id} className="rounded-xl border border-seam bg-rack-2/30 p-4 space-y-3">
                        <div className="flex items-center justify-between border-b border-seam/60 pb-2">
                          <div className="flex items-center gap-2 font-medium text-sm text-ink">
                            <CatIcon className="size-4 text-dim" />
                            <span>{cat.name}</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => toggleCategory(catFlags)}
                            className="text-xs text-amber hover:underline font-medium"
                          >
                            {allCatSelected ? 'Alle abwählen' : 'Alle auswählen'}
                          </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          {catFlags.map((flag) => {
                            const isChecked = selectedFlags.includes(flag);
                            const label = catalog.labels[flag] ?? flag;
                            return (
                              <label
                                key={flag}
                                className={`flex items-start gap-2.5 p-2 rounded-lg border text-xs cursor-pointer transition-colors ${
                                  isChecked
                                    ? 'bg-amber/10 border-amber/50 text-ink'
                                    : 'bg-rack-1/50 border-seam/50 text-dim hover:text-ink'
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleFlag(flag)}
                                  className="mt-0.5 rounded border-seam accent-amber"
                                />
                                <div className="min-w-0">
                                  <div className="font-medium truncate">{label}</div>
                                  <div className="text-[10px] text-dim/60 font-mono">{flag}</div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-seam bg-rack-2/50 shrink-0">
              <Button variant="quiet" onClick={closeModal}>
                Abbrechen
              </Button>
              <Button
                variant="primary"
                onClick={handleSave}
                busy={addMutation.isPending || updateMutation.isPending}
              >
                <Check className="size-4" />
                {editingUser ? 'Änderungen speichern' : 'Mitnutzer einladen'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteUserId && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-rack border border-seam rounded-xl p-5 max-w-sm w-full space-y-4 shadow-xl">
            <div className="flex items-center gap-3 text-led-crash">
              <AlertTriangle className="size-5 shrink-0" />
              <h3 className="font-semibold text-sm">Mitnutzer entfernen?</h3>
            </div>
            <p className="text-xs text-dim">
              Der Nutzer verliert sofort alle Zugriffsrechte auf diese Server-Instanz.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="quiet" onClick={() => setDeleteUserId(null)}>
                Abbrechen
              </Button>
              <Button
                variant="danger"
                busy={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate(deleteUserId)}
              >
                Entfernen
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
