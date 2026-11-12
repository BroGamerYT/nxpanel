import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccountError, type LocalAccount } from '../../store/account.js';
import type { ServerRegistry } from '../../store/registry.js';

/**
 * SFTP-Passwoerter - dieselben Routen und Antworten wie im Panel. Mit Zwei-Faktor-Schutz geht SFTP nur
 * mit so einem Passwort (SFTP kann keinen Code abfragen); ohne Zwei-Faktor zusaetzlich zum Kontopasswort.
 * Das Passwort steht genau einmal in der Antwort, gespeichert wird nur der Hash.
 */
export function registerSftpPasswordRoutes(server: FastifyInstance, deps: { registry: ServerRegistry; account: LocalAccount }): void {
  const { registry, account } = deps;

  const own = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const actor = req.actor;
    if (!actor || actor.master || !account.get(actor.id)) {
      reply.status(403).send({ error: 'Das Zugriffstoken hat kein Benutzerkonto. Bitte als Benutzer anmelden.', code: 'forbidden' });
      return null;
    }
    return actor.id;
  };

  server.get('/api/v1/auth/sftp-passwords', async (req, reply) => {
    const id = own(req, reply);
    if (!id) return reply;
    return { passwords: account.sftpPasswords(id) };
  });

  server.post<{ Body: unknown }>('/api/v1/auth/sftp-passwords', async (req, reply) => {
    const id = own(req, reply);
    if (!id) return reply;
    const body = z.object({ label: z.string().trim().min(1).max(60) }).safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'Bitte eine Bezeichnung angeben', message: 'Bitte eine Bezeichnung angeben', code: 'invalid_request' });
    try {
      const { info, password } = await account.createSftpPassword(id, body.data.label);
      registry.audit('user.sftp_password_created', null, 'standalone', { id: info.id, label: info.label });
      return { password: info, secret: password };
    } catch (err) {
      if (err instanceof AccountError) return reply.status(err.statusCode).send({ error: err.message, message: err.message, code: err.code });
      throw err;
    }
  });

  server.delete<{ Params: { id: string } }>('/api/v1/auth/sftp-passwords/:id', async (req, reply) => {
    const id = own(req, reply);
    if (!id) return reply;
    if (!(await account.deleteSftpPassword(id, req.params.id))) return reply.status(404).send({ error: 'Nicht gefunden', code: 'not_found' });
    registry.audit('user.sftp_password_deleted', null, 'standalone', { id: req.params.id });
    return { ok: true };
  });
}
