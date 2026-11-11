import type { ServerRegistry } from './registry.js';

/**
 * Wem gehoert ein Server und wer darf mit welchen Rechten darauf?
 *
 * Gespeichert in den Einstellungen (`access.<serverId>`). Ein Server ohne
 * Eintrag hat keinen Besitzer: er gehoert dem Administrator und ist fuer
 * normale Benutzer unsichtbar - das ist der sichere Standard fuer alle schon
 * vorhandenen Server.
 */
export interface ServerAccessRecord {
  ownerId: string | null;
  /** Benutzer-ID -> Flags (Mitnutzer). */
  subusers: Record<string, string[]>;
}

const key = (serverId: string): string => `access.${serverId}`;

export function getAccess(registry: ServerRegistry, serverId: string): ServerAccessRecord {
  const raw = registry.getSetting<Partial<ServerAccessRecord>>(key(serverId));
  return {
    ownerId: typeof raw?.ownerId === 'string' ? raw.ownerId : null,
    subusers: raw?.subusers && typeof raw.subusers === 'object' ? raw.subusers : {},
  };
}

function put(registry: ServerRegistry, serverId: string, record: ServerAccessRecord): void {
  if (record.ownerId === null && Object.keys(record.subusers).length === 0) {
    registry.deleteSetting(key(serverId));
    return;
  }
  registry.setSetting(key(serverId), record);
}

export function setOwner(registry: ServerRegistry, serverId: string, ownerId: string | null): void {
  put(registry, serverId, { ...getAccess(registry, serverId), ownerId });
}

/** Flags eines Mitnutzers setzen; `null` entfernt ihn. */
export function setSubuserFlags(registry: ServerRegistry, serverId: string, userId: string, flags: string[] | null): void {
  const cur = getAccess(registry, serverId);
  const subusers = { ...cur.subusers };
  if (flags === null) delete subusers[userId];
  else subusers[userId] = flags;
  put(registry, serverId, { ...cur, subusers });
}

export function removeServerAccess(registry: ServerRegistry, serverId: string): void {
  put(registry, serverId, { ownerId: null, subusers: {} });
}

/** Ein Benutzer wird geloescht: seine Server werden herrenlos (Administrator), Mitnutzer-Rechte verfallen. */
export function removeUserAccess(registry: ServerRegistry, userId: string): void {
  for (const c of registry.list()) {
    const cur = getAccess(registry, c.id);
    if (cur.ownerId !== userId && !(userId in cur.subusers)) continue;
    const subusers = { ...cur.subusers };
    delete subusers[userId];
    put(registry, c.id, { ownerId: cur.ownerId === userId ? null : cur.ownerId, subusers });
  }
}

/** Server, die ein Benutzer besitzt oder auf die er Rechte hat. */
export function serversOfUser(registry: ServerRegistry, userId: string): Array<{ serverId: string; isOwner: boolean; flags: string[] }> {
  const out: Array<{ serverId: string; isOwner: boolean; flags: string[] }> = [];
  for (const c of registry.list()) {
    const a = getAccess(registry, c.id);
    if (a.ownerId === userId) out.push({ serverId: c.id, isOwner: true, flags: [] });
    else if (a.subusers[userId]) out.push({ serverId: c.id, isOwner: false, flags: a.subusers[userId]! });
  }
  return out;
}
