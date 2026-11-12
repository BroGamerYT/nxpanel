import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { canCreateServer } from '../../auth/permissions.js';
import { analyzeArchive } from '../../servers/detect.js';
import { ImportService, mayUseImportFile, uploadPrefix } from '../../servers/import-service.js';
import { importRoot, listImportFiles } from '../../servers/importer.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig, ServerState } from '../../types.js';
import { flagsFor, type AccessPolicy, type RequestActor } from '../authz.js';

/**
 * Daten aus einem Backup uebernehmen (etwa ein AMP-Backup als .zip) - dieselben Routen und Antworten wie im Panel.
 * Zwei Wege, weil Groessen sehr verschieden sind: Hochladen im Browser (MB bis wenige GB) oder den Import-Ordner
 * (`<Datenordner>/imports`) per WinSCP/scp fuellen und hier auswaehlen.
 *
 * Ein Import schreibt Dateien in den Server-Ordner: wo das nur Administratoren duerfen (Spiele direkt als Prozess auf dem
 * Rechner), gilt das auch hier. Nur Administratoren und der Besitzer importieren in einen Server - ein Import ersetzt Spielstaende.
 */

const importBody = z.object({ file: z.string().min(1).max(255) });

export interface ImportRouteDeps {
  registry: ServerRegistry;
  imports: ImportService;
  policy: AccessPolicy;
  find: (id: string) => ServerInstanceConfig | undefined;
  stateOf: (id: string) => Promise<ServerState | undefined>;
  isOwnerOf: (serverId: string, actor: NonNullable<FastifyRequest['actor']>) => boolean;
}

