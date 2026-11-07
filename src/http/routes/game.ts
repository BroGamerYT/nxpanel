import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { chown, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { config } from '../../config.js';
import { sql } from '../../db/index.js';
import { writeAudit } from '../../audit.js';
import { gameStatus, querySpec, rconCommand } from '../../games/status.js';
import { ADAPTERS, PLAYER_ID } from '../../games/adapters.js';
import { HttpError, requireServer } from '../auth.js';
import { can } from '../../auth/permissions.js';

/**
 * Live aus dem Spiel: Spieler, TPS, Antwortzeit - und Spielerverwaltung
 * (kicken, bannen, Whitelist, OP). Gilt fuer Spiele, deren Egg "query"
 * angibt; bisher Minecraft (jeder Servertyp).
 */
export const iconBody = z.object({ png: z.string().min(20).max(200_000) });

/** Minecraft-Namen: 3-16 Zeichen, Buchstaben, Ziffern, Unterstrich. Alles andere waere RCON-Injektion. */
const playerName = z.string().regex(/^[A-Za-z0-9_]{2,16}$/, 'Ungueltiger Spielername');
export const playerActionBody = z.object({
  action: z.enum(['kick', 'ban', 'pardon', 'op', 'deop', 'whitelist_add', 'whitelist_remove']),
  /** Minecraft: der Spielername. Andere Spiele: Anzeigename (nur fuers Protokoll). */
  name: z.string().min(1).max(64).regex(/^[^\r\n]*$/),
  /** ARK/Palworld: EOS- bzw. Steam-ID - darueber laufen dort Kicken und Bannen. */
  id: z.string().regex(PLAYER_ID).optional(),
  // Kein Zeilenumbruch: der Text landet in einem Konsolenbefehl.
  reason: z.string().max(200).regex(/^[^\r\n]*$/).optional(),
  /** Nur fuer "ban": nach so vielen Minuten hebt das Panel den Bann auf. Leer = dauerhaft. */
  minutes: z.number().int().min(1).max(60 * 24 * 365).optional(),
});

interface McBan { name?: string; reason?: string; created?: string; expires?: string; source?: string }

async function readJson<T>(dir: string, file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(join(dir, file), 'utf8')) as T; } catch { return null; }
}

