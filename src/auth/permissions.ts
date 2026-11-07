/**
 * Rechte - zwei Ebenen, wie im Konzept festgelegt:
 *
 *   1. Globale Rolle (admin | moderator | user) plus das Recht, Server
 *      anzulegen (users.can_create_servers = "server.create").
 *   2. Flags pro Server fuer Mitnutzer (subusers.permissions).
 *
 * Die Pruefung ist eine reine Funktion ohne Datenbankzugriff. Dadurch ist
 * sie vollstaendig testbar, und jede Route benutzt dieselbe Logik.
 *
 * Neue Flags werden NUR hier ergaenzt. Gespeicherte Flags, die es nicht
 * (mehr) gibt, werden beim Lesen ignoriert statt Fehler zu werfen.
 */

export const SERVER_FLAGS = [
  'control.console',
  'control.command',
  'control.start',
  'control.stop',
  'control.restart',
  'control.kill',
  'file.read',
  'file.write',
  'file.delete',
  'file.archive',
  'file.sftp',
  'backup.read',
  'backup.create',
  'backup.restore',
  'backup.delete',
  'backup.download',
  'allocation.read',
  'allocation.assign',
  'startup.read',
  'startup.update',
  'startup.image',
  'schedule.read',
  'schedule.update',
  'schedule.run',
  'player.read',
  'player.kick',
  'player.ban',
  'player.whitelist',
  'subuser.read',
  'subuser.create',
  'subuser.update',
  'subuser.delete',
  'settings.rename',
  'settings.reinstall',
  'activity.read',
  'player.ip_read',
] as const;

export type ServerFlag = (typeof SERVER_FLAGS)[number];

const FLAG_SET: ReadonlySet<string> = new Set(SERVER_FLAGS);

export function isServerFlag(v: string): v is ServerFlag {
  return FLAG_SET.has(v);
}

/** Beschriftungen fuer die Oberflaeche (Flag-Matrix, Tooltips). */
export const FLAG_LABELS: Record<ServerFlag, string> = {
  'control.console': 'Konsolenausgabe mitlesen',
  'control.command': 'Befehle in die Konsole senden',
  'control.start': 'Server starten',
  'control.stop': 'Server stoppen',
  'control.restart': 'Server neu starten',
  'control.kill': 'Hart abwuergen (SIGKILL)',
  'file.read': 'Dateien auflisten und lesen',
  'file.write': 'Dateien anlegen und aendern (faktisch Vollzugriff!)',
  'file.delete': 'Dateien loeschen',
  'file.archive': 'Packen und entpacken',
  'file.sftp': 'Zugang per SFTP',
  'backup.read': 'Backup-Liste sehen',
  'backup.create': 'Backup anlegen',
  'backup.restore': 'Backup zurueckspielen',
  'backup.delete': 'Backup loeschen',
  'backup.download': 'Backup herunterladen',
  'allocation.read': 'Ports sehen',
  'allocation.assign': 'Zusaetzliche Ports zuweisen',
  'startup.read': 'Startparameter und Variablen sehen',
  'startup.update': 'Variablen aendern',
  'startup.image': 'Docker-Image wechseln',
  'schedule.read': 'Zeitplaene sehen',
  'schedule.update': 'Zeitplaene anlegen und aendern',
  'schedule.run': 'Zeitplaene sofort ausfuehren',
  'player.read': 'Online-Spieler sehen',
  'player.kick': 'Spieler kicken',
  'player.ban': 'Spieler bannen und entbannen',
  'player.whitelist': 'Whitelist verwalten',
  'subuser.read': 'Mitnutzer sehen',
  'subuser.create': 'Mitnutzer einladen',
  'subuser.update': 'Rechte anderer aendern',
  'subuser.delete': 'Mitnutzer entfernen',
  'settings.rename': 'Server umbenennen',
  'settings.reinstall': 'Neu installieren (loescht Daten)',
  'activity.read': 'Aktivitaetsprotokoll des Servers lesen',
  'player.ip_read': 'IP-Adressen und Herkunft der Spieler sehen',
};

