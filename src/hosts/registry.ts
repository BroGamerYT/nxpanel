import { sql } from '../db/index.js';
import { encrypt, decrypt } from '../crypto.js';
import { log } from '../log.js';
import { CoreHost, tokenFingerprint } from './core-host.js';
import { LocalHost } from './local-host.js';
import type { Host, HostRow, HostRuntime, HostStatus, HostType } from './types.js';

/** Ein Host, wie er in der Datenbank steht (inklusive der Zahl der Server). */
interface NodeRow {
  id: string;
  name: string;
  type: HostType;
  address: string | null;
  runtime: HostRuntime;
  status: HostStatus;
  cert_fingerprint: string | null;
  token_encrypted: string | null;
  last_seen_at: Date | null;
  ram_total_mb: number;
  ram_used_mb: number;
  disk_total_mb: number;
  disk_used_mb: number;
  cpu_percent: number | string;
  servers: number;
}

/** Instanzen pro Host - werden zwischengespeichert, damit nicht jedes Mal entschluesselt wird. */
const hostCache = new Map<string, Host>();

const NODE_COLUMNS = `
  n.id, n.name, n."type", n.address, n.runtime, n.status, n.cert_fingerprint,
  n.token_encrypted, n.last_seen_at, n.ram_total_mb, n.ram_used_mb,
  n.disk_total_mb, n.disk_used_mb, n.cpu_percent,
  (SELECT count(*)::int FROM servers s WHERE s.node_id = n.id) AS servers`;

/** Alle Hosts, wie sie in der Datenbank stehen. */
export async function listHosts(): Promise<HostRow[]> {
  const rows = await sql<NodeRow[]>`
    SELECT ${sql.unsafe(NODE_COLUMNS)}
    FROM nodes n ORDER BY n.created_at`;
  return rows.map(toHostRow);
}

/** Ein einzelner Host aus der Datenbank. */
export async function loadHostRow(id: string): Promise<NodeRow | null> {
  const [row] = await sql<NodeRow[]>`
    SELECT ${sql.unsafe(NODE_COLUMNS)}
    FROM nodes n WHERE n.id = ${id}`;
  return row ?? null;
}

/**
 * Holt den Host zu einer ID - oder null, wenn es ihn nicht gibt.
 *
 * Fuer 'core' wird das Token entschluesselt. Faellt die Entschluesselung
 * aus (Schluesselwechsel, kaputte Daten), gibt es keinen Host: ein Core
 * ohne Token waere ein Host, den das Panel nicht nutzen kann.
 */
export async function resolveHost(id: string): Promise<Host | null> {
  const row = await loadHostRow(id);
  if (!row) return null;

  const cached = hostCache.get(id);
  if (cached) {
    if (cached instanceof LocalHost) return cached;
    if (cached instanceof CoreHost && cached.token && row.token_encrypted) {
      // Nur weiterverwenden, wenn das Token noch passt.
      try {
        if (decrypt(row.token_encrypted) === cached.token) return cached;
      } catch {
        /* neu aufbauen */
      }
    }
  }

  if (row.type === 'local') {
    const host = new LocalHost(row.id, row.runtime);
    hostCache.set(id, host);
    return host;
  }

  if (!row.address || !row.token_encrypted) {
    log.warn({ hostId: id }, 'Core-Host ohne Adresse oder Token - nicht verwendbar');
    return null;
  }

  let token: string;
  try {
    token = decrypt(row.token_encrypted);
  } catch (err) {
    log.error({ err, hostId: id }, 'Token des Core-Hosts nicht entschluesselbar');
    return null;
  }

  const host = new CoreHost(row.id, row.address, token, row.runtime);
  hostCache.set(id, host);
  return host;
}

/**
 * Legt einen Core-Host an.
 *
 * Vor dem Speichern wird die Verbindung wirklich geprueft: es wird eine
 * Anfrage an den Core geschickt und geprueft, ob das eingegebene Token zum
 * Token des Cores passt. So kann ein Core nicht mit einem falschen Token
 * untergeschoben werden.
 */
export async function createCoreHost(input: {
  name: string;
  address: string;
  token: string;
  pin?: string | undefined;
}): Promise<HostRow> {
  const address = normalizeAddress(input.address);
  const verification = await verifyCore(address, input.token, input.pin);

  const [row] = await sql<NodeRow[]>`
    INSERT INTO nodes (name, fqdn, type, address, runtime, status, token_encrypted,
                       last_seen_at, ram_total_mb, ram_used_mb, disk_total_mb, disk_used_mb, cpu_percent)
    VALUES (
      ${input.name}, ${verification.fqdn}, 'core', ${address}, ${verification.runtime}, 'online',
      ${encrypt(input.token)}, now(), ${verification.ramTotalMb}, ${verification.ramUsedMb},
      ${verification.diskTotalMb}, ${verification.diskUsedMb}, ${verification.cpuPercent}
    )
    RETURNING id, name, type, address, runtime, status, cert_fingerprint, token_encrypted,
              last_seen_at, ram_total_mb, ram_used_mb, disk_total_mb, disk_used_mb, cpu_percent,
              0 AS servers`;
  if (!row) throw new Error('Host konnte nicht angelegt werden');
  log.info({ hostId: row.id, address }, 'Core-Host angelegt');
  return toHostRow(row);
}

