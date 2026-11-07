import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { basename } from 'node:path';
import {
  listDirectory,
  readFileContent,
  writeFileContent,
  createDirectory,
  renamePath,
  deletePath,
  getDownloadStream,
  compressToZip,
  decompressArchive,
  safePath,
  FilePathSecurityError,
} from '../../servers/files.js';
import {
  saveRevision,
  listRevisions,
  getRevision,
  rollbackRevision,
} from '../../servers/revisions.js';
import { HttpError, requireServer } from '../auth.js';
import { writeAudit } from '../../audit.js';

export const listFilesQuery = z.object({
  path: z.string().optional().default(''),
});

export const fileContentQuery = z.object({
  path: z.string().min(1, 'Pfad darf nicht leer sein'),
});

export const fileContentBody = z.object({
  path: z.string().min(1, 'Pfad darf nicht leer sein'),
  content: z.string(),
});

export const createDirBody = z.object({
  path: z.string().min(1, 'Pfad darf nicht leer sein'),
});

export const renameBody = z.object({
  from: z.string().min(1, 'Ursprungspfad darf nicht leer sein'),
  to: z.string().min(1, 'Zielpfad darf nicht leer sein'),
});

export const deleteFileBody = z.object({
  path: z.string().min(1, 'Pfad darf nicht leer sein'),
});

export const compressBody = z.object({
  paths: z.array(z.string().min(1)).min(1, 'Mindestens eine Datei erforderlich'),
  destination: z.string().min(1, 'Zielarchivname erforderlich'),
});

export const decompressBody = z.object({
  path: z.string().min(1, 'Archivpfad erforderlich'),
  destination: z.string().optional().default(''),
});

function wrapFileErrors(err: unknown): never {
  if (err instanceof FilePathSecurityError) {
    throw new HttpError(400, err.message, 'invalid_path');
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code;
    if (code === 'ENOENT') {
      throw new HttpError(404, 'Datei oder Verzeichnis nicht gefunden', 'not_found');
    }
    if (code === 'EEXIST') {
      throw new HttpError(409, 'Datei oder Verzeichnis existiert bereits', 'conflict');
    }
  }
  if (err instanceof HttpError) throw err;
  throw new HttpError(400, err instanceof Error ? err.message : String(err), 'file_error');
}

