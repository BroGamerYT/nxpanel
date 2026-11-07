import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { engine, DEFAULT_TMP, RUNTIME_LABEL, runtimeKey, type TmpSpec } from '../docker/client.js';
import { writeEvent } from '../events.js';
import { setStatus } from './status.js';
import { allocatePorts, internalRefs, releasePorts, type EggPorts } from './allocations.js';
import { installServer } from './install.js';
import { validateVariables, substitute, fillGeneratedValues, isGeneratedDefault, type SubstitutionContext } from '../eggs/variables.js';
import { patchConfigFile, type ConfigFileSpec } from '../eggs/config-files.js';
import { filterCapabilities } from '../eggs/capabilities.js';
import { CURSEFORGE_KEY, getSetting } from '../settings.js';
import type { ServerRecord } from '../types.js';

export interface CreateServerInput {
  ownerId: string;
  nodeId: string;
  eggId: string;
  name: string;
  ramMb: number;
  diskMb: number;
  cpuPercent?: number;
  imageKey?: string;
  variables?: Record<string, string>;
  autoRestart?: boolean;
  autoSleepMinutes?: number;
  actorId?: string | null;
}

export class ValidationError extends Error {
  constructor(readonly issues: { variable: string; message: string }[]) {
    super(`Ungueltige Werte: ${issues.map((i) => i.variable).join(', ')}`);
    this.name = 'ValidationError';
  }
}

interface EggForCreate {
  id: string; name: string; docker_images: Record<string, string>; default_image: string | null;
  startup: string; ports: EggPorts | null; config_files: Record<string, ConfigFileSpec> | null;
  capabilities: string[]; data_dir: string; run_as: string | null;
  /** Optional aus dem Egg: Einstiegspunkt, falls das Image keinen passenden mitbringt. */
  entrypoint: string[] | null;
  /** Rohwert aus dem Egg: "disk" oder { "size_mb": n }. */
  tmp: unknown;
}

/** Egg-Angabe "tmp" deuten. Unbekanntes faellt auf die Vorgabe zurueck. */
export function tmpFromEgg(raw: unknown): TmpSpec {
  if (raw === 'disk') return { mode: 'disk' };
  if (raw && typeof raw === 'object' && typeof (raw as { size_mb?: unknown }).size_mb === 'number') {
    const mb = Math.round((raw as { size_mb: number }).size_mb);
    return { mode: 'tmpfs', sizeMb: Math.min(4096, Math.max(64, mb)) };
  }
  return DEFAULT_TMP;
}

async function loadEgg(eggId: string): Promise<EggForCreate> {
  const [egg] = await sql<EggForCreate[]>`
    SELECT id, name, docker_images, default_image, startup, ports, config_files, capabilities, data_dir, run_as,
           CASE WHEN jsonb_typeof(raw_egg->'entrypoint') = 'array' THEN raw_egg->'entrypoint' END AS entrypoint,
           raw_egg->'tmp' AS tmp
    FROM eggs WHERE id = ${eggId}`;
  if (!egg) throw new NotFoundError('Egg nicht gefunden');
  return egg;
}

export class NotFoundError extends Error {}

/**
 * Schritt 1, schnell und synchron: pruefen, Eintrag anlegen, Ports vergeben,
 * Startkommando einsetzen. Danach existiert der Server mit Status
 * "installing" und belegten Ports - die API kann sofort antworten.
 *
 * Scheitert hier etwas, bleibt nichts zurueck.
 */
