import type { FastifyInstance, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import {
  FileAccessError,
  createDirectory,
  deletePath,
  listDirectory,
  openDownload,
  readFileContent,
  renamePath,
  resolveUploadTarget,
  writeFileContent,
} from '../../files/files.js';
import { resolveInstanceDir } from '../../files/instance-dir.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig } from '../../types.js';

/**
 * Dateien eines Servers (Block B4) - dieselben Routen und Antworten wie im Panel,
 * damit der Dateimanager der Oberflaeche unveraendert funktioniert.
 */

export interface FileRouteDeps {
  registry: ServerRegistry;
  /** Sucht einen Server nach exakter ID oder 8-stelliger Kurz-ID. */
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
}

/** Pflichtangabe mit lesbarer Meldung - sonst sagt zod bei einem fehlenden Feld nur "Required". */
const required = (message: string) => z.string({ required_error: message, invalid_type_error: message }).min(1, message);

const pathQuery = z.object({ path: z.string().optional().default('') });
const requiredPathQuery = z.object({ path: required('Pfad darf nicht leer sein') });
const contentBody = z.object({
  path: required('Pfad darf nicht leer sein'),
  content: z.string({ required_error: 'Inhalt fehlt', invalid_type_error: 'Inhalt muss Text sein' }),
});
const pathBody = z.object({ path: required('Pfad darf nicht leer sein') });
const renameBody = z.object({
  from: required('Ursprungspfad darf nicht leer sein'),
  to: required('Zielpfad darf nicht leer sein'),
});

/** Antwort mit "error" (Oberflaeche) und "message" (Upload-Dialog) - beides liest die Oberflaeche. */
function fail(reply: FastifyReply, status: number, message: string, code: string): FastifyReply {
  return reply.status(status).send({ error: message, message, code });
}

/** Uebersetzt Fehler des Dateisystems in lesbare Antworten. */
function sendFileError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof FileAccessError) return fail(reply, err.statusCode, err.message, err.code);

  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  const status = (err as { statusCode?: number } | undefined)?.statusCode;
  if (code === 'ENOENT') return fail(reply, 404, 'Datei oder Verzeichnis nicht gefunden', 'not_found');
  if (code === 'EEXIST') return fail(reply, 409, 'Datei oder Verzeichnis existiert bereits', 'conflict');
  if (code === 'ENOTDIR' || code === 'EISDIR') return fail(reply, 400, 'Das ist keine Datei bzw. kein Ordner', 'invalid_path');
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return fail(reply, 409, 'Die Datei ist gesperrt, vermutlich weil der Server sie gerade benutzt', 'locked');
  }
  if (status === 413 || code === 'FST_REQ_FILE_TOO_LARGE') {
    return fail(reply, 413, 'Datei überschreitet das Größenlimit', 'too_large');
  }
  // Fehler des Upload-Moduls (kaputte Anfrage, zu viele Teile ...) sind Fehler des Absenders.
  if (typeof status === 'number' && status >= 400 && status < 500 && err instanceof Error) {
    return fail(reply, status, err.message, 'bad_request');
  }
  throw err;
}

