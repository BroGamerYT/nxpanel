import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { checkCurseForgeKey, packOf, packStatus, packVersionChoices, presetFor, searchPacks, type PackSource } from '../../games/modpacks.js';
import type { ModpackUpdater } from '../../servers/modpack-update.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { SecretStore } from '../../store/secrets.js';
import type { ServerInstanceConfig } from '../../types.js';
import { flagsFor, type AccessPolicy } from '../authz.js';

/**
 * Modpacks (CurseForge, Modrinth, Feed the Beast) suchen, den Stand eines Servers ansehen und mit einem Klick aktualisieren -
 * dieselben Routen und Antworten wie im Panel.
 *
 * Der CurseForge-Schluessel steht in den Einstellungen des Cores und geht nie in eine Antwort. Das Update braucht dieselben Rechte
 * wie die Einzelschritte (Einstellungen aendern und Backups anlegen) und laeuft nur mit fertigem Backup.
 */

const CURSEFORGE_SECRET = 'curseforge';

const searchQuery = z.object({
  q: z.string().trim().min(2).max(80),
  source: z.enum(['all', 'curseforge', 'modrinth', 'ftb']).default('all'),
});

const versionsQuery = z.object({
  source: z.enum(['curseforge', 'modrinth', 'ftb']),
  ref: z.string().trim().min(1).max(120),
});

export interface ModpackRouteDeps {
  registry: ServerRegistry;
  secrets: SecretStore;
  updater: ModpackUpdater;
  policy: AccessPolicy;
  find: (id: string) => ServerInstanceConfig | undefined;
}