export async function prepareServer(input: CreateServerInput): Promise<ServerRecord> {
  const egg = await loadEgg(input.eggId);

  const defs = await sql<{
    env_variable: string; default_value: string | null; rules: string | null; user_editable: boolean;
  }[]>`SELECT env_variable, default_value, rules, user_editable
       FROM egg_variables WHERE egg_id = ${input.eggId} ORDER BY sort_order`;

  // Felder mit Vorgabe {{GENERATE_PASSWORD}} bekommen ein Zufallspasswort,
  // wenn sie leer sind - vor der Pruefung, damit "required" erfuellt ist.
  const filled = fillGeneratedValues(defs, input.variables ?? {}, () => randomBytes(12).toString('base64url'));
  const { values, errors } = validateVariables(defs, filled.values);
  if (errors.length > 0) throw new ValidationError(errors);

  // Nie ueber die Reihenfolge der JSONB-Schluessel gehen - die stimmt nicht.
  const image = input.imageKey
    ? egg.docker_images[input.imageKey]
    : egg.default_image ?? Object.values(egg.docker_images)[0];
  if (!image) {
    throw new ValidationError([{ variable: 'image', message: input.imageKey ? `Image "${input.imageKey}" gibt es in diesem Egg nicht` : 'Egg nennt kein nutzbares Image' }]);
  }

  const shortId = randomBytes(4).toString('hex');

  const [created] = await sql<{ id: string }[]>`
    INSERT INTO servers (short_id, owner_id, node_id, egg_id, name, docker_image, startup,
                         status, ram_mb, disk_mb, cpu_percent, variables, auto_restart, auto_sleep_minutes)
    VALUES (${shortId}, ${input.ownerId}, ${input.nodeId}, ${input.eggId}, ${input.name},
            ${image}, ${egg.startup}, 'installing', ${input.ramMb}, ${input.diskMb},
            ${input.cpuPercent ?? 100}, ${sql.json(values)}, ${input.autoRestart ?? true}, ${input.autoSleepMinutes ?? 0})
    RETURNING id
  `;
  const serverId = created!.id;

  try {
    const portSpec: EggPorts = egg.ports ?? { primary: { ref: 'game', protocol: 'both' } };
    const allocations = await allocatePorts(input.nodeId, serverId, portSpec);
    const ctx = await buildContext(serverId, egg);
    const startup = substitute(egg.startup, ctx);
    await sql`UPDATE servers SET startup = ${startup} WHERE id = ${serverId}`;
    await writeEvent({
      serverId, kind: 'server_created', actorId: input.actorId ?? null,
      summary: `Server "${input.name}" angelegt (${egg.name}), Port ${allocations.find((a) => a.isPrimary)?.port}`,
      code: 'server_created',
      params: { name: input.name, egg: egg.name, port: allocations.find((a) => a.isPrimary)?.port ?? 0 },
      payload: { egg: egg.name, image, ports: Object.fromEntries(allocations.map((a) => [a.ref, a.port])) },
    });
  } catch (err) {
    await releasePorts(serverId, 0);
    await sql`DELETE FROM servers WHERE id = ${serverId}`;
    throw err;
  }

  const [server] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  return server!;
}

async function buildContext(serverId: string, egg: EggForCreate): Promise<SubstitutionContext> {
  const [s] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  const allocs = await sql<{ port: number; ref: string | null; is_primary: boolean }[]>`
    SELECT port, ref, is_primary FROM allocations WHERE server_id = ${serverId}`;
  const primary = allocs.find((a) => a.is_primary) ?? allocs[0];
  if (!s || !primary) throw new Error('Server oder Port fehlt');
  return {
    variables: s.variables,
    ramMb: s.ram_mb,
    ip: '0.0.0.0',
    port: primary.port,
    ports: Object.fromEntries(allocs.filter((a) => a.ref).map((a) => [a.ref!, a.port])),
    serverDir: egg.data_dir,
    serverName: s.name,
  };
}

export interface ProvisionOptions {
  /** CLI: bei Fehler alles entfernen. API: Server als install_failed stehen lassen, damit man sieht, was los war. */
  cleanupOnFailure?: boolean;
  actorId?: string | null | undefined;
}

/**
 * Schritt 2, langsam: Image holen, Container anlegen, installieren,
 * Konfiguration schreiben. Kann bei grossen Spielen viele Minuten dauern.
 */
