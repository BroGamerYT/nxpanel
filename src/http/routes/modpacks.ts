import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireAuth, requireAdmin, requireServer } from '../auth.js';
import { can } from '../../auth/permissions.js';
import { writeAudit } from '../../audit.js';
import { CURSEFORGE_KEY, getSetting, setSetting } from '../../settings.js';
import { checkCurseForgeKey, packOf, packStatus, presetFor, searchPacks, type PackSource } from '../../games/modpacks.js';
import { isUpdating, startPackUpdate, updateState } from '../../servers/modpack-update.js';

const searchQuery = z.object({
  q: z.string().trim().min(2).max(80),
  source: z.enum(['all', 'curseforge', 'modrinth', 'ftb']).default('all'),
});

export async function modpackRoutes(app: FastifyInstance) {
  /** Modpacks suchen - mit fertigem Vorschlag fuers Minecraft-Egg je Treffer. */
  app.get('/modpacks/search', { preHandler: requireAuth }, async (req) => {
    const { q, source } = searchQuery.parse(req.query);
    const cfKey = await getSetting(CURSEFORGE_KEY);
    const r = await searchPacks(q, { sources: source === 'all' ? [] : [source as PackSource], cfKey });
    return { ...r, hits: r.hits.map((h) => ({ ...h, preset: presetFor(h) })) };
  });

  /** Ist ein CurseForge-Schluessel hinterlegt? (Der Schluessel selbst geht nie raus.) */
  app.get('/modpacks/curseforge', { preHandler: requireAuth }, async () => ({ configured: !!(await getSetting(CURSEFORGE_KEY)) }));

  app.put('/admin/modpacks/curseforge', { preHandler: requireAdmin() }, async (req) => {
    const { apiKey } = z.object({ apiKey: z.string().trim().min(20).max(200) }).parse(req.body);
    if (apiKey.startsWith('cfc_pat_')) {
      throw new HttpError(400, 'Dies ist ein Profile-Token (cfc_pat_...). Bitte unter „API keys“ den Core-Schlüssel kopieren (beginnt mit $2a$10$...).', 'invalid_input');
    }
    if (!(await checkCurseForgeKey(apiKey))) throw new HttpError(400, 'CurseForge lehnt den Schluessel ab', 'invalid_input');
    await setSetting(CURSEFORGE_KEY, apiKey, { secret: true, actorId: req.actor!.id });
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'settings.curseforge', ip: req.ip, metadata: { set: true } });
    return { ok: true };
  });

  app.delete('/admin/modpacks/curseforge', { preHandler: requireAdmin() }, async (req) => {
    await setSetting(CURSEFORGE_KEY, null);
    await writeAudit({ userId: req.actor!.id, actorName: req.actor!.username, action: 'settings.curseforge', ip: req.ip, metadata: { set: false } });
    return { ok: true };
  });

  /** Welches Pack laeuft hier, gibt es ein Update, laeuft gerade eines? */
  app.get<{ Params: { id: string } }>('/servers/:id/modpack', { preHandler: requireServer('startup.read') }, async (req) => {
    const { server } = req.target!;
    const pack = packOf(server.variables ?? {});
    if (!pack) return { pack: null };
    const job = updateState(server.id);
    try {
      const st = await packStatus(pack, await getSetting(CURSEFORGE_KEY));
      return { ...st, job };
    } catch (err) {
      return { source: pack.source, ref: pack.ref, error: err instanceof Error ? err.message : String(err), job };
    }
  });

  /**
   * 1-Klick-Update: Backup, neue Version, Neustart. Braucht dieselben Rechte
   * wie die Einzelschritte - Einstellungen aendern und Backups anlegen.
   */
  app.post<{ Params: { id: string } }>('/servers/:id/modpack/update', { preHandler: requireServer('startup.update') }, async (req, reply) => {
    const { server, access } = req.target!;
    if (!can(req.actor!, access, 'backup.create')) throw new HttpError(403, 'Fehlendes Recht: backup.create (Update laeuft nur mit Backup)', 'forbidden');
    const body = z.object({ versionId: z.string().trim().min(1).max(64).optional() }).parse(req.body ?? {});
    const pack = packOf(server.variables ?? {});
    if (!pack) throw new HttpError(400, 'Auf diesem Server laeuft kein Modpack von CurseForge, Modrinth oder FTB', 'invalid_input');
    if (isUpdating(server.id)) throw new HttpError(409, 'Update laeuft bereits', 'conflict');
    const st = await packStatus(pack, await getSetting(CURSEFORGE_KEY));
    const target = body.versionId ?? st.latest?.id;
    if (!target) throw new HttpError(409, 'Keine Version gefunden', 'conflict');
    if (target === pack.version) throw new HttpError(409, 'Diese Version ist schon installiert', 'conflict');
    const toName = st.latest?.id === target ? st.latest.name : target;
    const label = `${st.pack?.name ?? pack.ref}: ${st.current?.name ?? 'unbekannt'} → ${toName}`;
    const state = startPackUpdate({
      serverId: server.id, versionVar: pack.versionVar, from: pack.version, to: target, label,
      actor: { id: req.actor!.id, username: req.actor!.username }, ip: req.ip,
    });
    await writeAudit({ userId: req.actor!.id, serverId: server.id, actorName: req.actor!.username, action: 'modpack.update', ip: req.ip, metadata: { from: pack.version, to: target } });
    reply.code(202);
    return { ok: true, job: state };
  });
}
