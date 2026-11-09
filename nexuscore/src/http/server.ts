import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import cors from '@fastify/cors';
import { config } from '../config/index.js';
import { HostDriver } from '../drivers/interface.js';
import { getSystemMetrics } from '../system/monitor.js';
import { validateRequestToken, validatePairingPin } from '../protocol/security.js';
import { HostInfo } from '../types.js';
import os from 'os';

export async function createCoreServer(driver: HostDriver) {
  const server = Fastify({ logger: false });

  await server.register(cors, { origin: true });
  await server.register(websocket);

  // Authentifizierungs-Hook
  server.addHook('onRequest', async (req, reply) => {
    // Öffentliche Endpunkte freigeben
    if (req.url === '/core/v1/info' || req.url === '/core/v1/pair') {
      return;
    }

    const authHeader = req.headers.authorization;
    const auth = validateRequestToken(authHeader);
    if (!auth.valid) {
      reply.status(401).send({ error: 'Nicht autorisiert', message: auth.reason });
    }
  });

  // Host Info & Status
  server.get('/core/v1/info', async () => {
    const info: HostInfo = {
      id: `host-${os.hostname().toLowerCase()}`,
      name: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      runtime: driver.name as any,
      version: '0.1.0-alpha',
      uptimeSeconds: Math.floor(process.uptime()),
    };

    return {
      status: 'ok',
      host: info,
      metrics: getSystemMetrics(),
    };
  });

  // Kopplung mit Panel über PIN
  server.post<{ Body: { pin: string } }>('/core/v1/pair', async (req, reply) => {
    const { pin } = req.body || {};
    if (!pin || !validatePairingPin(pin)) {
      return reply.status(400).send({ error: 'Kopplung fehlgeschlagen', message: 'Ungültige PIN' });
    }

    return {
      status: 'paired',
      token: config.secretToken,
      message: 'NexusCore erfolgreich mit Panel gekoppelt.',
    };
  });

  // Server-Liste
  server.get('/core/v1/servers', async () => {
    const servers = await driver.listServers();
    return { servers };
  });

  // Server registrieren
  server.post<{ Body: any }>('/core/v1/servers', async (req, reply) => {
    try {
      const state = await driver.registerServer(req.body);
      return reply.status(201).send({ status: 'created', state });
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // Server Aktionen (start, stop, kill)
  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/start', async (req, reply) => {
    try {
      const state = await driver.startServer(req.params.id);
      return { status: 'starting', state };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/stop', async (req, reply) => {
    try {
      const state = await driver.stopServer(req.params.id);
      return { status: 'stopping', state };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  server.post<{ Params: { id: string } }>('/core/v1/servers/:id/kill', async (req, reply) => {
    try {
      const state = await driver.killServer(req.params.id);
      return { status: 'killed', state };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // WebSocket Live Log & Stream
  server.get('/core/v1/stream', { websocket: true }, (connection) => {
    connection.socket.send(JSON.stringify({ type: 'connected', message: 'NexusCore Live Event Stream bereit.' }));

    // Demo Log Broadcast für verknüpfte Server
    const interval = setInterval(() => {
      connection.socket.send(JSON.stringify({
        type: 'metrics',
        timestamp: new Date().toISOString(),
        metrics: getSystemMetrics(),
      }));
    }, 5000);

    connection.socket.on('close', () => {
      clearInterval(interval);
    });
  });

  return server;
}
