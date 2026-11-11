import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { LoadedEgg } from '../../eggs/loader.js';
import { resolveInstanceDir } from '../../files/instance-dir.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';

/**
 * Kleinere Seiten der Oberflaeche: Konfigurationsdateien eines Servers, Server-Icon
 * (Minecraft), Aktivitaetsfeed des Dashboards und der Modpack-Zustand.
 * Dieselben Routen und Antworten wie im Panel.
 */

export interface ExtrasDeps {
  registry: ServerRegistry;
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
  eggs: () => Promise<LoadedEgg[]>;
}

function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

const CONFIG_EXT = /\.(toml|cfg|conf|ini|properties|json|json5|jsonc|yml|yaml|snbt|xml)$/i;
const SKIPPED_FOLDERS = /^(cache|backups?|logs?|tmp|temp|lang|locales?|schematics|assets|textures)$/i;

/** Bekannte Konfigurationsdateien, falls vorhanden - dieselbe Liste wie im Panel plus Windows-Pfade. */
const KNOWN_FILES = [
  'server.properties',
  'bukkit.yml',
  'spigot.yml',
  'paper.yml',
  'purpur.yml',
  'pufferfish.yml',
  'velocity.toml',
  'ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini',
  'ShooterGame/Saved/Config/WindowsServer/Game.ini',
  'Pal/Saved/Config/WindowsServer/PalWorldSettings.ini',
  'server/rust/cfg/server.cfg',
  'enshrouded_server.json',
  'serverconfig.xml',
  'dedicatedserver.cfg',
  'FactoryGame/Saved/Config/WindowsServer/Game.ini',
  'game/dedicatedServer.xml',
  'ts3server.ini',
];

const MOD_FOLDERS: Array<{ folder: string; group: string }> = [
  { folder: 'config', group: 'config' },
  { folder: 'defaultconfigs', group: 'defaultconfigs' },
  { folder: 'world/serverconfig', group: 'serverconfig' },
  { folder: 'BepInEx/config', group: 'BepInEx/config' },
  { folder: 'oxide/config', group: 'oxide/config' },
  { folder: 'carbon/configs', group: 'carbon/configs' },
  { folder: 'plugins', group: 'plugins' },
];

interface ConfigItem {
  path: string;
  name: string;
  exists: boolean;
  group: string;
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    const info = await fs.lstat(file);
    return info.isFile(); // Verknuepfungen zaehlen nicht: sie koennten aus dem Server-Ordner hinauszeigen
  } catch {
    return false;
  }
}

/** Breitensuche in einem Mod-Ordner: Dateien mit Konfigurationsendung, ohne Verknuepfungen. */
async function scanFolder(root: string, relFolder: string, group: string, maxDepth: number, maxFiles: number): Promise<ConfigItem[]> {
  const results: ConfigItem[] = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: relFolder, depth: 1 }];
  while (queue.length > 0 && results.length < maxFiles) {
    const { rel, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIPPED_FOLDERS.test(entry.name)) queue.push({ rel: child, depth: depth + 1 });
      } else if (entry.isFile() && CONFIG_EXT.test(entry.name)) {
        const info = await fs.stat(path.join(root, child)).catch(() => null);
        if (!info || info.size > 2 * 1024 * 1024) continue;
        results.push({ path: child, name: child.slice(relFolder.length + 1), exists: true, group });
      }
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}

/** PNG mit genau 64 x 64 Pixeln - so verlangt es Minecraft, alles andere ignoriert der Server. */
export function isServerIcon(buf: Buffer): boolean {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buf.length > 24 && buf.subarray(0, 8).equals(sig) && buf.readUInt32BE(16) === 64 && buf.readUInt32BE(20) === 64;
}

/** Wie die Oberflaeche das Ereignis nennt: Core-Aktion -> Satz, Schwere. null = nicht im Feed. */
function describe(action: string, detail: Record<string, unknown> | null): { kind: string; severity: 'info' | 'warn' | 'error'; summary: string } | null {
  const named = (what: string) => (typeof detail?.['name'] === 'string' ? `${what}: ${detail['name'] as string}` : what);
  switch (action) {
    case 'server.start': return { kind: 'server_started', severity: 'info', summary: 'Server gestartet' };
    case 'server.stop': return { kind: 'server_stopped', severity: 'info', summary: 'Server gestoppt' };
    case 'server.restart': return { kind: 'server_restarted', severity: 'info', summary: 'Server neu gestartet' };
    case 'server.kill': return { kind: 'server_killed', severity: 'warn', summary: 'Server abgewürgt' };
    case 'server.create': return { kind: 'server_created', severity: 'info', summary: 'Server angelegt' };
    case 'server.delete': return { kind: 'server_deleted', severity: 'warn', summary: 'Server gelöscht' };
    case 'server.install': return { kind: 'install_done', severity: 'info', summary: 'Installation abgeschlossen' };
    case 'server.install_failed': return { kind: 'install_failed', severity: 'error', summary: `Installation fehlgeschlagen${typeof detail?.['error'] === 'string' ? `: ${detail['error'] as string}` : ''}` };
    case 'backup.create': return { kind: 'backup_completed', severity: 'info', summary: named('Backup erstellt') };
    case 'backup.failed': return { kind: 'backup_failed', severity: 'error', summary: `Backup fehlgeschlagen${typeof detail?.['error'] === 'string' ? `: ${detail['error'] as string}` : ''}` };
    case 'backup.restore': return { kind: 'backup_restored', severity: 'info', summary: named('Backup wiederhergestellt') };
    case 'schedule.run': return detail?.['ok'] === false
      ? { kind: 'schedule_failed', severity: 'error', summary: named('Zeitplan fehlgeschlagen') }
      : { kind: 'schedule_run', severity: 'info', summary: named('Zeitplan ausgeführt') };
    case 'schedule.skipped': return { kind: 'schedule_skipped', severity: 'warn', summary: named('Zeitplan übersprungen (Core war aus)') };
    case 'player.kick': return { kind: 'player_kicked', severity: 'info', summary: named('Spieler gekickt') };
    case 'player.ban': return { kind: 'player_banned', severity: 'warn', summary: named('Spieler gebannt') };
    default: return null;
  }
}