/**
 * Aendert einen Core-Host.
 *
 * Werden Adresse oder Token geaendert, wird die Verbindung erneut geprueft -
 * ein Host, der nicht erreichbar ist, wird nicht gespeichert.
 */
export async function updateCoreHost(
  id: string,
  input: { name?: string | undefined; address?: string | undefined; token?: string | undefined },
): Promise<HostRow> {
  const row = await loadHostRow(id);
  if (!row) throw new Error('Host nicht gefunden');
  if (row.type !== 'core') throw new Error('Der lokale Host kann nicht geaendert werden');

  const address = input.address ? normalizeAddress(input.address) : row.address;
  const token = input.token ?? (row.token_encrypted ? safeDecrypt(row.token_encrypted) : null);
  if (!address || !token) throw new Error('Core-Host braucht Adresse und Token');

  let verification: CoreVerification | null = null;
  if (input.address !== undefined || input.token !== undefined) {
    verification = await verifyCore(address, token, undefined);
  }

  const [updated] = await sql<NodeRow[]>`
    UPDATE nodes SET
      name = ${input.name ?? sql`name`},
      address = ${address},
      token_encrypted = ${input.token ? encrypt(input.token) : sql`token_encrypted`},
      status = ${verification ? 'online' : sql`status`},
      last_seen_at = ${verification ? new Date() : sql`last_seen_at`},
      ram_total_mb = ${verification ? verification.ramTotalMb : sql`ram_total_mb`},
      ram_used_mb = ${verification ? verification.ramUsedMb : sql`ram_used_mb`},
      disk_total_mb = ${verification ? verification.diskTotalMb : sql`disk_total_mb`},
      disk_used_mb = ${verification ? verification.diskUsedMb : sql`disk_used_mb`},
      cpu_percent = ${verification ? verification.cpuPercent : sql`cpu_percent`}
    WHERE id = ${id}
    RETURNING id, name, type, address, runtime, status, cert_fingerprint, token_encrypted,
              last_seen_at, ram_total_mb, ram_used_mb, disk_total_mb, disk_used_mb, cpu_percent,
              (SELECT count(*)::int FROM servers s WHERE s.node_id = nodes.id) AS servers`;

  if (!updated) throw new Error('Host nicht gefunden');
  hostCache.delete(id);
  return toHostRow(updated);
}