export function registerModpackRoutes(server: FastifyInstance, deps: ModpackRouteDeps): void {
  const { registry, secrets, updater, policy, find } = deps;

  const fail = (reply: FastifyReply, status: number, message: string, code: string): FastifyReply => reply.status(status).send({ error: message, message, code });
  const key = (): string | null => secrets.get(CURSEFORGE_SECRET);
  /** Die Pack-Variablen eines Servers: Umgebung des Containers und Installationsvariablen. */
  const varsOf = (c: ServerInstanceConfig): Record<string, string> => ({ ...(c.env ?? {}), ...(c.install?.variables ?? {}) });

  /** Modpacks suchen - mit fertigem Vorschlag fuers Minecraft-Egg je Treffer. */
  server.get<{ Querystring: unknown }>('/api/v1/modpacks/search', async (req, reply) => {
    const q = searchQuery.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'Suchbegriff: 2 bis 80 Zeichen', 'invalid_request');
    const r = await searchPacks(q.data.q, { sources: q.data.source === 'all' ? [] : [q.data.source as PackSource], cfKey: key() });
    return { ...r, hits: r.hits.map((h) => ({ ...h, preset: presetFor(h) })) };
  });

  /** Alle Versionen eines Packs (neueste zuerst) - fuer die Auswahl beim Anlegen. */
  server.get<{ Querystring: unknown }>('/api/v1/modpacks/versions', async (req, reply) => {
    const q = versionsQuery.safeParse(req.query);
    if (!q.success) return fail(reply, 400, 'Quelle und Pack-Kennung angeben', 'invalid_request');
    try {
      return { versions: await packVersionChoices({ source: q.data.source, ref: q.data.ref }, key()) };
    } catch (err) {
      return fail(reply, 502, err instanceof Error ? err.message : 'Versionen nicht abrufbar', 'upstream_error');
    }
  });

  /** Ist ein CurseForge-Schluessel hinterlegt? (Der Schluessel selbst geht nie raus.) */
  server.get('/api/v1/modpacks/curseforge', async () => {
    const status = secrets.status(CURSEFORGE_SECRET);
    // "unreadable": gespeichert, aber mit dem jetzigen Hauptschluessel nicht lesbar - der Schluessel muss neu eingegeben werden
    return { configured: status === 'ok', ...(status === 'unreadable' ? { unreadable: true } : {}) };
  });

  server.put<{ Body: unknown }>('/api/v1/admin/modpacks/curseforge', async (req, reply) => {
    const body = z.object({ apiKey: z.string().trim().min(20).max(200) }).safeParse(req.body);
    if (!body.success) return fail(reply, 400, 'Schlüssel: 20 bis 200 Zeichen', 'invalid_input');
    if (body.data.apiKey.startsWith('cfc_pat_')) {
      return fail(reply, 400, 'Dies ist ein Profile-Token (cfc_pat_...). Bitte unter „API keys“ den Core-Schlüssel kopieren (beginnt mit $2a$10$...).', 'invalid_input');
    }
    if (!(await checkCurseForgeKey(body.data.apiKey))) return fail(reply, 400, 'CurseForge lehnt den Schlüssel ab', 'invalid_input');
    secrets.set(CURSEFORGE_SECRET, body.data.apiKey);
    registry.audit('settings.curseforge', null, 'standalone', { set: true });
    return { ok: true };
  });

  server.delete('/api/v1/admin/modpacks/curseforge', async () => {
    secrets.delete(CURSEFORGE_SECRET);
    registry.audit('settings.curseforge', null, 'standalone', { set: false });
    return { ok: true };
  });

  /** Welches Pack laeuft hier, gibt es ein Update, laeuft gerade eines? */
  server.get<{ Params: { id: string } }>('/api/v1/servers/:id/modpack', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const pack = packOf(varsOf(c));
    if (!pack) return { pack: null };
    const job = updater.state(c.id);
    try {
      return { ...(await packStatus(pack, key())), job };
    } catch (err) {
      return { source: pack.source, ref: pack.ref, error: err instanceof Error ? err.message : String(err), job };
    }
  });

  /** 1-Klick-Update: Backup, neue Version, Neustart. */
  server.post<{ Params: { id: string }; Body: unknown }>('/api/v1/servers/:id/modpack/update', async (req, reply) => {
    const c = find(req.params.id);
    if (!c) return fail(reply, 404, 'Server nicht gefunden', 'not_found');
    const actor = req.actor!;
    if (!flagsFor(registry, c.id, actor, policy).includes('backup.create')) return fail(reply, 403, 'Fehlendes Recht: backup.create (Update läuft nur mit Backup)', 'forbidden');
    const body = z.object({ versionId: z.string().trim().min(1).max(64).optional() }).safeParse(req.body ?? {});
    if (!body.success) return fail(reply, 400, 'Ungültige Anfrage', 'invalid_request');
    const pack = packOf(varsOf(c));
    if (!pack) return fail(reply, 400, 'Auf diesem Server läuft kein Modpack von CurseForge, Modrinth oder FTB', 'invalid_input');
    if (updater.isUpdating(c.id)) return fail(reply, 409, 'Update läuft bereits', 'conflict');
    let st;
    try {
      st = await packStatus(pack, key());
    } catch (err) {
      return fail(reply, 502, `Die Version konnte nicht abgefragt werden: ${err instanceof Error ? err.message : String(err)}`, 'upstream_failed');
    }
    const target = body.data.versionId ?? st.latest?.id;
    if (!target) return fail(reply, 409, 'Keine Version gefunden', 'conflict');
    if (target === pack.version) return fail(reply, 409, 'Diese Version ist schon installiert', 'conflict');
    const toName = st.latest?.id === target ? st.latest.name : target;
    const label = `${st.pack?.name ?? pack.ref}: ${st.current?.name ?? 'unbekannt'} → ${toName}`;
    const state = updater.start({ serverId: c.id, versionVar: pack.versionVar, from: pack.version, to: target, label, actor: actor.username });
    registry.audit('modpack.update', c.id, 'standalone', { from: pack.version, to: target });
    return reply.code(202).send({ ok: true, job: state });
  });
}
