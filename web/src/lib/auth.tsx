import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api, ApiError, refreshSession, setAccessToken, onAuthChange } from './api';
import type { Me } from './types';
import { setLocale, getLocale, takeChoiceBeforeLogin } from './i18n';

interface ImpersonatorAdmin {
  id: string;
  username: string;
  /** Einmal-Token fuer die Rueckkehr zum Admin-Konto (vom Server beim Start) */
  returnToken?: string;
}

interface AuthState {
  me: Me | null;
  ready: boolean;
  login: (login: string, password: string, code?: { totp?: string; recoveryCode?: string }) => Promise<void>;
  loginWithPasskey: (username?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  impersonatorAdmin: ImpersonatorAdmin | null;
  impersonateUser: (userId: string) => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

const IMPERSONATOR_STORAGE_KEY = 'nxp.impersonator';

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [impersonatorAdmin, setImpersonatorAdmin] = useState<ImpersonatorAdmin | null>(() => {
    try {
      const stored = sessionStorage.getItem(IMPERSONATOR_STORAGE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  const loadMe = useCallback(async () => {
    try {
      const m = await api<Me>('/auth/me');
      // Auf der Anmeldeseite gewaehlt -> ans Konto. Sonst gilt die Sprache
      // des Kontos (auf jedem Geraet gleich); nie gewaehlt -> Browser.
      const chosen = takeChoiceBeforeLogin();
      if (chosen && chosen !== m.user.locale) {
        void api('/auth/me', { method: 'PATCH', body: { locale: chosen } }).catch(() => {});
        m.user.locale = chosen;
      } else if (m.user.locale && m.user.locale !== getLocale()) setLocale(m.user.locale);
      if (impersonatorAdmin && (m.user.id === impersonatorAdmin.id || m.user.username === impersonatorAdmin.username)) {
        sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
        setImpersonatorAdmin(null);
      }
      setMe(m);
    } catch { setMe(null); }
  }, [impersonatorAdmin]);

  // Beim Laden: stilles Wiederanmelden ueber das Cookie.
  useEffect(() => {
    void (async () => {
      if (await refreshSession()) await loadMe();
      setReady(true);
    })();
    return onAuthChange((ok) => { if (!ok) setMe(null); });
  }, [loadMe]);

  const login = useCallback<AuthState['login']>(async (login, password, code) => {
    const r = await api<{ accessToken: string }>('/auth/login', { method: 'POST', body: { login, password, client: 'web', ...code } });
    setAccessToken(r.accessToken);
    sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
    setImpersonatorAdmin(null);
    await loadMe();
  }, [loadMe]);

  const loginWithPasskey = useCallback<AuthState['loginWithPasskey']>(async (username?: string) => {
    const opts = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      '/auth/passkeys/login-options',
      { method: 'POST', body: { username: username || undefined } }
    );
    const asseResp = await startAuthentication({ optionsJSON: opts.options });
    const r = await api<{ accessToken: string }>('/auth/passkeys/login-verify', {
      method: 'POST',
      body: { challengeId: opts.challengeId, response: asseResp, client: 'web' },
    });
    setAccessToken(r.accessToken);
    sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
    setImpersonatorAdmin(null);
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { if (!(e instanceof ApiError)) throw e; }
    sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
    setImpersonatorAdmin(null);
    setAccessToken(null);
    qc.clear();
  }, [qc]);

  const impersonateUser = useCallback(async (userId: string) => {
    const res = await api<{ accessToken: string; user: any; originalAdmin: ImpersonatorAdmin }>(
      `/admin/users/${userId}/impersonate`,
      { method: 'POST' },
    );
    sessionStorage.setItem(IMPERSONATOR_STORAGE_KEY, JSON.stringify(res.originalAdmin));
    setImpersonatorAdmin(res.originalAdmin);
    setAccessToken(res.accessToken);
    qc.clear();
    await loadMe();
  }, [loadMe, qc]);

  const stopImpersonation = useCallback(async () => {
    if (!impersonatorAdmin) return;
    try {
      const res = await api<{ accessToken: string; user: any }>('/auth/impersonate/stop', {
        method: 'POST',
        body: { returnToken: impersonatorAdmin.returnToken ?? '' },
      });
      setAccessToken(res.accessToken);
    } catch (err) {
      console.warn('Failed to cleanly stop impersonation on backend:', err);
    } finally {
      sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
      setImpersonatorAdmin(null);
      qc.clear();
      await loadMe();
    }
  }, [impersonatorAdmin, loadMe, qc]);

  return (
    <Ctx.Provider
      value={{
        me,
        ready,
        login,
        loginWithPasskey,
        logout,
        refreshMe: loadMe,
        impersonatorAdmin,
        impersonateUser,
        stopImpersonation,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
