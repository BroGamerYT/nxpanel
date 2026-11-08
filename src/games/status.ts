import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import { engine } from '../docker/client.js';
import { listPorts } from '../servers/repo.js';
import type { ServerRecord } from '../types.js';
import { Rcon } from './rcon.js';
import { ADAPTERS, type Person } from './adapters.js';
import { a2sInfo, a2sPlayers } from './a2s.js';
import { parseTps, serverListPing, tpsCommands, type SlpResult, type TpsResult } from './minecraft.js';

/**
 * Live-Zustand aus dem Spiel selbst (nicht aus Docker): Spieler, Version,
 * TPS. Welche Abfrage ein Spiel kann, sagt das Egg unter "query":
 *   { "kind": "minecraft", "rcon": { "port_ref": "rcon", "password_var": "RCON_PASSWORD",
 *     "password_files": [".rcon-cli.env"] } }
 * Ergebnisse werden kurz zwischengespeichert, damit mehrere offene
 * Browserfenster den Server nicht mit Abfragen eindecken.
 */
export interface QuerySpec {
  kind: 'minecraft' | 'ark' | 'palworld' | 'source';
  rcon?: { port_ref?: string; password_var?: string; password_files?: string[] };
  /** Nur "source": welcher Port die Valve-Abfrage beantwortet (Vorgabe: Spielport). */
  port_ref?: string;
}
const KINDS = ['minecraft', 'ark', 'palworld', 'source'];

export interface GameStatus {
  kind: QuerySpec['kind'];
  /** Spieler mit ID (wo das Spiel eine hat) - Grundlage fuer Kicken/Bannen. */
  people?: Person[];
  /** Was die Oberflaeche anbieten darf. */
  actions?: string[];
  max?: number | null;
  version?: string | null;
  latencyMs?: number | null;
  map?: string | null;
  at: number;
  ping: (SlpResult & { error?: undefined }) | { error: string } | null;
  tps: (TpsResult & { error?: undefined }) | { error: string } | null;
  /** Vollstaendige Spielerliste ueber RCON ("list") - die Server-Liste-Antwort zeigt hoechstens 12. */
  players: string[] | null;
  /** Kann das Panel Befehle schicken (Kicken, Bannen, Whitelist)? */
  rcon: boolean;
}

/** "There are 2 of a max of 20 players online: Steve, Alex" (Vanilla, Paper, Fabric, Forge) */
export function parseList(raw: string): string[] | null {
  const s = raw.replace(/§./g, '');
  if (!/players? online/i.test(s)) return null;
  const i = s.indexOf(':');
  if (i < 0) return [];
  return s.slice(i + 1).split(/[,\n]/).map((x) => x.trim().replace(/\s*\(.*\)$/, '')).filter((x) => /^[\w.]{1,32}$/.test(x));
}

const cache = new Map<string, GameStatus>();
const rcons = new Map<string, { key: string; rcon: Rcon }>();
const workingCmd = new Map<string, string>();
const CACHE_MS = 10_000;

export async function querySpec(eggId: string): Promise<QuerySpec | null> {
  const [e] = await sql<{ q: unknown }[]>`SELECT raw_egg->'query' AS q FROM eggs WHERE id = ${eggId}`;
  const q = e?.q as QuerySpec | null;
  return q && KINDS.includes(q.kind) ? q : null;
}

/** Wo ist der Container erreichbar? Panel im Container: ueber das Spielnetz, sonst lokal. */
async function hostFor(server: ServerRecord): Promise<string> {
  if (server.container_id && existsSync('/.dockerenv')) return (await engine.gameNetworkIp(server.container_id).catch(() => null)) ?? '127.0.0.1';
  return '127.0.0.1';
}

