import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { parseRules } from '../../eggs/rules.js';
import { isGeneratedDefault } from '../../eggs/variables.js';
import { convertForeignEggToBundled, importEgg, type RawEgg } from '../../eggs/import.js';
import { isAllowedEggUrl, searchEggCatalog, toRawGithubUrl } from '../../eggs/catalog.js';
import { writeAudit } from '../../audit.js';
import { HttpError, requireAuth, requireAdmin } from '../auth.js';
import { BRANDING, coverFor, isValidChoice, readCustomCover, removeCustomCover, saveCustomCover, steamAppId, steamCover } from '../../eggs/cover.js';

/**
 * Spielekatalog. Die Variablen kommen schon als Formularbeschreibung
 * heraus (Widget, Optionen, Grenzen) - die Oberflaeche baut daraus
 * Dropdowns, Schalter und Schieberegler, ohne ein einziges Spiel zu kennen.
 */
export async function eggRoutes(app: FastifyInstance) {
  app.get('/eggs', { preHandler: requireAuth }, async (req) => {
    const actor = req.actor!;
    const rows = await sql<{ id: string; name: string; nest: string; author: string | null; docker_images: Record<string, string>;
      default_image: string | null; console_mode: string; resources: unknown; servers: number;
      raw_egg: unknown; cover: string | null; cover_version: string | null }[]>`
      SELECT e.id, e.name, n.name AS nest, e.author, e.docker_images, e.default_image, e.console_mode, e.resources,
             e.raw_egg, e.cover, e.cover_version,
             (SELECT count(*)::int FROM servers s WHERE s.egg_id = e.id) AS servers
      FROM eggs e JOIN nests n ON n.id = e.nest_id
      ORDER BY n.name, e.name`;

    const filtered = rows.filter((r) => {
      if (actor.role === 'admin') return true;
      if (actor.allowedEggs === null || actor.allowedEggs === undefined) return true;
      if (actor.allowedEggs.length === 0) return false;
      return actor.allowedEggs.includes(r.id) || actor.allowedEggs.includes(r.name);
    });

    return {
      eggs: filtered.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.nest,
        author: r.author,
        images: imageList(r.docker_images, r.default_image),
        consoleMode: r.console_mode,
        resources: r.resources,
        servers: r.servers,
        cover: coverFor({ id: r.id, name: r.name, raw: r.raw_egg, choice: r.cover, version: r.cover_version }),
        coverChoice: r.cover ?? 'auto',
        hasSteamCover: steamAppId(r.name, r.raw_egg) !== null,
      })),
    };
  });

  /** Auswahl fuer den Bild-Dialog. */
  app.get('/eggs/branding', { preHandler: requireAuth }, async () => ({ branding: BRANDING.map((p) => `/branding/${p}`) }));

  /**
   * Das Bild selbst. Ohne Anmeldung, weil <img> keinen Bearer-Token mitschickt -
   * ein Spielbild ist nichts Geheimes. Kommt nur aus dem Upload oder dem
   * Steam-Zwischenspeicher, nie von einer frei waehlbaren Adresse.
   */
  app.get<{ Params: { id: string } }>('/eggs/:id/cover', async (req, reply) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'Kein Bild', 'not_found');
    const [egg] = await sql<{ name: string; raw_egg: unknown; cover: string | null }[]>`
      SELECT name, raw_egg, cover FROM eggs WHERE id = ${req.params.id}`;
    if (!egg) throw new HttpError(404, 'Kein Bild', 'not_found');
    let img: { data: Buffer; type: string } | null = null;
    if (egg.cover === 'custom') img = await readCustomCover(req.params.id);
    if (!img) {
      const app = steamAppId(egg.name, egg.raw_egg);
      const data = app ? await steamCover(app) : null;
      if (data) img = { data, type: 'image/jpeg' };
    }
    if (!img) throw new HttpError(404, 'Kein Bild', 'not_found');
    reply.header('Content-Type', img.type).header('Cache-Control', 'public, max-age=86400').header('X-Content-Type-Options', 'nosniff');
    return reply.send(img.data);
  });

  const coverBody = z.union([
    z.object({ choice: z.string().max(80) }),
    z.object({ upload: z.string().max(3_000_000) }),
  ]);

  /** Titelbild waehlen (auto, steam, random, branding:...) oder eigenes hochladen. */
  app.put<{ Params: { id: string } }>('/admin/eggs/:id/cover', { preHandler: requireAdmin() }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');
    const [egg] = await sql<{ name: string }[]>`SELECT name FROM eggs WHERE id = ${req.params.id}`;
    if (!egg) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');
    const body = coverBody.parse(req.body);
    let choice: string;
    if ('upload' in body) {
      try { await saveCustomCover(req.params.id, body.upload); } catch (err) {
        throw new HttpError(400, err instanceof Error ? err.message : 'Bild ungueltig', 'invalid_input');
      }
      choice = 'custom';
    } else {
      if (!isValidChoice(body.choice) || body.choice === 'custom') throw new HttpError(400, 'Unbekannte Bildwahl', 'invalid_input');
      choice = body.choice;
      await removeCustomCover(req.params.id);
    }
    const stored = choice === 'auto' ? null : choice;
    await sql`UPDATE eggs SET cover = ${stored}, cover_version = ${Date.now().toString(36)} WHERE id = ${req.params.id}`;
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'egg.cover', ip: req.ip, metadata: { name: egg.name, choice } });
    return { ok: true, choice };
  });

  app.get<{ Params: { id: string } }>('/eggs/:id', { preHandler: requireAuth }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');
    const [egg] = await sql<{ id: string; name: string; nest: string; docker_images: Record<string, string>; default_image: string | null;
      console_mode: string; web_interface: unknown; ports: unknown; resources: unknown }[]>`
      SELECT e.id, e.name, n.name AS nest, e.docker_images, e.default_image, e.console_mode, e.web_interface, e.ports, e.resources
      FROM eggs e JOIN nests n ON n.id = e.nest_id WHERE e.id = ${req.params.id}`;
    if (!egg) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');

    const actor = req.actor!;
    if (actor.role !== 'admin' && actor.allowedEggs !== null && actor.allowedEggs !== undefined) {
      const allowed = actor.allowedEggs.length > 0 && (actor.allowedEggs.includes(egg.id) || actor.allowedEggs.includes(egg.name));
      if (!allowed) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');
    }

    const vars = await sql<{ name: string; description: string | null; name_locales: Record<string, string> | null; description_locales: Record<string, string> | null; env_variable: string; default_value: string | null;
      rules: string | null; requires: string | null; is_secret: boolean; user_editable: boolean }[]>`
      SELECT name, description, name_locales, description_locales, env_variable, default_value, rules, requires, is_secret, user_editable
      FROM egg_variables WHERE egg_id = ${egg.id} AND user_viewable ORDER BY sort_order`;

    return {
      egg: {
        id: egg.id,
        name: egg.name,
        category: egg.nest,
        images: imageList(egg.docker_images, egg.default_image),
        consoleMode: egg.console_mode,
        webInterface: egg.web_interface,
        ports: egg.ports,
        resources: egg.resources,
        variables: vars.map((v) => {
          const r = parseRules(v.rules, v.env_variable);
          return {
            env: v.env_variable,
            label: v.name,
            description: v.description,
            labelLocales: v.name_locales ?? undefined,
            descriptionLocales: v.description_locales ?? undefined,
            // Geheime Vorgaben (Passwoerter) nie ausliefern, Erzeugungs-Platzhalter auch nicht
            default: v.is_secret || isGeneratedDefault(v.default_value) ? null : v.default_value,
            generated: isGeneratedDefault(v.default_value),
            secret: v.is_secret,
            editable: v.user_editable,
            requires: v.requires,
            widget: v.is_secret ? 'password' : r.widget,
            // Leer lassen erlaubt: das Panel erzeugt dann ein Passwort
            required: r.required && !isGeneratedDefault(v.default_value),
            type: r.type,
            ...(r.options ? { options: r.options } : {}),
            ...(r.min !== undefined ? { min: r.min } : {}),
            ...(r.max !== undefined ? { max: r.max } : {}),
            ...(r.pattern ? { pattern: r.pattern } : {}),
          };
        }),
      },
    };
  });

  /** Online-Katalog aller Eggs durchsuchen (lokaler Katalog + GitHub pelican-eggs). */
  app.get<{ Querystring: { q?: string; category?: string; live?: string } }>('/admin/eggs/catalog', { preHandler: requireAdmin() }, async (req) => {
    const q = (req.query.q ?? '').slice(0, 100);
    const category = (req.query.category ?? 'all').slice(0, 40);
    const includeLive = req.query.live === 'true' || q.trim().length >= 2;
    const rows = await sql<{ name: string }[]>`SELECT name FROM eggs`;
    const existingNames = new Set(rows.map((r) => r.name));
    const items = await searchEggCatalog(q, { category, includeLive, existingNames });
    return { items };
  });

  /** Egg direkt von einer GitHub-URL herunterladen, automatisch fuer NexusPanel aufbereiten und importieren. */
  app.post('/admin/eggs/import-url', { preHandler: requireAdmin() }, async (req, reply) => {
    const body = z.object({
      url: z.string().url().max(500),
      steamId: z.number().int().positive().optional().nullable(),
      category: z.string().max(60).optional(),
    }).parse(req.body);

    if (!isAllowedEggUrl(body.url)) {
      throw new HttpError(400, 'Nur GitHub-JSON-Links (github.com / raw.githubusercontent.com) sind erlaubt', 'invalid_url');
    }

    const rawUrl = toRawGithubUrl(body.url);
    let rawJson: RawEgg;
    try {
      const res = await fetch(rawUrl, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      rawJson = (await res.json()) as RawEgg;
    } catch (err) {
      throw new HttpError(400, `Download von GitHub fehlgeschlagen: ${err instanceof Error ? err.message : 'Unbekannter Fehler'}`, 'download_failed');
    }

    const { egg, report } = convertForeignEggToBundled(rawJson, rawUrl);
    if (body.steamId && !egg.cover?.steam) {
      egg.cover = { steam: body.steamId };
    }
    if (body.category && (!rawJson.nest || egg.nest === 'Survival')) {
      const mapCat: Record<string, string> = {
        SteamCMD: 'Survival',
        Standalone: 'Eigenständig',
        Minecraft: 'Minecraft',
        Voice: 'Sprachserver',
        Chatbots: 'Bots & Tools',
      };
      egg.nest = mapCat[body.category] ?? body.category;
    }

    const [dupe] = await sql`SELECT 1 FROM eggs WHERE lower(name) = lower(${String(egg.name ?? '')})`;
    if (dupe) throw new HttpError(409, `Ein Spiel mit dem Namen "${egg.name}" ist bereits installiert`, 'conflict');

    let result;
    try {
      result = await importEgg(egg, egg.nest ?? 'Importiert');
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Egg ungueltig', 'invalid_egg');
    }

    const allWarnings = [...new Set([...report, ...result.warnings])];
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'egg.import_url',
      ip: req.ip,
      metadata: { name: result.name, url: rawUrl },
    });
    reply.code(201);
    return { ...result, warnings: allWarnings };
  });

  /** Egg einspielen (Pterodactyl-Format oder eigenes). Body = der Inhalt der JSON-Datei. */
  app.post('/admin/eggs', { preHandler: requireAdmin() }, async (req, reply) => {
    if (!req.body || typeof req.body !== 'object') throw new HttpError(400, 'Egg-JSON erwartet', 'invalid_input');
    const [dupe] = await sql`SELECT 1 FROM eggs WHERE name = ${String((req.body as { name?: unknown }).name ?? '')}`;
    if (dupe) throw new HttpError(409, 'Ein Egg mit diesem Namen gibt es schon', 'conflict');
    let result;
    try {
      result = await importEgg(req.body as Parameters<typeof importEgg>[0]);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : 'Egg ungueltig', 'invalid_egg');
    }
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'egg.import', ip: req.ip, metadata: { name: result.name } });
    reply.code(201);
    return result;
  });

  app.delete<{ Params: { id: string } }>('/admin/eggs/:id', { preHandler: requireAdmin() }, async (req) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');
    const [used] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM servers WHERE egg_id = ${req.params.id}`;
    if (used!.n > 0) throw new HttpError(409, `Wird noch von ${used!.n} Server(n) genutzt`, 'in_use');
    const del = await sql<{ name: string }[]>`DELETE FROM eggs WHERE id = ${req.params.id} RETURNING name`;
    if (!del.length) throw new HttpError(404, 'Egg nicht gefunden', 'not_found');
    await removeCustomCover(req.params.id);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'egg.delete', ip: req.ip, metadata: { name: del[0]!.name } });
    return { ok: true };
  });
}

/** Images als Liste mit Vorgabe zuerst - das Dropdown im Erstellungsdialog. */
function imageList(images: Record<string, string>, defaultImage: string | null) {
  return Object.entries(images)
    .map(([label, image]) => ({ key: label, label, image, default: image === defaultImage }))
    .sort((a, b) => Number(b.default) - Number(a.default));
}
