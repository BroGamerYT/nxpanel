import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createWriteStream } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sql } from '../../db/index.js';
import { writeEvent } from '../../events.js';
import { writeAudit } from '../../audit.js';
import { log } from '../../log.js';
import { STOPPED_STATES } from '../../servers/create.js';
import { setStatus } from '../../servers/status.js';
import { diskCollector } from '../../servers/stats.js';
import { importArchive, listImportFiles, IMPORT_ROOT, type ImportRule } from '../../servers/importer.js';
import { analyzeArchive, type DetectSpec, type EggForDetect } from '../../servers/detect.js';
import { canCreateServer } from '../../auth/permissions.js';
import { HttpError, requireAuth, requireServer } from '../auth.js';
import type { AuthContext } from '../../auth/users.js';

/**
 * Daten aus einem Backup uebernehmen - etwa ein AMP-Backup (.zip).
 * Zwei Wege, weil Groessen sehr verschieden sind:
 *   Hochladen im Browser - bequem fuer TeamSpeak oder Minecraft (MB bis wenige GB)
 *   Import-Ordner        - fuer 15 GB ARK besser per WinSCP/scp nach
 *                          /var/lib/panel/imports kopieren und hier auswaehlen
 */
const ruleSchema = z.array(z.object({
  match: z.string().min(1).max(200),
  to: z.string().min(1).max(200),
  exclude: z.array(z.string().max(100)).max(20).optional(),
})).max(50);

export const importBody = z.object({ file: z.string().min(1).max(255) });
export const analyzeBody = importBody;

/**
 * Wem gehoert eine Datei im Import-Ordner? Admins duerfen alles dort nutzen
 * (sie haben es per scp hineinkopiert). Alle anderen nur, was sie selbst
 * hochgeladen haben - sonst koennte jemand mit Anlege-Recht das Backup eines
 * anderen in seinen eigenen Server ziehen.
 */
export function uploadPrefix(userId: string) { return `upload-u${userId.slice(0, 8)}-`; }
export function mayUseImportFile(actor: { id: string; role: string }, name: string) {
  return actor.role === 'admin' || basename(name).startsWith(uploadPrefix(actor.id));
}

/** Pruefen und den echten Pfad liefern - fuer Analyse und Anlegen mit Import. */
export async function resolveImportFile(actor: { id: string; role: string }, file: string): Promise<{ path: string; bytes: number; name: string }> {
  const name = basename(file);
  if (!/\.zip$/i.test(name)) throw new HttpError(400, 'Nur .zip-Archive', 'invalid_input');
  if (!mayUseImportFile(actor, name)) throw new HttpError(404, 'Datei nicht im Import-Ordner', 'not_found');
  const path = join(IMPORT_ROOT, name);
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) throw new HttpError(404, 'Datei nicht im Import-Ordner', 'not_found');
  return { path, bytes: st.size, name };
}

/**
 * Import fuer einen frisch angelegten Server, nach der Installation.
 * Waehrenddessen steht er auf "installing", damit niemand ihn startet.
 */
export async function importAfterCreate(serverId: string, file: { path: string; name: string; removeAfter: boolean }, actorId: string) {
  const [server] = await sql<{ short_id: string; egg_id: string; status: string }[]>`SELECT short_id, egg_id, status FROM servers WHERE id = ${serverId}`;
  if (!server) return;
  if (server.status !== 'offline') {
    await writeEvent({ serverId, kind: 'import_failed', severity: 'error', actorId,
      summary: `Import übersprungen: Server ist nach der Installation "${server.status}". Später unter Einstellungen → Daten übernehmen nachholen.` });
    return;
  }
  const { rules, owner } = await loadRules(server.egg_id);
  await setStatus(serverId, 'installing', { reason: 'Daten aus Backup übernehmen', actorId });
  await writeEvent({ serverId, kind: 'import_start', actorId, summary: `Daten aus ${file.name} werden übernommen` });
  try {
    const r = await importArchive(server.short_id, file.path, rules, owner, (msg) => log.info({ serverId, msg }, 'Import laeuft'));
    const parts = Object.entries(r.matched).map(([k, n]) => `${k}: ${n}`).join(', ');
    await writeEvent({ serverId, kind: 'import_done', actorId, severity: r.files === 0 ? 'warn' : 'info',
      summary: r.files === 0 ? 'Import: nichts Passendes gefunden' : `Import fertig: ${r.files} Dateien, ${(r.bytes / 1024 / 1024).toFixed(0)} MB (${parts})`,
      payload: { ...r } });
    if (file.removeAfter) await unlink(file.path).catch(() => {});
    void diskCollector.measure(serverId, server.short_id).catch(() => {});
  } catch (err) {
    log.error({ err, serverId }, 'Import nach Anlegen fehlgeschlagen');
    await writeEvent({ serverId, kind: 'import_failed', severity: 'error', actorId,
      summary: `Import fehlgeschlagen: ${err instanceof Error ? err.message : err}. Die Datei bleibt liegen – unter Einstellungen erneut versuchen.` });
  } finally {
    await setStatus(serverId, 'offline', { reason: 'Import beendet', actorId });
  }
}

