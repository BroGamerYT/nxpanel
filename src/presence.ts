import { sql } from './db/index.js';

export interface UserPresence {
  userId: string;
  username: string;
  role: string;
  avatar?: string | null | undefined;
  path: string;
  serverId?: string | null | undefined;
  serverName?: string | null | undefined;
  locationLabel: string;
  lastSeenAt: Date;
  ip?: string | null | undefined;
}

const presences = new Map<string, UserPresence>();
const serverNameCache = new Map<string, { name: string; expires: number }>();
const DB_UPDATE_THROTTLE_MS = 30_000;
const lastDbUpdate = new Map<string, number>();

/** Server-Name mit 60-Sekunden Cache abfragen */
async function lookupServerName(serverId: string): Promise<string | null> {
  const cached = serverNameCache.get(serverId);
  if (cached && cached.expires > Date.now()) return cached.name;

  try {
    const [row] = await sql<{ name: string }[]>`SELECT name FROM servers WHERE id = ${serverId}`;
    if (row?.name) {
      serverNameCache.set(serverId, { name: row.name, expires: Date.now() + 60_000 });
      return row.name;
    }
  } catch {
    // Ungueltige ID / geloescht
  }
  return null;
}

export async function recordPresence(params: {
  userId: string;
  username: string;
  role: string;
  avatar?: string | null | undefined;
  path: string;
  serverId?: string | null | undefined;
  locationLabel?: string | null | undefined;
  ip?: string | null | undefined;
}): Promise<UserPresence> {
  const { userId, username, role, avatar, path, serverId, ip } = params;
  let serverName: string | null = null;

  if (serverId && /^[0-9a-f-]{36}$/i.test(serverId)) {
    serverName = await lookupServerName(serverId);
  }

  // Lesbares Label fuer den Aufenthaltsort
  let label = params.locationLabel?.trim() || '';
  if (!label) {
    if (serverName) {
      label = `Server "${serverName}"`;
    } else if (path === '/' || path === '') {
      label = 'Serverliste';
    } else if (path.startsWith('/admin/users')) {
      label = 'Benutzerverwaltung';
    } else if (path.startsWith('/admin/audit')) {
      label = 'Audit-Log';
    } else if (path.startsWith('/admin/dateien')) {
      label = 'Dateimanager (VM)';
    } else if (path.startsWith('/admin/testbericht')) {
      label = 'Spiele-Testbericht';
    } else if (path.startsWith('/admin/integrationen')) {
      label = 'Integrationen';
    } else if (path.startsWith('/account')) {
      label = 'Kontoeinstellungen';
    } else if (path.startsWith('/neu')) {
      label = 'Neuen Server erstellen';
    } else if (path.startsWith('/netzwerk')) {
      label = 'Netzwerk & Nodes';
    } else {
      label = 'Im Panel aktiv';
    }
  }

  const now = new Date();
  const presence: UserPresence = {
    userId,
    username,
    role,
    avatar: avatar ?? null,
    path,
    serverId: serverId ?? null,
    serverName,
    locationLabel: label,
    lastSeenAt: now,
    ip: ip ?? null,
  };

  presences.set(userId, presence);

  // In DB last_seen_at aktualisieren (max. alle 30s pro Nutzer)
  const lastUpdate = lastDbUpdate.get(userId) ?? 0;
  if (Date.now() - lastUpdate > DB_UPDATE_THROTTLE_MS) {
    lastDbUpdate.set(userId, Date.now());
    void sql`UPDATE users SET last_seen_at = now() WHERE id = ${userId}`.catch(() => {});
  }

  return presence;
}

/** Alle Nutzer, die in den letzten 60 Sekunden aktiv waren */
export function getActivePresences(maxAgeMs = 60_000): UserPresence[] {
  const cutoff = Date.now() - maxAgeMs;
  return Array.from(presences.values())
    .filter((p) => p.lastSeenAt.getTime() > cutoff)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

/** Holt die Live-Präsenz eines bestimmten Nutzers */
export function getPresenceForUser(userId: string, maxAgeMs = 60_000): UserPresence | null {
  const p = presences.get(userId);
  if (!p) return null;
  if (Date.now() - p.lastSeenAt.getTime() > maxAgeMs) return null;
  return p;
}

/** Holt alle Nutzer, die sich aktuell auf einem bestimmten Server aufhalten */
export function getPresencesForServer(serverId: string, maxAgeMs = 60_000): UserPresence[] {
  const cutoff = Date.now() - maxAgeMs;
  return Array.from(presences.values()).filter(
    (p) => p.serverId === serverId && p.lastSeenAt.getTime() > cutoff
  );
}