export function registerImportRoutes(server: FastifyInstance, deps: ImportRouteDeps): void {
  const { registry, imports, policy, find, stateOf, isOwnerOf } = deps;

  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });

  /** Wer neue Server anlegen darf, darf auch Archive hochladen und ansehen. */
  const creatorOnly = (req: FastifyRequest, reply: FastifyReply): RequestActor | null => {
    const actor = req.actor!;
    if (!canCreateServer(actor)) {
      fail(reply, 403, 'Fehlendes Recht: server.create', 'forbidden');
      return null;
    }
    return actor;
  };

  /** Eine Datei aus dem Import-Ordner: nur .zip, nur eigene (ausser Administratoren), muss es geben. */
  async function resolveFile(actor: RequestActor, file: string): Promise<{ path: string; bytes: number; name: string } | { status: number; message: string; code: string }> {
    const name = path.basename(file);
    if (!/\.zip$/i.test(name)) return { status: 400, message: 'Nur .zip-Archive', code: 'invalid_input' };
    if (!mayUseImportFile(actor, name)) return { status: 404, message: 'Datei nicht im Import-Ordner', code: 'not_found' };
    const full = path.join(importRoot(), name);
    const st = await fs.stat(full).catch(() => null);
    if (!st?.isFile()) return { status: 404, message: 'Datei nicht im Import-Ordner', code: 'not_found' };
    return { path: full, bytes: st.size, name };
  }

  /** Eine hochgeladene Datei sicher ablegen. */
  async function saveUpload(req: FastifyRequest, reply: FastifyReply, nameFor: (clean: string) => string): Promise<{ name: string; bytes: number } | null> {
    const part = await req.file();
    if (!part) {
      fail(reply, 400, 'Keine Datei', 'invalid_input');
      return null;
    }
    if (!/\.zip$/i.test(part.filename)) {
      fail(reply, 400, 'Nur .zip-Archive (z. B. AMP-Backups)', 'invalid_input');
      return null;
    }
    await fs.mkdir(importRoot(), { recursive: true });
    const clean = path.basename(part.filename).replace(/[^\w.-]+/g, '_').slice(0, 80);
    const name = nameFor(clean);
    const full = path.join(importRoot(), name);
    try {
      await pipeline(part.file, createWriteStream(full));
      if (part.file.truncated) throw Object.assign(new Error('Datei zu groß'), { statusCode: 413 });
    } catch (err) {
      await fs.rm(full, { force: true }).catch(() => {});
      if ((err as { statusCode?: number }).statusCode === 413) {
        fail(reply, 413, 'Datei zu gross', 'too_large');
        return null;
      }
      throw err;
    }
    return { name, bytes: (await fs.stat(full)).size };
  }

  /** Gemeinsame Pruefung fuer Import in einen vorhandenen Server. */
  function guard(req: FastifyRequest, reply: FastifyReply): ServerInstanceConfig | null {
    const params = req.params as { id: string };
    const c = find(params.id);
    if (!c) {
      fail(reply, 404, 'Server nicht gefunden', 'not_found');
      return null;
    }
    const actor = req.actor!;
    if (!isOwnerOf(c.id, actor)) {
      fail(reply, 403, 'Importieren dürfen nur Administrator und Besitzer', 'forbidden');
      return null;
    }
    // Wie "Datei schreiben": wo das auf diesem Rechner nur Administratoren duerfen, duerfen sie auch nur importieren
    if (!flagsFor(registry, c.id, actor, policy).includes('file.write')) {
      fail(reply, 403, 'Dateien ändern darf auf diesem Rechner nur ein Administrator: sonst ließen sich damit Programme auf dem PC ausführen.', 'forbidden');
      return null;
    }
    return c;
  }

  async function mustBeStopped(c: ServerInstanceConfig, reply: FastifyReply): Promise<boolean> {
    const state = await stateOf(c.id);
    const stopped = !state || state.status === 'offline' || state.status === 'error';
    if (c.install?.state === 'installing' || !stopped) {
      fail(reply, 409, `Server ist "${c.install?.state === 'installing' ? 'installing' : state?.status}" - erst stoppen`, 'must_stop');
      return false;
    }
    if (imports.isImporting(c.id)) {
      fail(reply, 409, 'Es läuft schon ein Import', 'conflict');
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------- ohne Server

  /** Archive, die man fuer einen neuen Server nehmen darf. */
  server.get('/api/v1/imports', async (req, reply) => {
    const actor = creatorOnly(req, reply);
    if (!actor) return reply;
    const files = (await listImportFiles()).filter((f) => mayUseImportFile(actor, f.name));
    return { folder: actor.role === 'admin' ? importRoot() : null, files };
  });

  /** Backup hochladen, ohne schon einen Server zu haben. Danach analysieren. */
  server.post('/api/v1/imports/upload', async (req, reply) => {
    const actor = creatorOnly(req, reply);
    if (!actor) return reply;
    const saved = await saveUpload(req, reply, (clean) => `${uploadPrefix(actor.id)}${Date.now()}-${clean}`);
    if (!saved) return reply;
    reply.code(201);
    return { file: saved.name, bytes: saved.bytes };
  });

  /** Was steckt im Backup? Spiel, Version, Einstellungen. */
  server.post<{ Body: unknown }>('/api/v1/imports/analyze', async (req, reply) => {
    const actor = creatorOnly(req, reply);
    if (!actor) return reply;
    const body = importBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const f = await resolveFile(actor, body.data.file);
    if ('status' in f) return fail(reply, f.status, f.message, f.code);
    try {
      return { file: f.name, bytes: f.bytes, ...(await analyzeArchive(f.path, await imports.eggsForDetect())) };
    } catch (err) {
      return fail(reply, 422, `Archiv nicht lesbar: ${err instanceof Error ? err.message : String(err)}`, 'bad_archive');
    }
  });

  /** Eigenen Upload wieder wegwerfen (Abbruch im Dialog). */
  server.delete<{ Params: { file: string } }>('/api/v1/imports/:file', async (req, reply) => {
    const actor = req.actor!;
    const name = path.basename(req.params.file);
    // Auch Administratoren loeschen hier nur Hochgeladenes - per scp abgelegte Dateien bleiben
    if (!name.startsWith('upload-u') || !mayUseImportFile(actor, name)) return fail(reply, 404, 'Datei nicht gefunden', 'not_found');
    await fs.rm(path.join(importRoot(), name), { force: true });
    return { ok: true };
  });

  // ------------------------------------------------------- in einen Server

  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/import', async (req, reply) => {
    const c = guard(req, reply);
    if (!c) return reply;
    const { rules, notes } = await imports.loadRules(c.game);
    return {
      supported: rules.length > 0,
      looksFor: rules.map((r) => r.match),
      notes,
      folder: importRoot(),
      files: (await listImportFiles()).filter((f) => mayUseImportFile(req.actor!, f.name)),
      running: imports.isImporting(c.id),
    };
  });

  async function begin(c: ServerInstanceConfig, name: string, reply: FastifyReply, req: FastifyRequest, removeAfter: boolean): Promise<FastifyReply> {
    const { rules } = await imports.loadRules(c.game);
    if (!rules.length) return fail(reply, 400, 'Für dieses Spiel gibt es noch keine Import-Regeln', 'unsupported');
    const f = await resolveFile(req.actor!, name);
    if ('status' in f) return fail(reply, f.status, f.message, f.code);
    if (!imports.start(c.id, { path: f.path, name: f.name, removeAfter }, req.actor!.username)) return fail(reply, 409, 'Es läuft schon ein Import', 'conflict');
    registry.audit('server.import', c.id, 'standalone', { file: f.name, bytes: f.bytes });
    return reply.code(202).send({ accepted: true });
  }

  server.post<{ Params: { id: string }; Body: unknown }>('/api/v1/servers/:id/import', async (req, reply) => {
    const c = guard(req, reply);
    if (!c) return reply;
    const body = importBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    if (!(await mustBeStopped(c, reply))) return reply;
    return begin(c, body.data.file, reply, req, false);
  });

  /** Hochladen und gleich importieren. Die Datei wird danach geloescht. */
  server.post<{ Params: { id: string } }>('/api/v1/servers/:id/import/upload', async (req, reply) => {
    const c = guard(req, reply);
    if (!c) return reply;
    if (!(await mustBeStopped(c, reply))) return reply;
    const saved = await saveUpload(req, reply, () => `upload-${c.id.slice(0, 8)}-${Date.now()}.zip`);
    if (!saved) return reply;
    // Der Name beginnt mit "upload-", aber nicht mit "upload-u<Benutzer>": nur Administratoren und Besitzer kommen bis hierher
    const f = { path: path.join(importRoot(), saved.name), name: saved.name, removeAfter: true };
    const { rules } = await imports.loadRules(c.game);
    if (!rules.length) {
      await fs.rm(f.path, { force: true });
      return fail(reply, 400, 'Für dieses Spiel gibt es noch keine Import-Regeln', 'unsupported');
    }
    if (!imports.start(c.id, f, req.actor!.username)) return fail(reply, 409, 'Es läuft schon ein Import', 'conflict');
    registry.audit('server.import', c.id, 'standalone', { file: saved.name, bytes: saved.bytes });
    return reply.code(202).send({ accepted: true });
  });
}
