import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstanceConfig } from '../types.js';

interface RegistryFile {
  version: number;
  servers: ServerInstanceConfig[];
}

const FILE_VERSION = 1;

/**
 * Persistenz der registrierten Server.
 *
 * Die Datei wird atomar geschrieben (Temp-Datei + Rename), damit ein Absturz
 * keine halb geschriebene Registry hinterlaesst. Eine beschaedigte Datei ist
 * kein Grund fuer einen Startabbruch - der Core startet dann mit leerer
 * Registry und meldet das im Log.
 */
export class ServerRegistry {
  private servers = new Map<string, ServerInstanceConfig>();

  private constructor(
    readonly dir: string,
    readonly file: string,
  ) {}

  static async open(dir: string): Promise<ServerRegistry> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'servers.json');
    const registry = new ServerRegistry(dir, file);

    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed && Array.isArray(parsed.servers)) {
        for (const server of parsed.servers) {
          if (server && typeof server.id === 'string') {
            registry.servers.set(server.id, server);
          }
        }
      }
    } catch {
      // Keine oder beschaedigte Datei: mit leerer Registry weiterarbeiten.
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

  async save(): Promise<void> {
    const payload: RegistryFile = { version: FILE_VERSION, servers: this.list() };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}
