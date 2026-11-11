import type { ServerRegistry } from '../store/registry.js';
import {
  SERVER_FLAGS,
  canCreateServer,
  canDeleteServer,
  canSee,
  effectiveFlags,
  hasGlobalPermission,
  type Actor,
  type GlobalPermission,
  type ServerAccess,
  type ServerFlag,
} from '../auth/permissions.js';
import { getAccess } from '../store/access.js';

/**
 * Wer darf welche Route? Eine Stelle, ein Standard: was hier nicht steht, darf
 * nur ein Administrator. Ein neuer Endpunkt ist damit nie versehentlich fuer
 * normale Benutzer offen - ein Test geht alle Routen durch und schlaegt an,
 * wenn eine nicht ausdruecklich eingetragen ist.
 */

export interface RequestActor extends Actor {
  username: string;
  /** Das Master-Token (Panel, Skripte): kein Benutzer, volle Rechte. */
  master: boolean;
}

export const MASTER_ACTOR: RequestActor = {
  id: 'core',
  username: 'NexusCore',
  role: 'admin',
  canCreateServers: true,
  allowedEggs: null,
  globalPermissions: null,
  master: true,
};

export type Need =
  /** Jeder angemeldete Benutzer (die Antwort filtert selbst nach Sichtbarkeit). */
  | { kind: 'user' }
  /** Nur Administratoren (und das Master-Token). */
  | { kind: 'admin' }
  /** Administrator oder wer das Modul-Recht hat. */
  | { kind: 'perm'; perm: GlobalPermission }
  /** Ein Server: mindestens eines der Flags. `see` = nur sichtbar sein. `all` = jedes Flag (Besitzer/Admin). */
  | { kind: 'server'; any: readonly ServerFlag[] | 'see' | 'all' }
  /** Server loeschen: Administrator oder Besitzer. */
  | { kind: 'server-delete' }
  /** Server anlegen: Recht und erlaubtes Spiel (aus dem Inhalt). */
  | { kind: 'server-create' }
  /** Je nach Inhalt (Power-Aktion, Spieler-Aktion). */
  | { kind: 'body-server'; pick: (body: unknown) => readonly ServerFlag[] | 'all' };

interface Rule {
  methods: readonly string[] | '*';
  pattern: RegExp;
  need: Need;
}

const GET = ['GET'];
const S = '^/api/v1/servers/:id';

const flag = (...flags: ServerFlag[]): Need => ({ kind: 'server', any: flags });
const perm = (p: GlobalPermission): Need => ({ kind: 'perm', perm: p });
const bodyOf = (body: unknown): Record<string, unknown> => (body && typeof body === 'object' ? (body as Record<string, unknown>) : {});

const POWER_FLAG: Record<string, ServerFlag> = {
  start: 'control.start',
  stop: 'control.stop',
  restart: 'control.restart',
  kill: 'control.kill',
};

const PLAYER_FLAG: Record<string, ServerFlag> = {
  kick: 'player.kick',
  ban: 'player.ban',
  pardon: 'player.ban',
  whitelist_add: 'player.whitelist',
  whitelist_remove: 'player.whitelist',
};

/**
 * Reihenfolge ist egal, die erste passende Regel gilt - spezifische vor allgemeinen.
 * Oeffentliche Routen (Anmeldung, Weboberflaeche) stehen in security.ts, nicht hier.
 */