export async function provisionServer(serverId: string, opts: ProvisionOptions = {}): Promise<ServerRecord> {
  const [server] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  if (!server) throw new NotFoundError('Server nicht gefunden');
  const egg = await loadEgg(server.egg_id);

  try {
    const ctx = await buildContext(serverId, egg);
    if (!server.container_id) {
      await createContainerFor(server, egg, ctx);
    }

    const [fresh] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
    const installed = await installServer(fresh!, { actorId: opts.actorId });
    if (installed) await applyConfigFiles(fresh!, egg.config_files, ctx);

    const [final] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
    log.info({ server: server.name, shortId: server.short_id, port: ctx.port }, 'Server bereitgestellt');
    return final!;
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : 'Anlegen fehlgeschlagen';
    log.error({ err, serverId }, 'Bereitstellung fehlgeschlagen');
    await writeEvent({ serverId, kind: 'create_failed', severity: 'error', summary: message });
    if (opts.cleanupOnFailure) {
      const [row] = await sql<{ container_id: string | null }[]>`SELECT container_id FROM servers WHERE id = ${serverId}`;
      if (row?.container_id) await engine.remove(row.container_id, true).catch(() => {});
      await releasePorts(serverId, 0);
      if (server?.short_id) await engine.removeVolume(server.short_id).catch(() => {});
      await sql`DELETE FROM servers WHERE id = ${serverId}`;
    } else {
      await setStatus(serverId, 'install_failed', { reason: message });
    }
    throw err;
  }
}

/** Legt den Container eines Servers an - aus dem, was gerade in der Datenbank steht. */
async function createContainerFor(server: ServerRecord, egg: EggForCreate, ctx: SubstitutionContext): Promise<string> {
  // Nicht editierbare Variablen gehoeren dem Panel, nicht dem Nutzer: sie
  // kommen immer frisch aus dem Egg (so wirken Egg-Updates auch bei
  // bestehenden Servern). Platzhalter wie {{SERVER_MEMORY_HEAP}} werden
  // erst hier eingesetzt, mit dem aktuellen RAM.
  const defs = await sql<{ env_variable: string; default_value: string | null; user_editable: boolean }[]>`
    SELECT env_variable, default_value, user_editable FROM egg_variables WHERE egg_id = ${egg.id}`;
  const vars: Record<string, string> = { ...server.variables, ...(await ensureRconPassword(server)) };
  for (const d of defs) if (!d.user_editable && !isGeneratedDefault(d.default_value)) vars[d.env_variable] = d.default_value ?? '';
  // CurseForge-Modpacks: ohne eigenen Schluessel am Server den des Panels nehmen.
  if ((vars.TYPE ?? '').toUpperCase() === 'AUTO_CURSEFORGE' && !(vars.CF_API_KEY ?? '').trim()) {
    const key = await getSetting(CURSEFORGE_KEY);
    if (key) vars.CF_API_KEY = key;
  }
  // Leere optionale Modpack-Variablen duerfen dem Container nicht uebergeben werden,
  // da z. B. itzg/minecraft-server mc-image-helper ein leeres CF_MODPACK_ZIP="" als
  // Pfad "" (aktuelles Verzeichnis /data) interpretiert und mit "Zip file seems to be a directory:" abstuerzt.
  const OMIT_IF_EMPTY = new Set([
    'CF_MODPACK_ZIP',
    'CF_API_KEY',
    'CF_SLUG',
    'CF_FILE_ID',
    'MODRINTH_MODPACK',
    'MODRINTH_VERSION',
    'FTB_MODPACK_ID',
    'FTB_MODPACK_VERSION_ID',
  ]);
  const envVars = Object.fromEntries(
    (Object.entries(vars) as [string, string][])
      .map(([k, v]): [string, string] => [k, substitute(v ?? '', ctx)])
      .filter(([k, v]) => !(OMIT_IF_EMPTY.has(k) && !v.trim()))
  );
  const internal = internalRefs(egg.ports);
  const allocs = (await sql<{ port: number; protocol: 'tcp' | 'udp' | 'both'; ref: string | null }[]>`
    SELECT port, protocol, ref FROM allocations WHERE server_id = ${server.id}`)
    // Interne Ports (RCON) nicht am Host freigeben
    .filter((a) => !(a.ref && internal.has(a.ref)));
  const containerId = await engine.create({
    shortId: server.short_id,
    serverId: server.id,
    ownerId: server.owner_id,
    image: server.docker_image,
    // TZ: sonst schreiben die Spiele ihre Logs in UTC und die Konsole liegt eine Stunde daneben.
    env: { TZ: config.TZ, ...envVars, SERVER_MEMORY: String(server.ram_mb), SERVER_PORT: String(ctx.port), STARTUP: server.startup },
    ramMb: server.ram_mb,
    swapMb: server.swap_mb,
    cpuPercent: server.cpu_percent,
    ioWeight: server.io_weight,
    // Nochmals durch den Filter, auch wenn der Import es schon tat: ein
    // von Hand geaenderter Datenbankeintrag soll keine Rechte erschleichen.
    capAdd: filterCapabilities(egg.capabilities).granted,
    dataDir: egg.data_dir,
    user: egg.run_as,
    tmp: tmpFromEgg(egg.tmp),
    ...(egg.entrypoint && egg.entrypoint.every((x) => typeof x === 'string') ? { entrypoint: egg.entrypoint } : {}),
    // Ein Port mit "both" braucht ZWEI Freigaben - tcp und udp. Vorher wurde
    // daraus nur tcp, und Spiele mit UDP (Palworld, Enshrouded, ARK) waeren
    // von aussen stumm geblieben.
    ports: allocs.flatMap((a) =>
      a.protocol === 'both'
        ? [{ containerPort: a.port, hostPort: a.port, protocol: 'tcp' as const }, { containerPort: a.port, hostPort: a.port, protocol: 'udp' as const }]
        : [{ containerPort: a.port, hostPort: a.port, protocol: a.protocol }]),
  });
  await sql`UPDATE servers SET container_id = ${containerId} WHERE id = ${server.id}`;
  return containerId;
}

