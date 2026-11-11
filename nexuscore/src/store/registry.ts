import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstanceConfig } from '../types.js';

interface RegistryFile {
  version: number;
  servers: ServerInstanceConfig[];
}

const FILE_VERSION = 1;

/** Die Registry-Datei ist beschaedigt - der Core darf damit nicht weiterlaufen. */
export class RegistryCorruptError extends Error {
  constructor(
    readonly file: string,
    readonly backup: string,
    reason: string,
  ) {
    super(
      `Die Registry ${file} ist beschaedigt (${reason}). Sie wurde nach ${backup} gesichert. ` +
        'Datei pruefen und zurueckkopieren, oder den Core neu starten, um mit leerer Registry zu beginnen.',
    );
    this.name = 'RegistryCorruptError';
  }
}

/**
 * Persistenz der registrierten Server.
 *
 * Die Datei wird atomar geschrieben (eigene Temp-Datei je Vorgang, fsync,
 * dann Rename), damit ein Absturz keine halb geschriebene Registry
 * hinterlaesst und sich zwei Schreibvorgaenge nicht gegenseitig ueberschreiben.
 *
 * Eine beschaedigte Datei wird NICHT still durch eine leere Registry ersetzt:
 * alle Instanzen waeren dann ohne Hinweis weg. Stattdessen wird sie als
 * `servers.json.korrupt-<zeitstempel>` weggesichert und der Start bricht ab.
 */
export class ServerRegistry {
  private servers = new Map<string, ServerInstanceConfig>();

  /** Schreibvorgaenge laufen nacheinander, damit der letzte Stand gewinnt. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    readonly dir: string,
    readonly file: string,
  ) {}

  static async open(dir: string): Promise<ServerRegistry> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'servers.json');
    const registry = new ServerRegistry(dir, file);

    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (err) {
      // Noch keine Datei: erster Start, leere Registry ist richtig.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return registry;
      throw err;
    }

    let reason: string | null = null;
    try {
      const parsed = JSON.parse(raw) as Partial<RegistryFile> | null;
      if (!parsed || !Array.isArray(parsed.servers)) {
        reason = 'Feld "servers" fehlt';
      } else {
        for (const server of parsed.servers) {
          if (server && typeof server.id === 'string') {
            registry.servers.set(server.id, server);
          }
        }
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : 'kein gueltiges JSON';
    }

    if (reason !== null) {
      const backup = `${file}.korrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await fs.rename(file, backup);
      throw new RegistryCorruptError(file, backup, reason);
    }

    return registry;
  }

  list(): ServerInstanceConfig[] {
    return Array.from(this.servers.values());
  }

  get(id: string): ServerInstanceConfig | undefined {
    return this.servers.get(id);
  }

  async add(config: ServerInstanceConfig): Promise<void> {
    if (this.servers.has(config.id)) {
      throw new Error(`Server "${config.id}" existiert bereits.`);
    }
    this.servers.set(config.id, config);
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.servers.delete(id);
    if (removed) await this.save();
    return removed;
  }

  save(): Promise<void> {
    const next = this.writing.catch(() => {}).then(() => this.writeNow());
    this.writing = next;
    return next;
  }

  private async writeNow(): Promise<void> {
    const payload: RegistryFile = { version: FILE_VERSION, servers: this.list() };
    const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(payload, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
