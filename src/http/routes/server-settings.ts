import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { sql } from '../../db/index.js';
import { volumePath } from '../../docker/client.js';
import { parseRules } from '../../eggs/rules.js';
import { validateVariables, substitute, isGeneratedDefault } from '../../eggs/variables.js';
import { allocatePorts, releasePorts, nodeNetwork, type EggPorts } from '../../servers/allocations.js';
import { STOPPED_STATES, StateError } from '../../servers/create.js';
import { can } from '../../auth/permissions.js';
import { writeAudit } from '../../audit.js';
import type { RateLimiter } from '../../auth/ratelimit.js';
import { HttpError, requireServer } from '../auth.js';
import type { ServerOps } from './servers.js';
import { syncAllDns } from '../../network/dns.js';
import { log } from '../../log.js';

/**
 * Einstellungen eines bestehenden Servers.
 *
 * Was Docker beim Anlegen festschreibt (Umgebungsvariablen, Image, Ports),
 * laesst sich nur durch einen neuen Container aendern. Das geht nur im
 * gestoppten Zustand - die Spieldaten im Volume bleiben dabei erhalten.
 * RAM und CPU dagegen lassen sich live nachziehen.
 */

export const startupBody = z.object({
  variables: z.record(z.string().max(64), z.string().max(4096)).optional(),
  imageKey: z.string().max(200).optional(),
}).refine((b) => b.variables || b.imageKey, 'Nichts zu aendern');

export const resourcesBody = z.object({
  ramMb: z.number().int().min(128).max(1_048_576).optional(),
  cpuPercent: z.number().int().min(10).max(6400).optional(),
  diskMb: z.number().int().min(256).max(10_485_760).optional(),
  bandwidthDownloadKbps: z.number().int().min(1).max(10_000_000).optional().nullable(),
  bandwidthUploadKbps: z.number().int().min(1).max(10_000_000).optional().nullable(),
}).refine((b) => Object.keys(b).length > 0, 'Nichts zu aendern');

export const extraPortBody = z.object({
  /** Kurzname, wird im Container als <NAME>_PORT bekannt, z. B. "dynmap" -> DYNMAP_PORT */
  ref: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,23}$/, 'Nur Kleinbuchstaben, Ziffern, _ (2-24 Zeichen)'),
  protocol: z.enum(['tcp', 'udp', 'both']).default('tcp'),
});

export const domainBody = z.object({
  subdomain: z.string().trim().toLowerCase().regex(/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/, 'Ungültige Subdomain (nur a-z, 0-9 und Bindestrich, 2-32 Zeichen)').nullable().optional(),
  customDomain: z.string().trim().toLowerCase().max(128).nullable().optional(),
  srvRecordEnabled: z.boolean().optional(),
});

function requireStopped(status: string) {
  if (!(STOPPED_STATES as readonly string[]).includes(status)) {
    throw new HttpError(409, `Server ist "${status}" - diese Aenderung geht nur im gestoppten Zustand`, 'must_stop');
  }
}

async function rebuild(ops: ServerOps, serverId: string, actorId: string, reason: string) {
  try {
    await ops.rebuild(serverId, { actorId, reason });
  } catch (err) {
    if (err instanceof StateError) throw new HttpError(409, err.message, 'must_stop');
    throw err;
  }
}

