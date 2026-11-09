import type { Server as SshServer } from 'ssh2';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { openSync, readSync, writeSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { log } from '../log.js';
import { findUserForLogin } from '../auth/users.js';
import { verifyPassword } from '../auth/password.js';
import type { Actor } from '../auth/permissions.js';
import { listServersForActor, type ServerListItem } from './access.js';
import { safePath, FilePathSecurityError } from './files.js';

const { STATUS_CODE, OPEN_MODE, flagsToString } = utils.sftp;

function hasPerm(server: ServerListItem, flag: string): boolean {
  return server.permissions.includes(flag);
}

function getOrCreateHostKey(): string {
  const keyDir = resolve(config.VOLUME_ROOT);
  if (!existsSync(keyDir)) {
    mkdirSync(keyDir, { recursive: true });
  }
  const keyPath = join(keyDir, '.sftp_host_key.pem');
  if (existsSync(keyPath)) {
    try {
      return readFileSync(keyPath, 'utf8');
    } catch (err) {
      log.warn({ err }, 'Konnte bestehenden SFTP-Host-Key nicht lesen, erstelle neuen');
    }
  }

  const generated = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  } as any) as unknown as { privateKey: string };

  const privateKey = generated.privateKey;

  try {
    writeFileSync(keyPath, privateKey, { mode: 0o600 });
  } catch (err) {
    log.warn({ err }, 'Konnte SFTP-Host-Key nicht auf Festplatte sichern');
  }
  return privateKey;
}

interface SftpSessionState {
  actor: Actor & { username: string };
  /** Wenn angegeben: direkter Chroot in diesen Server */
  directServer?: ServerListItem | undefined;
  /** Liste aller zugaenglichen Server (fuer Root-Uebersicht) */
  accessibleServers: ServerListItem[];
}

export function createSftpServer(): SshServer | null {
  if (!config.SFTP_ENABLED) {
    log.info('SFTP-Server ist in der Konfiguration deaktiviert');
    return null;
  }

  let hostKey: string;
  try {
    hostKey = getOrCreateHostKey();
  } catch (err) {
    log.error({ err }, 'SFTP Host-Key konnte nicht geladen oder generiert werden');
    return null;
  }

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let sessionState: SftpSessionState | null = null;

    client.on('authentication', async (ctx) => {
      if (ctx.method !== 'password') {
        return ctx.reject(['password']);
      }

      const rawUsername = ctx.username.trim();
      const password = ctx.password;

      // Format: "username.short_id" ODER "username"
      let loginName = rawUsername;
      let targetShortId: string | null = null;

      const lastDot = rawUsername.lastIndexOf('.');
      if (lastDot > 0 && lastDot < rawUsername.length - 1) {
        loginName = rawUsername.slice(0, lastDot);
        targetShortId = rawUsername.slice(lastDot + 1).toLowerCase();
      }

      const user = await findUserForLogin(loginName);
      if (!user || user.suspended) {
        return ctx.reject(['password']);
      }

      const valid = await verifyPassword(user.password_hash, password);
      if (!valid) {
        return ctx.reject(['password']);
      }

      const actor: Actor & { username: string } = {
        id: user.id,
        role: user.role,
        canCreateServers: user.can_create_servers,
        allowedEggs: user.allowed_eggs ?? null,
        username: user.username,
      };

      const allServers = await listServersForActor(actor);
      const readable = allServers.filter((s) => hasPerm(s, 'file.read'));

      if (targetShortId) {
        const found = readable.find(
          (s) => s.shortId.toLowerCase() === targetShortId || s.id.toLowerCase() === targetShortId
        );
        if (!found) {
          log.warn({ user: user.username, targetShortId }, 'SFTP-Login fehlgeschlagen: Kein Zugriff auf diesen Server');
          return ctx.reject(['password']);
        }
        sessionState = {
          actor,
          directServer: found,
          accessibleServers: readable,
        };
      } else {
        sessionState = {
          actor,
          accessibleServers: readable,
        };
      }

      ctx.accept();
    });

    client.on('session', (accept) => {
      const session = accept();

      session.on('sftp', (acceptSftp, rejectSftp) => {
        if (!sessionState) return rejectSftp?.();
        const sftp = acceptSftp();
        setupSftpHandlers(sftp, sessionState);
      });
    });

    client.on('error', (err: unknown) => {
      // Ignoriere typische Abbruch-Fehler (z. B. Client schließt Fenster)
      if ((err as any)?.code !== 'ECONNRESET') {
        log.debug({ err }, 'SFTP-Verbindungsfehler');
      }
    });
  });

  return server;
}

