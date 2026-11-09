import { useState, useId } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  User,
  Shield,
  KeyRound,
  Lock,
  Smartphone,
  Share2,
  Trash2,
  Plus,
  Check,
  AlertTriangle,
  RefreshCw,
  LogOut,
  Laptop,
  CheckCircle2,
  ExternalLink,
  Layers,
  Sparkles,
  Info,
} from 'lucide-react';
import { api, currentToken } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Button, Input, Field, Spinner } from '../components/ui';
import { UserAvatar, AVATAR_PRESETS } from '../components/UserAvatar';
import type { SteamAccount, UserSession } from '../lib/types';
import { t } from '../lib/i18n';

// Official Steam Icon
function SteamIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2a10 10 0 0 0-10 10c0 4.7 3.2 8.6 7.6 9.7l2.5-3.6a3.5 3.5 0 0 1-1.6-2.9 3.5 3.5 0 0 1 .4-1.6L7.4 11.2a4.8 4.8 0 0 1-4.8-4.8 4.8 4.8 0 0 1 4.8-4.8 4.8 4.8 0 0 1 4.8 4.8c0 .2 0 .4-.1.6l2.4 3.5a3.5 3.5 0 0 1 1.6-.4 3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-2.9-1.5l-3.7 2.5A10 10 0 0 0 12 22a10 10 0 0 0 10-10A10 10 0 0 0 12 2z" />
    </svg>
  );
}