export async function fileRoutes(app: FastifyInstance) {
  /** Ordnerinhalt auflisten */
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/servers/:id/files',
    { preHandler: requireServer('file.read') },
    async (req) => {
      const { server } = req.target!;
      const q = listFilesQuery.parse(req.query);
      try {
        return await listDirectory(server.short_id, q.path);
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Dateiinhalt lesen */
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/servers/:id/files/content',
    { preHandler: requireServer('file.read') },
    async (req) => {
      const { server } = req.target!;
      const q = fileContentQuery.parse(req.query);
      try {
        const { content, size } = await readFileContent(server.short_id, q.path);
        return { path: q.path, content, size };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Dateiinhalt speichern */
  app.put<{ Params: { id: string }; Body: { path: string; content: string } }>(
    '/servers/:id/files/content',
    { preHandler: requireServer('file.write') },
    async (req) => {
      const { server } = req.target!;
      const body = fileContentBody.parse(req.body);
      try {
        await writeFileContent(server.short_id, body.path, body.content);
        await saveRevision(server.id, body.path, body.content, req.actor ?? undefined, 'Im Editor gespeichert');
        await writeAudit({
          action: 'file.edit',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { path: body.path },
        });
        return { ok: true, path: body.path };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Neuen Ordner anlegen */
  app.post<{ Params: { id: string }; Body: { path: string } }>(
    '/servers/:id/files/directory',
    { preHandler: requireServer('file.write') },
    async (req) => {
      const { server } = req.target!;
      const body = createDirBody.parse(req.body);
      try {
        await createDirectory(server.short_id, body.path);
        return { ok: true, path: body.path };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Datei oder Ordner umbenennen / verschieben */
  app.post<{ Params: { id: string }; Body: { from: string; to: string } }>(
    '/servers/:id/files/rename',
    { preHandler: requireServer('file.write') },
    async (req) => {
      const { server } = req.target!;
      const body = renameBody.parse(req.body);
      try {
        await renamePath(server.short_id, body.from, body.to);
        return { ok: true };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Datei oder Verzeichnis löschen */
  app.delete<{ Params: { id: string }; Body: { path: string } }>(
    '/servers/:id/files',
    { preHandler: requireServer('file.delete') },
    async (req) => {
      const { server } = req.target!;
      const body = deleteFileBody.parse(req.body);
      try {
        await deletePath(server.short_id, body.path);
        await writeAudit({
          action: 'file.delete',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { path: body.path },
        });
        return { ok: true };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Datei herunterladen */
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/servers/:id/files/download',
    { preHandler: requireServer('file.read') },
    async (req, reply) => {
      const { server } = req.target!;
      const q = fileContentQuery.parse(req.query);
      try {
        const { stream, filename, size } = await getDownloadStream(server.short_id, q.path);
        reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
        reply.header('Content-Type', 'application/octet-stream');
        reply.header('Content-Length', size);
        return reply.send(stream);
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Datei hochladen */
  app.post<{ Params: { id: string }; Querystring: { path?: string } }>(
    '/servers/:id/files/upload',
    { preHandler: requireServer('file.write') },
    async (req) => {
      const { server } = req.target!;
      const targetDir = req.query?.path || '';

      const part = await req.file();
      if (!part) {
        throw new HttpError(400, 'Keine Datei übertragen', 'no_file');
      }

      const safeFilename = basename(part.filename).replace(/[\0\r\n]/g, '');
      if (!safeFilename) {
        throw new HttpError(400, 'Ungültiger Dateiname', 'invalid_name');
      }

      const destRel = targetDir ? `${targetDir.replace(/^\/+/, '')}/${safeFilename}` : safeFilename;
      const { fullPath } = await safePath(server.short_id, destRel);

      try {
        await pipeline(part.file, createWriteStream(fullPath));
        if (part.file.truncated) {
          await unlink(fullPath).catch(() => {});
          throw new HttpError(413, 'Datei überschreitet Größenlimit', 'too_large');
        }

        await writeAudit({
          action: 'file.upload',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { path: destRel },
        });

        return { ok: true, path: destRel };
      } catch (err) {
        await unlink(fullPath).catch(() => {});
        wrapFileErrors(err);
      }
    }
  );

  /** Dateien als Zip packen */
  app.post<{ Params: { id: string }; Body: { paths: string[]; destination: string } }>(
    '/servers/:id/files/compress',
    { preHandler: requireServer('file.archive') },
    async (req) => {
      const { server } = req.target!;
      const body = compressBody.parse(req.body);
      try {
        const result = await compressToZip(server.short_id, body.paths, body.destination);
        return { ok: true, ...result };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Archiv entpacken */
  app.post<{ Params: { id: string }; Body: { path: string; destination?: string } }>(
    '/servers/:id/files/decompress',
    { preHandler: requireServer('file.archive') },
    async (req) => {
      const { server } = req.target!;
      const body = decompressBody.parse(req.body);
      try {
        const result = await decompressArchive(server.short_id, body.path, body.destination);
        return { ok: true, ...result };
      } catch (err) {
        wrapFileErrors(err);
      }
    }
  );

  /** Dateirevisionen / Versionshistorie abfragen */
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/servers/:id/files/revisions',
    { preHandler: requireServer('file.read') },
    async (req) => {
      const { server } = req.target!;
      const q = fileContentQuery.parse(req.query);
      const revisions = await listRevisions(server.id, q.path);
      return { ok: true, path: q.path, revisions };
    }
  );

  /** Einzelne Dateirevision inkl. Inhalt (fuer Diff / Vorschau) abrufen */
  app.get<{ Params: { id: string; revisionId: string } }>(
    '/servers/:id/files/revisions/:revisionId',
    { preHandler: requireServer('file.read') },
    async (req) => {
      const { server } = req.target!;
      try {
        const revision = await getRevision(server.id, req.params.revisionId);
        return { ok: true, revision };
      } catch (err) {
        throw new HttpError(404, err instanceof Error ? err.message : String(err), 'revision_not_found');
      }
    }
  );

  /** Dateirevision wiederherstellen (Rollback) */
  app.post<{ Params: { id: string; revisionId: string } }>(
    '/servers/:id/files/revisions/:revisionId/rollback',
    { preHandler: requireServer('file.write') },
    async (req) => {
      const { server } = req.target!;
      try {
        const res = await rollbackRevision(server.id, server.short_id, req.params.revisionId, req.actor ?? undefined);
        await writeAudit({
          action: 'file.rollback',
          userId: req.actor!.id,
          actorName: req.actor!.username,
          serverId: server.id,
          ip: req.ip,
          metadata: { revisionId: req.params.revisionId, path: res.path },
        });
        return res;
      } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : String(err), 'rollback_error');
      }
    }
  );
}
