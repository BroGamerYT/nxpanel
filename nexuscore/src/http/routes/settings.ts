import type { FastifyInstance, FastifyReply } from 'fastify';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import type { HostDriver } from '../../drivers/interface.js';
import type { LoadedEgg } from '../../eggs/loader.js';
import { isSecretVariable, isUserVariable, parseRules, validateVariables } from '../../eggs/rules.js';
import { installKindFor, installSpecOf, type InstallManager } from '../../install/manager.js';
import { isMinecraftKind } from '../../install/minecraft.js';
import { dockerEnv } from '../../docker/egg-container.js';
import { heapMb } from '../../install/minecraft.js';
import { resolveInstanceDir } from '../../files/instance-dir.js';
import { allocatePort, isPortFree } from '../../protocol/ports.js';
import type { ServerRegistry } from '../../store/registry.js';
import type { ServerInstanceConfig, ServerPort } from '../../types.js';

/**
 * Einstellungen eines Servers (Block B4/B6): umbenennen, loeschen, Ressourcen,
 * Spiel-Einstellungen (Formular aus dem Egg) und Ports - dieselben Routen und
 * Antworten wie im Panel, damit der Reiter "Einstellungen" unveraendert laeuft.
 *
 * Der Core nimmt nur an, was er auch wirklich auswertet. Alles andere wird mit
 * einer klaren Meldung abgelehnt, statt es still zu speichern und nichts zu tun.
 */

export interface SettingsDeps {
  registry: ServerRegistry;
  driver: HostDriver;
  /** Sucht einen Server nach exakter ID oder 8-stelliger Kurz-ID. */
  find: (idOrShortId: string) => ServerInstanceConfig | undefined;
  /** Nur fuer die automatische Neuinstallation bei geaenderter Spielversion. */
  installs: InstallManager | null;
  eggs: () => Promise<LoadedEgg[]>;
  /** Pruefung, ob ein Port auf dem Rechner frei ist - in Tests austauschbar. */
  isPortFree?: (port: number) => Promise<boolean>;
  /** Nach dem Loeschen eines Servers (z. B. seine Backups entfernen). */
  onServerDeleted?: (id: string) => Promise<void>;
}

/** Was zu einem Server gehoert, aber nicht in seine Startkonfiguration. */
export interface ServerMeta {
  tags?: string[];
  isFavorite?: boolean;
  /** Zugeteilter Speicher in MB. Wird noch nicht durchgesetzt (Block B3). */
  diskMb?: number;
  /** Bandbreite in kbit/s. Wird noch nicht durchgesetzt (Block B3). */
  bandwidthDownloadKbps?: number | null;
  bandwidthUploadKbps?: number | null;
}

const metaKey = (id: string) => `server.${id}.meta`;

export function getServerMeta(registry: ServerRegistry, id: string): ServerMeta {
  return registry.getSetting<ServerMeta>(metaKey(id)) ?? {};
}

function saveServerMeta(registry: ServerRegistry, id: string, patch: Partial<ServerMeta>): void {
  registry.setSetting(metaKey(id), { ...getServerMeta(registry, id), ...patch });
}

// ------------------------------------------------------------ Eingaben

const refSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{0,23}$/, 'Nur Kleinbuchstaben, Ziffern, _ (bis 24 Zeichen)');

const patchBody = z.object({
  name: z.string().trim().min(1, 'Name darf nicht leer sein').max(64).optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  isFavorite: z.boolean().optional(),
  autoRestart: z.boolean().optional(),
  autoSleepMinutes: z.number().int().min(0).max(1440).optional(),
});

const resourcesBody = z
  .object({
    ramMb: z.number().int().min(128).max(1_048_576).optional(),
    cpuPercent: z.number().int().min(10).max(6400).optional(),
    diskMb: z.number().int().min(256).max(10_485_760).optional(),
    bandwidthDownloadKbps: z.number().int().min(1).max(10_000_000).nullable().optional(),
    bandwidthUploadKbps: z.number().int().min(1).max(10_000_000).nullable().optional(),
  })
  .refine((b) => Object.keys(b).length > 0, 'Nichts zu ändern');

const startupBody = z
  .object({
    variables: z.record(z.string().max(64), z.string().max(4096)).optional(),
    imageKey: z.string().max(200).optional(),
  })
  .refine((b) => b.variables || b.imageKey, 'Nichts zu ändern');

