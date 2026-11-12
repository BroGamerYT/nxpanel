import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { isAllowedEggUrl, searchEggCatalog, toRawGithubUrl } from '../../eggs/catalog.js';
import { CustomEggError, deleteCustomEgg, saveCustomEgg } from '../../eggs/custom.js';
import { EggImportError, prepareEggImport, type RawEgg } from '../../eggs/import.js';
import { loadEggs } from '../../eggs/loader.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { Fetcher } from '../covers.js';

/**
 * Spiele verwalten (nur Administratoren) - dieselben Routen und Antworten wie im Panel:
 * Katalog durchsuchen, ein Egg aus einer Datei oder von GitHub einspielen, importierte Eggs loeschen.
 *
 * Ein Egg ist Programmcode in Textform (Installationsskript, Startkommando): deshalb nur Administratoren, nur GitHub-JSON-Links,
 * hoechstens 1 MB, und alles geht durch `prepareEggImport` (erlaubte Rechte, harmloser Datenpfad, kein root, kein Windows-Block).
 */

const MAX_EGG_BYTES = 1024 * 1024;

export interface EggAdminDeps {
  registry: ServerRegistry;
  /** Fuer Tests: ersetzt den Download von GitHub. */
  fetchImpl?: Fetcher | undefined;
}

export function registerEggAdminRoutes(server: FastifyInstance, deps: EggAdminDeps): void {
  const { registry } = deps;
  const fetcher: Fetcher = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });

  /** Antwort lesen, aber nie mehr als MAX_EGG_BYTES - ein riesiges "Egg" darf den Core nicht fuellen. */
  async function readLimited(res: Response): Promise<string> {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_EGG_BYTES) throw new Error('Datei zu groß (höchstens 1 MB)');
    const reader = res.body?.getReader();
    if (!reader) return res.text();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_EGG_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('Datei zu groß (höchstens 1 MB)');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /** Online-Katalog aller Eggs durchsuchen (lokaler Katalog + GitHub pelican-eggs). */
  server.get<{ Querystring: { q?: string; category?: string; live?: string } }>('/api/v1/admin/eggs/catalog', async (req) => {
    const q = (req.query.q ?? '').slice(0, 100);
    const category = (req.query.category ?? 'all').slice(0, 40);
    const includeLive = req.query.live === 'true' || q.trim().length >= 2;
    const existingNames = new Set((await loadEggs()).map((e) => e.name));
    return { items: await searchEggCatalog(q, { category, includeLive, existingNames }) };
  });

  /** Egg direkt von einer GitHub-URL herunterladen, aufbereiten und importieren. */
  server.post<{ Body: unknown }>('/api/v1/admin/eggs/import-url', async (req, reply) => {
    const body = z
      .object({ url: z.string().url().max(500), steamId: z.number().int().positive().optional().nullable(), category: z.string().max(60).optional() })
      .safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    if (!isAllowedEggUrl(body.data.url)) return fail(reply, 400, 'Nur GitHub-JSON-Links (github.com / raw.githubusercontent.com) sind erlaubt', 'invalid_url');

    const rawUrl = toRawGithubUrl(body.data.url);
    let json: RawEgg;
    try {
      // redirect: 'error' - ein Link darf uns nicht auf einen anderen Rechner schicken
      const res = await fetcher(rawUrl, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = JSON.parse(await readLimited(res)) as RawEgg;
    } catch (err) {
      return fail(reply, 400, `Download von GitHub fehlgeschlagen: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`, 'download_failed');
    }

    const mapCat: Record<string, string> = { SteamCMD: 'Survival', Standalone: 'Eigenständig', Minecraft: 'Minecraft', Voice: 'Sprachserver', Chatbots: 'Bots & Tools' };
    try {
      const prepared = prepareEggImport(json, { sourceHint: rawUrl, nest: 'Importiert' });
      if (body.data.steamId && !prepared.egg.cover?.steam) prepared.egg.cover = { steam: body.data.steamId };
      if (body.data.category && (!json.nest || prepared.egg.nest === 'Survival')) prepared.egg.nest = mapCat[body.data.category] ?? body.data.category;
      const id = await saveCustomEgg(prepared);
      registry.audit('egg.import_url', null, 'standalone', { name: prepared.name, url: rawUrl });
      reply.code(201);
      return { eggId: id, name: prepared.name, variables: prepared.variables, warnings: prepared.warnings };
    } catch (err) {
      if (err instanceof CustomEggError) return fail(reply, err.statusCode, err.message, err.code);
      if (err instanceof EggImportError) return fail(reply, 400, err.message, 'invalid_egg');
      throw err;
    }
  });

  /** Egg einspielen (Pterodactyl-Format oder eigenes). Body = der Inhalt der JSON-Datei. */
  server.post<{ Body: unknown }>('/api/v1/admin/eggs', async (req, reply) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return fail(reply, 400, 'Egg-JSON erwartet', 'invalid_input');
    try {
      const prepared = prepareEggImport(req.body as RawEgg, { nest: 'Importiert' });
      const id = await saveCustomEgg(prepared);
      registry.audit('egg.import', null, 'standalone', { name: prepared.name });
      reply.code(201);
      return { eggId: id, name: prepared.name, variables: prepared.variables, warnings: prepared.warnings };
    } catch (err) {
      if (err instanceof CustomEggError) return fail(reply, err.statusCode, err.message, err.code);
      if (err instanceof EggImportError) return fail(reply, 400, err.message, 'invalid_egg');
      throw err;
    }
  });

  /** Ein importiertes Egg loeschen - nur, wenn kein Server es benutzt. */
  server.delete<{ Params: { id: string } }>('/api/v1/admin/eggs/:id', async (req, reply) => {
    const inUse = registry.list().filter((c) => c.game === req.params.id).length;
    try {
      const name = await deleteCustomEgg(req.params.id, inUse);
      registry.audit('egg.delete', null, 'standalone', { name });
      return { ok: true };
    } catch (err) {
      if (err instanceof CustomEggError) return fail(reply, err.statusCode, err.message, err.code);
      throw err;
    }
  });
}