/** Zustaende, in denen der Container ohne Datenverlust neu gebaut werden darf. */
export const STOPPED_STATES = ['offline', 'crashed', 'install_failed'] as const;

export class StateError extends Error {}

/**
 * Container neu anlegen, ohne neu zu installieren. Noetig, wenn sich etwas
 * aendert, das Docker beim Anlegen festschreibt: Umgebungsvariablen, Image,
 * Port-Freigaben. Die Spieldaten liegen im Volume und bleiben unberuehrt;
 * die Konfigurationsdateien schreibt der naechste Start ohnehin neu.
 */
/**
 * Passt der Container noch zum Egg? Manche Einstellungen (z. B. /tmp) lassen
 * sich nur beim Anlegen setzen. Weichen sie ab - etwa weil ein Egg-Update
 * "tmp": "disk" brachte -, wird der Container vor dem Start neu angelegt.
 * Container ohne Label stammen von vor dieser Pruefung; sie hatten die
 * Vorgabe und werden nur neu gebaut, wenn das Egg etwas anderes will.
 */
export async function ensureRuntimeCurrent(serverId: string, actorId?: string | null): Promise<boolean> {
  const [server] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  if (!server?.container_id) return false;
  // Leeres RCON-Passwort im Container: neu bauen, damit das erzeugte greift.
  if (Object.keys(await ensureRconPassword(server)).length) {
    await rebuildContainer(serverId, { actorId: actorId ?? null, reason: 'RCON-Passwort angelegt (war leer - TPS und Spielerverwaltung gingen nicht)' });
    return true;
  }
  const egg = await loadEgg(server.egg_id);
  const want = runtimeKey(tmpFromEgg(egg.tmp));
  const labels = await engine.labels(server.container_id);
  if (labels === null) return false;
  const have = labels[RUNTIME_LABEL] ?? runtimeKey(DEFAULT_TMP);
  if (have === want) return false;
  await rebuildContainer(serverId, { actorId: actorId ?? null, reason: `Laufzeit an das Spiel angepasst (${have} -> ${want})` });
  return true;
}

