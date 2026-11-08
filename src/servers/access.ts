import { coverFor, type CoverInfo } from '../eggs/cover.js';
import { sql } from '../db/index.js';
import type { Actor, ServerAccess } from '../auth/permissions.js';
import { canSee, effectiveFlags } from '../auth/permissions.js';
import type { ServerRecord } from '../types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServerWithAccess {
  server: ServerRecord;
  access: ServerAccess;
}

/**
 * Laedt einen Server samt den Mitnutzer-Flags des anfragenden Nutzers.
 * Akzeptiert UUID oder short_id. Gibt null zurueck, wenn es den Server
 * nicht gibt ODER der Nutzer ihn nicht sehen darf - beides wird nach
 * aussen gleich beantwortet (404), damit niemand fremde IDs abklopfen kann.
 */
export async function loadServerForActor(idOrShort: string, actor: Actor): Promise<ServerWithAccess | null> {
  const byId = UUID_RE.test(idOrShort);
  const [row] = await sql<(ServerRecord & { subuser_flags: string[] | null })[]>`
    SELECT s.*, su.permissions AS subuser_flags
    FROM servers s
    LEFT JOIN subusers su ON su.server_id = s.id AND su.user_id = ${actor.id}
    WHERE ${byId ? sql`s.id = ${idOrShort}` : sql`s.short_id = ${idOrShort}`}
  `;
  if (!row) return null;
  const { subuser_flags, ...server } = row;
  const access: ServerAccess = { ownerId: server.owner_id, subuserFlags: subuser_flags };
  if (!canSee(actor, access)) return null;
  return { server: server as ServerRecord, access };
}

export interface ServerListItem {
  id: string;
  shortId: string;
  name: string;
  status: string;
  ownerId: string;
  ownerName: string;
  eggName: string;
  eggId: string;
  cover: CoverInfo;
  ramMb: number;
  cpuPercent: number;
  diskMb: number;
  autoRestart: boolean;
  crashCount: number;
  unstartable: boolean;
  suspended: boolean;
  primaryPort: number | null;
  /** Oeffentliche Adresse des Hosts (Domain/IP) - null = die, unter der das Panel erreichbar ist. */
  publicHost: string | null;
  createdAt: Date;
  isOwner: boolean;
  permissions: string[];
  gameVersion: string | null;
  serverType: string | null;
  modpackName: string | null;
  modpackVersion: string | null;
  tags: string[];
  isFavorite: boolean;
}

export function extractGameInfo(
  eggName: string,
  rawEgg: unknown,
  vars: Record<string, string> | null | undefined,
): {
  gameVersion: string | null;
  serverType: string | null;
  modpackName: string | null;
  modpackVersion: string | null;
} {
  if (!vars) return { gameVersion: null, serverType: null, modpackName: null, modpackVersion: null };

  let gameVersion: string | null = vars.VERSION || vars.GAME_VERSION || vars.MINECRAFT_VERSION || null;
  let serverType: string | null = vars.TYPE || null;
  let modpackName: string | null = null;
  let modpackVersion: string | null = null;

  const t = (serverType ?? '').toUpperCase();
  if (t === 'AUTO_CURSEFORGE' || vars.CF_SLUG) {
    const slug = (vars.CF_SLUG || '').trim();
    if (slug) {
      modpackName = slug
        .split(/[-_]+/)
        .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
        .join(' ');
    }
    modpackVersion = vars.CF_FILE_ID?.trim() || null;
    serverType = 'CurseForge';
  } else if (t === 'MODRINTH' || vars.MODRINTH_MODPACK) {
    const slug = (vars.MODRINTH_MODPACK || '').split('/').pop()?.replace(/\.mrpack$/i, '') || '';
    if (slug) {
      modpackName = slug
        .split(/[-_]+/)
        .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ''))
        .join(' ');
    }
    modpackVersion = vars.MODRINTH_VERSION?.trim() || null;
    serverType = 'Modrinth';
  } else if (t === 'FTBA' || vars.FTB_MODPACK_ID) {
    modpackName = `FTB Pack #${vars.FTB_MODPACK_ID}`;
    modpackVersion = vars.FTB_MODPACK_VERSION_ID?.trim() || null;
    serverType = 'FTB';
  } else if (t) {
    const niceTypes: Record<string, string> = {
      PAPER: 'Paper',
      PURPUR: 'Purpur',
      FABRIC: 'Fabric',
      FORGE: 'Forge',
      NEOFORGE: 'NeoForge',
      VANILLA: 'Vanilla',
      FOLIA: 'Folia',
      QUILT: 'Quilt',
      MOHIST: 'Mohist',
      ARCLIGHT: 'Arclight',
      SPIGOT: 'Spigot',
    };
    serverType = niceTypes[t] || serverType;
  }

  return { gameVersion, serverType, modpackName, modpackVersion };
}