/** Entfernt einen Core-Host. Der lokale Host bleibt unberuehrbar. */
export async function deleteHost(id: string): Promise<void> {
  const row = await loadHostRow(id);
  if (!row) throw new Error('Host nicht gefunden');
  if (row.type !== 'core') throw new Error('Der lokale Host kann nicht entfernt werden');

  const [used] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM servers WHERE node_id = ${id}`;
  if (used && used.count > 0) {
    throw new Error(`An diesem Host laufen noch ${used.count} Server - erst die Server verschieben`);
  }

  await sql`DELETE FROM nodes WHERE id = ${id}`;
  hostCache.delete(id);
  log.info({ hostId: id }, 'Core-Host entfernt');
}

/**
 * Fragt den Status eines Hosts ab und schreibt ihn in die Datenbank.
 *
 * Ein Core, der nicht antwortet, wird als 'unreachable' vermerkt - nicht als
 * entfernt. Sonst wuerde ein kurzer Netzausfall den Host aus der Liste
 * verschwinden lassen.
 */
export async function refreshHost(id: string): Promise<HostRow | null> {
  const row = await loadHostRow(id);
  if (!row) return null;

  const host = await resolveHost(id);
  if (!host) return toHostRow(row);

  try {
    const info = await host.info();
    const metrics = info.metrics;
    const [updated] = await sql<NodeRow[]>`
      UPDATE nodes SET
        status = 'online', last_seen_at = now(),
        ram_total_mb = ${metrics ? metrics.ramTotalMb : sql`ram_total_mb`},
        ram_used_mb = ${metrics ? metrics.ramUsedMb : sql`ram_used_mb`},
        disk_total_mb = ${metrics ? metrics.diskTotalMb : sql`disk_total_mb`},
        disk_used_mb = ${metrics ? metrics.diskUsedMb : sql`disk_used_mb`},
        cpu_percent = ${metrics ? metrics.cpuPercent : sql`cpu_percent`}
      WHERE id = ${id}
      RETURNING id, name, type, address, runtime, status, cert_fingerprint, token_encrypted,
                last_seen_at, ram_total_mb, ram_used_mb, disk_total_mb, disk_used_mb, cpu_percent,
                (SELECT count(*)::int FROM servers s WHERE s.node_id = nodes.id) AS servers`;
    log.debug({ hostId: id, version: info.version }, 'Host erreicht');
    return updated ? toHostRow(updated) : toHostRow(row);
  } catch (err) {
    log.warn({ err, hostId: id }, 'Core-Host nicht erreichbar');
    await sql`UPDATE nodes SET status = 'unreachable' WHERE id = ${id}`;
    row.status = 'unreachable';
    return toHostRow(row);
  }
}

/** Fragt alle Core-Hosts ab. Wird vom Hintergrund-Job benutzt. */
export async function refreshAllHosts(): Promise<void> {
  const rows = await sql<{ id: string }[]>`SELECT id FROM nodes WHERE type = 'core'`;
  for (const row of rows) {
    try {
      await refreshHost(row.id);
    } catch (err) {
      log.warn({ err, hostId: row.id }, 'Statusabfrage des Core-Hosts fehlgeschlagen');
    }
  }
}

/** Leert den Cache - nach einem Tokenwechsel. */
export function forgetHost(id: string): void {
  hostCache.delete(id);
}

interface CoreVerification {
  fqdn: string;
  runtime: HostRuntime;
  ramTotalMb: number;
  ramUsedMb: number;
  diskTotalMb: number;
  diskUsedMb: number;
  cpuPercent: number;
}

/**
 * Prueft Adresse und Token gegen den echten Core.
 *
 * Mit PIN: der Core nennt den Fingerabdruck seines Tokens, das Panel vergleicht
 * ihn mit dem eigenen. Ohne PIN genuegt ein erfolgreicher Zugriff auf die
 * geschuetzte Route - damit wird das Token ebenfalls bestaetigt.
 */
async function verifyCore(address: string, token: string, pin?: string | undefined): Promise<CoreVerification> {
  const base = address.replace(/\/+$/, '');

  if (pin) {
    let fingerprint: string;
    try {
      const response = await fetch(`${base}/core/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pin }),
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        core?: { tokenFingerprint?: string };
        message?: string;
      };
      if (!response.ok) {
        throw new Error(body.message ?? `Der Core lehnt die PIN ab (HTTP ${response.status})`);
      }
      fingerprint = body.core?.tokenFingerprint ?? '';
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Der Core ist nicht erreichbar');
    }

    if (fingerprint !== tokenFingerprint(token)) {
      throw new Error('Das Token passt nicht zu diesem Core - bitte NEXUSCORE_TOKEN des Cores eintragen');
    }
  } else {
    try {
      const response = await fetch(`${base}/core/v1/servers`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error('Der Core lehnt das Token ab');
      }
      if (!response.ok) {
        throw new Error(`Der Core antwortet mit HTTP ${response.status}`);
      }
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : 'Der Core ist nicht erreichbar');
    }
  }

  // Auskunft des Cores holen - nicht erreichbar ist kein Fehler, der Host
  // wird dann ohne Ressourcenangaben angelegt.
  try {
    const response = await fetch(`${base}/core/v1/info`, { signal: AbortSignal.timeout(5_000) });
    if (response.ok) {
      const body = (await response.json()) as {
        host?: { name?: string; runtime?: string };
        metrics?: {
          cpuUsagePercent?: number;
          totalMemoryMb?: number;
          usedMemoryMb?: number;
          diskTotalGb?: number;
          diskFreeGb?: number;
        };
      };
      const metrics = body.metrics ?? {};
      const runtime = body.host?.runtime;
      return {
        fqdn: hostOf(address),
        runtime: isRuntime(runtime) ? runtime : 'docker',
        ramTotalMb: Math.round(metrics.totalMemoryMb ?? 0),
        ramUsedMb: Math.round(metrics.usedMemoryMb ?? 0),
        diskTotalMb: Math.round((metrics.diskTotalGb ?? 0) * 1024),
        diskUsedMb: Math.round(((metrics.diskTotalGb ?? 0) - (metrics.diskFreeGb ?? 0)) * 1024),
        cpuPercent: Math.round((metrics.cpuUsagePercent ?? 0) * 100) / 100,
      };
    }
  } catch {
    /* Info ist optional */
  }

  return {
    fqdn: hostOf(address),
    runtime: 'docker',
    ramTotalMb: 0,
    ramUsedMb: 0,
    diskTotalMb: 0,
    diskUsedMb: 0,
    cpuPercent: 0,
  };
}

function isRuntime(value: unknown): value is HostRuntime {
  return value === 'docker' || value === 'podman' || value === 'windows-native' || value === 'mock';
}

/** Hostname aus einer Adresse - die Spalte fqdn ist nicht leer. */
function hostOf(address: string): string {
  try {
    return new URL(address).hostname;
  } catch {
    return address;
  }
}

/** Trailing Slashes entfernen, damit keine doppelten Schrägstriche entstehen. */
function normalizeAddress(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, '');
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    throw new Error('Adresse muss eine URL sein, z. B. http://192.168.1.50:8443');
  }
  return trimmed;
}

function safeDecrypt(value: string): string | null {
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

function toHostRow(row: NodeRow): HostRow {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address: row.address,
    runtime: row.runtime,
    status: row.status,
    certFingerprint: row.cert_fingerprint,
    lastSeenAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    ramTotalMb: row.ram_total_mb,
    ramUsedMb: row.ram_used_mb,
    diskTotalMb: row.disk_total_mb,
    diskUsedMb: row.disk_used_mb,
    cpuPercent: Number(row.cpu_percent),
    servers: row.servers,
  };
}
