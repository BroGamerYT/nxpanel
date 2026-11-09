import { existsSync, createReadStream, createWriteStream, statSync } from 'node:fs';
import { mkdir, stat, rm, copyFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import { volumePath } from '../docker/client.js';
import { writeEvent } from '../events.js';
import { writeAudit } from '../audit.js';
import { log } from '../log.js';
import { STOPPED_STATES } from './create.js';
import { diskCollector } from './stats.js';

export interface ActiveBackupState {
  backupId: string;
  serverId: string;
  serverName: string;
  shortId: string;
  name: string;
  phase: 'compressing' | 'hashing' | 'uploading_nas' | 'verifying' | 'completed' | 'failed';
  bytesWritten: number;
  totalBytes: number;
  archiveSize?: number;
  hashedBytes?: number;
  nasTransferred?: number;
  nasTotal?: number;
  nasSpeed?: number;
  progressPercent: number;
  error?: string;
  startedAt: number;
}

export const activeBackupStates = new Map<string, ActiveBackupState>();

export interface ActiveNasSync {
  backupId: string;
  serverId: string;
  serverName: string;
  backupName: string;
  transferred: number;
  total: number;
  speed: number;
  progressPercent: number;
  startedAt: number;
}

export const activeNasSyncs = new Map<string, ActiveNasSync>();

export interface BackupRow {
  id: string;
  server_id: string;
  name: string;
  filename: string;
  bytes: number;
  checksum: string | null;
  locked: boolean;
  status: 'running' | 'completed' | 'failed' | 'restoring';
  error: string | null;
  ignored_files: string[] | null;
  verification_status?: 'unverified' | 'valid' | 'corrupted';
  verified_at?: string | null;
  verification_details?: VerificationResult | null;
  nas_stored?: boolean;
  created_at: string;
  completed_at: string | null;
}

export interface VerificationResult {
  status: 'valid' | 'corrupted';
  sha256Match: boolean;
  archiveIntact: boolean;
  filesCount: number;
  criticalFilesFound: string[];
  missingCriticalFiles?: string[] | undefined;
  error?: string | undefined;
  verifiedAt: string;
}

export function sanitizeFileName(name: string): string {
  return name
    .trim()
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Erzeugt einen aussagekraeftigen Standard-Backupnamen im Format:
 * <ServerName>_<Spiel>_(<Version>)_<YYYY-MM-DD_HH-mm-ss>
 */
export function generateBackupName(
  serverName: string,
  gameName: string,
  version?: string | null,
  date = new Date()
): { name: string; filename: string } {
  const cleanServer = sanitizeFileName(serverName) || 'Server';
  const cleanGame = sanitizeFileName(gameName) || 'Game';
  const cleanVer = version ? sanitizeFileName(version) : null;

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const timestamp = `${yyyy}-${mm}-${dd}_${hh}-${min}-${ss}`;

  const baseName = cleanVer
    ? `${cleanServer}_${cleanGame}_(${cleanVer})_${timestamp}`
    : `${cleanServer}_${cleanGame}_${timestamp}`;

  return {
    name: baseName,
    filename: `${baseName}.tar.zst`,
  };
}

export function backupFilePath(serverId: string, backupId: string): string {
  return join(config.BACKUP_ROOT, serverId, `${backupId}.tar.zst`);
}

export function nasBackupFilePath(serverId: string, backupId: string, filename?: string, serverName?: string): string {
  const folder = serverName ? sanitizeFileName(serverName) : serverId;
  const file = filename || `${backupId}.tar.zst`;
  return join(config.NAS_BACKUP_ROOT, folder, file);
}

/**
 * Ermittelt den menschenlesbaren Zielpfad fuer ein Backup auf dem NAS
 * Format: NAS_ROOT/<ServerName>/<BackupFilename>.tar.zst
 */
export async function getNasBackupDestinationPath(serverId: string, backupId: string): Promise<string> {
  const [srv] = await sql<{ name: string }[]>`SELECT name FROM servers WHERE id = ${serverId}`;
  const [b] = await sql<{ filename: string }[]>`SELECT filename FROM backups WHERE id = ${backupId}`;
  const serverFolder = srv?.name ? sanitizeFileName(srv.name) : serverId;
  const fileName = b?.filename || `${backupId}.tar.zst`;
  return join(config.NAS_BACKUP_ROOT, serverFolder, fileName);
}

/**
 * Sucht eine Backup-Datei auf dem UGREEN NAS unabhaengig davon,
 * ob sie mit Servername, UUID oder Dateiname abgelegt wurde.
 */
export async function findNasBackupPath(
  serverId: string,
  backupId: string,
  filename?: string
): Promise<string | null> {
  if (!existsSync(config.NAS_BACKUP_ROOT)) return null;

  const [srv] = await sql<{ name: string }[]>`SELECT name FROM servers WHERE id = ${serverId}`;
  const serverFolder = srv?.name ? sanitizeFileName(srv.name) : serverId;

  let backupFilename = filename;
  if (!backupFilename) {
    const [b] = await sql<{ filename: string }[]>`SELECT filename FROM backups WHERE id = ${backupId}`;
    backupFilename = b?.filename;
  }

  // 1. Im Ordner mit Servernamen
  if (backupFilename) {
    const p1 = join(config.NAS_BACKUP_ROOT, serverFolder, backupFilename);
    if (existsSync(p1)) return p1;
  }
  const p2 = join(config.NAS_BACKUP_ROOT, serverFolder, `${backupId}.tar.zst`);
  if (existsSync(p2)) return p2;

  // 2. Im Ordner mit Server-UUID (bisheriges Format)
  if (backupFilename) {
    const p3 = join(config.NAS_BACKUP_ROOT, serverId, backupFilename);
    if (existsSync(p3)) return p3;
  }
  const p4 = join(config.NAS_BACKUP_ROOT, serverId, `${backupId}.tar.zst`);
  if (existsSync(p4)) return p4;

  // 3. Fallback: Verzeichnisse durchsuchen
  try {
    const entries = await readdir(config.NAS_BACKUP_ROOT, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (backupFilename) {
          const matchName = join(config.NAS_BACKUP_ROOT, entry.name, backupFilename);
          if (existsSync(matchName)) return matchName;
        }
        const matchId = join(config.NAS_BACKUP_ROOT, entry.name, `${backupId}.tar.zst`);
        if (existsSync(matchId)) return matchId;
      }
    }
  } catch {}

  return null;
}

/**
 * Synchronisiert ein fertiges Backup auf das UGREEN NAS mit Stream und Fortschrittsmessung
 */
export async function syncBackupToNas(
  serverId: string,
  backupId: string,
  onProgress?: (transferred: number, total: number, speed: number) => void
): Promise<boolean> {
  const src = backupFilePath(serverId, backupId);
  if (!existsSync(src)) return false;

  const isStandalone = !onProgress;
  let activeSync: ActiveNasSync | undefined;

  if (isStandalone) {
    const [b] = await sql<{ name: string; filename: string }[]>`SELECT name, filename FROM backups WHERE id = ${backupId}`;
    const [s] = await sql<{ name: string }[]>`SELECT name FROM servers WHERE id = ${serverId}`;
    const st = await stat(src).catch(() => null);
    if (st) {
      activeSync = {
        backupId,
        serverId,
        serverName: s?.name || serverId,
        backupName: b?.name || backupId,
        transferred: 0,
        total: st.size,
        speed: 0,
        progressPercent: 0,
        startedAt: Date.now(),
      };
      activeNasSyncs.set(backupId, activeSync);
    }
  }

  try {
    if (existsSync(config.NAS_BACKUP_ROOT)) {
      const dst = await getNasBackupDestinationPath(serverId, backupId);
      await mkdir(dirname(dst), { recursive: true });

      const st = await stat(src);
      const total = st.size;
      let transferred = 0;
      let lastReport = Date.now();
      let lastBytes = 0;
      let speed = 0;

      await new Promise<void>((resolve, reject) => {
        const inStream = createReadStream(src);
        const outStream = createWriteStream(dst);

        inStream.on('data', (chunk) => {
          transferred += chunk.length;
          const now = Date.now();
          if (now - lastReport >= 500) {
            speed = ((transferred - lastBytes) / (now - lastReport)) * 1000;
            lastReport = now;
            lastBytes = transferred;
            onProgress?.(transferred, total, speed);
            if (activeSync) {
              activeSync.transferred = transferred;
              activeSync.speed = speed;
              activeSync.progressPercent = Math.round((transferred / total) * 100);
            }
          }
        });

        inStream.on('error', (err) => {
          outStream.destroy();
          reject(err);
        });
        outStream.on('error', reject);
        outStream.on('finish', () => {
          onProgress?.(total, total, 0);
          if (activeSync) {
            activeSync.transferred = total;
            activeSync.progressPercent = 100;
          }
          resolve();
        });

        inStream.pipe(outStream);
      });

      log.info({ backupId, serverId, dst }, 'Backup erfolgreich auf UGREEN NAS synchronisiert');

      await writeEvent({
        serverId,
        kind: 'backup_nas_synced',
        severity: 'info',
        summary: `Backup erfolgreich auf UGREEN NAS gesichert`,
        payload: { backupId, path: dst },
      });

      return true;
    }
  } catch (err) {
    log.warn({ err, backupId, serverId }, 'Synchronisation zum UGREEN NAS fehlgeschlagen');
  } finally {
    if (activeSync) {
      setTimeout(() => {
        activeNasSyncs.delete(backupId);
      }, 3000);
    }
  }
  return false;
}

/**
 * Berechnet den SHA-256 Hash einer Datei als Checksumme mit Fortschritt
 */
async function computeSha256(
  filePath: string,
  totalSize?: number,
  onProgress?: (hashed: number, total: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    let hashed = 0;
    stream.on('data', (d) => {
      hash.update(d);
      hashed += d.length;
      if (totalSize && onProgress) {
        onProgress(hashed, totalSize);
      }
    });
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Startet die Erstellung eines Backups
 */
export async function createBackup(
  serverId: string,
  actor: { id: string; username: string },
  ip: string,
  customName?: string,
  ignoredFiles: string[] = []
): Promise<BackupRow> {
  // Pruefen, ob bereits ein Backup laeuft
  const [running] = await sql<{ id: string }[]>`
    SELECT id FROM backups WHERE server_id = ${serverId} AND status = 'running' LIMIT 1
  `;
  if (running) {
    throw new Error('Es wird bereits ein Backup für diesen Server erstellt');
  }

  // Server- & Spiel-Infos fuer Namensgebung laden
  const [srv] = await sql<{
    name: string;
    short_id: string;
    egg_name: string | null;
    egg_vars: Record<string, unknown> | null;
  }[]>`
    SELECT s.name, s.short_id, e.name AS egg_name, s.variables AS egg_vars
    FROM servers s
    LEFT JOIN eggs e ON e.id = s.egg_id
    WHERE s.id = ${serverId}
  `;
  if (!srv) {
    throw new Error('Server nicht gefunden');
  }

  // Version aus bekannten Umgebungsvariablen ermitteln (z. B. MINECRAFT_VERSION, VERSION, BUNDLE_VERSION)
  let version: string | null = null;
  if (srv.egg_vars) {
    for (const key of ['MINECRAFT_VERSION', 'VERSION', 'SERVER_VERSION', 'GAME_VERSION', 'BUILD_NUMBER']) {
      if (typeof srv.egg_vars[key] === 'string' && srv.egg_vars[key].trim()) {
        version = String(srv.egg_vars[key]).trim();
        break;
      }
    }
  }

  const generated = generateBackupName(srv.name, srv.egg_name || 'Generic', version);
  const finalName = customName?.trim() || generated.name;
  const finalFilename = sanitizeFileName(finalName) ? `${sanitizeFileName(finalName)}.tar.zst` : generated.filename;

  // Backup-Zeile in der Datenbank anlegen
  const [backup] = await sql<BackupRow[]>`
    INSERT INTO backups (server_id, name, filename, status, ignored_files)
    VALUES (${serverId}, ${finalName}, ${finalFilename}, 'running', ${ignoredFiles.length ? ignoredFiles : null})
    RETURNING *
  `;
  if (!backup) {
    throw new Error('Backup konnte nicht in der Datenbank angelegt werden');
  }

  // Backup im Hintergrund erstellen
  void runBackupCreation(backup.id, serverId, srv.short_id, ignoredFiles, actor, ip);

  return backup;
}

async function runBackupCreation(
  backupId: string,
  serverId: string,
  shortId: string,
  ignored: string[],
  actor: { id: string; username: string },
  ip: string
) {
  const dir = join(config.BACKUP_ROOT, serverId);
  const archivePath = backupFilePath(serverId, backupId);
  const srcDir = volumePath(shortId);

  // Server- & Backup-Name für aussagekräftige Live-Fortschrittsanzeige laden
  const [srv] = await sql<{ name: string }[]>`SELECT name FROM servers WHERE id = ${serverId}`;
  const serverName = srv?.name || serverId;
  const [bRow] = await sql<{ name: string }[]>`SELECT name FROM backups WHERE id = ${backupId}`;
  const backupName = bRow?.name || backupId;

  const serverMb = diskCollector.serverMb().get(serverId) ?? 0;
  const totalBytes = serverMb * 1024 * 1024;
  const targetCompressed = Math.max(totalBytes * 0.45, 10 * 1024 * 1024);

  const state: ActiveBackupState = {
    backupId,
    serverId,
    serverName,
    shortId,
    name: backupName,
    phase: 'compressing',
    bytesWritten: 0,
    totalBytes,
    progressPercent: 5,
    startedAt: Date.now(),
  };
  activeBackupStates.set(backupId, state);

  // Polling während Komprimierung läuft: misst Archivgröße und skaliert von 5% bis 65%
  const progressInterval = setInterval(() => {
    try {
      if (existsSync(archivePath)) {
        const sz = statSync(archivePath).size;
        state.bytesWritten = sz;
        const compPct = targetCompressed > 0 ? sz / targetCompressed : 0;
        state.progressPercent = Math.min(65, Math.max(5, Math.round(compPct * 60) + 5));
      }
    } catch {}
  }, 1000);

  try {
    await mkdir(dir, { recursive: true });

    // tar Argumente zusammenstellen
    const tarArgs = [
      '-cf',
      archivePath,
      '--zstd',
      '--exclude',
      '.panel',
      '--exclude',
      '*.log.gz',
    ];

    for (const ign of ignored) {
      if (ign.trim()) {
        tarArgs.push('--exclude', ign.trim());
      }
    }

    tarArgs.push('-C', srcDir, '.');

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        // GNU tar: Code 0 = Erfolg; Code 1 = Warnung (z. B. Datei geaendert waehrend des Lesens).
        // Code 1 wird nur akzeptiert, wenn die Archivdatei tatsaechlich existiert.
        if (code === 0 || (code === 1 && existsSync(archivePath))) {
          resolve();
        } else {
          reject(new Error(`tar beendet mit Code ${code}: ${stderr.trim() || 'Archiv wurde nicht erzeugt'}`));
        }
      });
      proc.on('error', reject);
    });

    clearInterval(progressInterval);

    const st = await stat(archivePath);
    state.archiveSize = st.size;
    state.bytesWritten = st.size;
    state.phase = 'hashing';
    state.progressPercent = 65;

    // Phase 2: Prüfsumme mit Fortschritt (65% bis 75%)
    const checksum = await computeSha256(archivePath, st.size, (hashed, total) => {
      state.hashedBytes = hashed;
      const hashPct = total > 0 ? hashed / total : 1;
      state.progressPercent = 65 + Math.round(hashPct * 10);
    });

    // Phase 3: UGREEN NAS Übertragung (75% bis 95%)
    if (existsSync(config.NAS_BACKUP_ROOT)) {
      state.phase = 'uploading_nas';
      state.nasTotal = st.size;
      state.nasTransferred = 0;
      state.progressPercent = 75;

      await syncBackupToNas(serverId, backupId, (transferred, total, speed) => {
        state.nasTransferred = transferred;
        state.nasTotal = total;
        state.nasSpeed = speed;
        const uploadPct = total > 0 ? transferred / total : 1;
        state.progressPercent = 75 + Math.round(uploadPct * 20);
      });
    }

    // Phase 4: Auto-Verifizierung & Retention ausführen
    const [srvConfig] = await sql<{
      auto_backup_verify: boolean;
      auto_backup_retention: number;
    }[]>`
      SELECT auto_backup_verify, auto_backup_retention FROM servers WHERE id = ${serverId}
    `;

    if (srvConfig?.auto_backup_verify) {
      state.phase = 'verifying';
      state.progressPercent = 95;
      await verifyBackup(serverId, backupId, actor).catch((err) => {
        log.warn({ err, backupId }, 'Automatische Verifizierung nach Backup-Erstellung fehlgeschlagen');
      });
    }

    state.progressPercent = 100;
    state.phase = 'completed';

    await sql`
      UPDATE backups
      SET status = 'completed',
          bytes = ${st.size},
          checksum = ${checksum},
          completed_at = now()
      WHERE id = ${backupId}
    `;

    await writeEvent({
      serverId,
      kind: 'backup_completed',
      severity: 'info',
      actorId: actor.id,
      summary: `Backup erfolgreich erstellt`,
      payload: { backupId, bytes: st.size },
    });

    await writeAudit({
      action: 'backup.create',
      userId: actor.id,
      actorName: actor.username,
      serverId,
      ip,
      metadata: { backupId, bytes: st.size },
    });

    if (srvConfig && srvConfig.auto_backup_retention > 0) {
      await rotateBackups(serverId, srvConfig.auto_backup_retention).catch((err) => {
        log.warn({ err, serverId }, 'Backup-Retention-Bereinigung fehlgeschlagen');
      });
    }
  } catch (err) {
    clearInterval(progressInterval);
    state.phase = 'failed';
    const errorMsg = err instanceof Error ? err.message : String(err);
    state.error = errorMsg;
    log.error({ err, backupId, serverId }, 'Backup-Erstellung fehlgeschlagen');

    await rm(archivePath, { force: true }).catch(() => {});

    await sql`
      UPDATE backups
      SET status = 'failed',
          error = ${errorMsg},
          completed_at = now()
      WHERE id = ${backupId}
    `;

    await writeEvent({
      serverId,
      kind: 'backup_failed',
      severity: 'error',
      actorId: actor.id,
      summary: `Backup fehlgeschlagen: ${errorMsg}`,
      payload: { backupId },
    });
  } finally {
    setTimeout(() => {
      activeBackupStates.delete(backupId);
    }, 4000);
  }
}