const RULES: readonly Rule[] = [
  // ----------------------------------------------------------- eigenes Konto
  { methods: '*', pattern: /^\/api\/v1\/auth\//, need: { kind: 'user' } },

  // ------------------------------------------------- allgemein (filtert selbst)
  { methods: GET, pattern: /^\/api\/v1\/(about|dashboard|dashboard\/activity|notifications|tasks\/active|steam\/accounts|eggs|eggs\/:id|eggs\/:id\/cover)$/, need: { kind: 'user' } },
  { methods: ['POST'], pattern: /^\/api\/v1\/(presence\/ping|live\/ws-ticket)$/, need: { kind: 'user' } },
  { methods: GET, pattern: /^\/api\/v1\/live\/ws$/, need: { kind: 'user' } },
  { methods: GET, pattern: /^\/api\/v1\/servers$/, need: { kind: 'user' } },
  { methods: ['POST'], pattern: /^\/api\/v1\/servers$/, need: { kind: 'server-create' } },

  // --------------------------------------------------------------- Server
  { methods: GET, pattern: new RegExp(`${S}$`), need: { kind: 'server', any: 'see' } },
  { methods: ['PATCH'], pattern: new RegExp(`${S}$`), need: flag('settings.rename') },
  { methods: ['DELETE'], pattern: new RegExp(`${S}$`), need: { kind: 'server-delete' } },
  { methods: GET, pattern: new RegExp(`${S}/(presence|history|events|tasks/active|modpack)$`), need: { kind: 'server', any: 'see' } },
  { methods: GET, pattern: new RegExp(`${S}/activity$`), need: flag('activity.read') },
  { methods: ['POST'], pattern: new RegExp(`${S}/ws-ticket$`), need: flag('control.console') },
  { methods: GET, pattern: new RegExp(`${S}/ws$`), need: flag('control.console') },
  { methods: GET, pattern: new RegExp(`${S}/logs(/file)?$`), need: flag('control.console') },
  { methods: ['POST'], pattern: new RegExp(`${S}/command$`), need: flag('control.command') },
  {
    methods: ['POST'],
    pattern: new RegExp(`${S}/power$`),
    need: { kind: 'body-server', pick: (b) => { const f = POWER_FLAG[String(bodyOf(b)['action'])]; return f ? [f] : 'all'; } },
  },
  { methods: ['POST'], pattern: new RegExp(`${S}/reinstall$`), need: flag('settings.reinstall') },
  // Rechenleistung zuteilen darf nur, wer den Rechner verwaltet - sonst gaebe sich jeder Besitzer mehr
  { methods: ['PATCH'], pattern: new RegExp(`${S}/resources$`), need: { kind: 'admin' } },

  // --------------------------------------------------------------- Dateien
  { methods: GET, pattern: new RegExp(`${S}/(configs|files|files/content|files/download|files/revisions|files/revisions/:revisionId)$`), need: flag('file.read') },
  { methods: GET, pattern: new RegExp(`${S}/mc/icon$`), need: { kind: 'server', any: 'see' } },
  { methods: ['PUT', 'DELETE'], pattern: new RegExp(`${S}/mc/icon$`), need: flag('file.write') },
  { methods: ['PUT'], pattern: new RegExp(`${S}/files/content$`), need: flag('file.write') },
  { methods: ['POST'], pattern: new RegExp(`${S}/files/(directory|rename|upload|revisions/:revisionId/rollback)$`), need: flag('file.write') },
  { methods: ['DELETE'], pattern: new RegExp(`${S}/files$`), need: flag('file.delete') },
  { methods: ['POST'], pattern: new RegExp(`${S}/files/(compress|decompress)$`), need: flag('file.archive') },

  // --------------------------------------------------------------- Backups
  { methods: GET, pattern: new RegExp(`${S}/(backups|backup-schedule)$`), need: flag('backup.read') },
  { methods: ['POST'], pattern: new RegExp(`${S}/backups/:backupId/verify$`), need: flag('backup.read') },
  { methods: GET, pattern: new RegExp(`${S}/backups/:backupId/download$`), need: flag('backup.download') },
  { methods: ['POST'], pattern: new RegExp(`${S}/backups/:backupId/restore$`), need: flag('backup.restore') },
  { methods: ['DELETE'], pattern: new RegExp(`${S}/backups/:backupId$`), need: flag('backup.delete') },
  { methods: ['POST'], pattern: new RegExp(`${S}/backups$`), need: flag('backup.create') },
  { methods: ['PATCH'], pattern: new RegExp(`${S}/backups/:backupId$`), need: flag('backup.create') },
  { methods: ['POST'], pattern: new RegExp(`${S}/backups/:backupId/sync-nas$`), need: flag('backup.create') },
  { methods: ['PUT'], pattern: new RegExp(`${S}/backup-schedule$`), need: flag('backup.create') },

  // ------------------------------------------------------------- Zeitplaene
  { methods: GET, pattern: new RegExp(`${S}/schedules$`), need: flag('schedule.read') },
  { methods: ['POST'], pattern: new RegExp(`${S}/schedules$`), need: flag('schedule.update') },
  { methods: ['PATCH', 'DELETE'], pattern: new RegExp(`${S}/schedules/:scheduleId$`), need: flag('schedule.update') },
  { methods: ['POST'], pattern: new RegExp(`${S}/schedules/:scheduleId/run$`), need: flag('schedule.run') },

  // ---------------------------------------------------------------- Spieler
  { methods: GET, pattern: new RegExp(`${S}/(game-status|players/lists)$`), need: flag('player.read') },
  {
    methods: ['POST'],
    pattern: new RegExp(`${S}/players/action$`),
    need: { kind: 'body-server', pick: (b) => { const f = PLAYER_FLAG[String(bodyOf(b)['action'])]; return f ? [f] : 'all'; } },
  },

  // ----------------------------------------------------- Start und Ports
  { methods: GET, pattern: new RegExp(`${S}/startup$`), need: flag('startup.read') },
  { methods: ['PATCH'], pattern: new RegExp(`${S}/startup$`), need: flag('startup.update') },
  { methods: ['POST'], pattern: new RegExp(`${S}/(allocations|reallocate)$`), need: flag('allocation.assign') },
  { methods: ['PATCH', 'DELETE'], pattern: new RegExp(`${S}/allocations/:port$`), need: flag('allocation.assign') },

  // ------------------------------------------------------------------ Admin
  // Nur Administratoren: wer Benutzer verwalten darf, koennte sich sonst selbst zum Administrator machen
  { methods: '*', pattern: /^\/api\/v1\/admin\/users(\/|$)/, need: { kind: 'admin' } },
  { methods: GET, pattern: /^\/api\/v1\/admin\/audit$/, need: perm('admin.audit') },
  { methods: '*', pattern: /^\/api\/v1\/admin\/test-(report|games)(\/|$)/, need: perm('admin.test_report') },
  { methods: '*', pattern: /^\/api\/v1\/admin\/files(\/|$)/, need: perm('admin.files') },
  { methods: '*', pattern: /^\/api\/v1\/admin\/integrations(\/|$)/, need: perm('admin.integrations') },
  { methods: '*', pattern: /^\/api\/v1\/admin\/(nodes|allocations|network\/check|hosts)(\/|$)/, need: perm('admin.nodes') },
  { methods: '*', pattern: /^\/api\/v1\/admin\/eggs\/:id\/cover$/, need: perm('admin.eggs') },
  { methods: GET, pattern: /^\/api\/v1\/admin\/(overview|host-logs)$/, need: { kind: 'admin' } },

  // Schnittstelle fuer das Panel und die aeltere Standalone-Schnittstelle: nur Master-Token oder Administrator
  { methods: '*', pattern: /^\/(core\/v1|api\/panel)\//, need: { kind: 'admin' } },
];

export interface Classified {
  need: Need;
  /** false: keine Regel getroffen, es gilt der Standard "nur Administrator". */
  explicit: boolean;
}

export function classify(method: string, pattern: string): Classified {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const rule of RULES) {
    if (rule.methods !== '*' && !rule.methods.includes(m)) continue;
    if (rule.pattern.test(pattern)) return { need: rule.need, explicit: true };
  }
  return { need: { kind: 'admin' }, explicit: false };
}

// ---------------------------------------------------------------- Pruefung

export type Verdict = { ok: true } | { ok: false; status: 403 | 404; message: string; code: string };

const OK: Verdict = { ok: true };
const forbidden = (message = 'Dafür fehlt dir die Berechtigung.'): Verdict => ({ ok: false, status: 403, message, code: 'forbidden' });
const hidden: Verdict = { ok: false, status: 404, message: 'Server nicht gefunden', code: 'not_found' };

const isAdmin = (a: RequestActor): boolean => a.role === 'admin';

export function accessFor(registry: ServerRegistry, serverId: string, actor: Actor): ServerAccess {
  const access = getAccess(registry, serverId);
  return { ownerId: access.ownerId ?? '', subuserFlags: access.subusers[actor.id] ?? null };
}

/** Alle Flags des Benutzers an einem Server; leer = unsichtbar. */
export function flagsFor(registry: ServerRegistry, serverId: string, actor: RequestActor): ServerFlag[] {
  if (actor.master) return [...SERVER_FLAGS];
  return effectiveFlags(actor, accessFor(registry, serverId, actor));
}

export function canSeeServer(registry: ServerRegistry, serverId: string, actor: RequestActor): boolean {
  return actor.master || canSee(actor, accessFor(registry, serverId, actor));
}

export function authorize(input: {
  actor: RequestActor;
  need: Need;
  /** Der Server der Anfrage (aufgeloest aus :id), falls es einen gibt. */
  serverId: string | undefined;
  body: unknown;
  registry: ServerRegistry;
}): Verdict {
  const { actor, need, registry } = input;
  if (actor.master) return OK;

  switch (need.kind) {
    case 'user':
      return OK;
    case 'admin':
      return isAdmin(actor) ? OK : forbidden();
    case 'perm':
      return hasGlobalPermission(actor, need.perm) ? OK : forbidden();
    case 'server-create': {
      const egg = bodyOf(input.body)['eggId'];
      return canCreateServer(actor, typeof egg === 'string' ? egg : undefined) ? OK : forbidden('Du darfst keine Server anlegen (oder nicht mit diesem Spiel).');
    }
    default:
      break;
  }

  // Ab hier geht es um einen bestimmten Server
  if (!input.serverId) return hidden;
  const access = accessFor(registry, input.serverId, actor);
  if (!canSee(actor, access)) return hidden;

  if (need.kind === 'server-delete') return canDeleteServer(actor, access) ? OK : forbidden();

  const have = new Set(effectiveFlags(actor, access));
  const wanted = need.kind === 'body-server' ? need.pick(input.body) : need.any;
  if (wanted === 'see') return OK;
  if (wanted === 'all') return SERVER_FLAGS.every((f) => have.has(f)) ? OK : forbidden();
  return wanted.some((f) => have.has(f)) ? OK : forbidden();
}
