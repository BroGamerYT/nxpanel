import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { BackupError, type CoreBackups } from '../../backups/core-backup.js';
import { resolveEggsDir } from '../../eggs/loader.js';
import type { ServerRegistry } from '../../store/registry.js';
import { resolveWebDir } from './web.js';

/**
 * Sicherung und Pruefung des Cores selbst (nur Administratoren): Sicherungen anlegen, auflisten, loeschen und zurueckspielen,
 * dazu eine Pruefung ("Reparatur-Modus": zeigt, was nicht stimmt, und woran man es beheben kann).
 */

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Was zu tun ist, wenn es nicht in Ordnung ist. */
  fix?: string;
}

export async function runChecks(registry: ServerRegistry, backups: CoreBackups, pendingRestore: boolean): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  const db = (() => {
    try {
      return registry.integrityProblems();
    } catch (err) {
      return [err instanceof Error ? err.message : String(err)];
    }
  })();
  out.push(
    db.length === 0
      ? { name: 'Datenbank', ok: true, detail: 'In Ordnung (SQLite-Prüfung ohne Befund).' }
      : { name: 'Datenbank', ok: false, detail: db.slice(0, 3).join('; '), fix: 'Eine Sicherung zurückspielen (Wiederherstellen).' },
  );

  const probe = path.join(registry.dir, `.schreibtest-${process.pid}`);
  try {
    await writeFile(probe, 'x');
    await rm(probe, { force: true });
    out.push({ name: 'Datenordner', ok: true, detail: `${registry.dir} ist beschreibbar.` });
  } catch (err) {
    out.push({ name: 'Datenordner', ok: false, detail: `Nicht beschreibbar: ${err instanceof Error ? err.message : String(err)}`, fix: 'Rechte des Datenordners prüfen (der Dienst braucht Schreibrechte).' });
  }

  const users = path.join(registry.dir, 'users.json');
  if (existsSync(users)) {
    try {
      JSON.parse(await readFile(users, 'utf8'));
      out.push({ name: 'Benutzerkonten', ok: true, detail: 'users.json ist lesbar.' });
    } catch {
      out.push({ name: 'Benutzerkonten', ok: false, detail: 'users.json ist beschädigt.', fix: 'Eine Sicherung zurückspielen.' });
    }
  } else {
    out.push({ name: 'Benutzerkonten', ok: true, detail: 'Noch keine users.json (wird beim ersten Anlegen erstellt).' });
  }

  const web = resolveWebDir();
  out.push(web ? { name: 'Weboberfläche', ok: true, detail: web } : { name: 'Weboberfläche', ok: false, detail: 'Nicht gefunden.', fix: 'Installation reparieren: den Installer erneut starten und „Reparieren“ wählen.' });
  const eggs = resolveEggsDir();
  out.push(eggs ? { name: 'Spielvorlagen', ok: true, detail: eggs } : { name: 'Spielvorlagen', ok: false, detail: 'Ordner eggs nicht gefunden.', fix: 'Installation reparieren: den Installer erneut starten und „Reparieren“ wählen.' });

  const list = await backups.list();
  out.push(
    list.length > 0
      ? { name: 'Sicherungen', ok: true, detail: `${list.length} vorhanden, neueste vom ${list[0]!.createdAt.slice(0, 16).replace('T', ' ')} UTC.` }
      : { name: 'Sicherungen', ok: false, detail: 'Es gibt noch keine Sicherung des Cores.', fix: '„Jetzt sichern“ wählen.' },
  );
  if (pendingRestore) out.push({ name: 'Wiederherstellung', ok: false, detail: 'Eine Wiederherstellung ist vorgemerkt und wird beim nächsten Start eingespielt.' });
  return out;
}

export function registerCoreBackupRoutes(
  server: FastifyInstance,
  deps: { registry: ServerRegistry; backups: CoreBackups; restart?: () => void },
): void {
  const { registry, backups } = deps;
  // Wiederherstellen laeuft beim Start: der Dienst (nxsvc, systemd) startet den beendeten Core von selbst neu
  const restart = deps.restart ?? ((): void => void setTimeout(() => process.exit(75), 1500).unref());
  const pending = (): boolean => existsSync(path.join(registry.dir, 'restore-pending.json'));
  const fail = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof BackupError) return reply.status(err.statusCode).send({ error: err.message, message: err.message, code: err.code });
    throw err;
  };

  server.get('/api/v1/admin/core-backups', async () => ({ backups: await backups.list(), pendingRestore: pending() }));

  server.post<{ Body: unknown }>('/api/v1/admin/core-backups', async (req, reply) => {
    const body = z.object({ reason: z.string().trim().max(60).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'Ungültige Anfrage', code: 'invalid_request' });
    try {
      const info = await backups.create(body.data.reason || 'manuell');
      registry.audit('core.backup', null, 'standalone', { id: info.id, reason: info.reason });
      return { ok: true, backup: info };
    } catch (err) {
      return fail(reply, err);
    }
  });

  server.delete<{ Params: { id: string } }>('/api/v1/admin/core-backups/:id', async (req, reply) => {
    try {
      await backups.remove(req.params.id);
      registry.audit('core.backup_delete', null, 'standalone', { id: req.params.id });
      return { ok: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  server.post<{ Params: { id: string } }>('/api/v1/admin/core-backups/:id/restore', async (req, reply) => {
    try {
      if (!(await backups.list()).some((b) => b.id === req.params.id)) throw new BackupError('Diese Sicherung gibt es nicht.', 404, 'not_found');
      await backups.stageRestore(req.params.id);
      registry.audit('core.restore', null, 'standalone', { id: req.params.id });
      restart();
      return { ok: true, restarting: true };
    } catch (err) {
      return fail(reply, err);
    }
  });

  server.get('/api/v1/admin/core-check', async () => {
    const checks = await runChecks(registry, backups, pending());
    return { ok: checks.every((c) => c.ok), checks };
  });
}