const addPortBody = z.object({
  port: z.number().int().min(1024).max(65535).optional(),
  ref: refSchema.optional().or(z.literal('')).nullable(),
  protocol: z.enum(['tcp', 'udp', 'both']).default('tcp'),
});

const updatePortBody = z.object({
  newPort: z.number().int().min(1024).max(65535).optional(),
  protocol: z.enum(['tcp', 'udp', 'both']).optional(),
  ref: refSchema.optional().or(z.literal('')).nullable(),
});

// ------------------------------------------------------------ Antworten

function fail(reply: FastifyReply, status: number, message: string, code: string, extra: Record<string, unknown> = {}): FastifyReply {
  return reply.status(status).send({ error: message, message, code, ...extra });
}

function invalidRequest(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const issues = error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  return fail(reply, 400, issues[0]?.message ?? 'Ungültige Anfrage', 'invalid_request', { issues });
}

type RunState = 'stopped' | 'running' | 'busy';

const protocolsOf = (protocol: 'tcp' | 'udp' | 'both'): Array<'tcp' | 'udp'> => (protocol === 'both' ? ['tcp', 'udp'] : [protocol]);

export function registerSettingsRoutes(server: FastifyInstance, deps: SettingsDeps): void {
  const { registry, driver, find, installs, eggs } = deps;
  const probe = deps.isPortFree ?? isPortFree;
  const base = '/api/v1/servers/:id';
  // Der Treiber kann eine Instanz abmelden (neu seit dem Loeschen).
  const unregisterable = driver as HostDriver & { unregisterServer?: (id: string) => Promise<void> };

  async function runState(c: ServerInstanceConfig): Promise<RunState> {
    if (installs?.isInstalling(c.id) || c.install?.state === 'installing') return 'busy';
    try {
      const state = await driver.getServerState(c.id);
      return state.status === 'offline' || state.status === 'error' ? 'stopped' : 'running';
    } catch {
      // Dem Treiber unbekannt (z. B. Installation fehlgeschlagen): nichts laeuft
      return 'stopped';
    }
  }

  /** Gibt dem Treiber die neue Konfiguration - nur, solange nichts laeuft; sonst gilt sie beim naechsten Start. */
  async function syncDriver(next: ServerInstanceConfig): Promise<void> {
    if (next.install && next.install.state !== 'done') return;
    if ((await runState(next)) !== 'stopped') return;
    await driver.updateServer?.(next).catch(() => {});
  }

  const instanceDir = (c: ServerInstanceConfig): Promise<string | null> => resolveInstanceDir(registry, c);

  /** Liefert den Server oder antwortet mit 404. */
  function need(id: string, reply: FastifyReply): ServerInstanceConfig | null {
    const c = find(id);
    if (!c) {
      fail(reply, 404, 'Server nicht gefunden', 'not_found');
      return null;
    }
    return c;
  }

  /** Aenderungen an Spiel, Ports und Treiberdaten gehen nur im gestoppten Zustand. */
  async function requireStopped(c: ServerInstanceConfig, reply: FastifyReply): Promise<boolean> {
    const state = await runState(c);
    if (state === 'stopped') return true;
    fail(
      reply,
      409,
      state === 'busy' ? 'Der Server wird gerade installiert.' : 'Der Server läuft - diese Änderung geht nur im gestoppten Zustand.',
      'must_stop',
    );
    return false;
  }

  // ---------------------------------------------------------------- Allgemein

  server.patch<{ Params: { id: string }; Body: unknown }>(base, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const body = patchBody.safeParse(req.body ?? {});
    if (!body.success) return invalidRequest(reply, body.error);

    // Was der Core nicht kann, wird abgelehnt statt still gemerkt.
    if (body.data.autoRestart === true) {
      return fail(reply, 400, 'Automatischer Neustart nach einem Absturz gibt es im Core noch nicht.', 'not_supported');
    }
    if (body.data.autoSleepMinutes !== undefined && body.data.autoSleepMinutes > 0) {
      return fail(reply, 400, 'Auto-Sleep (Ruhemodus bei Leerlauf) gibt es im Core noch nicht.', 'not_supported');
    }

    const patch: Partial<ServerMeta> = {};
    if (body.data.tags) patch.tags = Array.from(new Set(body.data.tags));
    if (body.data.isFavorite !== undefined) patch.isFavorite = body.data.isFavorite;
    if (Object.keys(patch).length > 0) saveServerMeta(registry, c.id, patch);

    if (body.data.name !== undefined && body.data.name !== c.name) {
      const next = { ...c, name: body.data.name };
      await registry.update(next);
      await syncDriver(next);
    }
    registry.audit('server.update', c.id, 'standalone', {
      ...(body.data.name !== undefined ? { name: body.data.name } : {}),
      ...(body.data.tags ? { tags: body.data.tags.length } : {}),
      ...(body.data.isFavorite !== undefined ? { isFavorite: body.data.isFavorite } : {}),
    });
    return { ok: true };
  });

  server.delete<{ Params: { id: string }; Querystring: { force?: string } }>(base, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const force = req.query?.force === 'true';

    const state = await runState(c);
    if (state === 'busy') return fail(reply, 409, 'Der Server wird gerade installiert - bitte warten.', 'invalid_state');
    if (state === 'running' && !force) {
      return fail(reply, 409, 'Der Server läuft - erst stoppen oder mit ?force=true beenden.', 'invalid_state');
    }

    // Protokoll VOR dem Loeschen: danach gibt es den Server nicht mehr.
    registry.audit('server.delete', c.id, 'standalone', { name: c.name, force });

    if (state === 'running') await driver.killServer(c.id).catch(() => {});

    // Erst die Dateien: schlaegt das fehl (gesperrt), bleibt der Server erhalten und man kann es erneut versuchen.
    const dir = await instanceDir(c);
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        return fail(
          reply,
          409,
          'Die Dateien des Servers konnten nicht gelöscht werden - vermutlich benutzt ein Programm sie noch. Bitte schließen und erneut versuchen.',
          'files_locked',
        );
      }
    }

    await unregisterable.unregisterServer?.(c.id);
    await registry.remove(c.id);
    registry.deleteSetting(metaKey(c.id));
    registry.deleteSetting(`server.${c.id}.backup_schedule`);
    await deps.onServerDeleted?.(c.id).catch(() => {});
    return { ok: true, filesDeleted: dir !== null };
  });

  // ---------------------------------------------------------------- Ressourcen

  server.patch<{ Params: { id: string }; Body: unknown }>(`${base}/resources`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const body = resourcesBody.safeParse(req.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const b = body.data;

    const ramBefore = c.maxMemoryMb ?? 2048;
    const ramNow = b.ramMb ?? ramBefore;
    // Der Java-Heap haengt an einem Startargument: bei neuer Groesse mitziehen.
    const args =
      isMinecraftKind(c.install?.kind) && ramNow !== ramBefore
        ? c.args.map((a) => (a.startsWith('-Xmx') ? `-Xmx${heapMb(ramNow)}M` : a))
        : c.args;
    let next: ServerInstanceConfig = { ...c, maxMemoryMb: ramNow, maxCpuPercent: b.cpuPercent ?? c.maxCpuPercent ?? 100, args };
    // Docker: SERVER_MEMORY und Platzhalter wie {{SERVER_MEMORY_HEAP}} im Startkommando folgen dem neuen Speicher
    if (c.container && ramNow !== ramBefore) {
      const egg = (await eggs()).find((e) => e.id === c.game);
      if (egg) next = { ...next, env: dockerEnvOf(next, egg, c.install?.variables ?? c.env ?? {}) };
    }
    await registry.update(next);

    // Speicher und Bandbreite merkt sich der Core (Anzeige, Budget); durchgesetzt wird davon noch nichts (B3).
    const meta: Partial<ServerMeta> = {};
    if (b.diskMb !== undefined) meta.diskMb = b.diskMb;
    if (b.bandwidthDownloadKbps !== undefined) meta.bandwidthDownloadKbps = b.bandwidthDownloadKbps;
    if (b.bandwidthUploadKbps !== undefined) meta.bandwidthUploadKbps = b.bandwidthUploadKbps;
    if (Object.keys(meta).length > 0) saveServerMeta(registry, c.id, meta);

    const state = await runState(c);
    await syncDriver(next);
    registry.audit('server.resources_update', c.id, 'standalone', {
      from: { ramMb: ramBefore, cpuPercent: c.maxCpuPercent ?? 100 },
      to: { ramMb: next.maxMemoryMb, cpuPercent: next.maxCpuPercent, ...meta },
    });
    return { ok: true, live: false, restartNeeded: ramNow !== ramBefore && state === 'running' };
  });

  // ---------------------------------------------------------------- Spiel-Einstellungen

  /** Die Egg-Variablen des Servers und die aktuell gesetzten Werte. */
  /** Docker: Umgebung des Containers aus den (neuen) Variablen und dem aktuellen Speicher berechnen. */
  function dockerEnvOf(c: ServerInstanceConfig, egg: LoadedEgg, variables: Record<string, string>): Record<string, string> {
    return dockerEnv(egg, variables, {
      name: c.name,
      ramMb: c.maxMemoryMb ?? 0,
      port: Number(c.env?.SERVER_PORT) || c.ports[0]?.hostPort || 0,
      refPorts: c.container?.refPorts ?? {},
      serverDir: c.container?.dataDir ?? '/data',
    });
  }

  async function variablesOf(c: ServerInstanceConfig): Promise<{ defs: NonNullable<LoadedEgg['raw']['variables']>; current: Record<string, string> }> {
    const egg = (await eggs()).find((e) => e.id === c.game);
    return { defs: egg?.raw.variables ?? [], current: { ...(c.env ?? {}), ...(c.install?.variables ?? {}) } };
  }

  server.get<{ Params: { id: string } }>(`${base}/startup`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const { defs, current } = await variablesOf(c);

    return {
      startup: [c.executable, ...c.args].filter(Boolean).join(' '),
      // Nur im Docker-Betrieb gibt es ein Image zu waehlen
      images: c.container
        ? ((await eggs()).find((e) => e.id === c.game)?.images ?? []).map((i) => ({ ...i, current: i.image === c.container?.image }))
        : [],
      variables: defs
        .filter(isUserVariable)
        .map((v) => {
          const rules = parseRules(v.rules, v.env_variable);
          const secret = isSecretVariable(v);
          const value = current[v.env_variable] ?? v.default_value ?? '';
          const generated = (v.default_value ?? '').trim() === '{{GENERATE_PASSWORD}}';
          return {
            env: v.env_variable,
            label: v.name,
            description: v.description ?? null,
            value,
            isSet: value !== '',
            default: secret || generated ? null : (v.default_value ?? null),
            secret,
            editable: true,
            requires: v.requires ?? null,
            widget: secret ? 'password' : rules.widget,
            required: rules.required,
            type: rules.type,
            ...(rules.options ? { options: rules.options } : {}),
            ...(rules.min !== undefined ? { min: rules.min } : {}),
            ...(rules.max !== undefined ? { max: rules.max } : {}),
          };
        }),
    };
  });

  server.patch<{ Params: { id: string }; Body: unknown }>(`${base}/startup`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const body = startupBody.safeParse(req.body);
    if (!body.success) return invalidRequest(reply, body.error);
    if (body.data.imageKey && !c.container) {
      return fail(reply, 400, 'Der Core startet Spiele ohne Container-Image - es gibt keine Laufzeit zu wählen.', 'invalid_input');
    }
    if (!(await requireStopped(c, reply))) return reply;

    const { defs, current } = await variablesOf(c);
    // Ausgangspunkt sind die bisherigen Werte; ein leeres Geheimnis heisst "unveraendert".
    const input: Record<string, string> = { ...current };
    for (const [key, value] of Object.entries(body.data.variables ?? {})) {
      const def = defs.find((d) => d.env_variable === key);
      if (!def || !isUserVariable(def)) continue;
      if (isSecretVariable(def) && value === '') continue;
      input[key] = value;
    }

    const { values, errors } = validateVariables(defs, input);
    // Der Core installiert derzeit nur Paper.
    if (isMinecraftKind(c.install?.kind) && !['PAPER', 'VANILLA'].includes((values.TYPE ?? 'PAPER').toUpperCase())) {
      errors.push({ variable: 'TYPE', message: 'Der Core installiert derzeit nur Paper und Vanilla.' });
    }
    if (errors.length > 0) {
      return reply.status(400).send({ error: 'Ungültige Werte', message: 'Ungültige Werte', code: 'invalid_variables', issues: errors });
    }

    // Verglichen wird mit dem, was vorher galt - einschliesslich der Vorgaben des Eggs. Sonst
    // zaehlt jedes Feld als geaendert, das nur zum ersten Mal einen Wert bekommt.
    const before = Object.fromEntries(defs.map((d) => [d.env_variable, current[d.env_variable] ?? d.default_value ?? '']));
    const changed = Object.keys(values).filter((k) => values[k] !== before[k]);
    let next: ServerInstanceConfig = c.install
      ? { ...c, install: { ...c.install, variables: values } }
      : { ...c, env: { ...(c.env ?? {}), ...values } };
    // Docker: Umgebung des Containers (Platzhalter, Startkommando) und Image neu berechnen
    if (c.container) {
      const egg = (await eggs()).find((e) => e.id === c.game);
      if (egg) {
        const image = body.data.imageKey ? egg.images.find((i) => i.key === body.data.imageKey) : undefined;
        if (body.data.imageKey && !image) return fail(reply, 400, 'Dieses Image gibt es für das Spiel nicht.', 'invalid_input');
        next = { ...next, env: dockerEnvOf(next, egg, values), ...(image ? { executable: image.image, container: { ...c.container, image: image.image } } : {}) };
      }
    }
    await registry.update(next);
    // Namen der geaenderten Felder ins Protokoll, nie die Werte (Passwoerter).
    registry.audit('server.startup_update', c.id, 'standalone', { changed });

    // Eine andere Spielversion heisst: Spiel neu laden. Welt und Einstellungen bleiben liegen.
    const reinstall =
      Boolean(installs) && isMinecraftKind(next.install?.kind) && (changed.includes('VERSION') || changed.includes('TYPE'));
    if (reinstall && installs && next.install) {
      await registry.update({ ...next, install: { ...next.install, state: 'installing' } });
      // Ein anderer Typ (Paper <-> Vanilla) ist eine andere Installationsart
      const kind = installKindFor(c.game, values) ?? next.install.kind;
      installs.start(c.id, { ...installSpecOf(next.install), kind, variables: values });
    } else {
      await syncDriver(next);
    }
    return { ok: true, changed, reinstall };
  });

  // ---------------------------------------------------------------- Ports

  /** Ports anderer Server - die gehoeren ihnen. */
  const portsOfOthers = (c: ServerInstanceConfig): Set<number> =>
    new Set(registry.list().filter((s) => s.id !== c.id).flatMap((s) => s.ports.map((p) => p.hostPort)));

  const portName = (ports: ServerPort[], wanted: string | null | undefined): string => {
    const name = wanted && wanted.trim() ? wanted.trim().toLowerCase() : 'extra';
    if (!ports.some((p) => p.name === name)) return name;
    for (let i = 2; i < 100; i++) if (!ports.some((p) => p.name === `${name}${i}`)) return `${name}${i}`;
    return `${name}${Date.now()}`;
  };

  /** Kann der Server diesen Port bekommen? Sonst die Meldung. */
  async function checkFreePort(c: ServerInstanceConfig, port: number): Promise<string | null> {
    if (portsOfOthers(c).has(port)) return `Port ${port} ist bereits an einen anderen Server vergeben`;
    if (!(await probe(port))) return `Port ${port} wird auf diesem Rechner bereits benutzt`;
    return null;
  }

  server.post<{ Params: { id: string }; Body: unknown }>(`${base}/allocations`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const body = addPortBody.safeParse(req.body ?? {});
    if (!body.success) return invalidRequest(reply, body.error);
    if (!(await requireStopped(c, reply))) return reply;

    const ref = body.data.ref ? body.data.ref : null;
    if (ref && c.ports.some((p) => p.name === ref)) {
      return fail(reply, 409, `Es gibt schon einen Port mit der Kennung "${ref}"`, 'conflict');
    }
    const protocols = protocolsOf(body.data.protocol);

    let port: number;
    if (body.data.port) {
      port = body.data.port;
      if (c.ports.some((p) => p.hostPort === port && protocols.includes(p.protocol))) {
        return fail(reply, 409, `Dieser Server nutzt Port ${port} bereits`, 'conflict');
      }
      // Die eigenen Ports belegt der Server selbst nicht - sonst scheitert jeder Wechsel zwischen TCP und UDP.
      const problem = c.ports.some((p) => p.hostPort === port) ? null : await checkFreePort(c, port);
      if (problem) return fail(reply, 409, problem, 'conflict');
    } else {
      try {
        port = await allocatePort(registry.list(), probe);
      } catch (err) {
        return fail(reply, 409, err instanceof Error ? err.message : 'Kein freier Port', 'no_free_port');
      }
    }

    const name = portName(c.ports, ref);
    const next: ServerInstanceConfig = { ...c, ports: [...c.ports, ...protocols.map((protocol) => ({ name, hostPort: port, protocol }))] };
    await registry.update(next);
    await syncDriver(next);
    registry.audit('server.port_add', c.id, 'standalone', { ref: name, port, protocol: body.data.protocol });
    return reply.status(201).send({ ref, port, protocol: body.data.protocol, env: ref ? `${ref.toUpperCase()}_PORT` : undefined });
  });

  server.patch<{ Params: { id: string; port: string }; Body: unknown }>(`${base}/allocations/:port`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    const body = updatePortBody.safeParse(req.body ?? {});
    if (!body.success) return invalidRequest(reply, body.error);
    if (!(await requireStopped(c, reply))) return reply;

    const oldPort = Number(req.params.port);
    const current = c.ports.filter((p) => p.hostPort === oldPort);
    if (current.length === 0) return fail(reply, 404, `Port ${req.params.port} gehört nicht zu diesem Server`, 'not_found');

    const newPort = body.data.newPort ?? oldPort;
    if (newPort !== oldPort) {
      if (c.ports.some((p) => p.hostPort === newPort)) return fail(reply, 409, `Dieser Server nutzt Port ${newPort} bereits`, 'conflict');
      const problem = await checkFreePort(c, newPort);
      if (problem) return fail(reply, 409, problem, 'conflict');
    }

    const name = body.data.ref === undefined ? current[0]!.name : portName(c.ports.filter((p) => p.hostPort !== oldPort), body.data.ref);
    if (body.data.ref && c.ports.some((p) => p.hostPort !== oldPort && p.name === name && name !== current[0]!.name)) {
      return fail(reply, 409, `Es gibt schon einen Port mit der Kennung "${name}"`, 'conflict');
    }
    const protocols = body.data.protocol ? protocolsOf(body.data.protocol) : current.map((p) => p.protocol);

    // An derselben Stelle der Liste bleiben: der erste Eintrag ist der Hauptport.
    const firstAt = c.ports.findIndex((p) => p.hostPort === oldPort);
    const rest = c.ports.filter((p) => p.hostPort !== oldPort);
    const replaced = protocols.map((protocol) => ({ ...current[0]!, name, hostPort: newPort, protocol }));
    const next: ServerInstanceConfig = { ...c, ports: [...rest.slice(0, firstAt), ...replaced, ...rest.slice(firstAt)] };
    await registry.update(next);
    await syncDriver(next);
    registry.audit('server.port_update', c.id, 'standalone', { from: oldPort, to: newPort, ref: name });
    return { ok: true };
  });

  server.delete<{ Params: { id: string; port: string } }>(`${base}/allocations/:port`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    if (!(await requireStopped(c, reply))) return reply;

    const port = Number(req.params.port);
    if (!c.ports.some((p) => p.hostPort === port)) return fail(reply, 404, `Port ${req.params.port} gehört nicht zu diesem Server`, 'not_found');
    if (c.ports[0]?.hostPort === port) {
      return fail(reply, 400, 'Der Hauptport kann nicht gelöscht werden - er lässt sich ändern.', 'invalid_input');
    }

    const next: ServerInstanceConfig = { ...c, ports: c.ports.filter((p) => p.hostPort !== port) };
    await registry.update(next);
    await syncDriver(next);
    registry.audit('server.port_remove', c.id, 'standalone', { port });
    return { ok: true };
  });

  server.post<{ Params: { id: string } }>(`${base}/reallocate`, async (req, reply) => {
    const c = need(req.params.id, reply);
    if (!c) return reply;
    if (!(await requireStopped(c, reply))) return reply;

    // Jede bisherige Portnummer bekommt eine neue, die Reihenfolge und Namen bleiben.
    const others = registry.list().filter((s) => s.id !== c.id);
    const assigned: ServerPort[] = [];
    const mapping = new Map<number, number>();
    try {
      for (const old of [...new Set(c.ports.map((p) => p.hostPort))]) {
        const fresh = await allocatePort([...others, { ...c, ports: assigned }], probe);
        mapping.set(old, fresh);
        assigned.push({ name: 'neu', hostPort: fresh, protocol: 'tcp' });
      }
    } catch (err) {
      return fail(reply, 409, err instanceof Error ? err.message : 'Keine freien Ports', 'no_free_port');
    }

    const next: ServerInstanceConfig = { ...c, ports: c.ports.map((p) => ({ ...p, hostPort: mapping.get(p.hostPort)! })) };
    await registry.update(next);
    await syncDriver(next);
    registry.audit('server.reallocate', c.id, 'standalone', { from: [...mapping.keys()], to: [...mapping.values()] });
    return { ok: true, ports: next.ports.map((p) => ({ ref: p.name, port: p.hostPort })) };
  });
}
