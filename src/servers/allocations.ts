import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { portRange, config } from '../config.js';
import { engine } from '../docker/client.js';
import { existsSync } from 'node:fs';

/**
 * Portvergabe.
 *
 * Grundsatz aus dem Konzept: Der Nutzer tippt nie einen Port ein. Das Panel
 * nimmt den NIEDRIGSTEN freien im Wunschbereich des Eggs - nicht den
 * naechsthoeheren nach dem zuletzt vergebenen. So bleiben die Nummern dicht
 * beieinander, auch wenn zwischendurch ein Server geloescht wurde.
 */

export interface PortSpec {
  ref: string;
  name?: string;
  start?: number;
  end?: number;
  offset?: number;
  protocol: 'tcp' | 'udp' | 'both';
  optional?: boolean;
  /**
   * Nur intern: der Port bekommt eine Nummer (damit das Spiel weiss, worauf
   * es lauscht), wird aber NICHT am Host freigegeben. Fuer RCON - das Panel
   * erreicht den Container ueber das Spielnetz, aus dem Internet muss das
   * niemand. Minecraft-RCON ist unverschluesselt.
   */
  internal?: boolean;
}

/** Refs der Ports, die nicht nach aussen gehen. */
export function internalRefs(ports: EggPorts | null | undefined): Set<string> {
  return new Set((ports?.secondary ?? []).filter((p) => p.internal === true).map((p) => p.ref));
}

export interface EggPorts {
  primary: PortSpec;
  secondary?: PortSpec[];
}

export interface Allocation {
  ref: string;
  port: number;
  protocol: 'tcp' | 'udp' | 'both';
  isPrimary: boolean;
}

/** Ports, die nie vergeben werden. */
const BLOCKED = new Set([22, 25, 53, 80, 443, 3306, 5432, 6379, 8080]);

export function isBlocked(port: number): boolean {
  // Der SFTP-Port des Panels liegt evtl. im Spiel-Portbereich (z. B. 28999,
  // um die vorhandene Weiterleitung zu nutzen) - den nie an Spiele vergeben.
  return port < 1024 || BLOCKED.has(port) || port === (config.SFTP_PUBLIC_PORT ?? config.SFTP_PORT);
}

/**
 * Sucht den niedrigsten freien Port, bei dem auch alle Nebenports frei sind.
 * Ein halb belegtes Portpaar bringt nichts - deshalb wird die ganze Gruppe
 * zusammen geprueft.
 */
export interface PortRange { from: number; to: number }

/**
 * Mit `range` (Port-Bereich des Hosts) wird der Wunschbereich des Eggs
 * ignoriert: alle Ports - auch Nebenports - muessen in den Bereich passen,
 * sonst waeren sie von aussen nicht erreichbar.
 */
export function findPortGroup(
  spec: EggPorts,
  taken: Set<number>,
  isFree: (port: number) => boolean = () => true,
  range?: PortRange | null,
): Allocation[] | null {
  const from = range?.from ?? spec.primary.start ?? portRange.from;
  const to = range?.to ?? spec.primary.end ?? portRange.to;
  const inRange = (p: number) => !range || (p >= range.from && p <= range.to);

  for (let port = from; port <= to; port++) {
    if (isBlocked(port) || taken.has(port) || !isFree(port)) continue;

    const group: Allocation[] = [
      { ref: spec.primary.ref, port, protocol: spec.primary.protocol, isPrimary: true },
    ];

    let ok = true;
    for (const sec of spec.secondary ?? []) {
      const secPort = sec.offset !== undefined
        ? port + sec.offset
        : range
          ? findIn(range.from, range.to, taken, group, isFree)
          : findIn(sec.start ?? from, sec.end ?? to, taken, group, isFree);

      if (secPort === null || !inRange(secPort) || isBlocked(secPort) || taken.has(secPort) || !isFree(secPort) ||
          group.some((g) => g.port === secPort)) {
        if (sec.optional) continue;
        ok = false;
        break;
      }
      group.push({ ref: sec.ref, port: secPort, protocol: sec.protocol, isPrimary: false });
    }

    if (ok) return group;
  }

  return null;
}

function findIn(
  from: number, to: number, taken: Set<number>, group: Allocation[], isFree: (p: number) => boolean,
): number | null {
  for (let p = from; p <= to; p++) {
    if (!isBlocked(p) && !taken.has(p) && isFree(p) && !group.some((g) => g.port === p)) return p;
  }
  return null;
}

/**
 * Prueft, ob ein Port auf dem Host wirklich frei ist.
 *
 * Der haeufigste Fehler bei selbstgebauten Panels: nur die eigene Tabelle
 * pruefen. Dann vergibt das Panel 25565, waehrend dort schon ein fremder
 * Dienst laeuft - der Container startet, der Port ist belegt, und die
 * Meldung steht irgendwo tief im Log.
 */
