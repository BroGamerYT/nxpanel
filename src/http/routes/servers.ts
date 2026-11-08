import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { extractGameInfo, listServersForActor, publicHostFor } from '../../servers/access.js';
import { listPorts, resetCrashCount } from '../../servers/repo.js';
import { effectiveFlags, can, canCreateServer, canDeleteServer, type ServerFlag } from '../../auth/permissions.js';
import { prepareServer, ValidationError, NotFoundError } from '../../servers/create.js';
import { defaultNodeId } from '../../servers/nodes.js';
import { setStatus } from '../../servers/status.js';
import { LIMITS, type RateLimiter } from '../../auth/ratelimit.js';
import { writeAudit } from '../../audit.js';
import { writeEvent } from '../../events.js';
import { log } from '../../log.js';
import { HttpError, requireAuth, requireServer } from '../auth.js';
import { importAfterCreate, loadRules, resolveImportFile } from './import.js';
import { diskCollector } from '../../servers/stats.js';
import { createBackup, listBackups } from '../../servers/backups.js';
import { engine } from '../../docker/client.js';

export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';

export interface ActiveGameUpdate {
  serverId: string;
  step: 'stopping' | 'backup' | 'pulling' | 'rebuilding' | 'starting' | 'done' | 'failed';
  backupId?: string;
  startedAt: number;
  error?: string;
}
export const activeGameUpdates = new Map<string, ActiveGameUpdate>();

/** Die Power-Funktionen werden hereingereicht - so laesst sich die API ohne Docker testen. */
export type PowerFn = (serverId: string, ctx: { actorId: string }) => Promise<void>;
export type PowerHandlers = Record<PowerAction, PowerFn>;

/** Langsame Docker-Schritte, ebenfalls hereingereicht (Tests ohne Docker). */
export interface ServerOps {
  /** Container anlegen und installieren - laeuft im Hintergrund. */
  provision: (serverId: string, ctx: { actorId: string }) => Promise<void>;
  /** Container, Volume und Ports entfernen, Eintrag loeschen. */
  remove: (serverId: string, ctx: { actorId: string }) => Promise<void>;
  /** Container neu anlegen (Variablen, Image, Ports geaendert) - ohne Neuinstallation. */
  rebuild: (serverId: string, ctx: { actorId: string; reason: string }) => Promise<void>;
  /** RAM/CPU am vorhandenen Container nachziehen, auch im laufenden Betrieb. */
  updateResources: (serverId: string) => Promise<void>;
}

export const powerBody = z.object({ action: z.enum(['start', 'stop', 'restart', 'kill']) });

export const eventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  before: z.coerce.number().int().positive().optional(),
  kind: z.string().max(64).optional(),
  severity: z.enum(['info', 'warn', 'error']).optional(),
});

/** Welche Zustaende erlauben welche Aktion? Klare Meldung statt Docker-Fehler. */
const ALLOWED: Record<PowerAction, readonly string[]> = {
  start: ['offline', 'crashed'],
  stop: ['running', 'starting'],
  restart: ['running', 'crashed', 'offline'],
  kill: ['running', 'starting', 'stopping'],
};

export const createBody = z.object({
  name: z.string().trim().min(1).max(64),
  description: z.string().max(500).optional(),
  eggId: z.string().uuid(),
  ramMb: z.number().int().min(128).max(1_048_576),
  diskMb: z.number().int().min(256).max(10_485_760),
  cpuPercent: z.number().int().min(10).max(6400).default(100),
  imageKey: z.string().max(200).optional(),
  variables: z.record(z.string().max(64), z.string().max(4096)).default({}),
  autoRestart: z.boolean().default(true),
  autoSleepMinutes: z.number().int().min(0).max(1440).default(0),
  /** Nur Admins: Server direkt fuer jemand anderen anlegen. */
  ownerId: z.string().uuid().optional(),
  /** Backup aus dem Import-Ordner, das nach der Installation uebernommen wird. */
  importFile: z.string().min(1).max(255).optional(),
});