/**
 * Bereinigt beim Panel-Start verwaiste Backups, deren Erstellung durch
 * einen Panel-Neustart oder Container-Absturz unterbrochen wurde.
 */
export async function cleanupOrphanedBackups(): Promise<void> {
  const orphaned = await sql<BackupRow[]>`
    SELECT * FROM backups WHERE status = 'running'
  `;
  if (orphaned.length === 0) return;

  log.info({ count: orphaned.length }, 'Verwaiste Backups nach Panel-Start werden bereinigt');
  for (const b of orphaned) {
    const p = backupFilePath(b.server_id, b.id);
    await sql`
      UPDATE backups
      SET status = 'failed',
          error = 'Erstellung durch Panel-Neustart oder Server-Absturz unterbrochen',
          completed_at = now()
      WHERE id = ${b.id}
    `;
    await rm(p, { force: true }).catch(() => {});
    log.info({ backupId: b.id, serverId: b.server_id }, 'Verwaistes Backup auf fehlgeschlagen gesetzt und bereinigt');
  }
}

/**
 * Stellt ein Backup wieder her
 */
export async function restoreBackup(
  serverId: string,
  backupId: string,
  actor: { id: string; username: string },
  ip: string
): Promise<void> {
  const [srv] = await sql<{ short_id: string; status: string }[]>`
    SELECT short_id, status FROM servers WHERE id = ${serverId}
  `;
  if (!srv) throw new Error('Server nicht gefunden');

  if (!(STOPPED_STATES as readonly string[]).includes(srv.status)) {
    throw new Error(`Server läuft oder ist im Zustand "${srv.status}" – vor dem Wiederherstellen stoppen`);
  }

  const [backup] = await sql<BackupRow[]>`
    SELECT * FROM backups WHERE id = ${backupId} AND server_id = ${serverId}
  `;
  if (!backup) throw new Error('Backup nicht gefunden');
  if (backup.status !== 'completed') {
    throw new Error('Nur erfolgreich abgeschlossene Backups können wiederhergestellt werden');
  }

  let archivePath = backupFilePath(serverId, backupId);
  if (!existsSync(archivePath)) {
    const nasPath = await findNasBackupPath(serverId, backupId, backup.filename);
    if (nasPath && existsSync(nasPath)) {
      archivePath = nasPath;
    } else {
      throw new Error('Backup-Datei weder lokal noch auf dem UGREEN NAS gefunden');
    }
  }

  const destDir = volumePath(srv.short_id);
  await mkdir(destDir, { recursive: true });

  await sql`UPDATE backups SET status = 'restoring' WHERE id = ${backupId}`;

  try {
    // Entpacken via tar
    const tarArgs = ['-xf', archivePath, '-C', destDir];
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Entpacken fehlgeschlagen mit Code ${code}: ${stderr}`));
      });
      proc.on('error', reject);
    });

    await sql`UPDATE backups SET status = 'completed' WHERE id = ${backupId}`;

    await writeEvent({
      serverId,
      kind: 'backup_restored',
      severity: 'info',
      actorId: actor.id,
      summary: `Backup "${backup.name}" wiederhergestellt`,
      payload: { backupId, backupName: backup.name },
    });

    await writeAudit({
      action: 'backup.restore',
      userId: actor.id,
      actorName: actor.username,
      serverId,
      ip,
      metadata: { backupId, backupName: backup.name },
    });
  } catch (err) {
    await sql`UPDATE backups SET status = 'completed' WHERE id = ${backupId}`;
    throw err;
  }
}

/**
 * Löscht ein Backup (außer wenn gesperrt)
 */
export async function deleteBackup(
  serverId: string,
  backupId: string,
  actor: { id: string; username: string },
  ip: string
): Promise<void> {
  const [backup] = await sql<BackupRow[]>`
    SELECT * FROM backups WHERE id = ${backupId} AND server_id = ${serverId}
  `;
  if (!backup) throw new Error('Backup nicht gefunden');

  if (backup.locked) {
    throw new Error('Gesperrte Backups können nicht gelöscht werden. Vorher die Sperre aufheben.');
  }

  const archivePath = backupFilePath(serverId, backupId);
  await rm(archivePath, { force: true }).catch(() => {});
  const nasPath = await findNasBackupPath(serverId, backupId, backup.filename);
  if (nasPath) {
    await rm(nasPath, { force: true }).catch(() => {});
  }

  await sql`DELETE FROM backups WHERE id = ${backupId}`;

  await writeAudit({
    action: 'backup.delete',
    userId: actor.id,
    actorName: actor.username,
    serverId,
    ip,
    metadata: { backupId, backupName: backup.name },
  });
}

/**
 * Sperre umschalten (Lock against deletion / auto-retention)
 */
export async function setBackupLock(
  serverId: string,
  backupId: string,
  locked: boolean
): Promise<BackupRow> {
  const [backup] = await sql<BackupRow[]>`
    UPDATE backups
    SET locked = ${locked}
    WHERE id = ${backupId} AND server_id = ${serverId}
    RETURNING *
  `;
  if (!backup) throw new Error('Backup nicht gefunden');
  return backup;
}

/**
 * Backups auflisten
 */
export async function listBackups(serverId: string): Promise<BackupRow[]> {
  const rows = await sql<BackupRow[]>`
    SELECT * FROM backups
    WHERE server_id = ${serverId}
    ORDER BY created_at DESC
  `;
  const [srv] = await sql<{ name: string }[]>`SELECT name FROM servers WHERE id = ${serverId}`;
  const serverFolder = srv?.name ? sanitizeFileName(srv.name) : serverId;

  return rows.map((r) => {
    const hasNas =
      existsSync(join(config.NAS_BACKUP_ROOT, serverFolder, r.filename)) ||
      existsSync(join(config.NAS_BACKUP_ROOT, serverFolder, `${r.id}.tar.zst`)) ||
      existsSync(join(config.NAS_BACKUP_ROOT, serverId, r.filename)) ||
      existsSync(join(config.NAS_BACKUP_ROOT, serverId, `${r.id}.tar.zst`));

    return {
      ...r,
      nas_stored: hasNas,
    };
  });
}

/**
 * Prueft spielsicherheitsrelevante Pflichtdateien im entpackten Archiv-Listing
 */
function checkGameCriticalFiles(
  files: string[],
  eggName?: string | null
): { found: string[]; missing: string[] } {
  const normEgg = (eggName || '').toLowerCase();
  let expected: string[] = [];

  if (normEgg.includes('minecraft')) {
    expected = ['level.dat', 'server.properties'];
  } else if (normEgg.includes('ark')) {
    expected = ['GameUserSettings.ini', 'SavedArks'];
  } else if (normEgg.includes('palworld')) {
    expected = ['PalWorldSettings.ini', 'Level.sav'];
  } else if (normEgg.includes('enshrouded')) {
    expected = ['enshrouded_server.json', 'savegame'];
  } else if (normEgg.includes('rust')) {
    expected = ['server.cfg', '.sav'];
  } else if (normEgg.includes('valheim')) {
    expected = ['.db', '.fwl'];
  } else if (normEgg.includes('counter-strike') || normEgg.includes('cs2')) {
    expected = ['server.cfg'];
  } else if (normEgg.includes('teamspeak')) {
    expected = ['sqlitedb'];
  }

  const found: string[] = [];
  const missing: string[] = [];

  for (const exp of expected) {
    const has = files.some((f) => f.toLowerCase().includes(exp.toLowerCase()));
    if (has) found.push(exp);
    else missing.push(exp);
  }

  return { found, missing };
}

async function updateBackupVerification(backupId: string, res: VerificationResult): Promise<void> {
  await sql`
    UPDATE backups
    SET verification_status = ${res.status},
        verified_at = ${res.verifiedAt},
        verification_details = ${sql.json(res as never)}
    WHERE id = ${backupId}
  `;
}

/**
 * Prueft ein Backup auf Integritaet und Funktionalitaet (SHA-256 Hash, TAR-Dekodierung, Spieldateien)
 */
export async function verifyBackup(
  serverId: string,
  backupId: string,
  actor?: { id: string; username: string }
): Promise<VerificationResult> {
  const [backup] = await sql<(BackupRow & { egg_name?: string | null })[]>`
    SELECT b.*, e.name AS egg_name
    FROM backups b
    JOIN servers s ON s.id = b.server_id
    LEFT JOIN eggs e ON e.id = s.egg_id
    WHERE b.id = ${backupId} AND b.server_id = ${serverId}
  `;
  if (!backup) throw new Error('Backup nicht gefunden');
  if (backup.status !== 'completed') {
    throw new Error('Nur abgeschlossene Backups können verifiziert werden');
  }

  const archivePath = backupFilePath(serverId, backupId);
  const verifiedAt = new Date().toISOString();

  // 1. Physische Existenz auf Festplatte
  if (!existsSync(archivePath)) {
    const res: VerificationResult = {
      status: 'corrupted',
      sha256Match: false,
      archiveIntact: false,
      filesCount: 0,
      criticalFilesFound: [],
      error: 'Archivdatei existiert nicht auf der Festplatte',
      verifiedAt,
    };
    await updateBackupVerification(backupId, res);
    return res;
  }

  // 2. SHA-256 Pruefsumme abgleichen
  let currentHash: string | null = null;
  try {
    currentHash = await computeSha256(archivePath);
  } catch (err) {
    const res: VerificationResult = {
      status: 'corrupted',
      sha256Match: false,
      archiveIntact: false,
      filesCount: 0,
      criticalFilesFound: [],
      error: `Hash-Berechnung fehlgeschlagen: ${(err as Error).message}`,
      verifiedAt,
    };
    await updateBackupVerification(backupId, res);
    return res;
  }

  const shaMatch = backup.checksum ? currentHash === backup.checksum : true;
  if (!shaMatch) {
    const res: VerificationResult = {
      status: 'corrupted',
      sha256Match: false,
      archiveIntact: false,
      filesCount: 0,
      criticalFilesFound: [],
      error: 'SHA-256 Prüfsummen-Abweichung! Archiv wurde nachträglich modifiziert oder ist fehlerhaft.',
      verifiedAt,
    };
    await updateBackupVerification(backupId, res);
    return res;
  }

  // 3. Archiv-Integritaet & Dateiinhalte per tar testen (ohne auf Platte zu entpacken)
  let filesList: string[] = [];
  try {
    const tarOutput = await new Promise<string>((resolve, reject) => {
      const proc = spawn('tar', ['--zstd', '-tf', archivePath], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.trim() || `tar Test beendet mit Code ${code}`));
      });
      proc.on('error', reject);
    });
    filesList = tarOutput.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    const res: VerificationResult = {
      status: 'corrupted',
      sha256Match: true,
      archiveIntact: false,
      filesCount: 0,
      criticalFilesFound: [],
      error: `Archiv-Dekodierung fehlgeschlagen: ${(err as Error).message}`,
      verifiedAt,
    };
    await updateBackupVerification(backupId, res);
    return res;
  }

  if (filesList.length === 0) {
    const res: VerificationResult = {
      status: 'corrupted',
      sha256Match: true,
      archiveIntact: false,
      filesCount: 0,
      criticalFilesFound: [],
      error: 'Archiv enthält keine Dateien (leeres Archiv)',
      verifiedAt,
    };
    await updateBackupVerification(backupId, res);
    return res;
  }

  // 4. Spielspezifische Pflichtdateien pruefen
  const { found, missing } = checkGameCriticalFiles(filesList, backup.egg_name);

  const res: VerificationResult = {
    status: 'valid',
    sha256Match: true,
    archiveIntact: true,
    filesCount: filesList.length,
    criticalFilesFound: found,
    missingCriticalFiles: missing.length > 0 ? missing : undefined,
    verifiedAt,
  };

  await updateBackupVerification(backupId, res);

  await writeEvent({
    serverId,
    kind: 'backup_verified',
    severity: 'info',
    actorId: actor?.id ?? null,
    summary: `Backup "${backup.name}" erfolgreich validiert (${filesList.length} Dateien intakt)`,
    payload: { backupId, filesCount: filesList.length, foundCriticalFiles: found },
  });

  return res;
}

/**
 * Bereinigt aeltere ungesperrte Backups gemaess Retention-Limit
 */
export async function rotateBackups(
  serverId: string,
  retentionLimit: number
): Promise<{ deletedCount: number; deletedIds: string[] }> {
  if (!retentionLimit || retentionLimit <= 0) return { deletedCount: 0, deletedIds: [] };

  const unlocked = await sql<{ id: string; name: string }[]>`
    SELECT id, name
    FROM backups
    WHERE server_id = ${serverId}
      AND status = 'completed'
      AND locked = false
    ORDER BY created_at DESC
  `;

  if (unlocked.length <= retentionLimit) {
    return { deletedCount: 0, deletedIds: [] };
  }

  const toDelete = unlocked.slice(retentionLimit);
  const deletedIds: string[] = [];

  for (const b of toDelete) {
    const archivePath = backupFilePath(serverId, b.id);
    await rm(archivePath, { force: true }).catch(() => {});
    const nasPath = await findNasBackupPath(serverId, b.id);
    if (nasPath) {
      await rm(nasPath, { force: true }).catch(() => {});
    }
    await sql`DELETE FROM backups WHERE id = ${b.id}`;
    deletedIds.push(b.id);
  }

  if (deletedIds.length > 0) {
    await writeEvent({
      serverId,
      kind: 'backup_retention_rotated',
      severity: 'info',
      summary: `${deletedIds.length} ältere(s) Backup(s) gemäss Aufbewahrungslimit (${retentionLimit}) rotiert`,
      payload: { deletedCount: deletedIds.length, deletedIds },
    });
  }

  return { deletedCount: deletedIds.length, deletedIds };
}