/** Braucht der Server ein Panel-RCON-Passwort? Leer oder fehlend = ja. */
export function rconPasswordMissing(passwordVar: string | null | undefined, variables: Record<string, string>): boolean {
  return Boolean(passwordVar) && !(variables[passwordVar!] ?? '').trim();
}

/**
 * Spiele mit RCON-Abfrage (query.rcon.password_var) brauchen ein Passwort.
 * Steht es leer in den Variablen, landet RCON_PASSWORD="" im Container - itzg
 * erzeugt dann KEIN eigenes ("No rcon password set ... rcon disabled") und TPS,
 * Spielerliste und Kick/Ban bleiben stumm. Das Panel legt dann eines an und
 * speichert es. Gibt die geaenderten Variablen zurueck (leer = nichts zu tun).
 */
export async function ensureRconPassword(server: ServerRecord): Promise<Record<string, string>> {
  const [egg] = await sql<{ v: string | null }[]>`
    SELECT raw_egg->'query'->'rcon'->>'password_var' AS v FROM eggs WHERE id = ${server.egg_id}`;
  const v = egg?.v;
  if (!v || !rconPasswordMissing(v, server.variables ?? {})) return {};
  const pw = randomBytes(18).toString('base64url');
  await sql`UPDATE servers SET variables = variables || ${sql.json({ [v]: pw })} WHERE id = ${server.id}`;
  server.variables = { ...server.variables, [v]: pw };
  log.info({ server: server.name, var: v }, 'RCON-Passwort angelegt');
  return { [v]: pw };
}

export async function rebuildContainer(serverId: string, opts: { actorId?: string | null; reason: string }): Promise<void> {
  const [server] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  if (!server) throw new NotFoundError('Server nicht gefunden');
  if (!(STOPPED_STATES as readonly string[]).includes(server.status)) {
    throw new StateError(`Server ist "${server.status}" - erst stoppen`);
  }
  const egg = await loadEgg(server.egg_id);
  const ctx = await buildContext(serverId, egg);
  const startup = substitute(egg.startup, ctx);
  await sql`UPDATE servers SET startup = ${startup}, container_id = NULL WHERE id = ${serverId}`;
  if (server.container_id) await engine.remove(server.container_id, true).catch(() => {});

  const [fresh] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  try {
    await createContainerFor(fresh!, egg, ctx);
  } catch (err) {
    // Alter Container ist weg, neuer kam nicht zustande: ehrlich als
    // fehlgeschlagen markieren - die Oberflaeche bietet dann "Erneut
    // installieren" an, statt einen Server zu zeigen, der nicht starten kann.
    const message = err instanceof Error ? err.message.slice(0, 200) : 'Container konnte nicht angelegt werden';
    await writeEvent({
      serverId,
      kind: 'rebuild_failed',
      severity: 'error',
      actorId: opts.actorId ?? null,
      summary: `Container neu anlegen fehlgeschlagen: ${message}`,
      code: 'rebuild_failed',
      params: { error: message },
    });
    if (server.status !== 'install_failed') await setStatus(serverId, 'install_failed', { reason: message, actorId: opts.actorId });
    throw err;
  }
  if (server.status === 'install_failed') {
    // Nach einem Neubau ist der Container da - der Fehlerzustand gilt nicht mehr.
    await setStatus(serverId, 'installing', { reason: 'Container neu angelegt', actorId: opts.actorId });
    await setStatus(serverId, 'offline', { reason: 'bereit', actorId: opts.actorId });
  }
  await writeEvent({
    serverId,
    kind: 'container_rebuilt',
    actorId: opts.actorId ?? null,
    summary: `Container neu angelegt: ${opts.reason}`,
    code: 'container_rebuilt',
    params: { reason: opts.reason },
  });
}