export function registerExtraRoutes(server: FastifyInstance, deps: ExtrasDeps): void {
  const { registry, find, eggs } = deps;

  async function dirOf(id: string, reply: FastifyReply): Promise<{ instance: ServerInstanceConfig; dir: string } | null> {
    const instance = find(id);
    if (!instance) {
      fail(reply, 404, 'Server nicht gefunden', 'not_found');
      return null;
    }
    const dir = await resolveInstanceDir(registry, instance);
    if (!dir) {
      fail(reply, 403, 'Dieser Server liegt nicht im Server-Verzeichnis des Cores.', 'forbidden');
      return null;
    }
    return { instance, dir };
  }

  // ------------------------------------------------------------ Konfigurationsdateien

  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/configs', async (req, reply) => {
    const t = await dirOf(req.params.id, reply);
    if (!t) return reply;
    const egg = (await eggs()).find((e) => e.id === t.instance.game);
    const declared = new Set<string>(Object.keys(egg?.raw.config_files ?? {}));
    for (const f of egg?.raw.windows?.files ?? []) declared.add(f.path);
    for (const f of t.instance.install?.steam?.files ?? []) declared.add(f.path);

    const configs: ConfigItem[] = [];
    const seen = new Set<string>();
    for (const rel of new Set([...declared, ...KNOWN_FILES])) {
      const exists = await isRegularFile(path.join(t.dir, rel));
      if (!exists && !declared.has(rel)) continue;
      seen.add(rel);
      configs.push({ path: rel, name: path.basename(rel), exists, group: 'main' });
    }
    for (const { folder, group } of MOD_FOLDERS) {
      for (const item of await scanFolder(t.dir, folder, group, 5, 5000)) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        configs.push(item);
      }
    }
    return { configs };
  });

  // ------------------------------------------------------------ Minecraft-Icon

  const iconBody = z.object({ png: z.string().min(20).max(200_000) });

  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/mc/icon', async (req, reply) => {
    const t = await dirOf(req.params.id, reply);
    if (!t) return reply;
    const file = path.join(t.dir, 'server-icon.png');
    if (!(await isRegularFile(file))) return fail(reply, 404, 'Kein Icon', 'not_found');
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store');
    return reply.send(await fs.readFile(file));
  });

  server.put<{ Params: { id: string }; Body: unknown }>('/api/v1/servers/:id/mc/icon', { bodyLimit: 400_000 }, async (req, reply) => {
    const t = await dirOf(req.params.id, reply);
    if (!t) return reply;
    const body = iconBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Icon fehlt', 'invalid_request');
    const buf = Buffer.from(body.data.png.replace(/^data:image\/png;base64,/, ''), 'base64');
    if (!isServerIcon(buf)) return fail(reply, 400, 'Icon muss ein PNG mit 64x64 Pixeln sein', 'invalid_input');
    const file = path.join(t.dir, 'server-icon.png');
    // Nicht durch eine Verknuepfung schreiben
    if ((await fs.lstat(file).catch(() => null))?.isSymbolicLink()) await fs.rm(file);
    await fs.writeFile(file, buf);
    registry.audit('server.icon', t.instance.id, 'standalone');
    return { ok: true };
  });

  server.delete<{ Params: { id: string } }>('/api/v1/servers/:id/mc/icon', async (req, reply) => {
    const t = await dirOf(req.params.id, reply);
    if (!t) return reply;
    await fs.rm(path.join(t.dir, 'server-icon.png'), { force: true });
    return { ok: true };
  });

  // ------------------------------------------------------------ Modpack und Aktivitaet

  // Modpacks kennt der Core nicht: leerer Zustand statt 404 (die Seite fragt bei jedem Oeffnen).
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/modpack', async (req, reply) => {
    if (!find(req.params.id)) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    return { source: null, pack: null, current: null, job: null, updateAvailable: false };
  });

  server.get('/api/v1/dashboard/activity', async () => {
    const names = new Map(registry.list().map((c) => [c.id, c.name]));
    const items = [];
    for (const row of registry.queryAudit({ limit: 400 })) {
      const info = describe(row.action, row.detail);
      if (!info || !row.serverId) continue;
      const name = names.get(row.serverId) ?? (typeof row.detail?.['name'] === 'string' ? (row.detail['name'] as string) : row.serverId.slice(0, 8));
      items.push({
        id: row.id,
        serverId: row.serverId,
        serverName: name,
        shortId: row.serverId.slice(0, 8),
        ts: row.ts,
        ...info,
        payload: row.detail,
      });
      if (items.length >= 40) break;
    }
    return { items };
  });
}
