import { sql } from '../db/index.js';
import type { ServerRecord } from '../types.js';

export async function findServer(id: string): Promise<ServerRecord | null> {
  const [row] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${id}`;
  return row ?? null;
}

export async function findServerByShortId(shortId: string): Promise<ServerRecord | null> {
  const [row] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE short_id = ${shortId}`;
  return row ?? null;
}

export async function setContainerId(serverId: string, containerId: string | null): Promise<void> {
  await sql`UPDATE servers SET container_id = ${containerId} WHERE id = ${serverId}`;
}

export async function bumpCrashCount(serverId: string): Promise<number> {
  const [row] = await sql<{ crash_count: number }[]>`
    UPDATE servers SET crash_count = crash_count + 1
    WHERE id = ${serverId}
    RETURNING crash_count
  `;
  return row?.crash_count ?? 0;
}

export async function resetCrashCount(serverId: string): Promise<void> {
  await sql`UPDATE servers SET crash_count = 0 WHERE id = ${serverId}`;
}

export async function listPorts(serverId: string) {
  return sql<{ port: number; protocol: string; ref: string | null; is_primary: boolean }[]>`
    SELECT port, protocol, ref, is_primary
    FROM allocations
    WHERE server_id = ${serverId}
    ORDER BY is_primary DESC, port
  `;
}

/** Wie viele Abstuerze gab es in den letzten Minuten? Grundlage der Neustartgrenze. */
export async function recentCrashCount(serverId: string, minutes: number): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    SELECT count(*) FROM events
    WHERE server_id = ${serverId}
      AND kind = 'crash'
      AND ts > now() - (${minutes} || ' minutes')::interval
  `;
  return Number(row?.count ?? 0);
}