export const patchBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  description: z.string().max(500).nullable().optional(),
  autoRestart: z.boolean().optional(),
  autoSleepMinutes: z.number().int().min(0).max(1440).optional(),
  tags: z.array(z.string().trim().min(1).max(24)).max(10).optional(),
  isFavorite: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nichts zu aendern');

/**
 * Hinweise aus dem Egg: Muster in der Konsole -> Erklaerung, was zu tun ist.
 * Nur gueltige Eintraege durchlassen; ein kaputter regulaerer Ausdruck soll
 * nicht die Konsole lahmlegen.
 */
export type Hint = { match: string; flags: string; level: 'ok' | 'warn' | 'error' | 'ignore'; text: string; text_locales?: Record<string, string> };
export function cleanHints(raw: unknown): Hint[] {
  if (!Array.isArray(raw)) return [];
  const out: Hint[] = [];
  for (const h of raw.slice(0, 50)) {
    if (!h || typeof h !== 'object') continue;
    const { match, flags, level, text, text_locales } = h as Record<string, unknown>;
    if (typeof match !== 'string' || typeof text !== 'string' || match.length > 300) continue;
    const f = typeof flags === 'string' && /^[i]?$/.test(flags) ? flags : '';
    try { new RegExp(match, f); } catch { continue; }
    const locales = text_locales && typeof text_locales === 'object' && !Array.isArray(text_locales)
      ? Object.fromEntries(Object.entries(text_locales).filter(([k, v]) => typeof k === 'string' && typeof v === 'string'))
      : undefined;
    out.push({
      match,
      flags: f,
      level: level === 'ok' || level === 'warn' || level === 'ignore' ? level : 'error',
      text: text.slice(0, 500),
      ...(locales ? { text_locales: locales } : {}),
    });
  }
  return out;
}

/** Kann ich das hier loeschen, ohne einen laufenden Server abzuwuergen? */
const DELETABLE = ['offline', 'crashed', 'install_failed', 'suspended'];

