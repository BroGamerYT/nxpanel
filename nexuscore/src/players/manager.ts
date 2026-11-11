import fs from 'node:fs/promises';
import path from 'node:path';
import type { HostDriver } from '../drivers/interface.js';
import { resolveInstanceDir } from '../files/instance-dir.js';
import { serverListPing, type SlpResult } from '../games/minecraft.js';
import { logger } from '../logger.js';
import type { ServerRegistry } from '../store/registry.js';
import type { ServerInstanceConfig } from '../types.js';

/**
 * Spieler (Block B4) fuer Minecraft Java: wer ist online, kicken, bannen
 * (auch auf Zeit), OP, Whitelist. Der Core ist der Elternprozess des Servers
 * und schickt die Befehle an dessen Konsole - RCON braucht er dafuer nicht.
 * Die Listen kommen aus den Dateien des Servers, gehen also auch gestoppt.
 */

export class PlayerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
    readonly code = 'player_error',
  ) {
    super(message);
    this.name = 'PlayerError';
  }
}

export type PlayerAction = 'kick' | 'ban' | 'pardon' | 'op' | 'deop' | 'whitelist_add' | 'whitelist_remove';
export const PLAYER_ACTIONS: PlayerAction[] = ['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist_add', 'whitelist_remove'];

/** Minecraft-Namen: Buchstaben, Ziffern, Unterstrich. Alles andere waere eine Befehls-Einschleusung. */
export const PLAYER_NAME = /^[A-Za-z0-9_]{2,16}$/;

export interface PlayersDeps {
  registry: ServerRegistry;
  driver: HostDriver;
  /** Austauschbar fuer Tests. */
  ping?: (host: string, port: number) => Promise<SlpResult>;
  now?: () => Date;
}

interface TimedBan {
  name: string;
  until: string;
}

export interface BanEntry {
  name: string;
  id: string | null;
  reason: string | null;
  created: string | null;
  by: string | null;
  until: string | null;
}

/** Nur dieses Spiel kann der Core (noch) verwalten. */
export function supportsPlayers(c: ServerInstanceConfig): boolean {
  return c.game === 'minecraft-paper';
}

export class PlayerManager {
  private readonly ping: (host: string, port: number) => Promise<SlpResult>;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(private readonly deps: PlayersDeps) {
    this.ping = deps.ping ?? ((host, port) => serverListPing(host, port));
    this.now = deps.now ?? (() => new Date());
  }

  private need(serverId: string): ServerInstanceConfig {
    const c = this.deps.registry.get(serverId);
    if (!c) throw new PlayerError('Server nicht gefunden', 404, 'not_found');
    return c;
  }

