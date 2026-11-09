import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, refreshSession, setAccessToken, onAuthChange } from './api';
import type { Me } from './types';
import { setLocale, getLocale, takeChoiceBeforeLogin } from './i18n';

interface ImpersonatorAdmin {
  id: string;
  username: string;
}

interface AuthState {
  me: Me | null;
  ready: boolean;
  login: (login: string, password: string, code?: { totp?: string; recoveryCode?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
  impersonatorAdmin: ImpersonatorAdmin | null;
  impersonateUser: (userId: string) => Promise<void>;
  stopImpersonation: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

const IMPERSONATOR_STORAGE_KEY = 'nxp.impersonator';

export function AuthProvider({ children }: { children: ReactNode }) {
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
      setMe(m);
    } catch { setMe(null); }
  }, []);

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

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { if (!(e instanceof ApiError)) throw e; }
    sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
    setImpersonatorAdmin(null);
    setAccessToken(null);
  }, []);

  const impersonateUser = useCallback(async (userId: string) => {
    const res = await api<{ accessToken: string; user: any; originalAdmin: ImpersonatorAdmin }>(
      `/admin/users/${userId}/impersonate`,
      { method: 'POST' },
    );
    sessionStorage.setItem(IMPERSONATOR_STORAGE_KEY, JSON.stringify(res.originalAdmin));
    setImpersonatorAdmin(res.originalAdmin);
    setAccessToken(res.accessToken);
    await loadMe();
  }, [loadMe]);

  const stopImpersonation = useCallback(async () => {
    if (!impersonatorAdmin) return;
    const res = await api<{ accessToken: string; user: any }>('/auth/impersonate/stop', {
      method: 'POST',
      body: { adminId: impersonatorAdmin.id },
    });
    sessionStorage.removeItem(IMPERSONATOR_STORAGE_KEY);
    setImpersonatorAdmin(null);
    setAccessToken(res.accessToken);
    await loadMe();
  }, [impersonatorAdmin, loadMe]);

  return (
    <Ctx.Provider
      value={{
        me,
        ready,
        login,
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