/**
 * Legt einen Server vollstaendig an (CLI). Schlaegt ein Schritt fehl, wird
 * wieder aufgeraeumt - halbe Server, die nur Ports belegen, sind sonst der
 * Normalfall.
 */
export async function createServer(input: CreateServerInput): Promise<ServerRecord> {
  const server = await prepareServer(input);
  return provisionServer(server.id, { cleanupOnFailure: true, actorId: input.actorId });
}

/**
 * Schreibt die Konfigurationsdateien des Eggs. Wird bei jedem Start erneut
 * ausgefuehrt, damit Port und IP stimmen, auch nach einem Umzug.
 */
export async function applyConfigFiles(
  server: ServerRecord,
  specs: Record<string, ConfigFileSpec> | null,
  ctx: SubstitutionContext,
): Promise<void> {
  if (!specs) return;

  for (const [relPath, spec] of Object.entries(specs)) {
    const full = join(config.VOLUME_ROOT, server.short_id, relPath);
    if (spec.parser === 'sqlite') {
      await patchSqlite(full, spec, ctx, relPath);
      continue;
    }
    let original: string;
    try {
      original = await readFile(full, 'utf8');
    } catch {
      log.debug({ file: relPath }, 'Konfigurationsdatei noch nicht vorhanden');
      continue;
    }

    const result = patchConfigFile(original, spec, ctx);
    if (result.changed.length === 0 && result.added.length === 0) continue;

    await writeFile(full, result.content, 'utf8');
    log.info({ file: relPath, changed: result.changed, added: result.added }, 'Konfiguration angepasst');

    if (result.skipped.length > 0) {
      log.warn({ file: relPath, skipped: result.skipped }, 'Schluessel nicht gefunden');
    }
  }
}

/** Entfernt einen Server samt Container, Ports und Daten. */
export async function deleteServer(serverId: string, actorId?: string | null): Promise<void> {
  const [server] = await sql<ServerRecord[]>`SELECT * FROM servers WHERE id = ${serverId}`;
  if (!server) return;

  if (server.container_id) await engine.remove(server.container_id, true).catch(() => {});
  await engine.removeVolume(server.short_id).catch(() => {});
  await releasePorts(serverId);

  await writeEvent({
    serverId: null, kind: 'server_deleted', actorId: actorId ?? null,
    summary: `Server "${server.name}" geloescht`,
    payload: { shortId: server.short_id },
  });

  await sql`DELETE FROM servers WHERE id = ${serverId}`;
  log.info({ server: server.name }, 'Server geloescht');
}

export { setStatus };

/**
 * Manche Server speichern Einstellungen in einer Datenbank statt in einer
 * Textdatei - TeamSpeak etwa den Sprach-Port je virtuellem Server. Nach
 * einem Umzug steht dort noch der alte Port, und der Server lauscht am
 * falschen Ort. Schluessel im Egg: "tabelle.spalte" -> neuer Wert.
 */
async function patchSqlite(file: string, spec: ConfigFileSpec, ctx: SubstitutionContext, relPath: string): Promise<void> {
  try {
    await readFile(file);
  } catch {
    return; // Datenbank gibt es noch nicht - der Server legt sie beim ersten Start an
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    for (const [key, template] of Object.entries(spec.find)) {
      const [table, column] = key.split('.');
      const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
      if (!table || !column || !ident.test(table) || !ident.test(column)) {
        log.warn({ file: relPath, key }, 'Ungueltiger Datenbank-Schluessel im Egg');
        continue;
      }
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === column)) {
        log.warn({ file: relPath, table, column }, 'Spalte nicht in der Datenbank - uebersprungen');
        continue;
      }
      const value = substitute(template, ctx);
      const r = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" IS NOT ?`).run(value, value);
      if (Number(r.changes) > 0) log.info({ file: relPath, key, value, rows: Number(r.changes) }, 'Datenbank angepasst');
    }
  } finally {
    db.close();
  }
}
