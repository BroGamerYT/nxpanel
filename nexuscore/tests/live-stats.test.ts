import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

const TOKEN = 'test-token-0123456789abcdefghij';

let server: Awaited<ReturnType<typeof createCoreServer>>;
let driver: InstanceType<typeof MockDriver>;
let registry: InstanceType<typeof ServerRegistry>;
let dataDir: string;
let base: string;

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-live-'));
  registry = await ServerRegistry.open(dataDir);
  driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry);
  const address = await server.listen({ port: 0, host: '127.0.0.1' });
  base = address.replace(/^http/, 'ws');

  const config = {
    id: 'ls-1',
    name: 'Live-Statistik',
    game: 'test',
    executable: 'x.exe',
    args: [],
    workingDir: '.',
    maxMemoryMb: 3072,
    ports: [],
  };
  await registry.add(config);
  await driver.registerServer(config);
  await driver.startServer('ls-1');
  // Der Mock meldet "laeuft" erst nach einer Sekunde.
  for (let i = 0; i < 50 && (await driver.getServerState('ls-1')).status !== 'running'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

afterAll(async () => {
  await server.close();
  await driver.shutdown();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

/** Wartet auf die erste Nachricht eines Typs vom Server-WebSocket. */
function firstMessage(url: string, type: string, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`Keine "${type}"-Nachricht innerhalb von ${timeoutMs} ms`));
    }, timeoutMs);
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timer);
      ws.close();
      resolve(message);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('WebSocket-Fehler'));
    };
  });
}

describe('Live-Statistik des Servers', () => {
  it('sendet genau die Felder, die die Oberflaeche liest', async () => {
    const message = await firstMessage(`${base}/api/v1/servers/ls-1/ws?token=${TOKEN}`, 'stats', 8000);

    // Dasselbe Format wie das Panel (ContainerStats). Weicht ein Name ab,
    // zeigt die Oberflaeche "undefined MB" und leere Diagramme.
    expect(message.stats).toEqual({
      cpuPercent: expect.any(Number),
      memMb: 512,
      memLimitMb: 3072,
      netRxBytes: 0,
      netTxBytes: 0,
    });
    expect(message.ts).toEqual(expect.any(Number));
  }, 15000);
});