export async function gameRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/servers/:id/game-status', { preHandler: requireServer() }, async (req) => {
    const { server } = req.target!;
    const spec = await querySpec(server.egg_id);
    if (!spec) throw new HttpError(404, 'Fuer dieses Spiel gibt es keine Live-Abfrage', 'unsupported');
    if (server.status !== 'running') return { kind: spec.kind, running: false };
    return { running: true, ...(await gameStatus(server, spec)) };
  });

  /** Bann-, Whitelist- und OP-Liste - direkt aus den Dateien des Servers, geht also auch gestoppt. */
  app.get<{ Params: { id: string } }>('/servers/:id/players/lists', { preHandler: requireServer() }, async (req) => {
    const { server, access } = req.target!;
    const actor = req.actor!;
    if (!can(actor, access, 'player.read') && !can(actor, access, 'control.console')) {
      throw new HttpError(403, 'Fehlendes Recht: player.read', 'forbidden');
    }
    const spec = await querySpec(server.egg_id);
    if (spec && spec.kind !== 'minecraft') {
      // Diese Spiele haben keine lesbare Bannliste - das Panel kennt die Banns, die es selbst verhaengt hat.
      const rows = await sql<{ player: string; player_id: string | null; reason: string | null; until: Date | null; created_at: Date; by: string | null }[]>`
        SELECT b.player, b.player_id, b.reason, b.until, b.created_at, u.username AS by FROM player_bans b LEFT JOIN users u ON u.id = b.created_by
        WHERE b.server_id = ${server.id} AND b.lifted_at IS NULL ORDER BY b.id DESC`;
      return { bans: rows.map((r) => ({ name: r.player, id: r.player_id, reason: r.reason, created: r.created_at.toISOString(), by: r.by, until: r.until?.toISOString() ?? null })),
        whitelist: [], ops: [], source: 'panel' };
    }
    const dir = resolve(config.VOLUME_ROOT, server.short_id);
    const [bans, white, ops] = await Promise.all([
      readJson<McBan[]>(dir, 'banned-players.json'),
      readJson<Array<{ name?: string }>>(dir, 'whitelist.json'),
      readJson<Array<{ name?: string; level?: number }>>(dir, 'ops.json'),
    ]);
    const timed = await sql<{ player: string; until: Date }[]>`
      SELECT DISTINCT ON (lower(player)) player, until FROM player_bans
      WHERE server_id = ${server.id} AND lifted_at IS NULL AND until IS NOT NULL ORDER BY lower(player), id DESC`;
    const until = new Map(timed.map((b) => [b.player.toLowerCase(), b.until.toISOString()]));
    return {
      bans: (bans ?? []).filter((b) => b.name).map((b) => ({
        name: b.name!, reason: b.reason ?? null, created: b.created ?? null, by: b.source ?? null,
        until: until.get(b.name!.toLowerCase()) ?? null,
      })),
      whitelist: (white ?? []).map((w) => w.name).filter(Boolean),
      ops: (ops ?? []).map((o) => o.name).filter(Boolean),
    };
  });

  app.post<{ Params: { id: string } }>('/servers/:id/players/action', { preHandler: requireServer() }, async (req) => {
    const { server, access } = req.target!;
    const actor = req.actor!;
    const body = playerActionBody.parse(req.body);

    if (body.action === 'kick' && !can(actor, access, 'player.kick') && !can(actor, access, 'control.command')) {
      throw new HttpError(403, 'Fehlendes Recht: player.kick', 'forbidden');
    }
    if ((body.action === 'ban' || body.action === 'pardon') && !can(actor, access, 'player.ban') && !can(actor, access, 'control.command')) {
      throw new HttpError(403, 'Fehlendes Recht: player.ban', 'forbidden');
    }
    if (
      (body.action === 'whitelist_add' || body.action === 'whitelist_remove' || body.action === 'op' || body.action === 'deop') &&
      !can(actor, access, 'player.whitelist') &&
      !can(actor, access, 'control.command')
    ) {
      throw new HttpError(403, 'Fehlendes Recht: player.whitelist', 'forbidden');
    }

    const spec = await querySpec(server.egg_id);
    if (!spec?.rcon) throw new HttpError(400, 'Fuer dieses Spiel gibt es keine Spielerverwaltung', 'unsupported');
    if (server.status !== 'running') throw new HttpError(409, 'Server muss laufen', 'must_run');
    const reason = body.reason?.trim();
    let cmd: string;
    if (spec.kind === 'minecraft') {
      const n = playerName.safeParse(body.name);
      if (!n.success) throw new HttpError(400, 'Ungueltiger Spielername', 'invalid_input');
      cmd = {
        kick: `kick ${body.name}${reason ? ` ${reason}` : ''}`,
        ban: `ban ${body.name}${reason ? ` ${reason}` : ''}`,
        pardon: `pardon ${body.name}`,
        op: `op ${body.name}`,
        deop: `deop ${body.name}`,
        whitelist_add: `whitelist add ${body.name}`,
        whitelist_remove: `whitelist remove ${body.name}`,
      }[body.action];
    } else {
      const adapter = ADAPTERS[spec.kind];
      if (!adapter || !(adapter.actions as string[]).includes(body.action)) throw new HttpError(400, 'Das kann dieses Spiel nicht', 'unsupported');
      if (!body.id) throw new HttpError(400, 'Spieler-ID fehlt', 'invalid_input');
      cmd = adapter.command(body.action as Parameters<typeof adapter.command>[0], body.id);
    }
    let out: string;
    try {
      out = await rconCommand(server, spec, cmd);
    } catch (e) {
      throw new HttpError(502, `RCON: ${e instanceof Error ? e.message : e}`, 'rcon_failed');
    }
    if (body.action === 'ban') {
      await sql`INSERT INTO player_bans (server_id, player, player_id, reason, until, created_by)
        VALUES (${server.id}, ${body.name}, ${body.id ?? null}, ${reason ?? null},
                ${body.minutes ? new Date(Date.now() + body.minutes * 60_000) : null}, ${req.actor!.id})`;
    }
    if (body.action === 'pardon') {
      await sql`UPDATE player_bans SET lifted_at = now() WHERE server_id = ${server.id} AND lifted_at IS NULL
        AND (${body.id ? sql`player_id = ${body.id}` : sql`lower(player) = lower(${body.name})`})`;
    }
    await writeAudit({ userId: req.actor!.id, serverId: server.id, actorName: req.actor!.username, action: `player.${body.action}`, ip: req.ip,
      metadata: { name: body.name, ...(body.id ? { id: body.id } : {}), ...(reason ? { reason } : {}), ...(body.minutes ? { minutes: body.minutes } : {}) } });
    return { ok: true, output: out.trim() };
  });

  /** Minecraft-Servericon (64x64 PNG) - liegt als server-icon.png im Datenordner. */
  app.get<{ Params: { id: string } }>('/servers/:id/mc/icon', { preHandler: requireServer() }, async (req, reply) => {
    const { server } = req.target!;
    const data = await readFile(join(resolve(config.VOLUME_ROOT, server.short_id), 'server-icon.png')).catch(() => null);
    if (!data) throw new HttpError(404, 'Kein Icon', 'not_found');
    reply.header('Content-Type', 'image/png').header('Cache-Control', 'no-store');
    return reply.send(data);
  });

  app.put<{ Params: { id: string } }>('/servers/:id/mc/icon', { preHandler: requireServer('startup.update') }, async (req) => {
    const { server } = req.target!;
    const { png } = iconBody.parse(req.body);
    const buf = Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64');
    // Nur echte PNGs in genau 64x64 - so verlangt es Minecraft, alles andere ignoriert der Server.
    const isPng = buf.length > 24 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (!isPng || buf.readUInt32BE(16) !== 64 || buf.readUInt32BE(20) !== 64) throw new HttpError(400, 'Icon muss ein PNG mit 64x64 Pixeln sein', 'invalid_input');
    const dir = resolve(config.VOLUME_ROOT, server.short_id);
    await mkdir(dir, { recursive: true });
    const iconPath = join(dir, 'server-icon.png');
    await writeFile(iconPath, buf, { mode: 0o644 });
    if (process.platform === 'linux' && process.getuid?.() === 0) {
      await chown(iconPath, 1000, 1000).catch(() => {});
    }
    await writeAudit({ userId: req.actor!.id, serverId: server.id, actorName: req.actor!.username, action: 'server.icon', ip: req.ip });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/servers/:id/mc/icon', { preHandler: requireServer('startup.update') }, async (req) => {
    const { server } = req.target!;
    await unlink(join(resolve(config.VOLUME_ROOT, server.short_id), 'server-icon.png')).catch(() => {});
    return { ok: true };
  });
}