/** Alle Server, die der Nutzer sehen darf - mit seinen Rechten je Server. */
export async function listServersForActor(actor: Actor): Promise<ServerListItem[]> {
  const seeAll = actor.role !== 'user';
  const rows = await sql<{
    id: string; short_id: string; name: string; status: string; owner_id: string; owner_name: string;
    egg_name: string; egg_id: string; egg_raw: unknown; egg_cover: string | null; egg_cover_version: string | null; ram_mb: number; cpu_percent: number; disk_mb: number;
    auto_restart: boolean; crash_count: number; suspended: boolean;
    primary_port: number | null; public_host: string | null; port_from: number | null; port_to: number | null; created_at: Date; subuser_flags: string[] | null;
    variables: Record<string, string>; tags: string[] | null; is_favorite: boolean | null;
  }[]>`
    SELECT s.id, s.short_id, s.name, s.status, s.owner_id, u.username AS owner_name,
           e.name AS egg_name, s.egg_id, e.raw_egg AS egg_raw, e.cover AS egg_cover, e.cover_version AS egg_cover_version,
           s.ram_mb, s.cpu_percent, s.disk_mb, s.auto_restart, s.crash_count, s.suspended, s.created_at,
           s.variables, s.tags, s.is_favorite, su.permissions AS subuser_flags, n.public_host, n.port_from, n.port_to,
           (SELECT a.port FROM allocations a WHERE a.server_id = s.id AND a.is_primary LIMIT 1) AS primary_port
    FROM servers s
    JOIN users u ON u.id = s.owner_id
    JOIN eggs e ON e.id = s.egg_id
    JOIN nodes n ON n.id = s.node_id
    LEFT JOIN subusers su ON su.server_id = s.id AND su.user_id = ${actor.id}
    WHERE ${seeAll ? sql`true` : sql`(s.owner_id = ${actor.id} OR cardinality(su.permissions) > 0)`}
    ORDER BY s.is_favorite DESC, s.name
  `;
  return rows.map((r) => {
    const info = extractGameInfo(r.egg_name, r.egg_raw, r.variables);
    return {
      id: r.id,
      shortId: r.short_id,
      name: r.name,
      status: r.status,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      eggName: r.egg_name,
      eggId: r.egg_id,
      cover: coverFor({ id: r.egg_id, name: r.egg_name, raw: r.egg_raw, choice: r.egg_cover, version: r.egg_cover_version }),
      ramMb: r.ram_mb,
      cpuPercent: r.cpu_percent,
      diskMb: r.disk_mb,
      autoRestart: r.auto_restart,
      crashCount: r.crash_count,
      unstartable: r.status === 'crashed' && r.crash_count >= 5,
      suspended: r.suspended,
      primaryPort: r.primary_port,
      publicHost: publicHostFor(r.public_host, r.port_from, r.port_to, r.primary_port),
      createdAt: r.created_at,
      isOwner: r.owner_id === actor.id,
      permissions: effectiveFlags(actor, { ownerId: r.owner_id, subuserFlags: r.subuser_flags }),
      gameVersion: info.gameVersion,
      serverType: info.serverType,
      modpackName: info.modpackName,
      modpackVersion: info.modpackVersion,
      tags: r.tags ?? [],
      isFavorite: Boolean(r.is_favorite),
    };
  });
}

/**
 * Die oeffentliche Adresse gilt nur fuer Ports im weitergeleiteten Bereich.
 * Liegt der Port ausserhalb, fuehrt "IP:Port" von aussen ins Leere oder
 * sogar zu einem fremden Server - dann lieber keine oeffentliche Adresse
 * nennen, die Oberflaeche zeigt dann die interne.
 */
export function publicHostFor(host: string | null, from: number | null, to: number | null, port: number | null): string | null {
  if (!host) return null;
  if (from === null || to === null || port === null) return host;
  return port >= from && port <= to ? host : null;
}
