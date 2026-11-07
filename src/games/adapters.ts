/**
 * Spielerverwaltung je Spiel. Minecraft hat seine eigene, reichere
 * Umsetzung (status.ts); hier stehen die Spiele, die Spieler ueber eine
 * ID (Steam/EOS) ansprechen.
 *
 *   ark       ARK: Survival Ascended - RCON "ListPlayers", Aktionen ueber die EOS-ID
 *   palworld  Palworld - RCON "ShowPlayers" (CSV), Aktionen ueber die Steam-ID
 *   source    Valve-Abfrage (A2S) - nur anzeigen, keine Aktionen
 */
export interface Person { name: string; id?: string }
export type GenericAction = 'kick' | 'ban' | 'pardon' | 'whitelist_add' | 'whitelist_remove';

export interface Adapter {
  listCommand: string;
  parseList(raw: string): Person[] | null;
  /** Was das Spiel kann - die Oberflaeche zeigt nur diese Knoepfe. */
  actions: GenericAction[];
  command(action: GenericAction, id: string): string;
}

/** ARK: "0. BroGamerYT, 0002a1b2c3d4e5f6..." oder "No Players Connected" */
export function parseArkList(raw: string): Person[] | null {
  if (/no players connected/i.test(raw)) return [];
  const out: Person[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*\d+\.\s*(.+?),\s*([0-9a-fA-F]{16,64})\s*$/.exec(line);
    if (m) out.push({ name: m[1]!.trim(), id: m[2]! });
  }
  return out.length || raw.trim() === '' ? out : null;
}

/** Palworld: "name,playeruid,steamid" + eine Zeile je Spieler */
export function parsePalworldList(raw: string): Person[] | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !/^name,playeruid,steamid/i.test(lines[0]!)) return null;
  return lines.slice(1).map((l) => {
    const parts = l.split(',');
    const steam = parts[parts.length - 1]!.trim();
    const name = parts.slice(0, -2).join(',').trim();
    return { name: name || steam, id: steam };
  }).filter((p) => p.id);
}

export const ADAPTERS: Record<string, Adapter> = {
  ark: {
    listCommand: 'ListPlayers',
    parseList: parseArkList,
    actions: ['kick', 'ban', 'pardon', 'whitelist_add', 'whitelist_remove'],
    command: (a, id) => ({
      kick: `KickPlayer ${id}`, ban: `BanPlayer ${id}`, pardon: `UnbanPlayer ${id}`,
      whitelist_add: `AllowPlayerToJoinNoCheck ${id}`, whitelist_remove: `DisallowPlayerToJoinNoCheck ${id}`,
    })[a],
  },
  palworld: {
    listCommand: 'ShowPlayers',
    parseList: parsePalworldList,
    actions: ['kick', 'ban', 'pardon'],
    command: (a, id) => ({ kick: `KickPlayer ${id}`, ban: `BanPlayer ${id}`, pardon: `UnBanPlayer ${id}`, whitelist_add: '', whitelist_remove: '' })[a],
  },
};

/** IDs gehen in Konsolenbefehle - nur harmlose Zeichen zulassen. */
export const PLAYER_ID = /^[A-Za-z0-9_:.-]{3,64}$/;
