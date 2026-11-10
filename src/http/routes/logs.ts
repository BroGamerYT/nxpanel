import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readdir, stat, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { basename, join, relative, resolve, sep } from 'node:path';
import { sql } from '../../db/index.js';
import { config } from '../../config.js';
import { tailFile } from '../../servers/logfile.js';
import { HttpError, requireServer } from '../auth.js';

/**
 * Logdateien eines Servers: die Ordner nennt das Egg ("log_dirs"), sonst
 * wird ein Ordner "logs" im Datenordner angenommen. Neueste zuerst - meist
 * will man genau die eine Datei vom letzten Absturz.
 */
const DEFAULT_DIRS = ['logs'];
const LOG_EXT = /\.(log|txt|gz)$/i;

export const logFileQuery = z.object({
  path: z.string().min(1).max(300),
  lines: z.coerce.number().int().min(10).max(20_000).default(2000),
  download: z.enum(['1', 'true']).optional(),
});

async function logDirs(eggId: string): Promise<string[]> {
  const [egg] = await sql<{ dirs: unknown }[]>`SELECT raw_egg->'log_dirs' AS dirs FROM eggs WHERE id = ${eggId}`;
  const dirs = Array.isArray(egg?.dirs) ? (egg!.dirs as unknown[]).filter((d): d is string => typeof d === 'string' && d.length < 200) : [];
  return dirs.length ? dirs : DEFAULT_DIRS;
}

function inside(base: string, p: string) {
  const full = resolve(base, p.replace(/\\/g, '/').replace(/^\/+/, ''));
  return full.startsWith(base + sep) ? full : null;
}

export async function listLogs(shortId: string, dirs: string[]) {
  const base = resolve(config.VOLUME_ROOT, shortId);
  const out: Array<{ path: string; name: string; bytes: number; modified: Date }> = [];

  const installLogPath = join(base, '.panel', 'install.log');
  const installSt = await stat(installLogPath).catch(() => null);
  if (installSt?.isFile()) {
    out.push({ path: '.panel/install.log', name: 'install.log (Installation)', bytes: installSt.size, modified: installSt.mtime });
  }

  for (const d of dirs) {
    const dir = inside(base, d);
    if (!dir) continue;
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!LOG_EXT.test(name)) continue;
      const st = await stat(join(dir, name)).catch(() => null);
      if (!st?.isFile()) continue;
      out.push({ path: relative(base, join(dir, name)).split(sep).join('/'), name, bytes: st.size, modified: st.mtime });
    }
  }
  return out.sort((a, b) => b.modified.getTime() - a.modified.getTime()).slice(0, 200);
}

export async function logRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/servers/:id/logs', { preHandler: requireServer('control.console') }, async (req) => {
    const { server } = req.target!;
    return { files: await listLogs(server.short_id, await logDirs(server.egg_id)) };
  });

  app.get<{ Params: { id: string } }>('/servers/:id/logs/file', { preHandler: requireServer('control.console') }, async (req, reply) => {
    const { server } = req.target!;
    const q = logFileQuery.parse(req.query);
    const dirs = await logDirs(server.egg_id);
    const base = resolve(config.VOLUME_ROOT, server.short_id);
    const full = inside(base, q.path);
    // Nur Dateien aus den Log-Ordnern oder das eigene Installationsprotokoll
    const isInstallLog = full === join(base, '.panel', 'install.log');
    const allowed = full && (isInstallLog || (dirs.some((d) => { const dir = inside(base, d); return dir && full.startsWith(dir + sep); }) && LOG_EXT.test(full)));
    if (!full || !allowed) throw new HttpError(404, 'Logdatei nicht gefunden', 'not_found');
    const st = await stat(full).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'Logdatei nicht gefunden', 'not_found');

    if (q.download) {
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Disposition', `attachment; filename="${basename(full).replace(/"/g, '')}"`);
      return reply.send(createReadStream(full));
    }
    let lines: string[];
    if (/\.gz$/i.test(full)) {
      if (st.size > 20 * 1024 * 1024) throw new HttpError(413, 'Archiv zu gross fuer die Anzeige - herunterladen', 'too_large');
      lines = gunzipSync(await readFile(full)).toString('utf8').split(/\r?\n/).filter((l) => l.length).slice(-q.lines);
    } else {
      lines = await tailFile(full, q.lines, 4 * 1024 * 1024);
    }
    return { path: q.path, bytes: st.size, modified: st.mtime, lines, truncated: lines.length >= q.lines };
  });
}
