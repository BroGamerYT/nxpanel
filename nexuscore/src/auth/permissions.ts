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

// ------------------------------------------------------------- Globale Modul-Rechte

export const GLOBAL_PERMISSIONS = [
  'server.create',
  'admin.test_report',
  'admin.files',
  'admin.audit',
  'admin.nodes',
  'admin.integrations',
  'admin.users',
  'admin.eggs',
] as const;

export type GlobalPermission = (typeof GLOBAL_PERMISSIONS)[number];

export const GLOBAL_PERMISSION_LABELS: Record<GlobalPermission, { label: string; desc: string }> = {
  'server.create': { label: 'Server erstellen', desc: 'Darf neue Server und Instanzen im Panel anlegen' },
  'admin.test_report': { label: 'Spiele-Testbericht', desc: 'Automatische Installationstests & Berichte ansehen und ausführen' },
  'admin.files': { label: 'Dateimanager (VM)', desc: 'Host-Dateisystem & Panel-Verzeichnisse auf der VM verwalten' },
  'admin.audit': { label: 'Audit-Protokoll', desc: 'Sicherheitsprotokoll und Benutzeraktionen einsehen' },
  'admin.nodes': { label: 'Netzwerk & Nodes', desc: 'Netzwerkkonfiguration, Ports und Node-Status einsehen' },
  'admin.integrations': { label: 'Integrationen', desc: 'Discord-Webhooks, Playit.gg und externe Dienste konfigurieren' },
  'admin.users': { label: 'Benutzerverwaltung', desc: 'Benutzer anlegen, bearbeiten und Berechtigungen verwalten' },
  'admin.eggs': { label: 'Egg-Vorlagen verwalten', desc: 'Spiele-Vorlagen importieren, anpassen und löschen' },
};

// ------------------------------------------------------------- Pruefung

export type Role = 'admin' | 'moderator' | 'user';

export interface Actor {
  id: string;
  role: Role;
  canCreateServers: boolean;
  allowedEggs?: string[] | null;
  globalPermissions?: string[] | null;
}

export function hasGlobalPermission(actor: Actor, perm: GlobalPermission): boolean {
  if (actor.role === 'admin') return true;
  if (perm === 'server.create' && actor.canCreateServers) return true;
  return Array.isArray(actor.globalPermissions) && actor.globalPermissions.includes(perm);
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
  if (actor.allowedEggs === null || actor.allowedEggs === undefined) return true;
  if (actor.allowedEggs.length === 0) return false;
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
  const isAdmin = actor.role === 'admin';
  return {
    'server.create': canCreateServer(actor),
    'server.view_all': isAdmin || actor.role !== 'user',
    'admin.users': isAdmin || hasGlobalPermission(actor, 'admin.users'),
    'admin.nodes': isAdmin || hasGlobalPermission(actor, 'admin.nodes'),
    'admin.eggs': isAdmin || hasGlobalPermission(actor, 'admin.eggs'),
    'admin.audit': isAdmin || hasGlobalPermission(actor, 'admin.audit'),
    'admin.test_report': isAdmin || hasGlobalPermission(actor, 'admin.test_report'),
    'admin.files': isAdmin || hasGlobalPermission(actor, 'admin.files'),
    'admin.integrations': isAdmin || hasGlobalPermission(actor, 'admin.integrations'),
  };
}
