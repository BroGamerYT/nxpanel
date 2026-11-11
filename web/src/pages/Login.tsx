import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { ApiError, api } from '../lib/api';
import { Button, ErrorBox } from '../components/ui';
import { t } from '../lib/i18n';
import { LanguagePicker } from '../components/LanguagePicker';
import {
  User,
  Lock,
  Eye,
  EyeOff,
  ShieldCheck,
  KeyRound,
  ArrowRight,
  Sparkles,
  AlertCircle,
  Radio,
} from 'lucide-react';

/**
 * Modernes, immersives Anmeldefenster mit Banner, Ambient-Glow,
 * Passwort-Umschalter, Feststelltasten-Erkennung und interaktivem Core-Logo.
 */
export function Login() {
  const { login, loginWithPasskey } = useAuth();
  // Welche Anmeldewege es gibt (der eigenstaendige Core hat nur Passwort); das Panel kennt die Route nicht - dann gilt alles.
  const methods = useQuery({
    queryKey: ['auth-methods'],
    queryFn: () => api<{ passkey?: boolean; steam?: boolean }>('/auth/methods').catch(() => null),
    staleTime: Infinity,
  });
  const showPasskey = methods.data?.passkey !== false;
  const showSteam = methods.data?.steam !== false;
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [needCode, setNeedCode] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyBusy, setPasskeyBusy] = useState(false);

  // Spielerische Logo-Animation & Easter-Egg
  const [logoSpin, setLogoSpin] = useState(false);
  const [easterEggCount, setEasterEggCount] = useState(0);

  function checkCapsLock(e: KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState('CapsLock'));
  }

  function handleLogoClick() {
    setLogoSpin(true);
    setEasterEggCount((c) => c + 1);
    setTimeout(() => setLogoSpin(false), 700);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(name, password, needCode ? (useRecovery ? { recoveryCode: code } : { totp: code }) : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedCode(true);
      } else if (err instanceof ApiError && err.code === 'invalid_credentials') {
        setError(t('login.invalid'));
      } else {
        setError(err instanceof Error ? err.message : t('login.failed'));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full w-full relative flex items-center justify-center p-4 sm:p-6 overflow-hidden bg-night text-ink">
      {/* Ambient Hintergrund-Atmosphäre */}
      <div
        aria-hidden
        className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[650px] h-[360px] bg-amber/10 rounded-full blur-[140px] pointer-events-none"
      />
      <div
        aria-hidden
        className="absolute bottom-[-15%] right-[-5%] w-[450px] h-[450px] bg-blue-500/5 rounded-full blur-[150px] pointer-events-none"
      />
      <div
        aria-hidden
        className="absolute -bottom-10 -left-10 w-[400px] h-[400px] bg-emerald-500/5 rounded-full blur-[130px] pointer-events-none"
      />

      {/* Cyber-Grid Linienmuster mit Vignette */}
      <div
        aria-hidden
        className="absolute inset-0 bg-[linear-gradient(to_right,#2C374920_1px,transparent_1px),linear-gradient(to_bottom,#2C374920_1px,transparent_1px)] bg-[size:3.5rem_3.5rem] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_50%,#000_60%,transparent_100%)] pointer-events-none"
      />

      {/* Top Header Controls: Sprachwechsler & Systemstatus */}
      <div className="absolute top-4 sm:top-6 inset-x-4 sm:inset-x-8 flex items-center justify-between z-20 pointer-events-none">
        <div className="hidden sm:inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-rack/80 border border-seam/80 shadow-sm backdrop-blur-md text-xs text-dim pointer-events-auto">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-led-run opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-led-run" />
          </span>
          <span className="font-mono text-[11px] text-ink/90">{t('login.systemOnline')}</span>
        </div>
        <div className="ml-auto pointer-events-auto bg-rack/80 border border-seam/80 rounded-lg backdrop-blur-md px-1 shadow-sm">
          <LanguagePicker />
        </div>
      </div>

      {/* Login Card */}
      <div className="relative z-10 w-full max-w-[420px] rounded-2xl bg-rack/85 border border-seam/90 shadow-[0_20px_60px_rgba(0,0,0,0.75)] backdrop-blur-xl overflow-hidden transition-all duration-300 hover:border-amber/40 hover:shadow-[0_20px_60px_rgba(242,169,59,0.08)]">
        {/* Oberer Lichtreflex-Streifen */}
        <div className="absolute top-0 inset-x-0 h-[2px] bg-gradient-to-r from-transparent via-amber to-transparent opacity-85 z-20" />

        {/* Banner-Grafik im Header */}
        <div className="relative h-32 sm:h-36 w-full overflow-hidden bg-rack-2 select-none group/banner">
          <img
            src="/branding/banner.png"
            onError={(e) => {
              // Fallback zum GitHub-Banner falls nötig
              (e.currentTarget as HTMLImageElement).src = '/branding/banner-github.png';
            }}
            alt="NexusPanel Banner"
            className="w-full h-full object-cover object-center filter brightness-95 contrast-105 group-hover/banner:scale-105 transition-transform duration-700 ease-out"
          />
          {/* Weicher Übergangs-Gradient nach unten & oben */}
          <div className="absolute inset-0 bg-gradient-to-t from-rack via-rack/40 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-transparent" />

          {/* Versions-Badge im Banner */}
          <div className="absolute top-3 left-3 px-2.5 py-1 rounded-md bg-black/60 border border-white/10 backdrop-blur-md text-[11px] font-mono text-ink/90 flex items-center gap-1.5 shadow-sm">
            <Sparkles className="size-3 text-amber animate-pulse" />
            <span>v0.18.0</span>
          </div>

          {/* Trennstrich zum Formular */}
          <div className="absolute bottom-0 inset-x-0 h-[1px] bg-gradient-to-r from-transparent via-seam to-transparent" />
        </div>

        {/* Formular-Inhalt */}
        <div className="px-6 pb-6 pt-0 space-y-5">
          {/* Schwebendes interaktives Logo (Spielerei zum Anklicken) */}
          <div className="relative -mt-9 flex flex-col items-center">
            <button
              type="button"
              onClick={handleLogoClick}
              title="Klick mich für einen Boost!"
              className="group/logo relative cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded-2xl"
            >
              <div className="absolute -inset-2 rounded-2xl bg-amber/25 blur-lg opacity-0 group-hover/logo:opacity-100 transition-opacity duration-300" />
              <div className="relative p-2 rounded-2xl bg-rack border border-seam shadow-xl group-hover/logo:border-amber/60 group-hover/logo:shadow-amber/20 transition-all duration-300">
                <img
                  src="/branding/nexuspanel-animated-transparent.gif"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).src = '/logo.svg';
                  }}
                  alt="NexusPanel Logo"
                  className={`size-11 drop-shadow-md transition-all duration-700 ease-out ${
                    logoSpin ? 'rotate-[360deg] scale-110' : 'group-hover/logo:scale-105'
                  }`}
                />
              </div>
            </button>

            <div className="text-center mt-2.5">
              <h1 className="text-xl font-bold tracking-tight text-ink flex items-center justify-center gap-1.5">
                NexusPanel
              </h1>
              <p className="text-xs text-dim mt-0.5">{t('login.tagline')}</p>

              {/* Spielerische Belohnung bei Klicks */}
              {easterEggCount > 0 && (
                <div className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber/15 border border-amber/30 text-[10px] text-amber font-mono animate-in fade-in zoom-in-95 duration-200">
                  <Radio className="size-2.5 animate-pulse" />
                  <span>
                    {easterEggCount >= 5
                      ? '⚡ Turbo-Host Engine aktiv!'
                      : `🚀 Ready to host (${easterEggCount})`}
                  </span>
                </div>
              )}
            </div>
          </div>

          <form onSubmit={submit} className="space-y-4">
            {!needCode ? (
              <>
                {/* Benutzername / E-Mail */}
                <div className="space-y-1.5">
                  <label htmlFor="login" className="block text-xs font-medium text-dim uppercase tracking-wider">
                    {t('login.name')}
                  </label>
                  <div className="relative group">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-dim group-focus-within:text-amber transition-colors">
                      <User className="size-4" />
                    </div>
                    <input
                      id="login"
                      autoComplete="username webauthn"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      autoFocus
                      placeholder="admin"
                      className="w-full h-10.5 rounded-lg bg-rack-2/90 border border-seam pl-9 pr-3 text-sm text-ink placeholder:text-dim/50 focus:border-amber focus:ring-1 focus:ring-amber/40 focus:outline-none transition-all"
                    />
                  </div>
                </div>

                {/* Passwort mit Auge-Umschalter & CapsLock-Erkennung */}
                <div className="space-y-1.5">
                  <label htmlFor="pw" className="block text-xs font-medium text-dim uppercase tracking-wider">
                    {t('login.password')}
                  </label>
                  <div className="relative group">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-dim group-focus-within:text-amber transition-colors">
                      <Lock className="size-4" />
                    </div>
                    <input
                      id="pw"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={checkCapsLock}
                      onKeyUp={checkCapsLock}
                      required
                      placeholder="••••••••••••"
                      className="w-full h-10.5 rounded-lg bg-rack-2/90 border border-seam pl-9 pr-10 text-sm text-ink placeholder:text-dim/50 focus:border-amber focus:ring-1 focus:ring-amber/40 focus:outline-none transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      tabIndex={-1}
                      title={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center text-dim hover:text-ink transition-colors focus:outline-none"
                    >
                      {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                    </button>
                  </div>

                  {/* CapsLock Warnung */}
                  {capsLock && (
                    <div className="flex items-center gap-1.5 text-xs text-amber animate-in fade-in duration-150 pt-0.5">
                      <AlertCircle className="size-3.5 shrink-0" />
                      <span>{t('login.capsLock')}</span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              /* Zwei-Faktor-Authentifizierung (TOTP / Recovery Code) */
              <div className="space-y-2.5 animate-in fade-in duration-200">
                <div className="flex items-center justify-between">
                  <label htmlFor="code" className="block text-xs font-medium text-dim uppercase tracking-wider">
                    {useRecovery ? t('login.recoveryCode') : t('login.appCode')}
                  </label>
                  <button
                    type="button"
                    className="text-xs text-amber hover:underline underline-offset-2 transition-colors"
                    onClick={() => {
                      setUseRecovery(!useRecovery);
                      setCode('');
                    }}
                  >
                    {useRecovery ? t('login.useApp') : t('login.useRecovery')}
                  </button>
                </div>
                <div className="relative group">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-dim group-focus-within:text-amber transition-colors">
                    <KeyRound className="size-4" />
                  </div>
                  <input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode={useRecovery ? 'text' : 'numeric'}
                    placeholder={useRecovery ? 'abcd-efgh-ijkl' : '000000'}
                    className={`w-full h-11 rounded-lg bg-rack-2/90 border border-seam pl-9 pr-3 text-ink focus:border-amber focus:ring-1 focus:ring-amber/40 focus:outline-none transition-all ${
                      useRecovery ? 'text-sm font-mono' : 'font-mono tracking-[0.35em] text-lg text-center'
                    }`}
                  />
                </div>
              </div>
            )}

            {error && <ErrorBox>{error}</ErrorBox>}

            {/* Steam Login Fehlermeldung aus URL Parametern */}
            {(() => {
              const p = new URLSearchParams(window.location.search);
              const err = p.get('error');
              const steamId = p.get('steamId');
              const steamName = p.get('name');
              if (err === 'steam_not_linked') {
                return (
                  <div className="p-3.5 rounded-lg bg-amber/15 border border-amber/40 text-amber text-xs space-y-2">
                    <div className="font-semibold flex items-center gap-1.5 text-ink">
                      <AlertCircle className="size-4 text-amber shrink-0" />
                      Zugriff nur für eingeladene Benutzer
                    </div>
                    <p className="text-[11px] leading-relaxed text-dim">
                      Dieses Steam-Konto {steamName ? <strong>({steamName})</strong> : ''} ist keinem Benutzerkonto zugewiesen.
                    </p>
                    {steamId && (
                      <div className="p-2 rounded bg-rack-2/80 border border-seam text-[11px] font-mono flex items-center justify-between text-ink select-all">
                        <span>Steam-ID64: {steamId}</span>
                      </div>
                    )}
                    <p className="text-[11px] leading-relaxed text-dim">
                      Bitte gib diese Steam-ID64 deinem Administrator. Sobald er dich angelegt oder deine ID freigeschaltet hat, kannst du dich sofort mit 1 Klick anmelden.
                    </p>
                  </div>
                );
              }
              if (err === 'steam_verify_failed') {
                return (
                  <div className="p-3 rounded-lg bg-rose-500/15 border border-rose-500/40 text-rose-400 text-xs">
                    Steam-Anmeldung fehlgeschlagen oder abgebrochen.
                  </div>
                );
              }
              return null;
            })()}

            {/* Anmelde-Button mit Pfeil-Animation */}
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              className="w-full h-11 text-sm font-semibold rounded-lg shadow-lg shadow-amber/15 hover:shadow-amber/25 hover:scale-[1.01] active:scale-[0.99] transition-all flex items-center justify-center gap-2 group cursor-pointer"
            >
              <span>{t('login.submit')}</span>
              <ArrowRight className="size-4 group-hover:translate-x-1 transition-transform" />
            </Button>

            {/* Trennlinie */}
            {(showPasskey || showSteam) && (
            <div className="relative flex py-1 items-center">
              <div className="flex-grow border-t border-seam" />
              <span className="flex-shrink mx-3 text-xs text-dim uppercase tracking-wider font-medium">Oder</span>
              <div className="flex-grow border-t border-seam" />
            </div>
            )}

            {/* Passkey 1-Click Login Button */}
            {showPasskey && (
            <Button
              type="button"
              variant="quiet"
              disabled={busy || passkeyBusy}
              busy={passkeyBusy}
              onClick={async () => {
                setPasskeyBusy(true);
                setError(null);
                try {
                  await loginWithPasskey(name.trim() || undefined);
                } catch (err: unknown) {
                  const errorObj = err as { name?: string; message?: string };
                  if (errorObj?.name === 'NotAllowedError') return;
                  setError(err instanceof Error ? err.message : 'Passkey-Anmeldung fehlgeschlagen');
                } finally {
                  setPasskeyBusy(false);
                }
              }}
              className="w-full h-11 px-4 rounded-lg bg-rack-2 hover:bg-rack border border-seam text-ink font-semibold text-sm transition-all flex items-center justify-center gap-2.5 shadow-sm"
            >
              <KeyRound className="size-4 text-amber shrink-0" />
              <span>Mit Passkey anmelden</span>
            </Button>
            )}

            {/* Steam 1-Click Login Button */}
            {showSteam && (
            <a
              href="/api/v1/auth/steam/login?action=login"
              className="w-full h-11 px-4 rounded-lg bg-[#171a21] hover:bg-[#2a475e] text-white border border-[#2a475e] shadow-md flex items-center justify-center gap-2.5 font-semibold text-sm transition-all group"
            >
              <svg className="size-5 text-[#66c0f4] group-hover:scale-110 transition-transform shrink-0" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a10 10 0 0 0-10 10c0 4.7 3.2 8.6 7.6 9.7l2.5-3.6a3.5 3.5 0 0 1-1.6-2.9 3.5 3.5 0 0 1 .4-1.6L7.4 11.2a4.8 4.8 0 0 1-4.8-4.8 4.8 4.8 0 0 1 4.8-4.8 4.8 4.8 0 0 1 4.8 4.8c0 .2 0 .4-.1.6l2.4 3.5a3.5 3.5 0 0 1 1.6-.4 3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5 3.5 3.5 0 0 1-2.9-1.5l-3.7 2.5A10 10 0 0 0 12 22a10 10 0 0 0 10-10A10 10 0 0 0 12 2z" />
              </svg>
              <span>Mit Steam anmelden</span>
            </a>
            )}
          </form>

          {/* Footer mit Sicherheits-Hinweis */}
          <div className="pt-2 border-t border-seam/50 flex items-center justify-center gap-2 text-[11px] text-dim/70 select-none">
            <ShieldCheck className="size-3.5 text-led-run shrink-0" />
            <span>{t('login.secureSession')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