  private async isRunning(serverId: string): Promise<boolean> {
    try {
      return (await this.deps.driver.getServerState(serverId)).status === 'running';
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ Live

  async status(serverId: string): Promise<Record<string, unknown>> {
    const c = this.need(serverId);
    if (!supportsPlayers(c)) throw new PlayerError('Für dieses Spiel gibt es keine Live-Abfrage', 404, 'unsupported');
    if (!(await this.isRunning(serverId))) return { kind: 'minecraft', running: false };

    const port = c.ports[0]?.hostPort ?? 25565;
    let slp: SlpResult | null = null;
    let pingError: string | null = null;
    try {
      slp = await this.ping('127.0.0.1', port);
    } catch (err) {
      pingError = err instanceof Error ? err.message : String(err);
    }
    const sample = slp?.players.sample ?? [];
    return {
      running: true,
      kind: 'minecraft',
      ping: slp ?? { error: pingError ?? 'Keine Antwort' },
      tps: null,
      // Die Server-Liste nennt hoechstens 12 Namen - mehr kennt der Core ohne RCON nicht.
      players: slp ? sample : null,
      people: sample.map((name: string) => ({ name })),
      rcon: Boolean(this.deps.driver.sendCommand),
      actions: this.deps.driver.sendCommand ? PLAYER_ACTIONS : [],
      max: slp?.players.max ?? null,
      version: slp?.version ?? null,
      latencyMs: slp?.latencyMs ?? null,
      map: null,
    };
  }

  // ------------------------------------------------------------ Listen

  private async readJson<T>(dir: string, file: string): Promise<T | null> {
    const full = path.join(dir, file);
    try {
      // Keine Verknuepfungen: sonst koennte "ops.json" auf eine fremde Datei zeigen.
      if ((await fs.lstat(full)).isSymbolicLink()) return null;
      return JSON.parse(await fs.readFile(full, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  async lists(serverId: string): Promise<{ bans: BanEntry[]; whitelist: string[]; ops: string[] }> {
    const c = this.need(serverId);
    if (!supportsPlayers(c)) throw new PlayerError('Für dieses Spiel gibt es keine Spielerverwaltung', 404, 'unsupported');
    const dir = await resolveInstanceDir(this.deps.registry, c);
    if (!dir) throw new PlayerError('Dieser Server liegt nicht im Server-Verzeichnis des Cores.', 403, 'forbidden');
    const [bans, white, ops] = await Promise.all([
      this.readJson<Array<{ name?: string; uuid?: string; reason?: string; created?: string; source?: string }>>(dir, 'banned-players.json'),
      this.readJson<Array<{ name?: string }>>(dir, 'whitelist.json'),
      this.readJson<Array<{ name?: string }>>(dir, 'ops.json'),
    ]);
    const timed = new Map(this.timedBans(serverId).map((b) => [b.name.toLowerCase(), b.until]));
    const names = (list: Array<{ name?: string }> | null) => (list ?? []).map((x) => x.name).filter((n): n is string => Boolean(n));
    return {
      bans: (bans ?? [])
        .filter((b) => b.name)
        .map((b) => ({
          name: b.name!,
          id: b.uuid ?? null,
          reason: b.reason ?? null,
          created: b.created ?? null,
          by: b.source ?? null,
          until: timed.get(b.name!.toLowerCase()) ?? null,
        })),
      whitelist: names(white),
      ops: names(ops),
    };
  }

  // ------------------------------------------------------------ Aktionen

  private timedKey = (serverId: string) => `server.${serverId}.timed_bans`;

  private timedBans(serverId: string): TimedBan[] {
    return this.deps.registry.getSetting<TimedBan[]>(this.timedKey(serverId)) ?? [];
  }

  private saveTimed(serverId: string, list: TimedBan[]): void {
    if (list.length) this.deps.registry.setSetting(this.timedKey(serverId), list);
    else this.deps.registry.deleteSetting(this.timedKey(serverId));
  }

  async act(
    serverId: string,
    body: { action: PlayerAction; name: string; reason?: string | undefined; minutes?: number | undefined },
  ): Promise<{ output: string }> {
    const c = this.need(serverId);
    if (!supportsPlayers(c)) throw new PlayerError('Für dieses Spiel gibt es keine Spielerverwaltung', 400, 'unsupported');
    if (!this.deps.driver.sendCommand) throw new PlayerError('Dieser Treiber nimmt keine Befehle an.', 400, 'unsupported');
    if (!PLAYER_NAME.test(body.name)) throw new PlayerError('Ungültiger Spielername', 400, 'invalid_input');
    if (!(await this.isRunning(serverId))) throw new PlayerError('Server muss laufen', 409, 'must_run');

    const reason = body.reason?.trim();
    const command = {
      kick: `kick ${body.name}${reason ? ` ${reason}` : ''}`,
      ban: `ban ${body.name}${reason ? ` ${reason}` : ''}`,
      pardon: `pardon ${body.name}`,
      op: `op ${body.name}`,
      deop: `deop ${body.name}`,
      whitelist_add: `whitelist add ${body.name}`,
      whitelist_remove: `whitelist remove ${body.name}`,
    }[body.action];
    await this.deps.driver.sendCommand(serverId, command);

    if (body.action === 'ban') {
      const rest = this.timedBans(serverId).filter((b) => b.name.toLowerCase() !== body.name.toLowerCase());
      if (body.minutes) rest.push({ name: body.name, until: new Date(this.now().getTime() + body.minutes * 60_000).toISOString() });
      this.saveTimed(serverId, rest);
    }
    if (body.action === 'pardon') {
      this.saveTimed(serverId, this.timedBans(serverId).filter((b) => b.name.toLowerCase() !== body.name.toLowerCase()));
    }
    this.deps.registry.audit(`player.${body.action}`, serverId, 'standalone', {
      name: body.name,
      ...(reason ? { reason } : {}),
      ...(body.minutes ? { minutes: body.minutes } : {}),
    });
    // Die Konsolenantwort liest der Core hier nicht mit - sie steht in der Konsole.
    return { output: '' };
  }

  // ------------------------------------------------------------ Bann auf Zeit

  /** Hebt abgelaufene Banns auf. Laeuft der Server nicht, bleibt der Eintrag bis zum naechsten Start. @returns Anzahl aufgehobener */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let lifted = 0;
    try {
      const now = this.now().getTime();
      for (const c of this.deps.registry.list()) {
        const list = this.timedBans(c.id);
        const expired = list.filter((b) => new Date(b.until).getTime() <= now);
        if (!expired.length || !(await this.isRunning(c.id)) || !this.deps.driver.sendCommand) continue;
        const keep = list.filter((b) => !expired.includes(b));
        for (const b of expired) {
          try {
            await this.deps.driver.sendCommand(c.id, `pardon ${b.name}`);
            this.deps.registry.audit('player.pardon', c.id, 'core', { name: b.name, reason: 'Bann abgelaufen' });
            lifted++;
          } catch (err) {
            logger.warn({ err, serverId: c.id }, 'Abgelaufener Bann konnte nicht aufgehoben werden');
            keep.push(b);
          }
        }
        this.saveTimed(c.id, keep);
      }
    } finally {
      this.ticking = false;
    }
    return lifted;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