export async function serverRoutes(
  app: FastifyInstance,
  opts: { limiter: RateLimiter; power: PowerHandlers; ops: ServerOps },
) {
  const { limiter, power, ops } = opts;

  /**
   * Server anlegen. Wer das Recht server.create hat, wird Besitzer.
   * Antwortet sofort mit 201 und dem Server im Zustand "installing";
   * Image holen und Installieren laufen im Hintergrund.
   */
  app.post('/servers', { preHandler: requireAuth }, async (req, reply) => {
    const actor = req.actor!;
    if (!canCreateServer(actor)) throw new HttpError(403, 'Fehlendes Recht: server.create', 'forbidden');
    const body = createBody.parse(req.body);

    const [eggRow] = await sql<{ id: string; name: string }[]>`SELECT id, name FROM eggs WHERE id = ${body.eggId}`;
    if (!eggRow) throw new HttpError(400, 'Spielvorlage nicht gefunden', 'invalid_input');

    if (actor.role !== 'admin' && actor.allowedEggs && actor.allowedEggs.length > 0) {
      const allowed = actor.allowedEggs.includes(eggRow.id) || actor.allowedEggs.includes(eggRow.name);
      if (!allowed) {
        throw new HttpError(403, `Du hast keine Berechtigung, einen Server mit der Spielvorlage "${eggRow.name}" zu erstellen`, 'forbidden');
      }
    }

    let ownerId = actor.id;
    if (body.ownerId && body.ownerId !== actor.id) {
      if (actor.role !== 'admin') throw new HttpError(403, 'Nur Admins koennen Server fuer andere anlegen', 'forbidden');
      const [o] = await sql`SELECT 1 FROM users WHERE id = ${body.ownerId}`;
      if (!o) throw new HttpError(400, 'Besitzer gibt es nicht', 'invalid_input');
      ownerId = body.ownerId;
    }

    // Budgets des Besitzers (0 = unbegrenzt). Admins legen fuer sich selbst ohne Grenze an.
    const [budget] = await sql<{ role: string; server_limit: number; ram_limit_mb: number; disk_limit_mb: number;
      servers: number; ram: number; disk: number }[]>`
      SELECT u.role, u.server_limit, u.ram_limit_mb, u.disk_limit_mb,
             count(s.id)::int AS servers, coalesce(sum(s.ram_mb), 0)::int AS ram, coalesce(sum(s.disk_mb), 0)::int AS disk
      FROM users u LEFT JOIN servers s ON s.owner_id = u.id
      WHERE u.id = ${ownerId} GROUP BY u.id`;
    if (budget && budget.role !== 'admin') {
      if (budget.server_limit > 0 && budget.servers + 1 > budget.server_limit) {
        throw new HttpError(409, `Server-Limit erreicht (${budget.server_limit})`, 'limit_servers');
      }
      if (budget.ram_limit_mb > 0 && budget.ram + body.ramMb > budget.ram_limit_mb) {
        throw new HttpError(409, `RAM-Budget reicht nicht: ${budget.ram_limit_mb - budget.ram} MB frei`, 'limit_ram');
      }
      if (budget.disk_limit_mb > 0 && budget.disk + body.diskMb > budget.disk_limit_mb) {
        throw new HttpError(409, `Speicher-Budget reicht nicht: ${budget.disk_limit_mb - budget.disk} MB frei`, 'limit_disk');
      }
    }

    // Backup vor dem Anlegen pruefen - sonst steht ein Server ohne Daten da.
    let importFile: { path: string; name: string; removeAfter: boolean } | null = null;
    if (body.importFile) {
      const f = await resolveImportFile(actor, body.importFile);
      const { rules } = await loadRules(body.eggId);
      if (!rules.length) throw new HttpError(400, 'Fuer dieses Spiel gibt es keine Import-Regeln', 'unsupported');
      importFile = { path: f.path, name: f.name, removeAfter: f.name.startsWith('upload-') };
    }

    let server;
    try {
      server = await prepareServer({
        ownerId,
        nodeId: await defaultNodeId(),
        eggId: body.eggId,
        name: body.name,
        ramMb: body.ramMb,
        diskMb: body.diskMb,
        cpuPercent: body.cpuPercent,
        ...(body.imageKey ? { imageKey: body.imageKey } : {}),
        variables: body.variables,
        autoRestart: body.autoRestart,
        autoSleepMinutes: body.autoSleepMinutes,
        actorId: actor.id,
      });
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.code(400).send({ error: err.message, code: 'invalid_variables', issues: err.issues });
      }
      if (err instanceof NotFoundError) throw new HttpError(400, err.message, 'invalid_input');
      if (err instanceof Error && /freier Port/i.test(err.message)) throw new HttpError(409, err.message, 'no_free_port');
      throw err;
    }
    if (body.description) await sql`UPDATE servers SET description = ${body.description} WHERE id = ${server.id}`;

    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.create', ip: req.ip,
      metadata: { name: server.name, eggId: body.eggId, ownerId, ...(importFile ? { importFile: importFile.name } : {}) } });

    const id = server.id;
    runInBackground(id, actor.id, 'install', async () => {
      await ops.provision(id, { actorId: actor.id });
      if (importFile) await importAfterCreate(id, importFile, actor.id);
      void diskCollector.measure(id, server.short_id).catch(() => {});
    });

    reply.code(201);
    return { server: { id: server.id, shortId: server.short_id, name: server.name, status: server.status } };
  });

  app.patch<{ Params: { id: string } }>('/servers/:id', { preHandler: requireServer() }, async (req) => {
    const body = patchBody.parse(req.body);
    const { server, access } = req.target!;
    const actor = req.actor!;
    if ((body.name !== undefined || body.description !== undefined || body.tags !== undefined) && !can(actor, access, 'settings.rename') && !can(actor, access, 'startup.update')) {
      throw new HttpError(403, 'Fehlendes Recht: settings.rename', 'forbidden');
    }
    if ((body.autoRestart !== undefined || body.autoSleepMinutes !== undefined) && !can(actor, access, 'startup.update') && !can(actor, access, 'control.start')) {
      throw new HttpError(403, 'Fehlendes Recht: startup.update', 'forbidden');
    }
    const cleanTags = body.tags ? Array.from(new Set(body.tags.map((t) => t.trim()).filter(Boolean))) : undefined;
    await sql`
      UPDATE servers SET
        name = ${body.name ?? server.name},
        description = ${body.description === undefined ? sql`description` : body.description},
        auto_restart = ${body.autoRestart ?? server.auto_restart},
        auto_sleep_minutes = ${body.autoSleepMinutes !== undefined ? body.autoSleepMinutes : server.auto_sleep_minutes},
        crash_count = ${body.autoRestart !== undefined ? 0 : server.crash_count},
        tags = ${cleanTags !== undefined ? cleanTags : (server.tags ?? [])},
        is_favorite = ${body.isFavorite !== undefined ? body.isFavorite : Boolean(server.is_favorite)}
      WHERE id = ${server.id}`;
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.update', ip: req.ip, metadata: body });
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>('/servers/:id', { preHandler: requireServer() }, async (req) => {
    const { server, access } = req.target!;
    const actor = req.actor!;
    if (!canDeleteServer(actor, access)) throw new HttpError(403, 'Loeschen duerfen nur Admin und Besitzer', 'forbidden');
    if (!DELETABLE.includes(server.status) && req.query.force !== 'true') {
      throw new HttpError(409, `Server ist "${server.status}" - erst stoppen oder ?force=true`, 'invalid_state');
    }
    // Audit VOR dem Loeschen: server_id wird danach NULL, der Name bleibt in metadata lesbar.
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.delete', ip: req.ip,
      metadata: { name: server.name, shortId: server.short_id, force: req.query.force === 'true' } });
    await ops.remove(server.id, { actorId: actor.id });
    return { ok: true };
  });

  /** Neu installieren: ueberschreibt Spieldateien. Bewusst in keinem Preset. */
  app.post<{ Params: { id: string } }>('/servers/:id/reinstall', { preHandler: requireServer('settings.reinstall') }, async (req, reply) => {
    const { server } = req.target!;
    const actor = req.actor!;
    if (!['offline', 'crashed', 'install_failed'].includes(server.status)) {
      throw new HttpError(409, `Neuinstallation nur im gestoppten Zustand, aktuell "${server.status}"`, 'invalid_state');
    }
    await setStatus(server.id, 'installing', { reason: 'Neuinstallation', actorId: actor.id });
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.reinstall', ip: req.ip });
    runInBackground(server.id, actor.id, 'reinstall', () => ops.provision(server.id, { actorId: actor.id }));
    reply.code(202);
    return { accepted: true };
  });

  /**
   * 1-Klick Server-Update (fuer alle Spiele):
   * 1. Stoppt den Server geordnet (falls er laeuft)
   * 2. Legt optional ein Sicherheits-Backup vor dem Update an
   * 3. Zieht das neueste Docker-Image, fuehrt bei SteamCMD-Installern das Update-Skript aus bzw. baut den Container neu
   * 4. Startet den Server wieder (falls er vorher lief oder auf Wunsch)
   */
  app.post<{ Params: { id: string }; Body: { backup?: boolean; startAfter?: boolean } }>('/servers/:id/update-game', { preHandler: requireServer('control.restart') }, async (req, reply) => {
    const { server, access } = req.target!;
    const actor = req.actor!;
    const body = z.object({ backup: z.boolean().default(true), startAfter: z.boolean().default(true) }).parse(req.body ?? {});

    if (body.backup && !can(actor, access, 'backup.create')) {
      throw new HttpError(403, 'Fehlendes Recht fuer Sicherheits-Backup: backup.create', 'forbidden');
    }
    if (server.suspended) throw new HttpError(409, 'Server ist gesperrt', 'suspended');
    if (server.status === 'installing' || server.status === 'stopping') {
      throw new HttpError(409, `Update ist im Zustand "${server.status}" nicht moeglich`, 'invalid_state');
    }

    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.update_game', ip: req.ip, metadata: body });
    await resetCrashCount(server.id).catch(() => {});

    const wasRunning = server.status === 'running' || server.status === 'starting';
    const ip = req.ip;

    runInBackground(server.id, actor.id, 'update', async () => {
      activeGameUpdates.set(server.id, {
        serverId: server.id,
        step: wasRunning ? 'stopping' : (body.backup ? 'backup' : 'pulling'),
        startedAt: Date.now(),
      });

      await writeEvent({
        serverId: server.id,
        kind: 'status_change',
        actorId: actor.id,
        summary: `1-Klick-Update gestartet${body.backup ? ' (mit Sicherheits-Backup)' : ''}`,
      });

      try {
        if (wasRunning) {
          activeGameUpdates.set(server.id, { serverId: server.id, step: 'stopping', startedAt: Date.now() });
          await power.stop(server.id, { actorId: actor.id });
        }

        if (body.backup) {
          const b = await createBackup(server.id, { id: actor.id, username: actor.username }, ip, 'Vor Server-Update');
          activeGameUpdates.set(server.id, { serverId: server.id, step: 'backup', backupId: b.id, startedAt: Date.now() });
          const end = Date.now() + 60 * 60_000;
          let bStatus = 'running';
          while (Date.now() < end) {
            bStatus = (await listBackups(server.id)).find((x) => x.id === b.id)?.status ?? 'missing';
            if (bStatus !== 'running') break;
            await new Promise((r) => setTimeout(r, 2000));
          }
          if (bStatus !== 'completed') {
            throw new Error(`Sicherheits-Backup fehlgeschlagen (${bStatus}) – Update abgebrochen`);
          }
        }

        activeGameUpdates.set(server.id, { serverId: server.id, step: 'pulling', startedAt: Date.now() });
        await engine.pullImage(server.docker_image).catch((err: unknown) => log.warn({ err, image: server.docker_image }, 'Image-Pull beim Update fehlgeschlagen, nutze lokales Image'));

        activeGameUpdates.set(server.id, { serverId: server.id, step: 'rebuilding', startedAt: Date.now() });
        await ops.rebuild(server.id, { actorId: actor.id, reason: '1-Klick-Update' });

        if (body.startAfter || wasRunning) {
          activeGameUpdates.set(server.id, { serverId: server.id, step: 'starting', startedAt: Date.now() });
          await power.start(server.id, { actorId: actor.id });
        }

        activeGameUpdates.set(server.id, { serverId: server.id, step: 'done', startedAt: Date.now() });
        setTimeout(() => activeGameUpdates.delete(server.id), 15000);
      } catch (err) {
        activeGameUpdates.set(server.id, { serverId: server.id, step: 'failed', error: (err as Error).message, startedAt: Date.now() });
        setTimeout(() => activeGameUpdates.delete(server.id), 30000);
        throw err;
      }
    });

    reply.code(202);
    return { accepted: true };
  });

  app.get<{ Params: { id: string } }>('/servers/:id/allocations', { preHandler: requireServer('allocation.read') }, async (req) => {
    return { allocations: await listPorts(req.target!.server.id) };
  });

  app.get('/servers', { preHandler: requireAuth }, async (req) => {
    return { servers: await listServersForActor(req.actor!) };
  });

  app.get<{ Params: { id: string } }>('/servers/:id', { preHandler: requireServer() }, async (req) => {
    const { server, access } = req.target!;
    const flags = effectiveFlags(req.actor!, access);
    const has = (f: ServerFlag) => flags.includes(f);
    const [egg] = await sql<{ name: string; console_mode: string; web_interface: unknown; hints: unknown; game_kind: string | null; raw_egg: unknown }[]>`
      SELECT name, console_mode, web_interface, raw_egg, raw_egg->'hints' AS hints, raw_egg->'query'->>'kind' AS game_kind FROM eggs WHERE id = ${server.egg_id}`;
    const [node] = await sql<{ public_host: string | null; port_from: number | null; port_to: number | null }[]>`
      SELECT public_host, port_from, port_to FROM nodes WHERE id = ${server.node_id}`;
    const ports = await listPorts(server.id);
    const primaryPort = ports.find((p) => p.is_primary)?.port ?? null;
    const gameInfo = extractGameInfo(egg?.name ?? '', egg ? egg.raw_egg : null, server.variables, server.short_id);

    return {
      server: {
        id: server.id,
        shortId: server.short_id,
        name: server.name,
        status: server.status,
        ownerId: server.owner_id,
        egg: egg ? { id: server.egg_id, name: egg.name, consoleMode: egg.console_mode, webInterface: egg.web_interface, hints: cleanHints(egg.hints), gameKind: egg.game_kind } : null,
        limits: { ramMb: server.ram_mb, swapMb: server.swap_mb, cpuPercent: server.cpu_percent, diskMb: server.disk_mb },
        // Belegt laut letzter Messung (alle paar Minuten), null = noch nicht gemessen.
        diskUsedMb: diskCollector.serverMb().get(server.id) ?? null,
        containerLayerMb: diskCollector.docker()?.serverContainerMb?.[server.id] ?? null,
        autoRestart: server.auto_restart,
        crashCount: server.crash_count,
        unstartable: server.status === 'crashed' && server.crash_count >= 5,
        autoSleepMinutes: server.auto_sleep_minutes,
        suspended: server.suspended,
        publicHost: publicHostFor(node?.public_host ?? null, node?.port_from ?? null, node?.port_to ?? null, primaryPort),
        gameVersion: gameInfo.gameVersion,
        serverType: gameInfo.serverType,
        modpackName: gameInfo.modpackName,
        modpackVersion: gameInfo.modpackVersion,
        tags: server.tags ?? [],
        isFavorite: Boolean(server.is_favorite),
        // Nur ausliefern, was der Nutzer sehen darf.
        ...(has('allocation.read') ? { ports } : {}),
        ...(has('startup.read') ? {
          image: server.docker_image,
          startup: server.startup,
          variables: server.variables,
          rcon: (() => {
            const rconPort = ports.find((p) => p.ref === 'rcon')?.port ?? null;
            const rconPass = server.variables?.RCON_PASSWORD ?? server.variables?.ADMIN_PASSWORD ?? server.variables?.RCON_PASS ?? null;
            return rconPort ? { port: rconPort, password: rconPass } : null;
          })(),
        } : {}),
      },
      permissions: flags,
    };
  });

  app.post<{ Params: { id: string } }>('/servers/:id/power', { preHandler: requireServer() }, async (req, reply) => {
    const { action } = powerBody.parse(req.body);
    const { server, access } = req.target!;
    const actor = req.actor!;

    if (!can(actor, access, `control.${action}`)) {
      throw new HttpError(403, `Fehlendes Recht: control.${action}`, 'forbidden');
    }
    if (server.suspended) throw new HttpError(409, 'Server ist gesperrt', 'suspended');
    if (!ALLOWED[action].includes(server.status)) {
      throw new HttpError(409, `"${action}" ist im Zustand "${server.status}" nicht moeglich`, 'invalid_state');
    }

    if (action === 'start' || action === 'restart') {
      const used = diskCollector.serverMb().get(server.id);
      if (used !== undefined && server.disk_mb > 0 && used > server.disk_mb) {
        throw new HttpError(409, `Speicher-Limit überschritten: ${Math.round(used / 102.4) / 10} GB belegt, ${Math.round(server.disk_mb / 102.4) / 10} GB zugeteilt. Platz schaffen oder mehr Speicher zuteilen.`, 'disk_full');
      }
    }

    const rl = await limiter.consume(`power:${actor.id}:${server.id}`, LIMITS.power);
    if (!rl.ok) {
      reply.header('Retry-After', String(rl.retryAfterS));
      throw new HttpError(429, 'Zu viele Power-Aktionen - kurz warten', 'rate_limited');
    }

    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: `server.power.${action}`, ip: req.ip });

    // Bei manuellem Start/Restart/Stop den Absturz-Zaehler sofort zuruecksetzen
    await resetCrashCount(server.id).catch(() => {});

    // Ein Start kann Minuten dauern (Readiness). Die API antwortet sofort mit
    // 202, den Verlauf sieht die Oberflaeche ueber Status und Ereignisse.
    runInBackground(server.id, actor.id, action, () => power[action](server.id, { actorId: actor.id }));

    reply.code(202);
    return { accepted: true, action };
  });

  /** Zeitachse des Servers. Absturzdetails nur fuer Nutzer mit Konsolenrecht. */
  app.get<{ Params: { id: string } }>('/servers/:id/events', { preHandler: requireServer() }, async (req) => {
    const q = eventsQuery.parse(req.query);
    const { server, access } = req.target!;
    const actor = req.actor!;
    if (!can(actor, access, 'control.console') && !can(actor, access, 'activity.read')) {
      throw new HttpError(403, 'Fehlendes Recht: control.console oder activity.read', 'forbidden');
    }
    const rows = await sql<{ id: string; ts: Date; kind: string; severity: string; summary: string; payload: unknown; actor_name: string | null }[]>`
      SELECT e.id, e.ts, e.kind, e.severity, e.summary, e.payload, u.username AS actor_name
      FROM events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.server_id = ${server.id}
        ${q.before ? sql`AND e.id < ${q.before}` : sql``}
        ${q.kind ? sql`AND e.kind = ${q.kind}` : sql``}
        ${q.severity ? sql`AND e.severity = ${q.severity}` : sql``}
      ORDER BY e.id DESC
      LIMIT ${q.limit}
    `;
    const showPayload = can(actor, access, 'control.console');
    return {
      events: rows.map((r) => ({
        id: Number(r.id),
        ts: r.ts,
        kind: r.kind,
        severity: r.severity,
        summary: r.summary,
        actor: r.actor_name,
        ...(showPayload ? { payload: r.payload } : {}),
      })),
      nextBefore: rows.length === q.limit ? Number(rows[rows.length - 1]!.id) : null,
    };
  });

  /** Wer hat an diesem Server was getan. IP-Adressen nur fuer Admin und Besitzer. */
  app.get<{ Params: { id: string } }>('/servers/:id/activity', { preHandler: requireServer('activity.read') }, async (req) => {
    const q = eventsQuery.parse(req.query);
    const { server } = req.target!;
    const actor = req.actor!;
    const showIp = actor.role === 'admin' || server.owner_id === actor.id;
    const rows = await sql<{ id: string; created_at: Date; action: string; actor_name: string | null; metadata: unknown; ip: string | null }[]>`
      SELECT id, created_at, action, actor_name, metadata, host(ip) AS ip
      FROM audit_log
      WHERE server_id = ${server.id} ${q.before ? sql`AND id < ${q.before}` : sql``}
      ORDER BY id DESC LIMIT ${q.limit}
    `;
    return {
      activity: rows.map((r) => ({
        id: Number(r.id),
        ts: r.created_at,
        action: r.action,
        actor: r.actor_name,
        metadata: r.metadata,
        ...(showIp ? { ip: r.ip } : {}),
      })),
      nextBefore: rows.length === q.limit ? Number(rows[rows.length - 1]!.id) : null,
    };
  });
}

/**
 * Langlaufende Aktion ohne die Anfrage aufzuhalten. Fehler landen als
 * Ereignis in der Zeitachse - dort sieht sie die Oberflaeche.
 */
function runInBackground(serverId: string, actorId: string, action: string, fn: () => Promise<void>) {
  void fn().catch(async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err, serverId, action }, 'Hintergrundaktion fehlgeschlagen');
    // Installation schreibt ihr Fehlerereignis selbst (create_failed) - nicht doppelt.
    if (action === 'install' || action === 'reinstall') return;
    await writeEvent({
      serverId,
      kind: 'power_failed',
      severity: 'error',
      actorId,
      summary: `${action} fehlgeschlagen: ${message}`,
      code: 'power_failed',
      params: { action, error: message },
      payload: { action, error: message },
    });
  });
}
