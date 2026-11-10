import type { FastifyInstance } from 'fastify';
import os from 'node:os';
import {
  pairingAttemptsRemaining,
  tokenFingerprint,
  validatePairingPin,
} from '../../protocol/security.js';
import { CORE_VERSION } from './info.js';

/**
 * Kopplung des Panels mit diesem Core.
 *
 * Der Core liefert den Token nicht im Klartext zurueck: er steht in der
 * Konfiguration (NEXUSCORE_TOKEN) und wird ausschliesslich auf dem sicheren
 * Weg an das Panel uebergeben. Die Antwort enthaelt nur den Fingerabdruck,
 * damit beide Seiten pruefen koennen, ob sie denselben Token verwenden.
 */
export function registerPairRoutes(server: FastifyInstance): void {
  server.post<{ Body: { pin?: unknown } }>('/core/v1/pair', async (req, reply) => {
    const body = req.body as { pin?: unknown } | undefined;
    const pin = typeof body?.pin === 'string' ? body.pin.trim() : '';

    if (!pin) {
      return reply.status(400).send({
        error: 'Kopplung fehlgeschlagen',
        message: 'Es wurde keine PIN angegeben.',
      });
    }

    if (!validatePairingPin(pin)) {
      const remaining = pairingAttemptsRemaining();
      if (remaining === 0) {
        return reply.status(429).send({
          error: 'Zu viele Fehlversuche',
          message: 'Die Kopplung ist fuer 10 Minuten gesperrt.',
        });
      }
      return reply.status(400).send({
        error: 'Kopplung fehlgeschlagen',
        message: 'Ungueltige PIN.',
      });
    }

    return {
      status: 'paired',
      host: {
        id: `host-${os.hostname().toLowerCase()}`,
        name: os.hostname(),
        platform: process.platform,
        arch: process.arch,
      },
      core: {
        version: CORE_VERSION,
        tokenFingerprint: tokenFingerprint(),
      },
      message: 'NexusCore erfolgreich mit Panel gekoppelt.',
    };
  });
}