export function Account() {
  const { me, refreshMe, logout } = useAuth();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();

  const [activeTab, setActiveTab] = useState<'profile' | 'steam' | 'security' | 'sessions'>('profile');

  // Steam Status Messages from Redirect
  const steamLinked = searchParams.get('steam') === 'linked';
  const steamError = searchParams.get('error');

  // Profile Form States
  const [username, setUsername] = useState(() => me?.user.username ?? '');
  const [email, setEmail] = useState(() => me?.user.email ?? '');
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(() => me?.user.avatar ?? null);
  const [customAvatarUrl, setCustomAvatarUrl] = useState('');
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Password Form States
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Steam Accounts State & Modal
  const [showAddSteamModal, setShowAddSteamModal] = useState(false);
  const [editAccountId, setEditAccountId] = useState<string | null>(null);
  const [accountLabel, setAccountLabel] = useState('');
  const [accountName, setAccountName] = useState('');
  const [accountPassword, setAccountPassword] = useState('');
  const [isShared, setIsShared] = useState(false);
  const [steamModalError, setSteamModalError] = useState<string | null>(null);

  // Steam Guard Modal
  const [guardModalAccount, setGuardModalAccount] = useState<SteamAccount | null>(null);
  const [guardCode, setGuardCode] = useState('');
  const [guardError, setGuardError] = useState<string | null>(null);

  // 2FA TOTP setup state
  const [totpSetupData, setTotpSetupData] = useState<{ secret: string; otpauth: string; qrDataUrl?: string } | null>(null);
  const [totpVerifyCode, setTotpVerifyCode] = useState('');
  const [totpRecoveryCodes, setTotpRecoveryCodes] = useState<string[] | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);

  // Query: Steam Accounts
  const { data: steamData, isLoading: steamLoading, refetch: refetchSteam } = useQuery<{ accounts: SteamAccount[] }>({
    queryKey: ['steam-accounts'],
    queryFn: () => api('/steam/accounts'),
  });

  // Query: Active Sessions
  const { data: sessionData, isLoading: sessionsLoading, refetch: refetchSessions } = useQuery<{ sessions: UserSession[] }>({
    queryKey: ['user-sessions'],
    queryFn: () => api('/auth/sessions'),
  });

  // Mutation: Profile Update
  const updateProfileMutation = useMutation({
    mutationFn: (data: { username?: string; email?: string; avatar?: string | null }) =>
      api('/auth/me', { method: 'PATCH', body: data }),
    onSuccess: async () => {
      setProfileSuccess(true);
      setProfileError(null);
      await refreshMe();
      setTimeout(() => setProfileSuccess(false), 3000);
    },
    onError: (err: any) => {
      setProfileError(err?.message || 'Fehler beim Aktualisieren des Profils');
    },
  });

  // Mutation: Change Password
  const changePasswordMutation = useMutation({
    mutationFn: () =>
      api('/auth/password', {
        method: 'POST',
        body: { currentPassword, newPassword },
      }),
    onSuccess: () => {
      setPasswordSuccess(true);
      setPasswordError(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPasswordSuccess(false), 4000);
    },
    onError: (err: any) => {
      setPasswordError(err?.message || 'Passwortänderung fehlgeschlagen');
    },
  });

  // Mutation: Save / Update Steam Account
  const saveSteamAccountMutation = useMutation({
    mutationFn: (body: { id?: string; label?: string; accountName: string; password?: string; isShared?: boolean }) =>
      api('/steam/accounts', { method: 'POST', body }),
    onSuccess: async () => {
      setShowAddSteamModal(false);
      setEditAccountId(null);
      setAccountLabel('');
      setAccountName('');
      setAccountPassword('');
      setIsShared(false);
      setSteamModalError(null);
      await refetchSteam();
    },
    onError: (err: any) => {
      setSteamModalError(err?.message || 'Fehler beim Speichern des Steam-Kontos');
    },
  });

  // Mutation: Delete Steam Account
  const deleteSteamAccountMutation = useMutation({
    mutationFn: (id: string) => api(`/steam/accounts/${id}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refetchSteam();
    },
  });

  // Mutation: Submit Steam Guard
  const submitGuardMutation = useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) =>
      api(`/steam/accounts/${id}/guard`, { method: 'POST', body: { code } }),
    onSuccess: async () => {
      setGuardModalAccount(null);
      setGuardCode('');
      setGuardError(null);
      await refetchSteam();
    },
    onError: (err: any) => {
      setGuardError(err?.message || 'Steam-Guard-Code ungültig');
    },
  });

  // Mutation: Unlink Steam OpenID
  const unlinkSteamMutation = useMutation({
    mutationFn: () => api('/auth/steam/unlink', { method: 'POST' }),
    onSuccess: async () => {
      await refreshMe();
    },
  });

  // Mutation: Revoke Session
  const revokeSessionMutation = useMutation({
    mutationFn: (sessionId: string) => api(`/auth/sessions/${sessionId}`, { method: 'DELETE' }),
    onSuccess: async () => {
      await refetchSessions();
    },
  });

  // Mutation: Logout all other sessions
  const logoutAllMutation = useMutation({
    mutationFn: () => api('/auth/logout-all', { method: 'POST' }),
    onSuccess: async () => {
      await refetchSessions();
    },
  });

  // 2FA Setup Flow
  const start2faSetup = async () => {
    try {
      setTotpError(null);
      const res = await api<{ secret: string; otpauth: string; qrDataUrl?: string }>('/auth/totp/setup', { method: 'POST' });
      setTotpSetupData(res);
    } catch (err: any) {
      setTotpError(err?.message || '2FA-Einrichtung fehlgeschlagen');
    }
  };

  const confirm2faEnable = async () => {
    try {
      setTotpError(null);
      const res = await api<{ enabled: boolean; recoveryCodes: string[] }>('/auth/totp/enable', {
        method: 'POST',
        body: { code: totpVerifyCode },
      });
      setTotpRecoveryCodes(res.recoveryCodes);
      setTotpSetupData(null);
      await refreshMe();
    } catch (err: any) {
      setTotpError(err?.message || 'Code ungültig');
    }
  };

  const startSteamLoginLink = () => {
    const token = currentToken();
    const url = `/api/v1/auth/steam/login?action=link${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    window.location.href = url;
  };

  return (
    <div className="w-full space-y-6">
      {/* Profil-Kopfbereich */}
      <div className="p-6 rounded-2xl border border-seam bg-rack shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="relative group">
            <UserAvatar avatar={me?.user.avatar} username={me?.user.username ?? 'User'} size="xl" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-ink">{me?.user.username}</h1>
              <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
                me?.user.role === 'admin'
                  ? 'bg-amber/20 text-amber border border-amber/30'
                  : me?.user.role === 'moderator'
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30'
                  : 'bg-rack-2 text-dim border border-seam'
              }`}>
                {t(`role.${me?.user.role ?? 'user'}`)}
              </span>
              {me?.user.totpEnabled && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                  <Shield className="size-3" /> 2FA aktiv
                </span>
              )}
            </div>
            <p className="text-sm text-dim mt-1 font-mono">{me?.user.email}</p>
          </div>
        </div>

        {/* Steam-Verknüpfung Badge / Button */}
        <div className="flex items-center gap-3">
          {me?.user.steamId ? (
            <div className="flex items-center gap-3 p-3 rounded-xl border border-[#1b2838] bg-[#171a21]/80 text-slate-200">
              <SteamIcon className="size-5 text-[#66c0f4]" />
              <div className="text-xs">
                <div className="font-semibold text-white flex items-center gap-1">
                  <span>Steam:</span>
                  <span className="text-[#66c0f4]">{me.user.steamName || me.user.steamId}</span>
                </div>
                <div className="font-mono text-[10px] text-slate-400">ID: {me.user.steamId}</div>
              </div>
              <Button
                variant="quiet"
                className="h-7 px-2.5 text-xs text-rose-400 hover:text-rose-300 ml-2"
                onClick={() => unlinkSteamMutation.mutate()}
                busy={unlinkSteamMutation.isPending}
                title="Steam-Konto trennen"
              >
                Trennen
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startSteamLoginLink}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold bg-[#171a21] hover:bg-[#2a475e] text-white border border-[#2a475e] shadow-md transition-all group"
            >
              <SteamIcon className="size-4 text-[#66c0f4] group-hover:scale-110 transition-transform" />
              <span>Mit Steam verbinden (1-Klick)</span>
            </button>
          )}
        </div>
      </div>

      {/* Notifications from Steam OpenID Redirects */}
      {steamLinked && (
        <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-sm flex items-center gap-3">
          <CheckCircle2 className="size-5 shrink-0" />
          <span>Dein Steam-Konto wurde erfolgreich mit NexusPanel verknüpft! Dein Profilbild und Name wurden synchronisiert.</span>
        </div>
      )}
      {steamError && (
        <div className="p-4 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-400 text-sm flex items-center gap-3">
          <AlertTriangle className="size-5 shrink-0" />
          <span>
            {steamError === 'steam_already_linked'
              ? 'Dieses Steam-Konto ist bereits mit einem anderen Benutzerkonto verknüpft.'
              : 'Steam-Authentifizierung fehlgeschlagen oder abgebrochen.'}
          </span>
        </div>
      )}

      {/* Navigations-Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-seam pb-3 overflow-x-auto">
        {[
          { key: 'profile', label: 'Profil & Avatar', icon: User },
          { key: 'steam', label: `Steam-Konten (${steamData?.accounts.length ?? 0})`, icon: SteamIcon },
          { key: 'security', label: 'Passwort & 2FA', icon: Lock },
          { key: 'sessions', label: `Aktive Sitzungen (${sessionData?.sessions.length ?? 0})`, icon: Laptop },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key as any)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                isActive
                  ? 'bg-amber text-black shadow-sm'
                  : 'bg-rack-2/60 text-dim hover:text-ink hover:bg-rack-2'
              }`}
            >
              <Icon className="size-4" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* ============================================================== TAB 1: PROFIL & AVATAR */}
      {activeTab === 'profile' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Avatar Auswahl */}
          <div className="lg:col-span-2 p-6 rounded-2xl border border-seam bg-rack space-y-6">
            <div>
              <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                <Sparkles className="size-5 text-amber" />
                Profilbild (PB) auswählen
              </h2>
              <p className="text-xs text-dim mt-1">
                Wähle ein Gamer-Icon, übernimm dein Steam-Avatar oder gib eine eigene Bild-URL ein.
              </p>
            </div>

            {/* Live-Vorschau */}
            <div className="flex items-center gap-4 p-4 rounded-xl border border-seam bg-rack-2/40">
              <UserAvatar avatar={selectedAvatar} username={username} size="lg" />
              <div className="text-xs space-y-1">
                <div className="font-semibold text-ink">Aktive Vorschau</div>
                <div className="text-dim">
                  {selectedAvatar ? (selectedAvatar.startsWith('preset:') ? 'Preset Icon' : 'Benutzerdefiniertes Bild / Steam') : 'Standard Initialen'}
                </div>
                {selectedAvatar && (
                  <button
                    type="button"
                    onClick={() => setSelectedAvatar(null)}
                    className="text-[11px] text-amber hover:underline"
                  >
                    Auf Initialen zurücksetzen
                  </button>
                )}
              </div>
            </div>

            {/* Presets Grid */}
            <div className="space-y-2">
              <label className="text-xs font-semibold text-ink uppercase tracking-wider">Preset-Symbole</label>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2.5">
                {AVATAR_PRESETS.map((p) => {
                  const Icon = p.icon;
                  const isSelected = selectedAvatar === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedAvatar(p.id)}
                      className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition-all ${
                        isSelected
                          ? 'border-amber bg-amber/15 shadow-sm ring-1 ring-amber'
                          : 'border-seam bg-rack-2/60 hover:bg-rack-2 hover:border-slate-600'
                      }`}
                    >
                      <Icon className="size-6 text-ink" />
                      <span className="text-[10px] font-medium text-dim">{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Eigene Bild URL */}
            <div className="space-y-2 pt-2 border-t border-seam">
              <label className="text-xs font-semibold text-ink uppercase tracking-wider">Eigene Bild-URL (z. B. Discord, Gravatar, Steam)</label>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="https://example.com/avatar.png"
                  value={customAvatarUrl}
                  onChange={(e) => setCustomAvatarUrl(e.target.value)}
                  className="text-xs"
                />
                <Button
                  variant="quiet"
                  type="button"
                  onClick={() => {
                    if (customAvatarUrl.trim()) setSelectedAvatar(customAvatarUrl.trim());
                  }}
                  disabled={!customAvatarUrl.trim()}
                >
                  Übernehmen
                </Button>
              </div>
            </div>

            {/* Steam Avatar übernehmen (wenn Steam verknüpft) */}
            {me?.user.steamId && (
              <div className="flex items-center justify-between p-3.5 rounded-xl border border-seam bg-[#171a21]/50 text-xs">
                <div className="flex items-center gap-2.5">
                  <SteamIcon className="size-4 text-[#66c0f4]" />
                  <span className="text-slate-200">Steam-Profilbild verwenden</span>
                </div>
                <Button
                  variant="quiet"
                  className="h-8 text-xs text-[#66c0f4]"
                  onClick={() => {
                    if (me.user.avatar) setSelectedAvatar(me.user.avatar);
                  }}
                >
                  Steam-Avatar wählen
                </Button>
              </div>
            )}
          </div>

          {/* Benutzerdaten bearbeiten */}
          <div className="p-6 rounded-2xl border border-seam bg-rack space-y-5">
            <div>
              <h2 className="text-lg font-bold text-ink">Kontodaten</h2>
              <p className="text-xs text-dim mt-1">Ändere deinen Anzeigenamen oder deine E-Mail-Adresse.</p>
            </div>

            {profileSuccess && (
              <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 text-xs flex items-center gap-2">
                <Check className="size-4" />
                <span>Änderungen erfolgreich gespeichert!</span>
              </div>
            )}

            {profileError && (
              <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs flex items-center gap-2">
                <AlertTriangle className="size-4" />
                <span>{profileError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                updateProfileMutation.mutate({
                  username: username !== me?.user.username ? username : undefined,
                  email: email !== me?.user.email ? email : undefined,
                  avatar: selectedAvatar,
                });
              }}
              className="space-y-4"
            >
              <Field label="Benutzername">
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  minLength={3}
                  maxLength={32}
                  className="text-xs"
                />
              </Field>

              <Field label="E-Mail-Adresse">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  className="text-xs"
                />
              </Field>

              <Button
                variant="primary"
                type="submit"
                className="w-full mt-4"
                busy={updateProfileMutation.isPending}
              >
                Profil speichern
              </Button>
            </form>
          </div>
        </div>
      )}

      {/* ============================================================== TAB 2: STEAM-KONTEN & SHARING */}
      {activeTab === 'steam' && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl border border-seam bg-rack shadow-sm flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                <SteamIcon className="size-5 text-amber" />
                Steam-Konten & Multi-Account-Verwaltung
              </h2>
              <p className="text-xs text-dim mt-1 max-w-3xl leading-relaxed">
                Hinterlege hier Steam-Accounts für Spiele, die einen lizenzierten Steam-Account erfordern (z. B. Farming Simulator 25, Arma 3).
                Du kannst Accounts auch <strong className="text-ink">für dein Team / Mitnutzer freigeben</strong> – die Passwörter bleiben dabei sicher mit AES-256-GCM verschlüsselt und werden anderen Benutzern niemals im Klartext angezeigt!
              </p>
            </div>
            <Button
              variant="primary"
              onClick={() => {
                setEditAccountId(null);
                setAccountLabel('');
                setAccountName('');
                setAccountPassword('');
                setIsShared(false);
                setSteamModalError(null);
                setShowAddSteamModal(true);
              }}
              className="shrink-0"
            >
              <Plus className="size-4" />
              Steam-Konto hinzufügen
            </Button>
          </div>

          {/* Kontenliste */}
          {steamLoading ? (
            <div className="py-12 flex justify-center"><Spinner /></div>
          ) : !steamData?.accounts || steamData.accounts.length === 0 ? (
            <div className="p-12 text-center rounded-2xl border border-dashed border-seam bg-rack/40 text-dim space-y-3">
              <SteamIcon className="size-12 mx-auto text-dim opacity-30" />
              <p className="text-base font-semibold text-ink">Noch keine Steam-Konten hinterlegt</p>
              <p className="text-xs text-dim max-w-md mx-auto">
                Füge dein Hauptkonto oder einen Bot-Account hinzu, um Spiele mit SteamCMD-Zwang nahtlos zu installieren.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {steamData.accounts.map((acc) => (
                <div
                  key={acc.id}
                  className="p-5 rounded-2xl border border-seam bg-rack hover:border-slate-600 transition-all flex flex-col justify-between space-y-4"
                >
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <div className="size-9 rounded-xl bg-[#171a21] border border-[#2a475e] flex items-center justify-center shrink-0">
                          <SteamIcon className="size-5 text-[#66c0f4]" />
                        </div>
                        <div>
                          <div className="text-sm font-bold text-ink leading-tight">{acc.label}</div>
                          <div className="text-xs font-mono text-dim leading-tight">{acc.accountName}</div>
                        </div>
                      </div>

                      {/* Freigabe-Badge */}
                      {acc.isShared ? (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-cyan-500/15 text-cyan-400 border border-cyan-500/30 flex items-center gap-1 shrink-0">
                          <Share2 className="size-3" /> Team-Freigabe
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-medium bg-rack-2 text-dim border border-seam shrink-0">
                          Privat
                        </span>
                      )}
                    </div>

                    {/* Eigentümer Info */}
                    <div className="text-[11px] text-dim flex items-center gap-1.5 pt-1">
                      <span>Eigentümer:</span>
                      <span className="font-semibold text-ink">{acc.isOwner ? 'Du (Mein Konto)' : acc.ownerName ?? 'Anderer Nutzer'}</span>
                    </div>

                    {/* Steam Guard Status */}
                    <div className="pt-2">
                      {acc.guardStatus === 'needed' ? (
                        <div className="p-2.5 rounded-lg bg-amber/15 border border-amber/40 text-amber text-xs space-y-1.5">
                          <div className="font-semibold flex items-center gap-1.5">
                            <AlertTriangle className="size-3.5" />
                            Steam-Guard-Code erforderlich!
                          </div>
                          {acc.guardPrompt && <div className="text-[11px] text-amber/90">{acc.guardPrompt}</div>}
                          <Button
                            variant="primary"
                            className="h-7 text-xs w-full mt-1"
                            onClick={() => {
                              setGuardModalAccount(acc);
                              setGuardCode('');
                              setGuardError(null);
                            }}
                          >
                            Code jetzt eingeben
                          </Button>
                        </div>
                      ) : acc.guardStatus === 'ok' ? (
                        <div className="text-xs text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="size-3.5" />
                          Steam Guard verifiziert
                        </div>
                      ) : (
                        <div className="text-xs text-dim">Steam Guard: Nicht erforderlich</div>
                      )}
                    </div>
                  </div>

                  {/* Aktionen (nur Eigentümer oder Admin) */}
                  <div className="flex items-center justify-between pt-3 border-t border-seam text-xs">
                    <span className="text-[11px] text-dim">
                      {acc.lastUsedAt ? `Zuletzt genutzt: ${new Date(acc.lastUsedAt).toLocaleDateString('de-DE')}` : 'Noch unbenutzt'}
                    </span>
                    {acc.isOwner && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="quiet"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            setEditAccountId(acc.id);
                            setAccountLabel(acc.label);
                            setAccountName(acc.accountName);
                            setAccountPassword('');
                            setIsShared(acc.isShared);
                            setSteamModalError(null);
                            setShowAddSteamModal(true);
                          }}
                        >
                          Bearbeiten
                        </Button>
                        <Button
                          variant="danger"
                          className="h-7 px-2 text-xs"
                          onClick={() => {
                            if (confirm(`Steam-Konto "${acc.label}" wirklich entfernen?`)) {
                              deleteSteamAccountMutation.mutate(acc.id);
                            }
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Modal: Steam-Konto hinzufügen / bearbeiten */}
          {showAddSteamModal && (
            <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-150">
              <div className="bg-rack border border-seam rounded-2xl w-full max-w-md p-6 space-y-5 shadow-2xl">
                <div>
                  <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                    <SteamIcon className="size-5 text-amber" />
                    {editAccountId ? 'Steam-Konto bearbeiten' : 'Neues Steam-Konto hinzufügen'}
                  </h3>
                  <p className="text-xs text-dim mt-1">
                    Passwörter werden mit AES-256-GCM verschlüsselt gespeichert und sind niemals für andere sichtbar.
                  </p>
                </div>

                {steamModalError && (
                  <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs">
                    {steamModalError}
                  </div>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveSteamAccountMutation.mutate({
                      id: editAccountId ?? undefined,
                      label: accountLabel.trim(),
                      accountName: accountName.trim(),
                      password: accountPassword || undefined,
                      isShared,
                    });
                  }}
                  className="space-y-4"
                >
                  <Field label="Bezeichnung / Label" hint="Z. B. 'Mein Hauptaccount' oder 'FS25 Lizenz'">
                    <Input
                      placeholder="Mein Steam-Konto"
                      value={accountLabel}
                      onChange={(e) => setAccountLabel(e.target.value)}
                      className="text-xs"
                    />
                  </Field>

                  <Field label="Steam-Anmeldename (Account Name)">
                    <Input
                      placeholder="steam_username"
                      value={accountName}
                      onChange={(e) => setAccountName(e.target.value)}
                      required
                      className="text-xs"
                    />
                  </Field>

                  <Field label={editAccountId ? 'Neues Passwort (leer lassen für unverändert)' : 'Steam-Passwort'}>
                    <Input
                      type="password"
                      placeholder="••••••••••••"
                      value={accountPassword}
                      onChange={(e) => setAccountPassword(e.target.value)}
                      className="text-xs"
                    />
                  </Field>

                  {/* Sharing Checkbox */}
                  <label className="flex items-start gap-3 p-3 rounded-xl border border-seam bg-rack-2/40 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={isShared}
                      onChange={(e) => setIsShared(e.target.checked)}
                      className="rounded border-seam bg-abyss text-amber focus:ring-amber mt-0.5"
                    />
                    <div className="text-xs">
                      <div className="font-semibold text-ink flex items-center gap-1.5">
                        <Share2 className="size-3.5 text-cyan-400" />
                        Für Mitnutzer / Team freigeben
                      </div>
                      <div className="text-dim text-[11px] mt-0.5">
                        Erlaubt anderen Benutzern, Spiele mit Steam-Pflicht (z. B. Farming Simulator 25) über dieses Konto zu installieren. Das Passwort bleibt geschützt.
                      </div>
                    </div>
                  </label>

                  <div className="flex items-center justify-end gap-2 pt-2">
                    <Button
                      variant="quiet"
                      type="button"
                      onClick={() => setShowAddSteamModal(false)}
                    >
                      Abbrechen
                    </Button>
                    <Button
                      variant="primary"
                      type="submit"
                      busy={saveSteamAccountMutation.isPending}
                    >
                      Speichern
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Modal: Steam Guard Code eingeben */}
          {guardModalAccount && (
            <div className="fixed inset-0 bg-black/75 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-in fade-in duration-150">
              <div className="bg-rack border border-seam rounded-2xl w-full max-w-sm p-6 space-y-4 shadow-2xl">
                <div>
                  <h3 className="text-lg font-bold text-ink flex items-center gap-2">
                    <Smartphone className="size-5 text-amber" />
                    Steam-Guard-Code eingeben
                  </h3>
                  <p className="text-xs text-dim mt-1">
                    Konto: <strong className="text-ink">{guardModalAccount.accountName}</strong>
                  </p>
                </div>

                {guardError && (
                  <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs">
                    {guardError}
                  </div>
                )}

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submitGuardMutation.mutate({ id: guardModalAccount.id, code: guardCode });
                  }}
                  className="space-y-4"
                >
                  <Field label="Code aus Steam Authenticator oder E-Mail">
                    <Input
                      placeholder="z. B. 5ABCD"
                      value={guardCode}
                      onChange={(e) => setGuardCode(e.target.value.toUpperCase())}
                      required
                      autoFocus
                      className="text-center font-mono tracking-widest text-lg font-bold uppercase"
                      maxLength={10}
                    />
                  </Field>

                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="quiet"
                      type="button"
                      onClick={() => setGuardModalAccount(null)}
                    >
                      Abbrechen
                    </Button>
                    <Button
                      variant="primary"
                      type="submit"
                      busy={submitGuardMutation.isPending}
                    >
                      Code bestätigen
                    </Button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================================================== TAB 3: SICHERHEIT & 2FA */}
      {activeTab === 'security' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Passwort ändern */}
          <div className="p-6 rounded-2xl border border-seam bg-rack space-y-5">
            <div>
              <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                <KeyRound className="size-5 text-amber" />
                Passwort ändern
              </h2>
              <p className="text-xs text-dim mt-1">
                Nach dem Ändern des Passworts werden alle anderen aktiven Sitzungen automatisch abgemeldet.
              </p>
            </div>

            {passwordSuccess && (
              <div className="p-3 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 text-xs flex items-center gap-2">
                <Check className="size-4" />
                <span>Passwort erfolgreich geändert!</span>
              </div>
            )}

            {passwordError && (
              <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs flex items-center gap-2">
                <AlertTriangle className="size-4" />
                <span>{passwordError}</span>
              </div>
            )}

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (newPassword !== confirmPassword) {
                  setPasswordError('Die neuen Passwörter stimmen nicht überein.');
                  return;
                }
                changePasswordMutation.mutate();
              }}
              className="space-y-4"
            >
              <Field label="Aktuelles Passwort">
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  className="text-xs"
                />
              </Field>

              <Field label="Neues Passwort (mind. 8 Zeichen)">
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={8}
                  className="text-xs"
                />
              </Field>

              <Field label="Neues Passwort bestätigen">
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  className="text-xs"
                />
              </Field>

              <Button
                variant="primary"
                type="submit"
                className="w-full mt-4"
                busy={changePasswordMutation.isPending}
              >
                Passwort aktualisieren
              </Button>
            </form>
          </div>

          {/* Zwei-Faktor-Authentifizierung (TOTP) */}
          <div className="p-6 rounded-2xl border border-seam bg-rack space-y-5">
            <div>
              <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                <Shield className="size-5 text-emerald-400" />
                Zwei-Faktor-Authentifizierung (2FA)
              </h2>
              <p className="text-xs text-dim mt-1">
                Schütze dein Konto zusätzlich mit einem 6-stelligen Code aus einer Authenticator-App (z. B. Google Authenticator, 2FAS).
              </p>
            </div>

            {totpError && (
              <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs">
                {totpError}
              </div>
            )}

            {me?.user.totpEnabled ? (
              <div className="space-y-4">
                <div className="p-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 text-xs flex items-center gap-3">
                  <CheckCircle2 className="size-6 shrink-0" />
                  <div>
                    <div className="font-semibold text-sm">2FA ist aktiv</div>
                    <div className="text-[11px] text-emerald-300 mt-0.5">Dein Konto ist optimal gegen unbefugten Zugriff geschützt.</div>
                  </div>
                </div>
              </div>
            ) : totpSetupData ? (
              <div className="space-y-4 p-4 rounded-xl border border-seam bg-rack-2/40">
                <div className="text-xs font-semibold text-ink">1. QR-Code scannen oder Schlüssel eingeben:</div>
                {totpSetupData.qrDataUrl && (
                  <div className="flex justify-center p-2 bg-white rounded-lg w-fit mx-auto">
                    <img src={totpSetupData.qrDataUrl} alt="2FA QR Code" className="size-36" />
                  </div>
                )}
                <div className="p-2.5 rounded bg-rack border border-seam font-mono text-center text-xs tracking-wider text-amber select-all">
                  {totpSetupData.secret}
                </div>

                <div className="text-xs font-semibold text-ink pt-2">2. Bestätigungscode aus App eingeben:</div>
                <div className="flex gap-2">
                  <Input
                    placeholder="123456"
                    value={totpVerifyCode}
                    onChange={(e) => setTotpVerifyCode(e.target.value)}
                    maxLength={6}
                    className="text-center font-mono text-base font-bold tracking-widest"
                  />
                  <Button variant="primary" onClick={confirm2faEnable}>
                    Aktivieren
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-dim leading-relaxed">
                  Mit 2FA verlangt NexusPanel bei der Anmeldung neben deinem Passwort zusätzlich einen zeitbasierten Einmalcode aus deiner Authenticator-App.
                </p>
                <Button variant="primary" onClick={start2faSetup}>
                  <Shield className="size-4" />
                  2FA jetzt einrichten
                </Button>
              </div>
            )}

            {/* Wiederherstellungscodes nach Einrichtung anzeigen */}
            {totpRecoveryCodes && (
              <div className="p-4 rounded-xl border border-amber/40 bg-amber/10 space-y-3">
                <div className="text-xs font-bold text-amber flex items-center gap-1.5">
                  <AlertTriangle className="size-4" />
                  Wichtig: Sichere deine Wiederherstellungscodes!
                </div>
                <div className="grid grid-cols-2 gap-1.5 font-mono text-xs text-ink bg-rack p-3 rounded-lg border border-seam">
                  {totpRecoveryCodes.map((c, i) => (
                    <div key={i}>{c}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============================================================== TAB 4: SITZUNGEN */}
      {activeTab === 'sessions' && (
        <div className="p-6 rounded-2xl border border-seam bg-rack space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                <Laptop className="size-5 text-amber" />
                Aktive Sitzungen & Geräte
              </h2>
              <p className="text-xs text-dim mt-1">
                Übersicht aller Geräte und Browser, die derzeit in deinem Konto angemeldet sind.
              </p>
            </div>
            {sessionData?.sessions && sessionData.sessions.length > 1 && (
              <Button
                variant="danger"
                onClick={() => {
                  if (confirm('Wirklich alle anderen Geräte abmelden?')) {
                    logoutAllMutation.mutate();
                  }
                }}
                busy={logoutAllMutation.isPending}
              >
                <LogOut className="size-4" />
                Alle anderen Geräte abmelden
              </Button>
            )}
          </div>

          {sessionsLoading ? (
            <div className="py-8 flex justify-center"><Spinner /></div>
          ) : !sessionData?.sessions || sessionData.sessions.length === 0 ? (
            <div className="text-center py-8 text-xs text-dim">Keine aktiven Sitzungen gefunden.</div>
          ) : (
            <div className="divide-y divide-seam border border-seam rounded-xl overflow-hidden">
              {sessionData.sessions.map((sess) => (
                <div
                  key={sess.id}
                  className={`p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 ${
                    sess.current ? 'bg-amber/5' : 'bg-rack'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <div className="size-9 rounded-xl bg-rack-2 flex items-center justify-center shrink-0 border border-seam">
                      <Laptop className={`size-5 ${sess.current ? 'text-amber' : 'text-dim'}`} />
                    </div>
                    <div className="text-xs space-y-0.5">
                      <div className="font-semibold text-ink flex items-center gap-2">
                        <span>{sess.user_agent ? sess.user_agent.slice(0, 60) : 'Browser / App'}</span>
                        {sess.current && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber/20 text-amber border border-amber/30">
                            Dieses Gerät
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] font-mono text-dim flex items-center gap-2">
                        <span>IP: {sess.ip ?? '127.0.0.1'}</span>
                        <span>•</span>
                        <span>Erstellt: {new Date(sess.created_at).toLocaleString('de-DE')}</span>
                      </div>
                    </div>
                  </div>

                  {!sess.current && (
                    <Button
                      variant="quiet"
                      className="text-xs text-rose-400 hover:text-rose-300"
                      onClick={() => revokeSessionMutation.mutate(sess.id)}
                      busy={revokeSessionMutation.isPending}
                    >
                      Abmelden
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
