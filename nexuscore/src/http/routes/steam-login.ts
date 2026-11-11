import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consumeOneTimeToken, issueOneTimeToken } from '../../auth/one-time.js';
import { fetchSteamProfile, getSteamOpenIdUrl, verifySteamOpenId, type SteamFetch } from '../../auth/steam-openid.js';
import { AccountError, type AccountUser, type LocalAccount } from '../../store/account.js';
import { runAs } from '../../store/identity.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * Anmeldung mit Steam (OpenID) - dieselben Routen und Weiterleitungen wie im Panel.
 * Steam ist nur der Ausweis: angemeldet wird nur, wer bereits ein Konto mit dieser SteamID64 hat.
 * Verknuepfen laeuft ueber ein Einmal-Token, das serverseitig an das angemeldete Konto gebunden ist
 * (die Konto-ID steht nie in der Adresse).
 */

export interface SteamLoginDeps {
  registry: ServerRegistry;
  account: LocalAccount;
  /** Stellt eine Sitzung aus (Cookie) - dieselbe wie bei der Anmeldung mit Passwort. */
  issueSession: (req: FastifyRequest, reply: FastifyReply, user: AccountUser) => Promise<{ accessToken: string }>;
  /** Fuer Tests: Anfragen an Steam. */
  fetchImpl?: SteamFetch;
}

/** Adresse, unter der der Browser den Core erreicht (Steam schickt ihn dorthin zurueck). */
function baseUrl(req: FastifyRequest): string {
  return `${req.protocol}://${req.headers.host ?? 'localhost'}`;
}

export function registerSteamLoginRoutes(server: FastifyInstance, deps: SteamLoginDeps): void {
  const { registry, account, issueSession } = deps;
  const fetchImpl: SteamFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  // Eingeloggt: Verknuepfung vorbereiten
  server.post('/api/v1/auth/steam/link-start', async (req, reply) => {
    const actor = req.actor;
    const user = actor && !actor.master ? account.get(actor.id) : undefined;
    if (!user) return reply.status(403).send({ error: 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', code: 'forbidden' });
    const state = issueOneTimeToken('steam-link', { userId: user.id }, 10 * 60_000);
    return { url: `/api/v1/auth/steam/login?action=link&state=${encodeURIComponent(state)}` };
  });

  server.get('/api/v1/auth/steam/login', async (req, reply) => {
    const q = req.query as { action?: string; state?: string };
    const action = q.action === 'link' ? 'link' : 'login';
    const base = baseUrl(req);
    const returnUrl = new URL(`${base}/api/v1/auth/steam/callback`);
    returnUrl.searchParams.set('action', action);
    if (action === 'link') {
      if (!q.state || q.state.length > 200) return reply.redirect('/account?error=unauthenticated');
      returnUrl.searchParams.set('state', q.state);
    }
    return reply.redirect(getSteamOpenIdUrl(returnUrl.toString(), base));
  });

  server.get('/api/v1/auth/steam/callback', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    const action = query.action === 'link' ? 'link' : 'login';
    const base = baseUrl(req);
    const steamId = await verifySteamOpenId(query, `${base}/api/v1/auth/steam/callback`, fetchImpl);
    if (!steamId) {
      registry.audit('auth.steam_verify_failed', null, 'standalone', { origin: req.ip });
      return reply.redirect(action === 'link' ? '/account?error=steam_verify_failed' : '/login?error=steam_verify_failed');
    }
    const profile = await fetchSteamProfile(steamId, fetchImpl);

    if (action === 'link') {
      const userId = consumeOneTimeToken<{ userId: string }>('steam-link', query.state)?.userId;
      const user = userId ? account.get(userId) : undefined;
      if (!user) return reply.redirect('/account?error=unauthenticated');
      try {
        await account.setSteam(user.id, { id: steamId, name: profile?.personaName ?? null, avatar: profile?.avatarUrl ?? null });
      } catch (err) {
        if (err instanceof AccountError && err.code === 'steam_already_linked') return reply.redirect('/account?error=steam_already_linked');
        throw err;
      }
      runAs({ userId: user.id, username: user.username }, () => registry.audit('user.steam_linked', null, 'standalone', { steamId, personaName: profile?.personaName }));
      return reply.redirect('/account?steam=linked');
    }

    const user = account.findBySteamId(steamId);
    if (!user) {
      registry.audit('auth.steam_login_not_linked', null, 'standalone', { steamId, personaName: profile?.personaName, origin: req.ip });
      return reply.redirect(`/login?error=steam_not_linked&steamId=${encodeURIComponent(steamId)}&name=${encodeURIComponent(profile?.personaName ?? '')}`);
    }
    if (user.suspended) return reply.redirect('/login?error=suspended');
    if (profile) await account.refreshSteamProfile(user.id, profile.personaName, profile.avatarUrl);
    await account.recordLogin(user.id);
    runAs({ userId: user.id, username: user.username }, () => registry.audit('auth.steam_login', null, 'standalone', { steamId, origin: req.ip }));
    await issueSession(req, reply, user);
    return reply.redirect('/?login=steam');
  });

  server.post('/api/v1/auth/steam/unlink', async (req, reply) => {
    const actor = req.actor;
    const user = actor && !actor.master ? account.get(actor.id) : undefined;
    if (!user) return reply.status(403).send({ error: 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', code: 'forbidden' });
    await account.setSteam(user.id, null);
    registry.audit('user.steam_unlinked', null, 'standalone', {});
    return { ok: true };
  });
}
