import type { FastifyInstance, FastifyRequest } from 'fastify';
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
} from '../../servers/files.js';
import { adminFileRoots, findAdminRoot, folderUsage, volumeLabels, applyVolumeLabels } from '../../admin/file-roots.js';
import { HttpError, requireAdmin, requireGlobalPermission } from '../auth.js';
import { writeAudit } from '../../audit.js';
import {
  listFilesQuery,
  fileContentQuery,
  fileContentBody,
  createDirBody,
  renameBody,
  deleteFileBody,
  compressBody,
  decompressBody,
  wrapFileErrors,
} from './files.js';

/**
 * Admin-Dateimanager: Zugriff auf die Ordner des Panels auf der VM
 * (Spieldaten aller Server, Backups, NAS). Nur fuer Administratoren,
 * jede aendernde Aktion landet im Audit-Log. Gleiche Pfadpruefung wie beim
 * Server-Dateimanager - kein Ausbruch aus dem gewaehlten Ordner.
 */
type RootReq = FastifyRequest<{ Params: { root: string } }>;

function rootOf(req: RootReq, requireWrite = false): { root: string } {
  const r = findAdminRoot(req.params.root);
  if (!r) throw new HttpError(404, 'Ordner nicht gefunden', 'not_found');
  if (!r.available) throw new HttpError(404, `${r.label} ist nicht eingebunden (${r.path})`, 'not_mounted');
  if (requireWrite && r.readOnly) throw new HttpError(403, `${r.label} ist schreibgeschützt (read-only)`, 'read_only');
  return { root: r.path };
}

async function audit(req: RootReq, action: string, metadata: Record<string, unknown>) {
  await writeAudit({
    action,
    userId: req.actor!.id,
    actorName: req.actor!.username,
    ip: req.ip,
    metadata: { root: req.params.root, ...metadata },
  });
}

export async function adminFileRoutes(app: FastifyInstance) {
  const admin = { preHandler: requireGlobalPermission('admin.files') };

  app.get('/admin/files', admin, async () => ({
    roots: adminFileRoots().map((r) => ({ id: r.id, label: r.label, path: r.path, available: r.available, readOnly: Boolean(r.readOnly) })),
  }));

  app.get<{ Params: { root: string }; Querystring: { path?: string } }>('/admin/files/:root', admin, async (req) => {
    const q = listFilesQuery.parse(req.query);
    try {
      const root = rootOf(req);
      const res = await listDirectory(root, q.path);
      const labels = await volumeLabels(root.root, q.path);
      // Server-Ordner (Kurz-ID) mit Servername beschriften
      return { ...res, entries: applyVolumeLabels(res.entries, labels) };
    } catch (err) { wrapFileErrors(err); }
  });

  app.get<{ Params: { root: string }; Querystring: { path?: string } }>('/admin/files/:root/usage', admin, async (req) => {
    const q = listFilesQuery.parse(req.query);
    try {
      const root = rootOf(req).root;
      const res = await folderUsage(root, q.path);
      const labels = await volumeLabels(root, q.path);
      return { ...res, entries: applyVolumeLabels(res.entries, labels) };
    } catch (err) { wrapFileErrors(err); }
  });

  app.get<{ Params: { root: string }; Querystring: { path: string } }>('/admin/files/:root/content', admin, async (req) => {
    const q = fileContentQuery.parse(req.query);
    try {
      const { content, size } = await readFileContent(rootOf(req), q.path);
      return { path: q.path, content, size };
    } catch (err) { wrapFileErrors(err); }
  });

  app.put<{ Params: { root: string }; Body: { path: string; content: string } }>('/admin/files/:root/content', admin, async (req) => {
    const body = fileContentBody.parse(req.body);
    try {
      await writeFileContent(rootOf(req, true), body.path, body.content);
      await audit(req, 'admin.file.edit', { path: body.path });
      return { ok: true, path: body.path };
    } catch (err) { wrapFileErrors(err); }
  });

  app.post<{ Params: { root: string }; Body: { path: string } }>('/admin/files/:root/directory', admin, async (req) => {
    const body = createDirBody.parse(req.body);
    try {
      await createDirectory(rootOf(req, true), body.path);
      await audit(req, 'admin.file.mkdir', { path: body.path });
      return { ok: true, path: body.path };
    } catch (err) { wrapFileErrors(err); }
  });

  app.post<{ Params: { root: string }; Body: { from: string; to: string } }>('/admin/files/:root/rename', admin, async (req) => {
    const body = renameBody.parse(req.body);
    try {
      await renamePath(rootOf(req, true), body.from, body.to);
      await audit(req, 'admin.file.rename', { from: body.from, to: body.to });
      return { ok: true };
    } catch (err) { wrapFileErrors(err); }
  });

  app.delete<{ Params: { root: string }; Body: { path: string } }>('/admin/files/:root', admin, async (req) => {
    const body = deleteFileBody.parse(req.body);
    try {
      await deletePath(rootOf(req, true), body.path);
      await audit(req, 'admin.file.delete', { path: body.path });
      return { ok: true };
    } catch (err) { wrapFileErrors(err); }
  });

  app.get<{ Params: { root: string }; Querystring: { path: string } }>('/admin/files/:root/download', admin, async (req, reply) => {
    const q = fileContentQuery.parse(req.query);
    try {
      const { stream, filename, size } = await getDownloadStream(rootOf(req), q.path);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', size);
      return reply.send(stream);
    } catch (err) { wrapFileErrors(err); }
  });

  app.post<{ Params: { root: string }; Querystring: { path?: string } }>('/admin/files/:root/upload', admin, async (req) => {
    const root = rootOf(req, true);
    const part = await req.file();
    if (!part) throw new HttpError(400, 'Keine Datei übertragen', 'no_file');
    const safeFilename = basename(part.filename).replace(/[\0\r\n]/g, '');
    if (!safeFilename) throw new HttpError(400, 'Ungültiger Dateiname', 'invalid_name');
    const targetDir = (req.query?.path || '').replace(/^\/+/, '');
    const destRel = targetDir ? `${targetDir}/${safeFilename}` : safeFilename;
    let fullPath = '';
    try {
      ({ fullPath } = await safePath(root, destRel));
      await pipeline(part.file, createWriteStream(fullPath));
      if (part.file.truncated) {
        await unlink(fullPath).catch(() => {});
        throw new HttpError(413, 'Datei überschreitet Größenlimit', 'too_large');
      }
      await audit(req, 'admin.file.upload', { path: destRel });
      return { ok: true, path: destRel };
    } catch (err) {
      if (fullPath) await unlink(fullPath).catch(() => {});
      wrapFileErrors(err);
    }
  });

  app.post<{ Params: { root: string }; Body: { paths: string[]; destination: string } }>('/admin/files/:root/compress', admin, async (req) => {
    const body = compressBody.parse(req.body);
    try {
      const result = await compressToZip(rootOf(req, true), body.paths, body.destination);
      await audit(req, 'admin.file.compress', { paths: body.paths, destination: body.destination });
      return { ok: true, ...result };
    } catch (err) { wrapFileErrors(err); }
  });

  app.post<{ Params: { root: string }; Body: { path: string; destination?: string } }>('/admin/files/:root/decompress', admin, async (req) => {
    const body = decompressBody.parse(req.body);
    try {
      const result = await decompressArchive(rootOf(req, true), body.path, body.destination);
      await audit(req, 'admin.file.decompress', { path: body.path });
      return { ok: true, ...result };
    } catch (err) { wrapFileErrors(err); }
  });
}