async function eggsForDetect(): Promise<EggForDetect[]> {
  const rows = await sql<{ id: string; name: string; rules: unknown; detect: unknown }[]>`
    SELECT id, name, raw_egg->'import'->'rules' AS rules, raw_egg->'import'->'detect' AS detect FROM eggs ORDER BY name`;
  return rows.map((r) => {
    const parsed = ruleSchema.safeParse(r.rules ?? []);
    return { id: r.id, name: r.name, rules: parsed.success ? (parsed.data as ImportRule[]) : [], detect: (r.detect as DetectSpec | null) ?? null };
  });
}

const running = new Set<string>();

export async function loadRules(eggId: string): Promise<{ rules: ImportRule[]; owner: string | null; notes: string | null }> {
  const [egg] = await sql<{ rules: unknown; run_as: string | null; notes: string | null }[]>`
    SELECT raw_egg->'import'->'rules' AS rules, run_as, raw_egg->'import'->>'notes' AS notes FROM eggs WHERE id = ${eggId}`;
  const parsed = ruleSchema.safeParse(egg?.rules ?? []);
  return { rules: parsed.success ? (parsed.data as ImportRule[]) : [], owner: egg?.run_as ?? null, notes: egg?.notes ?? null };
}

export async function importRoutes(app: FastifyInstance) {
  const creator = (actor: AuthContext) => {
    if (!canCreateServer(actor)) throw new HttpError(403, 'Fehlendes Recht: server.create', 'forbidden');
  };

  /** Archive, die man fuer einen neuen Server nehmen darf. */
  app.get('/imports', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    creator(actor);
    const files = (await listImportFiles()).filter((f) => mayUseImportFile(actor, f.name));
    return { folder: actor.role === 'admin' ? IMPORT_ROOT : null, files };
  });

  /** Backup hochladen, ohne schon einen Server zu haben. Danach analysieren. */
  app.post('/imports/upload', { preHandler: requireAuth }, async (req, reply) => {
    const actor = req.actor!;
    creator(actor);
    const part = await req.file();
    if (!part) throw new HttpError(400, 'Keine Datei', 'invalid_input');
    if (!/\.zip$/i.test(part.filename)) throw new HttpError(400, 'Nur .zip-Archive (z. B. AMP-Backups)', 'invalid_input');
    await mkdir(IMPORT_ROOT, { recursive: true });
    const clean = basename(part.filename).replace(/[^\w.\-]+/g, '_').slice(0, 80);
    const name = `${uploadPrefix(actor.id)}${Date.now()}-${clean}`;
    const path = join(IMPORT_ROOT, name);
    try {
      await pipeline(part.file, createWriteStream(path));
      if (part.file.truncated) throw new HttpError(413, 'Datei zu gross', 'too_large');
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err;
    }
    const st = await stat(path);
    reply.code(201);
    return { file: name, bytes: st.size };
  });

  /** Was steckt im Backup? Spiel, Version, Einstellungen. */
  app.post('/imports/analyze', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    creator(actor);
    const { file } = analyzeBody.parse(req.body);
    const f = await resolveImportFile(actor, file);
    try {
      return { file: f.name, bytes: f.bytes, ...(await analyzeArchive(f.path, await eggsForDetect())) };
    } catch (err) {
      throw new HttpError(422, `Archiv nicht lesbar: ${err instanceof Error ? err.message : err}`, 'bad_archive');
    }
  });

  /** Eigenen Upload wieder wegwerfen (Abbruch im Dialog). */
  app.delete<{ Params: { file: string } }>('/imports/:file', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    const name = basename(req.params.file);
    // Auch Admins loeschen hier nur Hochgeladenes - per scp abgelegte Dateien bleiben.
    if (!name.startsWith('upload-u') || !mayUseImportFile(actor, name)) throw new HttpError(404, 'Datei nicht gefunden', 'not_found');
    await unlink(join(IMPORT_ROOT, name)).catch(() => {});
    return { ok: true };
  });

  // Nur Besitzer und Admin: ein Import ersetzt Spielstaende.
  const guard = (actor: { role: string; id: string }, ownerId: string) => {
    if (actor.role !== 'admin' && actor.id !== ownerId) throw new HttpError(403, 'Importieren duerfen nur Admin und Besitzer', 'forbidden');
  };

  app.get<{ Params: { id: string } }>('/servers/:id/import', { preHandler: requireServer() }, async (req) => {
    const { server } = req.target!;
    guard(req.actor!, server.owner_id);
    const { rules, notes } = await loadRules(server.egg_id);
    return {
      supported: rules.length > 0,
      looksFor: rules.map((r) => r.match),
      notes,
      folder: IMPORT_ROOT,
      files: (await listImportFiles()).filter((f) => mayUseImportFile(req.actor!, f.name)),
      running: running.has(server.id),
    };
  });

  async function start(serverId: string, shortId: string, eggId: string, status: string, file: string, actor: { id: string; username: string }, ip: string, removeAfter: boolean) {
    if (!(STOPPED_STATES as readonly string[]).includes(status)) throw new HttpError(409, `Server ist "${status}" - erst stoppen`, 'must_stop');
    if (running.has(serverId)) throw new HttpError(409, 'Es laeuft schon ein Import', 'conflict');
    const { rules, owner } = await loadRules(eggId);
    if (!rules.length) throw new HttpError(400, 'Fuer dieses Spiel gibt es noch keine Import-Regeln', 'unsupported');

    const path = join(IMPORT_ROOT, basename(file));
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new HttpError(404, 'Datei nicht im Import-Ordner', 'not_found');

    running.add(serverId);
    await writeAudit({ userId: actor.id, serverId, actorName: actor.username, action: 'server.import', ip, metadata: { file: basename(file), bytes: st.size } });
    await writeEvent({ serverId, kind: 'import_start', actorId: actor.id, summary: `Import aus ${basename(file)} gestartet (${(st.size / 1024 / 1024).toFixed(0)} MB)` });

    void importArchive(shortId, path, rules, owner, (msg) => log.info({ serverId, msg }, 'Import laeuft'))
      .then(async (r) => {
        const parts = Object.entries(r.matched).map(([k, n]) => `${k}: ${n}`).join(', ');
        await writeEvent({
          serverId, kind: 'import_done', actorId: actor.id,
          severity: r.files === 0 ? 'warn' : 'info',
          summary: r.files === 0
            ? `Import: nichts Passendes gefunden (gesucht: ${rules.map((x) => x.match).join(', ')})`
            : `Import fertig: ${r.files} Dateien, ${(r.bytes / 1024 / 1024).toFixed(0)} MB (${parts})${r.backupDir ? ' - vorherige Daten liegen in .panel/' : ''}`,
          payload: { ...r },
        });
        if (removeAfter) await unlink(path).catch(() => {});
        void diskCollector.measure(serverId, shortId).catch(() => {});
      })
      .catch(async (err: unknown) => {
        log.error({ err, serverId }, 'Import fehlgeschlagen');
        await writeEvent({ serverId, kind: 'import_failed', severity: 'error', actorId: actor.id, summary: `Import fehlgeschlagen: ${err instanceof Error ? err.message : err}` });
      })
      .finally(() => running.delete(serverId));
  }

  app.post<{ Params: { id: string } }>('/servers/:id/import', { preHandler: requireServer() }, async (req, reply) => {
    const { server } = req.target!;
    guard(req.actor!, server.owner_id);
    const { file } = importBody.parse(req.body);
    if (!mayUseImportFile(req.actor!, file)) throw new HttpError(404, 'Datei nicht im Import-Ordner', 'not_found');
    await start(server.id, server.short_id, server.egg_id, server.status, file, req.actor!, req.ip, false);
    reply.code(202);
    return { accepted: true };
  });

  /** Hochladen und gleich importieren. Die Datei wird danach geloescht. */
  app.post<{ Params: { id: string } }>('/servers/:id/import/upload', { preHandler: requireServer() }, async (req, reply) => {
    const { server } = req.target!;
    guard(req.actor!, server.owner_id);
    if (!(STOPPED_STATES as readonly string[]).includes(server.status)) throw new HttpError(409, `Server ist "${server.status}" - erst stoppen`, 'must_stop');
    const part = await req.file();
    if (!part) throw new HttpError(400, 'Keine Datei', 'invalid_input');
    if (!/\.zip$/i.test(part.filename)) throw new HttpError(400, 'Nur .zip-Archive (z. B. AMP-Backups)', 'invalid_input');
    await mkdir(IMPORT_ROOT, { recursive: true });
    const name = `upload-${server.short_id}-${Date.now()}.zip`;
    const path = join(IMPORT_ROOT, name);
    try {
      await pipeline(part.file, createWriteStream(path));
      if (part.file.truncated) throw new HttpError(413, 'Datei zu gross', 'too_large');
    } catch (err) {
      await unlink(path).catch(() => {});
      throw err;
    }
    await start(server.id, server.short_id, server.egg_id, server.status, name, req.actor!, req.ip, true);
    reply.code(202);
    return { accepted: true };
  });
}
