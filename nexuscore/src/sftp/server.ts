import fs from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2, { type SFTPWrapper } from 'ssh2';
import type { ServerInstanceConfig } from '../types.js';
import type { AccountUser, LocalAccount } from '../store/account.js';
import type { ServerRegistry } from '../store/registry.js';
import { runAs } from '../store/identity.js';
import { logger } from '../logger.js';
import { flagsFor, type AccessPolicy, type RequestActor } from '../http/authz.js';
import { resolveInstanceDir } from '../files/instance-dir.js';
import { FileAccessError, resolveEntry } from '../files/files.js';
import type { ServerFlag } from '../auth/permissions.js';

/**
 * SFTP-Zugang zu den Dateien der Server - gleiche Anmeldung wie im Panel ("benutzer.kurzid" oder nur
 * "benutzer" mit Uebersicht aller Server), aber mit den Regeln des Cores:
 *  - dieselben Rechte wie in der Weboberflaeche (Dateien lesen, aendern, loeschen, "file.sftp"),
 *  - auf dem nativen Treiber schreiben nur Administratoren (sonst liessen sich Programme auf dem PC
 *    ueberschreiben und ausfuehren),
 *  - jeder Pfad geht durch dieselbe Pruefung wie der Dateimanager (nie aus dem Server-Ordner heraus,
 *    keine Windows-Sondernamen, Symlinks werden aufgeloest),
 *  - Rechte und Sperren gelten sofort, auch in einer offenen Verbindung.
 */

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE, flagsToString } = utils.sftp;

const MAX_HANDLES = 64;

export interface SftpDeps {
  account: LocalAccount;
  registry: ServerRegistry;
  policy: AccessPolicy;
  host: string;
  port: number;
  /** Hoechste Dateigroesse beim Schreiben (MB). */
  maxUploadMb: number;
}

export interface SftpService {
  port: number;
  /** SHA-256-Fingerabdruck des Host-Schluessels (so wie ihn ein SFTP-Programm anzeigt). */
  fingerprint: string;
  close: () => Promise<void>;
}

interface Accessible {
  instance: ServerInstanceConfig;
  shortId: string;
  root: string;
  flags: ServerFlag[];
}

// -------------------------------------------------------------- Host-Schluessel

function loadHostKey(dir: string): { key: string; fingerprint: string } {
  const file = path.join(dir, 'sftp_host_key.pem');
  let key: string | undefined;
  if (existsSync(file)) {
    try {
      key = readFileSync(file, 'utf8');
    } catch (err) {
      logger.warn({ err }, 'SFTP-Host-Schluessel nicht lesbar - es wird ein neuer erzeugt');
    }
  }
  if (!key) {
    const pair = utils.generateKeyPairSync('ed25519');
    key = pair.private;
    try {
      // sync, damit der Schluessel vor dem ersten Start sicher auf der Platte liegt
      writeFileSync(file, key, { mode: 0o600 });
    } catch (err) {
      logger.warn({ err }, 'SFTP-Host-Schluessel konnte nicht gespeichert werden - er gilt nur bis zum Neustart');
    }
  }
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error) throw parsed;
  const pub = Array.isArray(parsed) ? parsed[0]! : parsed;
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(pub.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
  return { key, fingerprint };
}

// -------------------------------------------------------------------- Hilfen

const toSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