function setupSftpHandlers(sftp: any, state: SftpSessionState) {
  const openFiles = new Map<string, { fd: number; server: ServerListItem; path: string }>();
  const openDirs = new Map<string, { items: Array<{ filename: string; longname: string; attrs: any }>; index: number }>();

  function resolveTarget(virtualPath: string): { server: ServerListItem; relPath: string } | 'root' | null {
    const clean = virtualPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (state.directServer) {
      return { server: state.directServer, relPath: clean };
    }

    if (!clean) return 'root';

    const slashIdx = clean.indexOf('/');
    const serverIdent = slashIdx === -1 ? clean : clean.slice(0, slashIdx);
    const subPath = slashIdx === -1 ? '' : clean.slice(slashIdx + 1);

    const srv = state.accessibleServers.find(
      (s) => s.shortId.toLowerCase() === serverIdent.toLowerCase() || s.name.toLowerCase() === serverIdent.toLowerCase()
    );

    if (!srv) return null;
    return { server: srv, relPath: subPath };
  }

  sftp.on('REALPATH', (reqid: number, path: string) => {
    let normalized = path.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    if (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    sftp.name(reqid, [{ filename: normalized }]);
  });

  sftp.on('STAT', async (reqid: number, path: string) => {
    const target = resolveTarget(path);
    if (!target) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);

    if (target === 'root') {
      const now = new Date();
      return sftp.attrs(reqid, {
        mode: 0o040755,
        uid: 1000,
        gid: 1000,
        size: 4096,
        atime: Math.floor(now.getTime() / 1000),
        mtime: Math.floor(now.getTime() / 1000),
      });
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      const st = await fs.stat(fullPath);
      sftp.attrs(reqid, st);
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('LSTAT', async (reqid: number, path: string) => {
    const target = resolveTarget(path);
    if (!target) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);

    if (target === 'root') {
      const now = new Date();
      return sftp.attrs(reqid, {
        mode: 0o040755,
        uid: 1000,
        gid: 1000,
        size: 4096,
        atime: Math.floor(now.getTime() / 1000),
        mtime: Math.floor(now.getTime() / 1000),
      });
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      const st = await fs.lstat(fullPath);
      sftp.attrs(reqid, st);
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('OPENDIR', async (reqid: number, path: string) => {
    const target = resolveTarget(path);
    if (!target) return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);

    if (target === 'root') {
      const items = state.accessibleServers.map((s) => ({
        filename: s.shortId,
        longname: `drwxr-xr-x 1 panel panel 4096 Jan 01 00:00 ${s.shortId}`,
        attrs: { mode: 0o040755, size: 4096, mtime: Math.floor(Date.now() / 1000) },
      }));
      const handle = randomBytes(16);
      openDirs.set(handle.toString('hex'), { items, index: 0 });
      return sftp.handle(reqid, handle);
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const items: Array<{ filename: string; longname: string; attrs: any }> = [];

      for (const ent of entries) {
        try {
          const entStat = await fs.stat(join(fullPath, ent.name));
          const typeChar = ent.isDirectory() ? 'd' : '-';
          const modeStr = `${typeChar}rwxr-xr-x`;
          items.push({
            filename: ent.name,
            longname: `${modeStr} 1 panel panel ${entStat.size} ${entStat.mtime.toDateString()} ${ent.name}`,
            attrs: entStat,
          });
        } catch {}
      }

      const handle = randomBytes(16);
      openDirs.set(handle.toString('hex'), { items, index: 0 });
      sftp.handle(reqid, handle);
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }
  });

  sftp.on('READDIR', (reqid: number, handle: Buffer) => {
    const key = handle.toString('hex');
    const d = openDirs.get(key);
    if (!d) return sftp.status(reqid, STATUS_CODE.FAILURE);

    if (d.index >= d.items.length) {
      return sftp.status(reqid, STATUS_CODE.EOF);
    }

    // Chunkweise senden (z. B. 64 Einträge)
    const chunk = d.items.slice(d.index, d.index + 64);
    d.index += chunk.length;
    sftp.name(reqid, chunk);
  });

  sftp.on('OPEN', async (reqid: number, filename: string, flags: number, attrs: any) => {
    const target = resolveTarget(filename);
    if (!target || target === 'root') {
      return sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
    }

    const isWrite = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
    const isRead = (flags & OPEN_MODE.READ) !== 0;

    if (isWrite && !hasPerm(target.server, 'file.write')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }
    if (isRead && !hasPerm(target.server, 'file.read')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      const fsMode = flagsToString(flags) || 'r';
      const fd = openSync(fullPath, fsMode);

      const handle = randomBytes(16);
      openFiles.set(handle.toString('hex'), { fd, server: target.server, path: fullPath });
      sftp.handle(reqid, handle);
    } catch (err: any) {
      if (err instanceof FilePathSecurityError) {
        sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
      } else if (err?.code === 'ENOENT') {
        sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      } else {
        sftp.status(reqid, STATUS_CODE.FAILURE);
      }
    }
  });

  sftp.on('READ', (reqid: number, handle: Buffer, offset: number, length: number) => {
    const key = handle.toString('hex');
    const f = openFiles.get(key);
    if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE);

    const buf = Buffer.alloc(length);
    try {
      const bytesRead = readSync(f.fd, buf, 0, length, offset);
      if (bytesRead === 0) {
        return sftp.status(reqid, STATUS_CODE.EOF);
      }
      sftp.data(reqid, buf.subarray(0, bytesRead));
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
    const key = handle.toString('hex');
    const f = openFiles.get(key);
    if (!f) return sftp.status(reqid, STATUS_CODE.FAILURE);

    try {
      writeSync(f.fd, data, 0, data.length, offset);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
    const key = handle.toString('hex');
    const f = openFiles.get(key);
    if (f) {
      try { closeSync(f.fd); } catch {}
      openFiles.delete(key);
      return sftp.status(reqid, STATUS_CODE.OK);
    }
    const d = openDirs.get(key);
    if (d) {
      openDirs.delete(key);
      return sftp.status(reqid, STATUS_CODE.OK);
    }
    sftp.status(reqid, STATUS_CODE.OK);
  });

  sftp.on('UNLINK', async (reqid: number, path: string) => {
    const target = resolveTarget(path);
    if (!target || target === 'root') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (!hasPerm(target.server, 'file.delete')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      await fs.unlink(fullPath);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err: any) {
      if (err?.code === 'ENOENT') sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      else sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('RMDIR', async (reqid: number, path: string) => {
    const target = resolveTarget(path);
    if (!target || target === 'root') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (!hasPerm(target.server, 'file.delete')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      await fs.rm(fullPath, { recursive: true });
      sftp.status(reqid, STATUS_CODE.OK);
    } catch (err: any) {
      if (err?.code === 'ENOENT') sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
      else sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('MKDIR', async (reqid: number, path: string, attrs: any) => {
    const target = resolveTarget(path);
    if (!target || target === 'root') return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    if (!hasPerm(target.server, 'file.write')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      await fs.mkdir(fullPath, { recursive: true });
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('RENAME', async (reqid: number, oldPath: string, newPath: string) => {
    const oldTarget = resolveTarget(oldPath);
    const newTarget = resolveTarget(newPath);
    if (!oldTarget || !newTarget || oldTarget === 'root' || newTarget === 'root') {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }
    if (oldTarget.server.id !== newTarget.server.id) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }
    if (!hasPerm(oldTarget.server, 'file.write')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }

    try {
      const oldReal = (await safePath(oldTarget.server.shortId, oldTarget.relPath)).fullPath;
      const newReal = (await safePath(newTarget.server.shortId, newTarget.relPath)).fullPath;
      await fs.rename(oldReal, newReal);
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });

  sftp.on('SETSTAT', async (reqid: number, path: string, attrs: any) => {
    const target = resolveTarget(path);
    if (!target || target === 'root') return sftp.status(reqid, STATUS_CODE.OK);
    if (!hasPerm(target.server, 'file.write')) {
      return sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
    }

    try {
      const { fullPath } = await safePath(target.server.shortId, target.relPath);
      if (attrs.mtime && attrs.atime) {
        await fs.utimes(fullPath, attrs.atime, attrs.mtime);
      }
      sftp.status(reqid, STATUS_CODE.OK);
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE);
    }
  });
}

export function startSftpService(): Promise<{ close: () => Promise<void> } | null> {
  const srv = createSftpServer();
  if (!srv) return Promise.resolve(null);

  return new Promise((resolve) => {
    srv.listen(config.SFTP_PORT, '0.0.0.0', () => {
      log.info(`SFTP-Server aktiv auf Port ${config.SFTP_PORT} (Standard-Login: username.shortId)`);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            srv.close(() => done());
          }),
      });
    });

    srv.on('error', (err: unknown) => {
      log.error({ err }, 'SFTP-Server Startfehler');
      resolve(null);
    });
  });
}