const ZUSCHAUER: ServerFlag[] = ['control.console', 'allocation.read', 'startup.read', 'backup.read', 'player.read', 'schedule.read'];
const OPERATOR: ServerFlag[] = [
  ...ZUSCHAUER,
  'control.start',
  'control.stop',
  'control.restart',
  'control.command',
  'player.kick',
  'player.ban',
  'player.whitelist',
  'schedule.run',
];
const VERWALTER: ServerFlag[] = [
  ...OPERATOR,
  ...SERVER_FLAGS.filter((f) => f.startsWith('file.') || f.startsWith('backup.') || f.startsWith('schedule.')),
  'startup.update',
];
const CO_ADMIN: ServerFlag[] = [
  ...VERWALTER,
  ...SERVER_FLAGS.filter((f) => f.startsWith('subuser.')),
  'settings.rename',
  'allocation.assign',
  'activity.read',
];

export const PRESETS = {
  zuschauer: { label: 'Zuschauer', flags: dedupe(ZUSCHAUER) },
  operator: { label: 'Operator', flags: dedupe(OPERATOR) },
  verwalter: { label: 'Verwalter', flags: dedupe(VERWALTER) },
  'co-admin': { label: 'Co-Admin', flags: dedupe(CO_ADMIN) },
} as const;

export type PresetName = keyof typeof PRESETS;

function dedupe(flags: ServerFlag[]): readonly ServerFlag[] {
  return Object.freeze([...new Set(flags)]);
}

// ------------------------------------------------------------- Pruefung

export type Role = 'admin' | 'moderator' | 'user';

export interface Actor {
  id: string;
  role: Role;
  canCreateServers: boolean;
  allowedEggs?: string[] | null;
}

export interface ServerAccess {
  ownerId: string;
  /** Flags aus subusers fuer DIESEN Nutzer; null = kein Mitnutzer. */
  subuserFlags: readonly string[] | null;
}

/**
 * Alle Flags, die ein Nutzer an einem Server hat.
 *   admin / moderator / Besitzer: alle
 *   Mitnutzer: genau die gespeicherten (unbekannte werden verworfen)
 *   sonst: keine - der Server ist fuer ihn unsichtbar
 */
export function effectiveFlags(actor: Actor, access: ServerAccess): ServerFlag[] {
  if (actor.role === 'admin' || actor.role === 'moderator') return [...SERVER_FLAGS];
  if (access.ownerId === actor.id) return [...SERVER_FLAGS];
  if (access.subuserFlags) return access.subuserFlags.filter(isServerFlag);
  return [];
}

export function can(actor: Actor, access: ServerAccess, flag: ServerFlag): boolean {
  return effectiveFlags(actor, access).includes(flag);
}

/** Darf der Nutzer den Server ueberhaupt sehen? (Sonst 404 statt 403 - nichts verraten.) */
export function canSee(actor: Actor, access: ServerAccess): boolean {
  return (
    actor.role !== 'user' ||
    access.ownerId === actor.id ||
    (access.subuserFlags !== null && access.subuserFlags.length > 0)
  );
}

/** Loeschen ist absichtlich kein Flag: nur Admin und Besitzer. */
export function canDeleteServer(actor: Actor, access: ServerAccess): boolean {
  return actor.role === 'admin' || access.ownerId === actor.id;
}

/** Neue Instanzen anlegen: Admin oder wer das Recht ausdruecklich bekommen hat. */
export function canCreateServer(actor: Actor, eggIdentifier?: string): boolean {
  if (actor.role === 'admin') return true;
  if (!actor.canCreateServers) return false;
  if (!eggIdentifier) return true;
  if (!actor.allowedEggs || actor.allowedEggs.length === 0) return true;
  return actor.allowedEggs.includes(eggIdentifier);
}

/**
 * Darf jemand einem Mitnutzer diese Flags geben?
 * Grundsatz: niemand vergibt mehr, als er selbst hat. Ein Co-Admin kann
 * also keinen anderen zum "Super-Co-Admin" machen.
 */
export function canGrant(actor: Actor, access: ServerAccess, wanted: readonly string[]): { ok: boolean; denied: string[] } {
  const own = new Set(effectiveFlags(actor, access));
  const denied = wanted.filter((f) => !isServerFlag(f) || !own.has(f));
  return { ok: denied.length === 0, denied };
}

/** Globale Rechte, z. B. fuer /auth/me und die Navigation der Oberflaeche. */
export function globalPermissions(actor: Actor) {
  return {
    'server.create': canCreateServer(actor),
    'server.view_all': actor.role !== 'user',
    'admin.users': actor.role === 'admin',
    'admin.nodes': actor.role === 'admin',
    'admin.eggs': actor.role === 'admin',
    'admin.audit': actor.role === 'admin',
  };
}
