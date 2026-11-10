import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, requireAdmin } from '../auth.js';
import { writeAudit } from '../../audit.js';
import {
  createCoreHost,
  deleteHost,
  listHosts,
  refreshHost,
  resolveHost,
  updateCoreHost,
} from '../../hosts/registry.js';

/** Unbekannte IDs werden wie "nicht gefunden" behandelt, nicht als 400. */
function uuidParam(v: string): string {
  if (!z.string().uuid().safeParse(v).success) throw new HttpError(404, 'Nicht gefunden', 'not_found');
  return v;
}

/**
 * Fehler aus der Host-Schicht sind fachliche Fehler (falsches Token, Host
 * nicht erreichbar) - kein Serverfehler. Ohne diese Umwandlung wuerde ein
 * falsch eingegebenes Token als 500 ankommen.
 */
async function fachFehler<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, err instanceof Error ? err.message : 'Ungueltige Anfrage', 'bad_request');
  }
}

export const createHostBody = z.object({
  name: z.string().trim().min(1).max(64),
  /** Adresse des NexusCore, z. B. http://192.168.1.50:8443 */
  address: z.string().trim().url('Adresse muss eine URL sein, z. B. http://192.168.1.50:8443'),
  /** Token des Cores (NEXUSCORE_TOKEN) - wird verschluesselt gespeichert. */
  token: z.string().min(1).max(512),
  /** Optionale Kopplungs-PIN des Cores. */
  pin: z.string().trim().max(32).optional(),
});

export const patchHostBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  address: z.string().trim().url().optional(),
  token: z.string().min(1).max(512).optional(),
});

/**
 * Host-Verwaltung (nur Admins).
 *
 * Ein Host ist entweder der lokale Docker-Host des Panels oder ein
 * gekoppelter NexusCore. Die Routen sind bewusst unter /admin/hosts
 * abgelegt - die bestehende nodes-Route bleibt unberuehrt.
 */
export async function hostRoutes(app: FastifyInstance) {
  app.get('/admin/hosts', { preHandler: requireAdmin() }, async () => {
    return { hosts: await listHosts() };
  });

  app.post('/admin/hosts', { preHandler: requireAdmin() }, async (req) => {
    const body = createHostBody.parse(req.body ?? {});
    const host = await fachFehler(() =>
      createCoreHost({
        name: body.name,
        address: body.address,
        token: body.token,
        pin: body.pin,
      }),
    );
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'host.create',
      ip: req.ip,
      metadata: { name: body.name, address: body.address },
    });
    return { host };
  });

  app.patch<{ Params: { id: string } }>('/admin/hosts/:id', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    const body = patchHostBody.parse(req.body ?? {});
    const host = await fachFehler(() =>
      updateCoreHost(id, {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.token !== undefined ? { token: body.token } : {}),
      }),
    );
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'host.update',
      ip: req.ip,
      metadata: { hostId: id, ...(body.name !== undefined ? { name: body.name } : {}) },
    });
    return { host };
  });

  app.delete<{ Params: { id: string } }>('/admin/hosts/:id', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    await fachFehler(() => deleteHost(id));
    await writeAudit({
      userId: req.actor!.id,
      actorName: req.actor!.username,
      action: 'host.delete',
      ip: req.ip,
      metadata: { hostId: id },
    });
    return { ok: true };
  });

  /** Status sofort neu abfragen (statt auf den Hintergrund-Job zu warten). */
  app.post<{ Params: { id: string } }>('/admin/hosts/:id/check', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    const host = await refreshHost(id);
    if (!host) throw new HttpError(404, 'Host nicht gefunden', 'not_found');
    return { host };
  });

  /** Instanzen, die auf diesem Host laufen. */
  app.get<{ Params: { id: string } }>('/admin/hosts/:id/servers', { preHandler: requireAdmin() }, async (req) => {
    const id = uuidParam(req.params.id);
    const host = await resolveHost(id);
    if (!host) throw new HttpError(404, 'Host nicht gefunden', 'not_found');
    return { servers: await host.listServers() };
  });
}