export async function isPortFreeOnHost(port: number, protocol: 'tcp' | 'udp' | 'both'): Promise<boolean> {
  if (protocol !== 'udp' && !(await canBindTcp(port))) return false;
  if (protocol !== 'tcp' && !(await canBindUdp(port))) return false;
  return true;
}

function canBindTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '0.0.0.0');
  });
}

function canBindUdp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.once('error', () => { s.close(); resolve(false); });
    s.once('listening', () => s.close(() => resolve(true)));
    s.bind(port, '0.0.0.0');
  });
}

/** Port-Bereich und oeffentliche Adresse eines Hosts. */
export async function nodeNetwork(nodeId: string): Promise<{ range: PortRange | null; publicHost: string | null }> {
  const [n] = await sql<{ port_from: number | null; port_to: number | null; public_host: string | null }[]>`
    SELECT port_from, port_to, public_host FROM nodes WHERE id = ${nodeId}`;
  return {
    range: n?.port_from && n.port_to ? { from: n.port_from, to: n.port_to } : null,
    publicHost: n?.public_host ?? null,
  };
}

/** Vergibt eine Portgruppe und schreibt sie in einer Transaktion fest. */
export async function allocatePorts(
  nodeId: string, serverId: string, spec: EggPorts, ip = '0.0.0.0',
): Promise<Allocation[]> {
  const rows = await sql<{ port: number }[]>`
    SELECT port FROM allocations
    WHERE node_id = ${nodeId}
      AND (server_id IS NOT NULL OR blocked_until > now())
  `;
  const taken = new Set(rows.map((r) => r.port));
  const { range } = await nodeNetwork(nodeId);

  // Ports anderer Container dazunehmen - etwa eines alten AMP-Servers, der
  // ebenfalls in Docker laeuft. Das Panel kennt ihn nicht aus der eigenen
  // Tabelle, belegen wuerde er den Port trotzdem.
  try {
    for (const p of await engine.listPublishedPorts()) taken.add(p);
  } catch (err) {
    log.warn({ err }, 'Belegte Container-Ports nicht abfragbar');
  }

  // Erst gegen die Listen suchen, dann die engere Auswahl gegen den Host
  // pruefen (kostet Zeit). Ist ein Port dort belegt, kommt er auf die
  // Liste und es wird weitergesucht - nicht neu angefangen, sonst fiele
  // die Suche immer wieder auf denselben belegten Port.
  // Laeuft das Panel selbst in einem Container, sagt der Bindungstest
  // nichts ueber den Host; dann zaehlt nur die Docker-Abfrage oben.
  const inContainer = existsSync('/.dockerenv');
  let group: Allocation[] | null = null;
  for (let attempt = 0; attempt < 200; attempt++) {
    group = findPortGroup(spec, taken, () => true, range);
    if (!group) break;
    const busy = inContainer ? undefined : await firstBusy(group);
    if (!busy) break;
    log.warn({ port: busy }, 'Port ist auf dem Host belegt, suche weiter');
    taken.add(busy);
    group = null;
  }
  if (!group) {
    throw new Error(range
      ? `Kein freier Port im Bereich ${range.from}-${range.to} - Bereich unter Netzwerk erweitern`
      : 'Kein freier Port im Bereich des Eggs');
  }

  await sql.begin(async (tx) => {
    for (const a of group) {
      await tx`
        INSERT INTO allocations (node_id, ip, port, protocol, server_id, is_primary, ref, blocked_until)
        VALUES (${nodeId}, ${ip}, ${a.port}, ${a.protocol}, ${serverId}, ${a.isPrimary}, ${a.ref}, NULL)
        ON CONFLICT (node_id, ip, port, protocol)
        DO UPDATE SET server_id = ${serverId}, is_primary = ${a.isPrimary}, ref = ${a.ref}, blocked_until = NULL
      `;
    }
  });

  log.info({ serverId, ports: group.map((g) => `${g.ref}:${g.port}`) }, 'Ports vergeben');
  return group;
}

async function firstBusy(group: Allocation[]): Promise<number | undefined> {
  for (const a of group) if (!(await isPortFreeOnHost(a.port, a.protocol))) return a.port;
  return undefined;
}

/** Gibt Ports frei, mit Sperrfrist, damit nicht sofort ein anderer Server die Adresse erbt. */
export async function releasePorts(serverId: string, cooldownMinutes = 5): Promise<void> {
  await sql`
    UPDATE allocations
    SET server_id = NULL, is_primary = false, ref = NULL,
        blocked_until = now() + (${cooldownMinutes} || ' minutes')::interval
    WHERE server_id = ${serverId}
  `;
}
