import { sql } from '../db/index.js';
import { log } from '../log.js';
import { createBackup } from './backups.js';

let timer: NodeJS.Timeout | null = null;
let runningCheck = false;

/**
 * Prueft minuetlich, ob fuer Server mit automatischen Backups eine Sicherung faellig ist.
 */
export async function checkAutoBackups(): Promise<void> {
  if (runningCheck) return;
  runningCheck = true;
  try {
    const servers = await sql<{
      id: string;
      name: string;
      short_id: string;
      auto_backup_enabled: boolean;
      auto_backup_interval_hours: number;
      auto_backup_retention: number;
      auto_backup_verify: boolean;
      last_auto_backup_at: Date | null;
    }[]>`
      SELECT id, name, short_id, auto_backup_enabled, auto_backup_interval_hours,
             auto_backup_retention, auto_backup_verify, last_auto_backup_at
      FROM servers
      WHERE auto_backup_enabled = true
    `;

    const now = Date.now();
    const SYSTEM_ACTOR = { id: '00000000-0000-0000-0000-000000000000', username: 'System (Auto-Backup)' };

    for (const srv of servers) {
      const intervalMs = Math.max(1, srv.auto_backup_interval_hours || 24) * 3600 * 1000;
      const lastTime = srv.last_auto_backup_at ? new Date(srv.last_auto_backup_at).getTime() : 0;

      if (now - lastTime >= intervalMs) {
        // Pruefen, ob bereits ein aktives Backup fuer diesen Server laeuft
        const [active] = await sql<{ id: string }[]>`
          SELECT id FROM backups WHERE server_id = ${srv.id} AND status = 'running' LIMIT 1
        `;
        if (active) continue;

        log.info({ serverId: srv.id, serverName: srv.name }, 'Starte geplantes Auto-Backup');

        await sql`
          UPDATE servers
          SET last_auto_backup_at = now()
          WHERE id = ${srv.id}
        `;

        try {
          await createBackup(
            srv.id,
            SYSTEM_ACTOR,
            '127.0.0.1',
            `Auto-Backup`,
            []
          );
        } catch (err) {
          log.error({ err, serverId: srv.id }, 'Automatisches Backup konnte nicht gestartet werden');
        }
      }
    }
  } catch (err) {
    log.error({ err }, 'Fehler im Auto-Backup-Scheduler');
  } finally {
    runningCheck = false;
  }
}

/**
 * Startet den Scheduler im Hintergrund
 */
export function startBackupScheduler(intervalMs = 60_000): void {
  if (timer) return;
  log.info('Auto-Backup-Scheduler gestartet (Prüfung alle 60 s)');
  timer = setInterval(() => {
    void checkAutoBackups();
  }, intervalMs);
}

/**
 * Stoppt den Scheduler
 */
export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info('Auto-Backup-Scheduler gestoppt');
  }
}
