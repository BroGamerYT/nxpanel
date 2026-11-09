import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, refreshSession, setAccessToken, onAuthChange } from './api';
import type { Me } from './types';
import { setLocale, getLocale, takeChoiceBeforeLogin } from './i18n';

interface AuthState {
  me: Me | null;
  ready: boolean;
  login: (login: string, password: string, code?: { totp?: string; recoveryCode?: string }) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);

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
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) { if (!(e instanceof ApiError)) throw e; }
    setAccessToken(null);
  }, []);

  return <Ctx.Provider value={{ me, ready, login, logout, refreshMe: loadMe }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('AuthProvider missing');
  return c;
}
