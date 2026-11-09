import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { Button, Input, Select, ErrorBox, Spinner } from '../components/ui';
import type { AdminUserItem, EggSummary } from '../lib/types';
import {
  Users, UserPlus, Shield, Key, Lock, Unlock, Edit2, Check,
  X, AlertTriangle, Search, Server, Cpu, HardDrive, Gamepad2, Eye,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { UserServerAssignModal } from '../components/UserServerAssignModal';

export function AdminUsers() {
  const { me, impersonateUser } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUserItem | null>(null);
  const [assignUser, setAssignUser] = useState<AdminUserItem | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [generatedPw, setGeneratedPw] = useState<{ user: string; pw: string } | null>(null);

  // Formular-Zustände für Neuanlage
  const [newUsername, setNewUsername] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newSteamId, setNewSteamId] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'moderator' | 'user'>('user');
  const [newCanCreate, setNewCanCreate] = useState(true);
  const [newAllowedEggs, setNewAllowedEggs] = useState<string[]>([]);

  // Formular-Zustände für Bearbeitung
  const [editRole, setEditRole] = useState<'admin' | 'moderator' | 'user'>('user');
  const [editSteamId, setEditSteamId] = useState('');
  const [editCanCreate, setEditCanCreate] = useState(false);
  const [editSuspended, setEditSuspended] = useState(false);
  const [editServerLimit, setEditServerLimit] = useState(0);
  const [editRamLimitMb, setEditRamLimitMb] = useState(0);
  const [editDiskLimitMb, setEditDiskLimitMb] = useState(0);
  const [editAllowedEggs, setEditAllowedEggs] = useState<string[]>([]);

  const { data: usersData, isLoading } = useQuery<{ users: AdminUserItem[] }>({
    queryKey: ['admin-users'],
    queryFn: () => api('/admin/users'),
  });

  const { data: eggsData } = useQuery<{ eggs: EggSummary[] }>({
    queryKey: ['eggs'],
    queryFn: () => api('/eggs'),
  });

  const eggs = eggsData?.eggs ?? [];

  const createMutation = useMutation({
    mutationFn: (body: unknown) =>
      api<{ user: AdminUserItem; password?: string }>('/admin/users', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setAddModalOpen(false);
      resetNewForm();
      if (data.password) {
        setGeneratedPw({ user: data.user.username, pw: data.password });
      }
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: unknown }) =>
      api(`/admin/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
      setEditUser(null);
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  const resetTotpMutation = useMutation({
    mutationFn: (id: string) =>
      api(`/admin/users/${id}/reset-2fa`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin-users'] });
    },
    onError: (err: Error) => setErrorMsg(err.message),
  });

  function resetNewForm() {
    setNewUsername('');
    setNewEmail('');
    setNewPassword('');
    setNewSteamId('');
    setNewRole('user');
    setNewCanCreate(true);
    setNewAllowedEggs([]);
    setErrorMsg(null);
  }

  function openEdit(u: AdminUserItem) {
    setEditUser(u);
    setEditRole(u.role);
    setEditSteamId(u.steamId ?? '');
    setEditCanCreate(u.canCreateServers);
    setEditSuspended(u.suspended);
    setEditServerLimit(u.serverLimit);
    setEditRamLimitMb(u.ramLimitMb);
    setEditDiskLimitMb(u.diskLimitMb);
    setEditAllowedEggs(u.allowedEggs ? [...u.allowedEggs] : []);
    setErrorMsg(null);
  }

  function handleCreate() {
    if (!newUsername.trim() || !newEmail.trim()) {
      setErrorMsg('Bitte Benutzername und E-Mail angeben.');
      return;
    }
    createMutation.mutate({
      username: newUsername.trim(),
      email: newEmail.trim(),
      password: newPassword ? newPassword : undefined,
      steamId: newSteamId.trim() || undefined,
      role: newRole,
      canCreateServers: newCanCreate,
      allowedEggs: newAllowedEggs.length > 0 ? newAllowedEggs : null,
    });
  }

  function handleSaveEdit() {
    if (!editUser) return;
    patchMutation.mutate({
      id: editUser.id,
      body: {
        role: editRole,
        steamId: editSteamId.trim() || null,
        canCreateServers: editCanCreate,
        suspended: editSuspended,
        serverLimit: Number(editServerLimit),
        ramLimitMb: Number(editRamLimitMb),
        diskLimitMb: Number(editDiskLimitMb),
        allowedEggs: editAllowedEggs.length > 0 ? editAllowedEggs : null,
      },
    });
  }

  function toggleAllowedEgg(eggId: string, isNew: boolean) {
    if (isNew) {
      setNewAllowedEggs((prev) =>
        prev.includes(eggId) ? prev.filter((e) => e !== eggId) : [...prev, eggId]
      );
    } else {
      setEditAllowedEggs((prev) =>
        prev.includes(eggId) ? prev.filter((e) => e !== eggId) : [...prev, eggId]
      );
    }
  }

  if (isLoading) return <Spinner />;

  const allUsers = usersData?.users ?? [];
  const filteredUsers = allUsers.filter(
    (u) =>
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-5 rounded-xl border border-seam bg-rack">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2 text-ink">
            <Users className="size-6 text-amber" />
            Benutzerverwaltung
          </h1>
          <p className="text-sm text-dim mt-1">
            Verwalte globale Accounts, Rollen, Ressourcen-Budgets und freigegebene Spielvorlagen.
          </p>
        </div>
        <Button variant="primary" onClick={() => { resetNewForm(); setAddModalOpen(true); }}>
          <UserPlus className="size-4" />
          Benutzer anlegen
        </Button>
      </div>

      {/* Suchleiste */}
      <div className="relative">
        <Search className="size-4 absolute left-3.5 top-3 text-dim" />
        <Input
          placeholder="Nach Benutzername oder E-Mail suchen..."
          className="pl-10"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Nutzer-Tabelle */}
      <div className="rounded-xl border border-seam bg-rack overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-sm min-w-[720px]">
            <thead>
              <tr className="border-b border-seam bg-rack-2/40 text-dim text-xs font-medium uppercase tracking-wider">
                <th className="px-5 py-3.5">Benutzer</th>
                <th className="px-5 py-3.5">Rolle / Status</th>
                <th className="px-5 py-3.5">Server / RAM</th>
                <th className="px-5 py-3.5">Erlaubte Spiele</th>
                <th className="px-5 py-3.5 text-right">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-seam">
            {filteredUsers.map((u) => {
              const roleColors = {
                admin: 'bg-red-500/15 text-red-400 border-red-500/30',
                moderator: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
                user: 'bg-rack-2 text-dim border-seam',
              }[u.role];

              const allowedText =
                !u.allowedEggs || u.allowedEggs.length === 0
                  ? 'Alle Spiele erlaubt'
                  : `${u.allowedEggs.length} Spiel(e) freigegeben`;

              return (
                <tr key={u.id} className="hover:bg-rack-2/30 transition-colors">
                  <td className="px-5 py-4">
                    <div className="font-medium text-ink flex items-center gap-2.5">
                      <span className="size-8 rounded-full bg-amber/20 text-amber font-semibold text-xs flex items-center justify-center">
                        {u.username.slice(0, 2).toUpperCase()}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span>{u.username}</span>
                          {u.steamId && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] bg-[#171a21] text-[#66c0f4] border border-[#66c0f4]/30"
                              title={`Steam verknüpft: ${u.steamName ? `${u.steamName} (${u.steamId})` : u.steamId}`}
                            >
                              <span className="font-semibold">Steam:</span> {u.steamName || u.steamId}
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-dim">{u.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`px-2 py-0.5 rounded text-xs border font-medium uppercase tracking-wider ${roleColors}`}>
                        {u.role}
                      </span>
                      {u.suspended && (
                        <span className="px-2 py-0.5 rounded text-xs bg-red-500/20 text-red-400 border border-red-500/40">
                          Gesperrt
                        </span>
                      )}
                      {u.canCreateServers && (
                        <span className="px-2 py-0.5 rounded text-xs bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                          Kann erstellen
                        </span>
                      )}
                      {u.totpEnabled && (
                        <span className="px-1.5 py-0.5 rounded text-[11px] bg-rack-2 text-dim border border-seam" title="2FA aktiv">
                          2FA
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-xs text-dim">
                    <div className="text-ink font-medium">
                      {u.servers} {u.serverLimit > 0 ? `/ ${u.serverLimit}` : ''} Server
                    </div>
                    <div>{u.ramUsedMb} MB {u.ramLimitMb > 0 ? `/ ${u.ramLimitMb} MB` : ''}</div>
                  </td>
                  <td className="px-5 py-4">
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs bg-rack-2 border border-seam text-dim">
                      <Gamepad2 className="size-3.5 text-amber" />
                      {allowedText}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      {me?.user.id !== u.id && !u.suspended && (
                        <Button
                          variant="quiet"
                          onClick={async () => {
                            try {
                              await impersonateUser(u.id);
                              window.location.href = '/';
                            } catch (err: any) {
                              setErrorMsg(err?.message || 'Fehler beim Starten der Sichtprüfung');
                            }
                          }}
                          className="text-amber hover:text-black hover:bg-amber transition-colors border-amber/30"
                          title={`Als ${u.username} anmelden (Sichtprüfung / isolierte Instanz)`}
                        >
                          <Eye className="size-3.5" />
                          Als Nutzer ansehen
                        </Button>
                      )}
                      <Button variant="primary" onClick={() => setAssignUser(u)} title="Server zuweisen & Rechte anpassen (AMP-Stil)">
                        <Server className="size-3.5" />
                        Server-Rechte
                      </Button>
                      <Button variant="quiet" onClick={() => openEdit(u)} title="Benutzer bearbeiten">
                        <Edit2 className="size-3.5" />
                        Bearbeiten
                      </Button>
                      {u.totpEnabled && (
                        <Button
                          variant="danger"
                          onClick={() => {
                            if (confirm(`2FA für ${u.username} wirklich zurücksetzen?`)) {
                              resetTotpMutation.mutate(u.id);
                            }
                          }}
                          title="2FA zurücksetzen"
                        >
                          2FA Reset
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      {/* Generiertes Passwort Modal */}
      {generatedPw && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-rack border border-seam rounded-xl p-6 max-w-md w-full space-y-4 shadow-2xl">
            <div className="flex items-center gap-2 text-emerald-400 font-semibold">
              <Check className="size-5" />
              Benutzer erfolgreich erstellt!
            </div>
            <p className="text-sm text-dim">
              Folgendes Einmal-Passwort wurde für <strong className="text-ink">{generatedPw.user}</strong> generiert. Bitte notiere es jetzt – es wird danach nicht wieder angezeigt:
            </p>
            <div className="p-3 bg-rack-2 border border-seam rounded-lg font-mono text-sm text-amber select-all">
              {generatedPw.pw}
            </div>
            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                variant="quiet"
                className="text-amber hover:text-black hover:bg-amber transition-colors border-amber/30 text-xs"
                onClick={async () => {
                  const targetUser = usersData?.users.find((u) => u.username === generatedPw.user);
                  if (targetUser) {
                    setGeneratedPw(null);
                    await impersonateUser(targetUser.id);
                    window.location.href = '/';
                  }
                }}
              >
                <Eye className="size-3.5" />
                Direkt als {generatedPw.user} einloggen
              </Button>
              <Button variant="primary" onClick={() => setGeneratedPw(null)}>
                Schließen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Benutzer anlegen */}
      {addModalOpen && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-3 sm:p-6 backdrop-blur-md">
          <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-seam bg-rack-2/50 shrink-0">
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                <UserPlus className="size-5 text-amber" />
                Neuen Benutzer anlegen
              </h3>
              <button onClick={() => setAddModalOpen(false)} className="text-dim hover:text-ink">
                <X className="size-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-4 flex-1">
              {errorMsg && <ErrorBox>{errorMsg}</ErrorBox>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                    Benutzername
                  </label>
                  <Input
                    placeholder="z. B. simon"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                    E-Mail-Adresse
                  </label>
                  <Input
                    type="email"
                    placeholder="simon@example.com"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                    Passwort (leer = autom. generieren)
                  </label>
                  <Input
                    type="password"
                    placeholder="Optionales Initialpasswort"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                    Steam-ID64 (optional)
                  </label>
                  <Input
                    placeholder="z. B. 76561198000000000"
                    value={newSteamId}
                    onChange={(e) => setNewSteamId(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-[11px] text-dim -mt-2">
                Hinterlege eine Steam-ID64, damit sich der Nutzer sofort ohne Passwort mit dem &quot;Mit Steam anmelden&quot;-Button einloggen kann.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                    Globale Rolle
                  </label>
                  <Select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as 'admin' | 'moderator' | 'user')}
                  >
                    <option value="user">Benutzer (Standard)</option>
                    <option value="moderator">Moderator</option>
                    <option value="admin">Administrator (Vollzugriff)</option>
                  </Select>
                </div>
                <div className="flex items-center gap-3 pt-6">
                  <input
                    type="checkbox"
                    id="newCanCreate"
                    checked={newCanCreate}
                    onChange={(e) => setNewCanCreate(e.target.checked)}
                    className="size-4 rounded border-seam accent-amber"
                  />
                  <label htmlFor="newCanCreate" className="text-sm font-medium text-ink cursor-pointer">
                    Darf Server erstellen
                  </label>
                </div>
              </div>

              {/* Erlaubte Spiele (Egg Whitelist) */}
              <div className="space-y-2 pt-2 border-t border-seam">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim">
                    Erlaubte Spiele / Vorlagen (Whitelisting)
                  </label>
                  <span className="text-xs text-amber">
                    {newAllowedEggs.length === 0 ? 'Alle Spiele erlaubt' : `${newAllowedEggs.length} ausgewählt`}
                  </span>
                </div>
                <p className="text-xs text-dim">
                  Wähle aus, welche Spiele dieser Nutzer anlegen darf. Bleibt nichts gewählt, darf er alle installierten Vorlagen nutzen.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-40 overflow-y-auto p-2 rounded-lg bg-rack-2/40 border border-seam">
                  {eggs.map((egg) => {
                    const checked = newAllowedEggs.includes(egg.id) || newAllowedEggs.includes(egg.name);
                    return (
                      <label
                        key={egg.id}
                        className={`flex items-center gap-2 p-1.5 rounded border text-xs cursor-pointer ${
                          checked ? 'bg-amber/15 border-amber/50 text-ink' : 'bg-rack-1/50 border-seam/50 text-dim'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAllowedEgg(egg.name, true)}
                          className="size-3.5 rounded border-seam accent-amber"
                        />
                        <span className="truncate">{egg.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-seam bg-rack-2/50 shrink-0">
              <Button variant="quiet" onClick={() => setAddModalOpen(false)}>
                Abbrechen
              </Button>
              <Button variant="primary" onClick={handleCreate} busy={createMutation.isPending}>
                <Check className="size-4" />
                Benutzer erstellen
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Benutzer bearbeiten */}
      {editUser && (
        <div className="fixed inset-0 bg-black/80 z-[60] flex items-center justify-center p-3 sm:p-6 backdrop-blur-md">
          <div className="bg-rack-1 border border-seam rounded-xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-seam bg-rack-2/50 shrink-0">
              <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                <Edit2 className="size-5 text-amber" />
                Benutzer {editUser.username} bearbeiten
              </h3>
              <button onClick={() => setEditUser(null)} className="text-dim hover:text-ink">
                <X className="size-5" />
              </button>
            </div>

            <div className="p-6 overflow-y-auto space-y-5 flex-1">
              {errorMsg && <ErrorBox>{errorMsg}</ErrorBox>}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim mb-1">
                    Globale Rolle
                  </label>
                  <Select
                    value={editRole}
                    onChange={(e) => setEditRole(e.target.value as 'admin' | 'moderator' | 'user')}
                  >
                    <option value="user">Benutzer</option>
                    <option value="moderator">Moderator</option>
                    <option value="admin">Administrator</option>
                  </Select>
                </div>
                <div className="space-y-2 pt-2">
                  <label className="flex items-center gap-2.5 text-sm font-medium text-ink cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editCanCreate}
                      onChange={(e) => setEditCanCreate(e.target.checked)}
                      className="size-4 rounded border-seam accent-amber"
                    />
                    Darf Server anlegen
                  </label>
                  <label className="flex items-center gap-2.5 text-sm font-medium text-red-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editSuspended}
                      onChange={(e) => setEditSuspended(e.target.checked)}
                      className="size-4 rounded border-seam accent-red-500"
                    />
                    Konto sperren (Suspended)
                  </label>
                </div>
              </div>

              {/* Limits / Quotas */}
              <div className="space-y-3 pt-3 border-t border-seam">
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim">
                  Ressourcen-Limits (0 = unbegrenzt)
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <span className="text-xs text-dim flex items-center gap-1 mb-1">
                      <Server className="size-3" /> Max. Server
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={editServerLimit}
                      onChange={(e) => setEditServerLimit(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <span className="text-xs text-dim flex items-center gap-1 mb-1">
                      <Cpu className="size-3" /> Max. RAM (MB)
                    </span>
                    <Input
                      type="number"
                      min={0}
                      step={1024}
                      value={editRamLimitMb}
                      onChange={(e) => setEditRamLimitMb(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <span className="text-xs text-dim flex items-center gap-1 mb-1">
                      <HardDrive className="size-3" /> Max. Disk (MB)
                    </span>
                    <Input
                      type="number"
                      min={0}
                      step={5120}
                      value={editDiskLimitMb}
                      onChange={(e) => setEditDiskLimitMb(Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>

              {/* Steam-Verknüpfung */}
              <div className="space-y-1.5 pt-3 border-t border-seam">
                <label className="block text-xs font-semibold uppercase tracking-wider text-dim flex items-center justify-between">
                  <span>Steam-ID64 (1-Klick Login)</span>
                  {editUser.steamName && (
                    <span className="text-xs text-[#66c0f4]">Steam-Name: {editUser.steamName}</span>
                  )}
                </label>
                <Input
                  placeholder="z. B. 76561198000000000 (leer lassen zum Entfernen)"
                  value={editSteamId}
                  onChange={(e) => setEditSteamId(e.target.value)}
                />
                <p className="text-[11px] text-dim">
                  Hinterlege die 17-stellige SteamID64. Damit kann sich der Nutzer passwortlos über Steam anmelden.
                </p>
              </div>

              {/* Erlaubte Spiele (Egg Whitelist) */}
              <div className="space-y-2 pt-3 border-t border-seam">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-semibold uppercase tracking-wider text-dim">
                    Erlaubte Spiele / Vorlagen (Whitelisting)
                  </label>
                  <button
                    type="button"
                    onClick={() => setEditAllowedEggs([])}
                    className="text-xs text-amber hover:underline"
                  >
                    Alle erlauben
                  </button>
                </div>
                <p className="text-xs text-dim">
                  Ermöglicht es, festzulegen, dass Dominik oder Simon z. B. nur Minecraft und Sons of the Forest anlegen darf.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto p-2 rounded-lg bg-rack-2/40 border border-seam">
                  {eggs.map((egg) => {
                    const checked = editAllowedEggs.includes(egg.id) || editAllowedEggs.includes(egg.name);
                    return (
                      <label
                        key={egg.id}
                        className={`flex items-center gap-2 p-2 rounded border text-xs cursor-pointer transition-colors ${
                          checked ? 'bg-amber/15 border-amber/50 text-ink' : 'bg-rack-1/50 border-seam/50 text-dim hover:text-ink'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleAllowedEgg(egg.name, false)}
                          className="size-3.5 rounded border-seam accent-amber"
                        />
                        <span className="truncate">{egg.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between px-6 py-4 border-t border-seam bg-rack-2/50 shrink-0">
              <Button variant="quiet" onClick={() => setEditUser(null)}>
                Abbrechen
              </Button>
              <Button variant="primary" onClick={handleSaveEdit} busy={patchMutation.isPending}>
                <Check className="size-4" />
                Änderungen speichern
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* AMP-Stil: Server-Zuweisung & Rechte Modal */}
      {assignUser && (
        <UserServerAssignModal
          user={assignUser}
          onClose={() => setAssignUser(null)}
        />
      )}
    </div>
  );
}
