/**
 * Steam OpenID 2.0 Authentifizierung & Profil-Abruf.
 * Erlaubt 1-Klick-Anmeldung ueber Steam und automatischen Import
 * des Steam-Profilnamens sowie Avatars.
 */

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

export async function verifySteamOpenId(query: Record<string, string | undefined>): Promise<string | null> {
  if (query['openid.mode'] !== 'id_res') return null;

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
    const res = await fetch('https://steamcommunity.com/openid/login', {
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

export async function fetchSteamProfile(steamId: string): Promise<{ personaName: string; avatarUrl: string } | null> {
  try {
    const res = await fetch(`https://steamcommunity.com/profiles/${steamId}/?xml=1`, {
      headers: { 'User-Agent': 'NexusPanel-Auth/1.0' },
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