export async function serverSettingsRoutes(app: FastifyInstance, opts: { ops: ServerOps; limiter: RateLimiter }) {
  const { ops } = opts;

  /** Aktuelle Spiel-Einstellungen als Formular - wie beim Anlegen, mit den gesetzten Werten. */
  app.get<{ Params: { id: string } }>('/servers/:id/startup', { preHandler: requireServer('startup.read') }, async (req) => {
    const { server, access } = req.target!;
    const [egg] = await sql<{ docker_images: Record<string, string>; default_image: string | null }[]>`
      SELECT docker_images, default_image FROM eggs WHERE id = ${server.egg_id}`;
    const defs = await sql<{ name: string; description: string | null; env_variable: string; default_value: string | null;
      rules: string | null; requires: string | null; is_secret: boolean; user_editable: boolean }[]>`
      SELECT name, description, env_variable, default_value, rules, requires, is_secret, user_editable
      FROM egg_variables WHERE egg_id = ${server.egg_id} AND user_viewable
        -- Vom Panel verwaltete Werte (z. B. Java-Heap) gehoeren nicht ins Formular.
        AND user_editable
      ORDER BY sort_order`;
    const canEdit = can(req.actor!, access, 'startup.update');
    // Vom Panel gesetzte Werte (z. B. Java-Heap) so zeigen, wie der Container
    // sie bekommt - nicht als rohen Platzhalter {{SERVER_MEMORY_HEAP}}M.
    const allocs = await sql<{ port: number; ref: string | null; is_primary: boolean }[]>`
      SELECT port, ref, is_primary FROM allocations WHERE server_id = ${server.id}`;
    const ctx = {
      variables: server.variables, ramMb: server.ram_mb, ip: '0.0.0.0',
      port: allocs.find((a) => a.is_primary)?.port ?? 0,
      ports: Object.fromEntries(allocs.filter((a) => a.ref).map((a) => [a.ref!, a.port])),
      serverDir: '', serverName: server.name,
    };
    return {
      startup: server.startup,
      images: Object.entries(egg?.docker_images ?? {}).map(([key, image]) => ({ key, label: key, image, default: image === egg?.default_image, current: image === server.docker_image })),
      variables: defs.map((d) => {
        const r = parseRules(d.rules, d.env_variable);
        const value = d.user_editable ? server.variables[d.env_variable] ?? '' : substitute(d.default_value ?? '', ctx);
        return {
          env: d.env_variable, label: d.name, description: d.description,
          // Geheime Werte (RCON-, Admin-, Serverpasswoerter) nur an die, die sie
          // ohnehin aendern duerfen - dort fuer das Auge-Symbol zum Einblenden.
          // Reine Zuschauer (startup.read) bekamen sonst z. B. das ARK-Admin-Passwort.
          value: d.is_secret && !canEdit ? '' : value,
          isSet: value !== '',
          default: d.is_secret || isGeneratedDefault(d.default_value) ? null : d.default_value,
          secret: d.is_secret,
          editable: d.user_editable && canEdit,
          requires: d.requires, widget: d.is_secret ? 'password' : r.widget, required: r.required, type: r.type,
          ...(r.options ? { options: r.options } : {}),
          ...(r.min !== undefined ? { min: r.min } : {}),
          ...(r.max !== undefined ? { max: r.max } : {}),
        };
      }),
    };
  });

  app.patch<{ Params: { id: string } }>('/servers/:id/startup', { preHandler: requireServer() }, async (req, reply) => {
    const body = startupBody.parse(req.body);
    const { server, access } = req.target!;
    const actor = req.actor!;
    if (body.variables && !can(actor, access, 'startup.update')) throw new HttpError(403, 'Fehlendes Recht: startup.update', 'forbidden');
    if (body.imageKey && !can(actor, access, 'startup.image')) throw new HttpError(403, 'Fehlendes Recht: startup.image', 'forbidden');
    requireStopped(server.status);

    let variables = server.variables;
    if (body.variables) {
      const defs = await sql<{ env_variable: string; default_value: string | null; rules: string | null; user_editable: boolean; is_secret: boolean }[]>`
        SELECT env_variable, default_value, rules, user_editable, is_secret FROM egg_variables WHERE egg_id = ${server.egg_id}`;
      // Ausgangspunkt sind die bisherigen Werte; ein leeres Geheimnis heisst "unveraendert".
      const input: Record<string, string> = { ...server.variables };
      for (const [k, v] of Object.entries(body.variables)) {
        const d = defs.find((x) => x.env_variable === k);
        if (!d || !d.user_editable) continue;
        if (d.is_secret && v === '') continue;
        input[k] = v;
      }
      const { values, errors } = validateVariables(defs, input);
      if (errors.length) return reply.code(400).send({ error: 'Ungueltige Werte', code: 'invalid_variables', issues: errors });
      // Nicht editierbare behalten ihren gespeicherten Wert (das Panel setzt sie beim Container-Bau).
      for (const d of defs) if (!d.user_editable) values[d.env_variable] = server.variables[d.env_variable] ?? '';
      variables = values;
    }

    let image = server.docker_image;
    if (body.imageKey) {
      const [egg] = await sql<{ docker_images: Record<string, string> }[]>`SELECT docker_images FROM eggs WHERE id = ${server.egg_id}`;
      const img = egg?.docker_images[body.imageKey];
      if (!img) throw new HttpError(400, `Image "${body.imageKey}" gibt es in diesem Egg nicht`, 'invalid_input');
      image = img;
    }

    const changed = Object.keys(variables).filter((k) => variables[k] !== server.variables[k]);
    await sql`UPDATE servers SET variables = ${sql.json(variables)}, docker_image = ${image} WHERE id = ${server.id}`;
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.startup_update', ip: req.ip,
      metadata: { changed, image: image !== server.docker_image ? image : undefined } });
    await rebuild(ops, server.id, actor.id, [changed.length ? `Einstellungen: ${changed.join(', ')}` : '', image !== server.docker_image ? `Image ${image}` : ''].filter(Boolean).join('; ') || 'Einstellungen');
    return { ok: true, changed };
  });

  /** RAM, CPU, Speicher. Nur Admin und Besitzer - das ist Budget, kein Server-Recht. */
  app.patch<{ Params: { id: string } }>('/servers/:id/resources', { preHandler: requireServer() }, async (req) => {
    const body = resourcesBody.parse(req.body);
    const { server } = req.target!;
    const actor = req.actor!;
    if (actor.role !== 'admin' && server.owner_id !== actor.id) throw new HttpError(403, 'Leistung aendern duerfen nur Admin und Besitzer', 'forbidden');

    const next = {
      ram: body.ramMb ?? server.ram_mb,
      cpu: body.cpuPercent ?? server.cpu_percent,
      disk: body.diskMb ?? server.disk_mb,
      bandwidthDownload: body.bandwidthDownloadKbps ?? server.bandwidth_download_kbps,
      bandwidthUpload: body.bandwidthUploadKbps ?? server.bandwidth_upload_kbps,
    };
    if (actor.role !== 'admin') {
      const [b] = await sql<{ ram_limit_mb: number; disk_limit_mb: number; ram: number; disk: number }[]>`
        SELECT u.ram_limit_mb, u.disk_limit_mb,
               coalesce(sum(s.ram_mb) FILTER (WHERE s.id <> ${server.id}), 0)::int AS ram,
               coalesce(sum(s.disk_mb) FILTER (WHERE s.id <> ${server.id}), 0)::int AS disk
        FROM users u LEFT JOIN servers s ON s.owner_id = u.id WHERE u.id = ${server.owner_id} GROUP BY u.id`;
      if (b && b.ram_limit_mb > 0 && b.ram + next.ram > b.ram_limit_mb) throw new HttpError(409, `RAM-Budget reicht nicht: ${b.ram_limit_mb - b.ram} MB frei`, 'limit_ram');
      if (b && b.disk_limit_mb > 0 && b.disk + next.disk > b.disk_limit_mb) throw new HttpError(409, `Speicher-Budget reicht nicht: ${b.disk_limit_mb - b.disk} MB frei`, 'limit_disk');
    }
    await sql`UPDATE servers SET ram_mb = ${next.ram}, cpu_percent = ${next.cpu}, disk_mb = ${next.disk}, bandwidth_download_kbps = ${next.bandwidthDownload}, bandwidth_upload_kbps = ${next.bandwidthUpload} WHERE id = ${server.id}`;
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.resources_update', ip: req.ip,
      metadata: { from: { ram: server.ram_mb, cpu: server.cpu_percent, disk: server.disk_mb, bandwidthDownload: server.bandwidth_download_kbps, bandwidthUpload: server.bandwidth_upload_kbps }, to: next } });

    // RAM/CPU sofort am Container; der Java-Heap haengt aber an einer
    // Umgebungsvariable und folgt erst mit neuem Container -> beim
    // naechsten Stopp oder sofort, wenn der Server ohnehin aus ist.
    let rebuilt = false;
    if (next.ram !== server.ram_mb && (STOPPED_STATES as readonly string[]).includes(server.status) && server.container_id) {
      await rebuild(ops, server.id, actor.id, `RAM ${server.ram_mb} -> ${next.ram} MB`);
      rebuilt = true;
    } else if (server.container_id) {
      await ops.updateResources(server.id);
    }
    return { ok: true, live: !rebuilt, restartNeeded: next.ram !== server.ram_mb && !rebuilt };
  });

  /** Ports neu vergeben - z. B. um einen alten Server in den weitergeleiteten Bereich zu holen. */
  app.post<{ Params: { id: string } }>('/servers/:id/reallocate', { preHandler: requireServer() }, async (req) => {
    const { server, access } = req.target!;
    const actor = req.actor!;
    if (!can(actor, access, 'allocation.assign')) throw new HttpError(403, 'Fehlendes Recht: allocation.assign', 'forbidden');
    requireStopped(server.status);

    const old = await sql<{ port: number; ref: string | null }[]>`SELECT port, ref FROM allocations WHERE server_id = ${server.id} ORDER BY is_primary DESC, port`;
    const [egg] = await sql<{ ports: EggPorts | null }[]>`SELECT ports FROM eggs WHERE id = ${server.egg_id}`;
    const spec: EggPorts = egg?.ports ?? { primary: { ref: 'game', protocol: 'both' } };
    // Zusaetzliche Ports (vom Nutzer angelegt) mitnehmen
    const extra = await sql<{ ref: string; protocol: 'tcp' | 'udp' | 'both' }[]>`
      SELECT ref, protocol FROM allocations WHERE server_id = ${server.id} AND ref IS NOT NULL
        AND ref NOT IN ${sql([spec.primary.ref, ...(spec.secondary ?? []).map((x) => x.ref)])}`;

    await releasePorts(server.id, 5);
    let fresh;
    try {
      fresh = await allocatePorts(server.node_id, server.id, spec);
      for (const e of extra) await addExtraPort(server.id, server.node_id, e.ref, e.protocol);
    } catch (err) {
      // Zurueck auf die alten Ports, damit der Server nicht ohne dasteht.
      await sql`UPDATE allocations SET server_id = NULL WHERE server_id = ${server.id}`;
      for (const o of old) {
        await sql`UPDATE allocations SET server_id = ${server.id}, ref = ${o.ref}, blocked_until = NULL,
                  is_primary = ${o === old[0]} WHERE node_id = ${server.node_id} AND port = ${o.port}`;
      }
      throw new HttpError(409, err instanceof Error ? err.message : 'Keine freien Ports', 'no_free_port');
    }
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.reallocate', ip: req.ip,
      metadata: { from: old.map((o) => o.port), to: fresh.map((f) => f.port) } });
    await rebuild(ops, server.id, actor.id, `Ports ${old.map((o) => o.port).join(', ')} -> ${fresh.map((f) => f.port).join(', ')}`);
    return { ok: true, ports: fresh.map((f) => ({ ref: f.ref, port: f.port })) };
  });

  /** Zusaetzlicher Port, z. B. fuer Dynmap oder Simple Voice Chat. */
  app.post<{ Params: { id: string } }>('/servers/:id/allocations', { preHandler: requireServer('allocation.assign') }, async (req, reply) => {
    const body = extraPortBody.parse(req.body);
    const { server } = req.target!;
    const actor = req.actor!;
    requireStopped(server.status);
    const [dupe] = await sql`SELECT 1 FROM allocations WHERE server_id = ${server.id} AND ref = ${body.ref}`;
    if (dupe) throw new HttpError(409, `Es gibt schon einen Port "${body.ref}"`, 'conflict');
    let port: number;
    try {
      port = await addExtraPort(server.id, server.node_id, body.ref, body.protocol);
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : 'Kein freier Port', 'no_free_port');
    }
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.port_add', ip: req.ip, metadata: { ref: body.ref, port } });
    await rebuild(ops, server.id, actor.id, `Port ${port} (${body.ref}) hinzugefuegt`);
    reply.code(201);
    return { ref: body.ref, port, env: `${body.ref.toUpperCase()}_PORT` };
  });

  /** Liste bekannter Konfigurationsdateien (inkl. Mod- und Plugin-Ordner) fuer diesen Server abfragen */
  app.get<{ Params: { id: string } }>('/servers/:id/configs', { preHandler: requireServer('startup.read') }, async (req) => {
    const { server } = req.target!;
    const [egg] = await sql<{ raw_egg: { config_files?: Record<string, unknown> } | null }[]>`
      SELECT raw_egg FROM eggs WHERE id = ${server.egg_id}
    `;
    const declared = egg?.raw_egg?.config_files ? Object.keys(egg.raw_egg.config_files) : [];

    const candidateFiles = new Set<string>(declared);
    candidateFiles.add('server.properties');
    candidateFiles.add('bukkit.yml');
    candidateFiles.add('spigot.yml');
    candidateFiles.add('paper.yml');
    candidateFiles.add('purpur.yml');
    candidateFiles.add('pufferfish.yml');
    candidateFiles.add('velocity.toml');
    candidateFiles.add('ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini');
    candidateFiles.add('ShooterGame/Saved/Config/WindowsServer/Game.ini');
    candidateFiles.add('Pal/Saved/Config/LinuxServer/PalWorldSettings.ini');
    candidateFiles.add('server/rust/cfg/server.cfg');
    candidateFiles.add('enshrouded_server.json');
    candidateFiles.add('serverconfig.xml');
    candidateFiles.add('dedicatedserver.cfg');
    candidateFiles.add('FactoryGame/Saved/Config/LinuxServer/Game.ini');
    candidateFiles.add('game/dedicatedServer.xml');
    candidateFiles.add('ts3server.ini');

    const dir = volumePath(server.short_id);
    const configs: Array<{ path: string; name: string; exists: boolean; group: string }> = [];
    const seen = new Set<string>();

    for (const rel of candidateFiles) {
      const full = join(dir, rel);
      const exists = existsSync(full);
      if (exists || declared.includes(rel)) {
        seen.add(rel);
        configs.push({
          path: rel,
          name: basename(rel),
          exists,
          group: 'main',
        });
      }
    }

    // Mod- und Plugin-Konfigurationsordner automatisch durchsuchen
    const modDirs = [
      { folder: 'config', group: 'config' },
      { folder: 'defaultconfigs', group: 'defaultconfigs' },
      { folder: 'world/serverconfig', group: 'serverconfig' },
      { folder: 'BepInEx/config', group: 'BepInEx/config' },
      { folder: 'oxide/config', group: 'oxide/config' },
      { folder: 'carbon/configs', group: 'carbon/configs' },
      { folder: 'plugins', group: 'plugins' },
    ];

    for (const { folder, group } of modDirs) {
      for (const item of scanModConfigFolder(dir, folder, group, 5, 5000)) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        configs.push(item);
      }
    }

    return { configs };
  });

  app.delete<{ Params: { id: string; port: string } }>('/servers/:id/allocations/:port', { preHandler: requireServer('allocation.assign') }, async (req) => {
    const { server } = req.target!;
    const actor = req.actor!;
    requireStopped(server.status);
    const port = Number(req.params.port);
    const [a] = await sql<{ is_primary: boolean; ref: string | null }[]>`SELECT is_primary, ref FROM allocations WHERE server_id = ${server.id} AND port = ${port}`;
    if (!a) throw new HttpError(404, 'Port gehoert nicht zu diesem Server', 'not_found');
    const [egg] = await sql<{ ports: EggPorts | null }[]>`SELECT ports FROM eggs WHERE id = ${server.egg_id}`;
    const eggRefs = [egg?.ports?.primary.ref, ...(egg?.ports?.secondary ?? []).filter((x) => !x.optional).map((x) => x.ref)];
    if (a.is_primary || eggRefs.includes(a.ref ?? undefined)) throw new HttpError(409, 'Diesen Port braucht das Spiel - er laesst sich nur neu vergeben, nicht entfernen', 'required_port');
    await sql`UPDATE allocations SET server_id = NULL, is_primary = false, ref = NULL, blocked_until = now() + interval '5 minutes'
              WHERE server_id = ${server.id} AND port = ${port}`;
    await writeAudit({ userId: actor.id, serverId: server.id, actorName: actor.username, action: 'server.port_remove', ip: req.ip, metadata: { port, ref: a.ref } });
    await rebuild(ops, server.id, actor.id, `Port ${port} entfernt`);
    return { ok: true };
  });

  /** Subdomain und SRV-Einstellungen des Servers aktualisieren */
  app.patch<{ Params: { id: string } }>('/servers/:id/domain', { preHandler: requireServer('allocation.assign') }, async (req) => {
    const { server } = req.target!;
    const actor = req.actor!;
    const body = domainBody.parse(req.body);

    const sub = body.subdomain !== undefined ? (body.subdomain?.trim().toLowerCase() || null) : undefined;
    const custom = body.customDomain !== undefined ? (body.customDomain?.trim().toLowerCase() || null) : undefined;

    if (sub) {
      const [dup] = await sql`SELECT 1 FROM servers WHERE lower(subdomain) = ${sub} AND id != ${server.id}`;
      if (dup) throw new HttpError(409, `Die Subdomain "${sub}" ist bereits für einen anderen Server vergeben`, 'subdomain_taken');
    }

    await sql`
      UPDATE servers SET
        subdomain = ${sub !== undefined ? sub : sql`subdomain`},
        custom_domain = ${custom !== undefined ? custom : sql`custom_domain`},
        srv_record_enabled = ${body.srvRecordEnabled !== undefined ? body.srvRecordEnabled : sql`srv_record_enabled`}
      WHERE id = ${server.id}
    `;

    await writeAudit({
      userId: actor.id,
      serverId: server.id,
      actorName: actor.username,
      action: 'server.domain_update',
      ip: req.ip,
      metadata: { subdomain: sub, customDomain: custom, srvRecordEnabled: body.srvRecordEnabled },
    });

    // Im Hintergrund DNS synchronisieren
    void syncAllDns().catch((err) => log.warn({ err }, 'DNS Sync nach Subdomain-Aenderung fehlgeschlagen'));

    return {
      ok: true,
      subdomain: sub !== undefined ? sub : server.subdomain,
      customDomain: custom !== undefined ? custom : server.custom_domain,
      srvRecordEnabled: body.srvRecordEnabled !== undefined ? body.srvRecordEnabled : (server.srv_record_enabled ?? true),
    };
  });
}