export function registerFileRoutes(server: FastifyInstance, deps: FileRouteDeps): void {
  const { registry, find } = deps;

  /**
   * Der Ordner eines Servers - nur, wenn er echt UNTER dem Server-Verzeichnis liegt.
   *
   * Instanzen, die ausserhalb liegen (z. B. die Testinstanz im Projektordner)
   * oder deren Ordner das Server-Verzeichnis selbst ist, bekommen keinen
   * Dateizugriff: sonst waeren fremde Dateien oder die Ordner anderer Server
   * erreichbar (Konzept Abschnitt 3.3).
   */
  async function rootOf(instance: ServerInstanceConfig): Promise<string> {
    const dir = await resolveInstanceDir(registry, instance);
    if (!dir) {
      throw new FileAccessError(
        'Dieser Server liegt nicht in einem eigenen Ordner unter dem Server-Verzeichnis - Dateizugriff gesperrt.',
        'forbidden',
        403,
      );
    }
    return dir;
  }

  /** Server und Ordner zu einer Anfrage; bei Fehler ist die Antwort schon gesendet (null). */
  async function target(
    id: string,
    reply: FastifyReply,
  ): Promise<{ instance: ServerInstanceConfig; root: string } | null> {
    const instance = find(id);
    if (!instance) {
      fail(reply, 404, 'Server nicht gefunden', 'not_found');
      return null;
    }
    try {
      return { instance, root: await rootOf(instance) };
    } catch (err) {
      sendFileError(reply, err);
      return null;
    }
  }

  const base = '/api/v1/servers/:id/files';

  server.get<{ Params: { id: string }; Querystring: { path?: string } }>(base, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    try {
      return await listDirectory(t.root, pathQuery.parse(req.query).path);
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.get<{ Params: { id: string }; Querystring: { path?: string } }>(`${base}/content`, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    const query = requiredPathQuery.safeParse(req.query);
    if (!query.success) return fail(reply, 400, query.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      const { content, size } = await readFileContent(t.root, query.data.path);
      return { path: query.data.path, content, size };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  // Der Editor sendet den ganzen Text: bis zur Groesse, die er oeffnen kann, plus Luft fuer JSON.
  server.put<{ Params: { id: string }; Body: unknown }>(
    `${base}/content`,
    { bodyLimit: 8 * 1024 * 1024 },
    async (req, reply) => {
      const t = await target(req.params.id, reply);
      if (!t) return reply;
      const body = contentBody.safeParse(req.body);
      if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
      try {
        await writeFileContent(t.root, body.data.path, body.data.content);
        registry.audit('file.edit', t.instance.id, 'standalone', { path: body.data.path, bytes: Buffer.byteLength(body.data.content) });
        return { ok: true, path: body.data.path };
      } catch (err) {
        return sendFileError(reply, err);
      }
    },
  );

  server.post<{ Params: { id: string }; Body: unknown }>(`${base}/directory`, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    const body = pathBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      await createDirectory(t.root, body.data.path);
      registry.audit('file.mkdir', t.instance.id, 'standalone', { path: body.data.path });
      return { ok: true, path: body.data.path };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.post<{ Params: { id: string }; Body: unknown }>(`${base}/rename`, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    const body = renameBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      await renamePath(t.root, body.data.from, body.data.to);
      registry.audit('file.rename', t.instance.id, 'standalone', { from: body.data.from, to: body.data.to });
      return { ok: true };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.delete<{ Params: { id: string }; Body: unknown }>(base, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    const body = pathBody.safeParse(req.body);
    if (!body.success) return fail(reply, 400, body.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      await deletePath(t.root, body.data.path);
      registry.audit('file.delete', t.instance.id, 'standalone', { path: body.data.path });
      return { ok: true };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.get<{ Params: { id: string }; Querystring: { path?: string } }>(`${base}/download`, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    const query = requiredPathQuery.safeParse(req.query);
    if (!query.success) return fail(reply, 400, query.error.issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request');
    try {
      const { stream, filename, size } = await openDownload(t.root, query.data.path);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', size);
      return reply.send(stream);
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.post<{ Params: { id: string }; Querystring: { path?: string } }>(`${base}/upload`, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;

    let part;
    try {
      part = await req.file();
    } catch (err) {
      return sendFileError(reply, err);
    }
    if (!part) return fail(reply, 400, 'Keine Datei übertragen', 'no_file');

    let destination: string;
    try {
      destination = await resolveUploadTarget(t.root, req.query?.path ?? '', part.filename);
    } catch (err) {
      // Den Rest der Anfrage verwerfen, sonst bleibt die Verbindung haengen.
      part.file.resume();
      return sendFileError(reply, err);
    }

    // Erst in eine Temp-Datei, dann umbenennen: ein abgebrochener Upload
    // hinterlaesst keine halbe Datei unter dem echten Namen.
    const temp = `${destination}.upload-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await pipeline(part.file, createWriteStream(temp));
      if (part.file.truncated) throw Object.assign(new Error('zu gross'), { statusCode: 413 });
      await rename(temp, destination);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      return sendFileError(reply, err);
    }

    const uploaded = destination.slice(t.root.length + 1).replace(/\\/g, '/');
    registry.audit('file.upload', t.instance.id, 'standalone', { path: uploaded });
    return { ok: true, path: uploaded };
  });

  // Versionsverlauf: den fuehrt der Core noch nicht. Eine leere Liste ist ehrlich
  // und laesst den Dialog der Oberflaeche funktionieren.
  server.get<{ Params: { id: string }; Querystring: { path?: string } }>(`${base}/revisions`, async (req, reply) => {
    const t = await target(req.params.id, reply);
    if (!t) return reply;
    return { ok: true, path: req.query?.path ?? '', revisions: [] };
  });
}