function attrsOf(st: Stats): { mode: number; uid: number; gid: number; size: number; atime: number; mtime: number } {
  // Keine echten Besitzer und Rechtebits des Rechners nach aussen geben
  return {
    mode: st.isDirectory() ? 0o040755 : st.isSymbolicLink() ? 0o120777 : 0o100644,
    uid: 1000,
    gid: 1000,
    size: st.size,
    atime: toSeconds(st.atime),
    mtime: toSeconds(st.mtime),
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "ls -l"-Zeile - manche Programme (FileZilla) lesen die Angaben daraus. */
function longname(name: string, st: Pick<Stats, 'size' | 'mtime'> & { isDirectory(): boolean }): string {
  const d = st.mtime;
  const day = String(d.getDate()).padStart(2, ' ');
  const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--'} 1 nexus nexus ${st.size} ${MONTHS[d.getMonth()]} ${day} ${time} ${name}`;
}

function actorOf(user: AccountUser): RequestActor {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    canCreateServers: user.canCreateServers,
    allowedEggs: user.allowedEggs,
    globalPermissions: user.globalPermissions,
    master: false,
  };
}

function statusFor(err: unknown): number {
  if (err instanceof FileAccessError) return err.code === 'invalid_path' ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return STATUS_CODE.NO_SUCH_FILE;
  if (code === 'EACCES' || code === 'EPERM') return STATUS_CODE.PERMISSION_DENIED;
  return STATUS_CODE.FAILURE;
}

// -------------------------------------------------------------------- Server

export async function startSftp(deps: SftpDeps): Promise<SftpService> {
  const { account, registry, policy } = deps;
  const { key, fingerprint } = loadHostKey(registry.dir);
  const live = new Set<{ end: () => void }>();

  const server = new Server({ hostKeys: [key] }, (client, info) => {
    const ip = info?.ip ?? 'unbekannt';
    let user: AccountUser | null = null;
    /** Gewuenschter Server aus dem Anmeldenamen ("benutzer.kurzid"). */
    let direct: string | null = null;
    const files = new Map<string, { handle: fs.FileHandle; write: boolean; size: number }>();
    const dirs = new Map<string, Array<{ filename: string; longname: string; attrs: ReturnType<typeof attrsOf> }>>();
    live.add(client);

    const audit = (action: string, meta: Record<string, unknown>): void => {
      try {
        if (user) runAs({ userId: user.id, username: user.username }, () => registry.audit(action, null, 'standalone', { ip, ...meta }));
        else registry.audit(action, null, 'standalone', { ip, ...meta });
      } catch {
        /* Protokoll darf die Verbindung nicht beenden */
      }
    };

    client.on('authentication', (ctx) => {
      if (ctx.method !== 'password') return ctx.reject(['password']);
      void (async () => {
        const raw = ctx.username.trim();
        // "name" oder "name.kurzid": gibt es "name.xyz" als ganzes Konto (Punkt im Namen, E-Mail), gilt das
        let login = raw;
        let target: string | null = null;
        const dot = raw.lastIndexOf('.');
        if (dot > 0 && dot < raw.length - 1 && !account.findByLogin(raw)) {
          login = raw.slice(0, dot);
          target = raw.slice(dot + 1).toLowerCase();
        }
        const found = await account.verifySftp(login, ctx.password, ip);
        if (!found) {
          audit('sftp.login_failed', { login: login.slice(0, 64) });
          return ctx.reject(['password']);
        }
        user = found;
        direct = target;
        // Ein Server, den es nicht gibt oder der diesem Benutzer nicht offensteht: wie im Panel schon beim Anmelden abweisen
        if (target && !(await accessible())?.length) {
          audit('sftp.login_failed', { login: login.slice(0, 64), target, reason: 'kein Zugriff auf diesen Server' });
          user = null;
          return ctx.reject(['password']);
        }
        await account.recordLogin(found.id);
        audit('sftp.login', { target });
        ctx.accept();
      })().catch((err) => {
        logger.error({ err }, 'SFTP-Anmeldung fehlgeschlagen');
        ctx.reject(['password']);
      });
    });

    /** Server, die diesem Benutzer jetzt per SFTP offenstehen - bei jeder Anfrage neu, damit Rechte sofort gelten. */
    const accessible = async (): Promise<Accessible[] | null> => {
      const current = user ? account.get(user.id) : undefined;
      if (!current || current.suspended) return null;
      const actor = actorOf(current);
      const out: Accessible[] = [];
      for (const instance of registry.list()) {
        const flags = flagsFor(registry, instance.id, actor, policy);
        if (!flags.includes('file.sftp') || !flags.includes('file.read')) continue;
        const root = await resolveInstanceDir(registry, instance).catch(() => null);
        if (!root) continue;
        out.push({ instance, shortId: instance.id.slice(0, 8).toLowerCase(), root, flags });
      }
      if (direct) {
        const one = out.find((s) => s.shortId === direct || s.instance.id.toLowerCase() === direct);
        return one ? [one] : [];
      }
      return out;
    };

    type Target = { server: Accessible; rel: string } | 'root' | null;
    const resolveTarget = async (virtual: string): Promise<Target> => {
      const list = await accessible();
      if (!list) return null;
      const clean = virtual.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
      if (direct) return list[0] ? { server: list[0], rel: clean } : null;
      if (!clean) return 'root';
      const slash = clean.indexOf('/');
      const ident = (slash === -1 ? clean : clean.slice(0, slash)).toLowerCase();
      const rel = slash === -1 ? '' : clean.slice(slash + 1);
      const server = list.find((s) => s.shortId === ident || s.instance.name.toLowerCase() === ident || s.instance.id.toLowerCase() === ident);
      return server ? { server, rel } : null;
    };

    const need = (t: { server: Accessible }, flag: ServerFlag): boolean => t.server.flags.includes(flag);
    const isRootOfServer = (rel: string): boolean => rel.replace(/\/+/g, '/').split('/').filter((p) => p && p !== '.').length === 0;

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (acceptSftp, rejectSftp) => {
          if (!user) return rejectSftp?.();
          const sftp = acceptSftp();
          handlers(sftp);
        });
      });
    });

    const newHandle = (): Buffer => crypto.randomBytes(16);

    function handlers(sftp: SFTPWrapper): void {
      const guard = (reqid: number, run: () => Promise<void>): void => {
        run().catch((err) => {
          if (!(err instanceof FileAccessError) && !(err as NodeJS.ErrnoException)?.code) logger.warn({ err }, 'SFTP-Fehler');
          try {
            sftp.status(reqid, statusFor(err));
          } catch {
            /* Verbindung schon weg */
          }
        });
      };
      const rootAttrs = () => ({ mode: 0o040755, uid: 1000, gid: 1000, size: 4096, atime: toSeconds(new Date()), mtime: toSeconds(new Date()) });

      sftp.on('REALPATH', (reqid: number, p: string) => {
        const parts: string[] = [];
        for (const seg of p.replace(/\\/g, '/').split('/')) {
          if (seg === '' || seg === '.') continue;
          if (seg === '..') parts.pop();
          else parts.push(seg);
        }
        const normalized = `/${parts.join('/')}`;
        sftp.name(reqid, [{ filename: normalized, longname: normalized, attrs: rootAttrs() }]);
      });

      const stat = (follow: boolean) => (reqid: number, p: string) =>
        guard(reqid, async () => {
          const t = await resolveTarget(p);
          if (!t) return void sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          if (t === 'root') return void sftp.attrs(reqid, rootAttrs());
          const full = await resolveEntry(t.server.root, t.rel);
          sftp.attrs(reqid, attrsOf(follow ? await fs.stat(full) : await fs.lstat(full)));
        });
      sftp.on('STAT', stat(true));
      sftp.on('LSTAT', stat(false));

      sftp.on('FSTAT', (reqid: number, handle: Buffer) =>
        guard(reqid, async () => {
          const f = files.get(handle.toString('hex'));
          if (!f) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          sftp.attrs(reqid, attrsOf(await f.handle.stat()));
        }),
      );

      sftp.on('OPENDIR', (reqid: number, p: string) =>
        guard(reqid, async () => {
          const t = await resolveTarget(p);
          if (!t) return void sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          if (dirs.size + files.size >= MAX_HANDLES) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          const items: Array<{ filename: string; longname: string; attrs: ReturnType<typeof attrsOf> }> = [];
          if (t === 'root') {
            const now = new Date();
            for (const s of (await accessible()) ?? []) {
              const st = { size: 4096, mtime: now, isDirectory: () => true };
              items.push({ filename: s.shortId, longname: longname(s.shortId, st), attrs: rootAttrs() });
            }
          } else {
            const full = await resolveEntry(t.server.root, t.rel);
            for (const ent of await fs.readdir(full, { withFileTypes: true })) {
              try {
                // lstat: ein Link nach draussen verraet so keine Angaben ueber sein Ziel
                const st = await fs.lstat(path.join(full, ent.name));
                items.push({ filename: ent.name, longname: longname(ent.name, st), attrs: attrsOf(st) });
              } catch {
                /* verschwunden oder gesperrt: weglassen */
              }
            }
          }
          const handle = newHandle();
          dirs.set(handle.toString('hex'), items);
          sftp.handle(reqid, handle);
        }),
      );

      sftp.on('READDIR', (reqid: number, handle: Buffer) => {
        const items = dirs.get(handle.toString('hex'));
        if (!items) return void sftp.status(reqid, STATUS_CODE.FAILURE);
        if (items.length === 0) return void sftp.status(reqid, STATUS_CODE.EOF);
        sftp.name(reqid, items.splice(0, 64));
      });

      sftp.on('OPEN', (reqid: number, filename: string, flags: number) =>
        guard(reqid, async () => {
          const t = await resolveTarget(filename);
          if (!t || t === 'root') return void sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          const write = (flags & (OPEN_MODE.WRITE | OPEN_MODE.APPEND | OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0;
          if (write && !need(t, 'file.write')) return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          if (!write && !need(t, 'file.read')) return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          if (isRootOfServer(t.rel)) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          if (dirs.size + files.size >= MAX_HANDLES) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          const full = await resolveEntry(t.server.root, t.rel);
          const handle = await fs.open(full, flagsToString(flags) || 'r');
          const id = newHandle();
          files.set(id.toString('hex'), { handle, write, size: 0 });
          if (write) audit('sftp.write', { server: t.server.instance.name, file: t.rel.slice(0, 200) });
          sftp.handle(reqid, id);
        }),
      );

      sftp.on('READ', (reqid: number, handle: Buffer, offset: number, length: number) =>
        guard(reqid, async () => {
          const f = files.get(handle.toString('hex'));
          if (!f) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          const buf = Buffer.alloc(Math.min(length, 256 * 1024));
          const { bytesRead } = await f.handle.read(buf, 0, buf.length, offset);
          if (bytesRead === 0) return void sftp.status(reqid, STATUS_CODE.EOF);
          sftp.data(reqid, buf.subarray(0, bytesRead));
        }),
      );

      sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) =>
        guard(reqid, async () => {
          const f = files.get(handle.toString('hex'));
          if (!f?.write) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          // Rechte koennen sich waehrend der Verbindung aendern
          const list = await accessible();
          if (!list) return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          if (offset + data.length > deps.maxUploadMb * 1024 * 1024) return void sftp.status(reqid, STATUS_CODE.FAILURE);
          await f.handle.write(data, 0, data.length, offset);
          sftp.status(reqid, STATUS_CODE.OK);
        }),
      );

      sftp.on('CLOSE', (reqid: number, handle: Buffer) =>
        guard(reqid, async () => {
          const key = handle.toString('hex');
          const f = files.get(key);
          files.delete(key);
          dirs.delete(key);
          if (f) await f.handle.close().catch(() => {});
          sftp.status(reqid, STATUS_CODE.OK);
        }),
      );

      const mutate = (flag: ServerFlag, run: (full: string, t: { server: Accessible; rel: string }) => Promise<void>, verb: string) =>
        (reqid: number, p: string) =>
          guard(reqid, async () => {
            const t = await resolveTarget(p);
            if (!t || t === 'root') return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            if (!need(t, flag) || isRootOfServer(t.rel)) return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
            await run(await resolveEntry(t.server.root, t.rel), t);
            audit(`sftp.${verb}`, { server: t.server.instance.name, file: t.rel.slice(0, 200) });
            sftp.status(reqid, STATUS_CODE.OK);
          });

      sftp.on('REMOVE', mutate('file.delete', (full) => fs.unlink(full), 'delete'));
      // Nur leere Ordner, wie bei SFTP ueblich: die Programme loeschen den Inhalt vorher selbst
      sftp.on('RMDIR', mutate('file.delete', (full) => fs.rmdir(full), 'delete'));
      sftp.on('MKDIR', mutate('file.write', async (full) => void (await fs.mkdir(full)), 'mkdir'));

      sftp.on('RENAME', (reqid: number, from: string, to: string) =>
        guard(reqid, async () => {
          const a = await resolveTarget(from);
          const b = await resolveTarget(to);
          if (!a || !b || a === 'root' || b === 'root' || a.server.instance.id !== b.server.instance.id) {
            return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          }
          if (!need(a, 'file.write') || isRootOfServer(a.rel) || isRootOfServer(b.rel)) return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          await fs.rename(await resolveEntry(a.server.root, a.rel), await resolveEntry(b.server.root, b.rel));
          audit('sftp.rename', { server: a.server.instance.name, from: a.rel.slice(0, 200), to: b.rel.slice(0, 200) });
          sftp.status(reqid, STATUS_CODE.OK);
        }),
      );

      // Zeitstempel und Abschneiden; Rechte und Besitzer des Rechners aendert SFTP hier nie
      type SetAttrs = { size?: number; atime?: number; mtime?: number };
      const setAttrs = async (full: string, attrs: SetAttrs): Promise<void> => {
        if (typeof attrs.size === 'number') await fs.truncate(full, attrs.size);
        if (typeof attrs.atime === 'number' && typeof attrs.mtime === 'number') await fs.utimes(full, attrs.atime, attrs.mtime);
      };
      sftp.on('SETSTAT', (reqid: number, p: string, attrs: SetAttrs) =>
        guard(reqid, async () => {
          const t = await resolveTarget(p);
          if (!t || t === 'root') return void sftp.status(reqid, STATUS_CODE.OK);
          if (!need(t, 'file.write')) return void sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED);
          if (isRootOfServer(t.rel)) return void sftp.status(reqid, STATUS_CODE.OK);
          await setAttrs(await resolveEntry(t.server.root, t.rel), attrs);
          sftp.status(reqid, STATUS_CODE.OK);
        }),
      );
      sftp.on('FSETSTAT', (reqid: number, handle: Buffer, attrs: SetAttrs) =>
        guard(reqid, async () => {
          const f = files.get(handle.toString('hex'));
          if (!f?.write) return void sftp.status(reqid, f ? STATUS_CODE.OK : STATUS_CODE.FAILURE);
          if (typeof attrs.size === 'number') await f.handle.truncate(attrs.size);
          if (typeof attrs.atime === 'number' && typeof attrs.mtime === 'number') await f.handle.utimes(attrs.atime, attrs.mtime);
          sftp.status(reqid, STATUS_CODE.OK);
        }),
      );

      // Links anlegen oder lesen gibt es nicht: ein Link koennte aus dem Server-Ordner heraus zeigen
      sftp.on('SYMLINK', (reqid: number) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED));
      sftp.on('READLINK', (reqid: number) => sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE));
    }

    const cleanup = (): void => {
      live.delete(client);
      for (const f of files.values()) void f.handle.close().catch(() => {});
      files.clear();
      dirs.clear();
    };
    client.on('close', cleanup);
    client.on('error', (err: unknown) => {
      if ((err as { code?: string })?.code !== 'ECONNRESET') logger.debug({ err }, 'SFTP-Verbindungsfehler');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.port, deps.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : deps.port;
  logger.info({ host: deps.host, port, fingerprint }, 'SFTP aktiv (Anmeldung: benutzer.kurzid, Passwort: Kontopasswort oder eigenes SFTP-Passwort)');
  return {
    port,
    fingerprint,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of live) c.end();
        server.close(() => resolve());
      }),
  };
}
