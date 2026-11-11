/**
 * Steam OpenID 2.0 Authentifizierung & Profil-Abruf.
 * Erlaubt 1-Klick-Anmeldung ueber Steam und automatischen Import
 * des Steam-Profilnamens sowie Avatars.
 */

import { seenBefore } from './one-time.js';

/** So viel braucht der Abruf von Steam - im Test durch eine Attrappe ersetzbar. */
export type SteamFetch = (url: string, init?: RequestInit) => Promise<Response>;

export function getSteamOpenIdUrl(returnUrl: string, realm: string): string {
  const p = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnUrl,
    'openid.realm': realm,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  return `https://steamcommunity.com/openid/login?${p.toString()}`;
}

export async function verifySteamOpenId(query: Record<string, string | undefined>, expectedReturnTo?: string, fetchImpl: SteamFetch = fetch): Promise<string | null> {
  if (query['openid.mode'] !== 'id_res') return null;
  if (query['openid.op_endpoint'] !== 'https://steamcommunity.com/openid/login') return null;
  // Die signierte Rueckkehr-Adresse muss auf unseren Callback zeigen
  // (sonst liessen sich Antworten fuer andere Seiten hier einloesen).
  if (expectedReturnTo) {
    const rt = query['openid.return_to'] ?? '';
    if (rt !== expectedReturnTo && !rt.startsWith(`${expectedReturnTo}?`)) return null;
  }
  // Jede Antwort nur einmal (Schutz vor Wiedereinspielen)
  const nonce = query['openid.response_nonce'];
  if (!nonce || seenBefore('steam-openid', nonce, 6 * 3600_000)) return null;

  const claimedId = query['openid.claimed_id'];
  if (!claimedId) return null;

  const match = /^https?:\/\/steamcommunity\.com\/openid\/id\/(\d+)$/.exec(claimedId);
  if (!match || !match[1]) return null;
  const steamId = match[1];

  // Steam OpenID Validierungs-Anfrage aufbauen
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key.startsWith('openid.') && typeof value === 'string') {
      params.set(key, value);
    }
  }
  params.set('openid.mode', 'check_authentication');

  try {
    const res = await fetchImpl('https://steamcommunity.com/openid/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes('is_valid:true')) {
      return steamId;
    }
  } catch {
    return null;
  }

  return null;
}

export async function fetchSteamProfile(steamId: string, fetchImpl: SteamFetch = fetch): Promise<{ personaName: string; avatarUrl: string } | null> {
  try {
    const res = await fetchImpl(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
      headers: { 'User-Agent': 'NexusCore-Auth/1.0' },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;

    const xml = await res.text();
    const nameMatch = /<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>|<steamID>(.*?)<\/steamID>/.exec(xml);
    const avatarMatch = /<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>|<avatarFull>(.*?)<\/avatarFull>|<avatarMedium><!\[CDATA\[(.*?)\]\]><\/avatarMedium>|<avatarMedium>(.*?)<\/avatarMedium>/.exec(xml);

    const personaName = (nameMatch?.[1] || nameMatch?.[2] || '').trim();
    const avatarUrl = (avatarMatch?.[1] || avatarMatch?.[2] || avatarMatch?.[3] || avatarMatch?.[4] || '').trim();

    return {
      personaName: personaName || `Steam-${steamId.slice(-4)}`,
      avatarUrl: avatarUrl || `https://avatars.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg`,
    };
  } catch {
    return {
      personaName: `Steam-${steamId.slice(-4)}`,
      avatarUrl: '',
    };
  }
}
