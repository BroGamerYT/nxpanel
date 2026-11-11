import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import {
  createDirectory,
  deletePath,
  listDirectory,
  openDownload,
  readFileContent,
  renamePath,
  resolveEntry,
  resolveUploadTarget,
  writeFileContent,
} from '../../files/files.js';
import { createZip, extractArchive } from '../../files/archive.js';
import { ORPHAN_LABEL, adminFileRoots, applyLabels, findAdminRoot, folderUsage, serverFolderLabels } from '../../admin/file-roots.js';
import type { ServerRegistry } from '../../store/registry.js';
import { compressBody, contentBody, decompressBody, fail, pathBody, pathQuery, renameBody, requiredPathQuery, sendFileError } from './files.js';

/**
 * Admin-Dateimanager: die Ordner des Cores auf diesem Rechner (Spieldaten aller
 * Server, Backups). Dieselben Routen wie im Panel; jede aendernde Aktion
 * landet im Audit-Log. Gleiche Pfadpruefung wie beim Server-Dateimanager -
 * kein Ausbruch aus dem gewaehlten Ordner.
 */

type P = { Params: { root: string } };
type Q = P & { Querystring: { path?: string } };
type RootReq = FastifyRequest<P>;

const isTop = (p: string | undefined) => (p ?? '').replace(/^[\\/]+|[\\/]+$/g, '') === '';