/** RCON-Passwort: aus den Variablen, sonst aus der Datei, die das Image selbst schreibt (itzg: .rcon-cli.env). */
export async function rconPassword(server: ServerRecord, spec: NonNullable<QuerySpec['rcon']>): Promise<string | null> {
  const v = spec.password_var ? server.variables?.[spec.password_var] : undefined;
  if (v) return v;
  for (const f of spec.password_files ?? []) {
    const text = await readFile(join(resolve(config.VOLUME_ROOT, server.short_id), f.replace(/\.\./g, '')), 'utf8').catch(() => null);
    const m = text && /^\s*password\s*[=:]\s*["']?([^"'\r\n]+)/im.exec(text);
    if (m?.[1]) return m[1].trim();
  }
  return null;
}

export function dropRcon(serverId: string) {
  rcons.get(serverId)?.rcon.close();
  rcons.delete(serverId);
  cache.delete(serverId);
}

async function rconFor(server: ServerRecord, spec: NonNullable<QuerySpec['rcon']>, host: string): Promise<Rcon | null> {
  const ports = await listPorts(server.id);
  const port = ports.find((p) => p.ref === (spec.port_ref ?? 'rcon'))?.port;
  const pw = await rconPassword(server, spec);
  if (!port || !pw) return null;
  const key = `${host}:${port}:${pw}`;
  const have = rcons.get(server.id);
  if (have?.key === key) return have.rcon;
  have?.rcon.close();
  const rcon = new Rcon(host, port, pw);
  rcons.set(server.id, { key, rcon });
  return rcon;
}

export async function gameStatus(server: ServerRecord, spec: QuerySpec): Promise<GameStatus> {
  const hit = cache.get(server.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  if (spec.kind !== 'minecraft') {
    const st = await otherStatus(server, spec);
    cache.set(server.id, st);
    return st;
  }
  const host = await hostFor(server);
  const ports = await listPorts(server.id);
  const game = ports.find((p) => p.is_primary)?.port ?? ports[0]?.port;

  let ping: GameStatus['ping'] = null;
  if (game) {
    ping = await serverListPing(host, game).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
  }

  let tps: GameStatus['tps'] = null;
  if (spec.rcon) {
    try {
      const rcon = await rconFor(server, spec.rcon, host);
      if (!rcon) tps = { error: 'RCON nicht eingerichtet' };
      else {
        const known = workingCmd.get(server.id);
        const cmds = known ? [known] : tpsCommands(server.variables?.TYPE);
        for (const cmd of cmds) {
          const out = await rcon.command(cmd);
          const parsed = parseTps(out, cmd);
          if (parsed) { tps = parsed; workingCmd.set(server.id, cmd); break; }
        }
        if (!tps) { workingCmd.delete(server.id); tps = { error: 'Kein TPS-Befehl verfuegbar' }; }
      }
    } catch (e) {
      dropRcon(server.id);
      tps = { error: e instanceof Error ? e.message : String(e) };
    }
  }
  let players: string[] | null = null;
  let hasRcon = false;
  if (spec.rcon) {
    try {
      const rcon = await rconFor(server, spec.rcon, host);
      if (rcon) { players = parseList(await rcon.command('list')); hasRcon = true; }
    } catch { /* TPS-Teil hat den Fehler schon */ }
  }
  const liveVersion = (ping && !('error' in ping) ? (typeof ping.version === 'string' ? ping.version : (ping.version as any)?.name ?? null) : null);
  const st: GameStatus = { kind: 'minecraft', at: Date.now(), ping, tps, players, rcon: hasRcon,
    version: liveVersion,
    people: (players ?? (ping && !('error' in ping) ? ping.players.sample : [])).map((name) => ({ name })),
    actions: hasRcon ? ['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist_add', 'whitelist_remove'] : [] };
  cache.set(server.id, st);
  return st;
}

/** Einen Befehl ueber RCON schicken (Spielerverwaltung). Wirft, wenn RCON nicht geht. */
export async function rconCommand(server: ServerRecord, spec: QuerySpec, cmd: string): Promise<string> {
  if (!spec.rcon) throw new Error('Dieses Spiel hat kein RCON');
  const rcon = await rconFor(server, spec.rcon, await hostFor(server));
  if (!rcon) throw new Error('RCON nicht eingerichtet (Port oder Passwort fehlt)');
  try {
    const out = await rcon.command(cmd);
    cache.delete(server.id);
    return out.replace(/§./g, '');
  } catch (e) {
    dropRcon(server.id);
    throw e;
  }
}

/** Alle Spiele ausser Minecraft: Spielerliste ueber RCON (ARK, Palworld) oder Valve-Abfrage. */
async function otherStatus(server: ServerRecord, spec: QuerySpec): Promise<GameStatus> {
  const host = await hostFor(server);
  let detectedVersion: string | null = null;

  // Versionserkennung aus Log-Dateien (z. B. ARK) oder App-Manifest
  if (spec.kind === 'ark') {
    try {
      const logPath = join(resolve(config.VOLUME_ROOT, server.short_id), 'ShooterGame/Saved/Logs/ShooterGame.log');
      const text = await readFile(logPath, 'utf8').catch(() => null);
      if (text) {
        const matches = [...text.matchAll(/ARK Version:\s*([0-9.]+)/gi)];
        if (matches.length > 0) {
          detectedVersion = matches[matches.length - 1]![1]!;
        }
      }
    } catch {}
  }

  const base: GameStatus = { kind: spec.kind, at: Date.now(), ping: null, tps: null, players: null, rcon: false, people: [], actions: [],
    version: detectedVersion,
    max: Number(server.variables?.MAX_PLAYERS ?? server.variables?.SERVER_SLOTS ?? server.variables?.PLAYERS ?? 0) || null };
  if (spec.kind === 'source') {
    const ports = await listPorts(server.id);
    const port = ports.find((p) => p.ref === (spec.port_ref ?? 'game'))?.port ?? ports.find((p) => p.is_primary)?.port;
    if (!port) return base;
    try {
      const info = await a2sInfo(host, port);
      const players = await a2sPlayers(host, port).catch(() => null);
      return { ...base, max: info.maxPlayers, version: info.version || detectedVersion, latencyMs: info.latencyMs, map: info.map,
        players: players?.map((p) => p.name) ?? null, people: players?.map((p) => ({ name: p.name })) ?? [] };
    } catch (e) {
      return { ...base, ping: { error: e instanceof Error ? e.message : String(e) } };
    }
  }
  const adapter = ADAPTERS[spec.kind];
  if (!adapter || !spec.rcon) return base;
  try {
    const rcon = await rconFor(server, spec.rcon, host);
    if (!rcon) return { ...base, tps: null, ping: { error: 'RCON nicht eingerichtet' } };
    const t0 = Date.now();
    const people = adapter.parseList(await rcon.command(adapter.listCommand)) ?? [];
    return { ...base, rcon: true, version: detectedVersion, latencyMs: Date.now() - t0, people, players: people.map((p) => p.name), actions: adapter.actions };
  } catch (e) {
    dropRcon(server.id);
    return { ...base, ping: { error: e instanceof Error ? e.message : String(e) } };
  }
}