const CONFIG_EXT_RE = /\.(toml|cfg|conf|ini|properties|json|json5|jsonc|yml|yaml|snbt|xml)$/i;

/** Durchsucht einen Mod-/Plugin-Ordner ebenenweise (Breadth-First) nach Konfigurationsdateien (max. 2 MB je Datei). */
function scanModConfigFolder(
  volumeRoot: string,
  relFolder: string,
  group: string,
  maxDepth: number,
  maxFiles: number,
): Array<{ path: string; name: string; exists: boolean; group: string }> {
  const rootTarget = join(volumeRoot, relFolder);
  if (!existsSync(rootTarget)) return [];

  const results: Array<{ path: string; name: string; exists: boolean; group: string }> = [];
  const queue: Array<{ rel: string; depth: number }> = [{ rel: relFolder, depth: 1 }];

  while (queue.length > 0 && results.length < maxFiles) {
    const { rel: currentRel, depth } = queue.shift()!;
    let entries;
    try {
      entries = readdirSync(join(volumeRoot, currentRel), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Erst alle Dateien auf dieser Ebene aufnehmen, Unterordner fuer die naechste Ebene vormerken
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (entry.name.startsWith('.')) continue;
      const childRel = `${currentRel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          // Cache-, Backup- und Temp-Unterordner in Mods/Plugins ueberspringen
          if (/^(cache|backups?|logs?|tmp|temp|lang|locales?|schematics|assets|textures)$/i.test(entry.name)) continue;
          queue.push({ rel: childRel, depth: depth + 1 });
        }
      } else if (entry.isFile() && CONFIG_EXT_RE.test(entry.name)) {
        try {
          const st = statSync(join(volumeRoot, childRel));
          if (st.size > 2 * 1024 * 1024) continue;
        } catch {
          continue;
        }
        const display = childRel.slice(relFolder.length + 1);
        results.push({
          path: childRel,
          name: display,
          exists: true,
          group,
        });
      }
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/** Einen einzelnen Port aus dem Bereich des Hosts (oder 25500-25600 als Rueckfall) vergeben. */
async function addExtraPort(serverId: string, nodeId: string, ref: string, protocol: 'tcp' | 'udp' | 'both'): Promise<number> {
  const { range } = await nodeNetwork(nodeId);
  const spec: EggPorts = { primary: { ref, protocol, ...(range ? {} : { start: 25500, end: 25999 }) } };
  // allocatePorts setzt is_primary - fuer Zusatzports danach zuruecknehmen.
  const [a] = await allocatePorts(nodeId, `${serverId}`, spec);
  await sql`UPDATE allocations SET is_primary = false WHERE server_id = ${serverId} AND port = ${a!.port}`;
  return a!.port;
}