export function registerAdminFileRoutes(server: FastifyInstance, deps: { registry: ServerRegistry }): void {
  const { registry } = deps;

  /** Ordner zur Anfrage; bei Fehler ist die Antwort schon gesendet (null). */
  function rootOf(req: RootReq, reply: FastifyReply, write = false): string | null {
    const r = findAdminRoot(registry, req.params.root);
    if (!r) {
      fail(reply, 404, 'Ordner nicht gefunden', 'not_found');
      return null;
    }
    if (!r.available) {
      fail(reply, 404, `${r.label} ist nicht vorhanden (${r.path})`, 'not_mounted');
      return null;
    }
    if (write && r.readOnly) {
      fail(reply, 403, `${r.label} ist schreibgeschützt`, 'read_only');
      return null;
    }
    return r.path;
  }

  const audit = (req: RootReq, action: string, detail: Record<string, unknown>) =>
    registry.audit(action, null, 'standalone', { root: req.params.root, ...detail });

  const invalid = (reply: FastifyReply, message: string | undefined) => fail(reply, 400, message ?? 'Ungültige Anfrage', 'invalid_request');
  const base = '/api/v1/admin/files';

  server.get(base, async () => ({
    roots: adminFileRoots(registry).map((r) => ({ id: r.id, label: r.label, path: r.path, available: r.available, readOnly: r.readOnly })),
  }));

  server.get<Q>(`${base}/:root`, async (req, reply) => {
    const root = rootOf(req, reply);
    if (!root) return reply;
    try {
      const res = await listDirectory(root, pathQuery.parse(req.query).path);
      const r = findAdminRoot(registry, req.params.root)!;
      const labels = serverFolderLabels(registry, r, req.query.path ?? '');
      return { ...res, entries: applyLabels(res.entries, labels, r.id === 'spieldaten' && isTop(req.query.path)) };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.get<Q>(`${base}/:root/usage`, async (req, reply) => {
    const root = rootOf(req, reply);
    if (!root) return reply;
    try {
      const res = await folderUsage(root, pathQuery.parse(req.query).path);
      const r = findAdminRoot(registry, req.params.root)!;
      const labels = serverFolderLabels(registry, r, res.path);
      const label = r.id === 'spieldaten' && res.path === '';
      const entries = res.entries.map((e) => {
        if (!label) return e;
        return labels[e.name] ? { ...e, label: labels[e.name] } : { ...e, label: ORPHAN_LABEL, orphan: true };
      });
      return { ...res, entries };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.get<Q>(`${base}/:root/content`, async (req, reply) => {
    const root = rootOf(req, reply);
    if (!root) return reply;
    const q = requiredPathQuery.safeParse(req.query);
    if (!q.success) return invalid(reply, q.error.issues[0]?.message);
    try {
      const { content, size } = await readFileContent(root, q.data.path);
      return { path: q.data.path, content, size };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.put<P & { Body: unknown }>(`${base}/:root/content`, { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    const body = contentBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    try {
      await writeFileContent(root, body.data.path, body.data.content);
      audit(req, 'admin.file.edit', { path: body.data.path });
      return { ok: true, path: body.data.path };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.post<P & { Body: unknown }>(`${base}/:root/directory`, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    const body = pathBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    try {
      await createDirectory(root, body.data.path);
      audit(req, 'admin.file.mkdir', { path: body.data.path });
      return { ok: true, path: body.data.path };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.post<P & { Body: unknown }>(`${base}/:root/rename`, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    const body = renameBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    try {
      await renamePath(root, body.data.from, body.data.to);
      audit(req, 'admin.file.rename', { from: body.data.from, to: body.data.to });
      return { ok: true };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.delete<P & { Body: unknown }>(`${base}/:root`, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    const body = pathBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    try {
      await deletePath(root, body.data.path);
      audit(req, 'admin.file.delete', { path: body.data.path });
      return { ok: true };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.get<Q>(`${base}/:root/download`, async (req, reply) => {
    const root = rootOf(req, reply);
    if (!root) return reply;
    const q = requiredPathQuery.safeParse(req.query);
    if (!q.success) return invalid(reply, q.error.issues[0]?.message);
    try {
      const { stream, filename, size } = await openDownload(root, q.data.path);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      reply.header('Content-Type', 'application/octet-stream');
      reply.header('Content-Length', size);
      return reply.send(stream);
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.post<Q>(`${base}/:root/upload`, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    let part;
    try {
      part = await req.file();
    } catch (err) {
      return sendFileError(reply, err);
    }
    if (!part) return fail(reply, 400, 'Keine Datei übertragen', 'no_file');
    let destination: string;
    try {
      destination = await resolveUploadTarget(root, req.query?.path ?? '', part.filename);
    } catch (err) {
      part.file.resume();
      return sendFileError(reply, err);
    }
    // Erst in eine Temp-Datei: ein abgebrochener Upload hinterlaesst keine halbe Datei
    const temp = `${destination}.upload-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await pipeline(part.file, createWriteStream(temp));
      if (part.file.truncated) throw Object.assign(new Error('zu gross'), { statusCode: 413 });
      await rename(temp, destination);
    } catch (err) {
      await rm(temp, { force: true }).catch(() => {});
      return sendFileError(reply, err);
    }
    const uploaded = destination.slice(root.length + 1).replace(/\\/g, '/');
    audit(req, 'admin.file.upload', { path: uploaded });
    return { ok: true, path: uploaded };
  });

  server.post<P & { Body: unknown }>(`${base}/:root/compress`, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    const body = compressBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    try {
      const result = await createZip(root, body.data.paths, body.data.destination);
      audit(req, 'admin.file.compress', { destination: result.path, files: body.data.paths.length });
      return { ok: true, ...result };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });

  server.post<P & { Body: unknown }>(`${base}/:root/decompress`, async (req, reply) => {
    const root = rootOf(req, reply, true);
    if (!root) return reply;
    const body = decompressBody.safeParse(req.body);
    if (!body.success) return invalid(reply, body.error.issues[0]?.message);
    try {
      const archive = await resolveEntry(root, body.data.path);
      const dest = await resolveEntry(root, body.data.destination);
      const info = await stat(archive).catch(() => null);
      if (!info?.isFile()) return fail(reply, 404, `Archiv „${body.data.path}“ existiert nicht`, 'not_found');
      await mkdir(dest, { recursive: true });
      const result = await extractArchive(archive, dest);
      audit(req, 'admin.file.decompress', { path: body.data.path, files: result.filesCount, skipped: result.skipped });
      return { ok: true, ...result };
    } catch (err) {
      return sendFileError(reply, err);
    }
  });
}
