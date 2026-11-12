/**
 * Was der Core fuer einen Server wirklich kann. Die Oberflaeche blendet Tabs und
 * Schaltflaechen nach diesen Rechten aus - ein Recht, das hier fehlt, versteckt die
 * Funktion. Neue Funktionen kommen erst dazu, wenn es die Routen dafuer gibt.
 */
/** Funktionsbereiche der Oberflaeche, die der Core unterstuetzt (siehe web/src/lib/features.ts). */
export const CORE_FEATURES: string[] = ['files', 'settings', 'logfiles', 'schedules', 'backups', 'players', 'admin', 'audit', 'account', 'configs', 'motd', 'testreport', 'hostlogs', 'network', 'integrations', 'adminfiles', 'hosts', 'users', 'gaming', 'limits', 'passkeys', 'steam', 'sftp', 'firewall', 'help', 'subusers', 'updates', 'import', 'modpacks', 'playit', 'domain'];

export const SERVER_PERMISSIONS = [
  'control.console',
  'control.command',
  'control.start',
  'control.stop',
  'control.restart',
  'control.kill',
  'file.read',
  'file.write',
  'file.delete',
  'settings.reinstall',
  'settings.rename',
  'startup.read',
  'startup.update',
  'allocation.read',
  'allocation.assign',
  'schedule.read',
  'schedule.update',
  'schedule.run',
  'backup.read',
  'backup.create',
  'backup.restore',
  'backup.delete',
  'backup.download',
  'player.read',
  'player.kick',
  'player.ban',
  'player.whitelist',
  'file.archive',
  'file.sftp',
  'subuser.read',
  'subuser.create',
  'subuser.update',
  'subuser.delete',
];
