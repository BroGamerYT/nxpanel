import { describe, expect, it } from 'vitest';
import { MockDriver } from '../src/drivers/mock-driver.js';

const cfg = {
  id: 'm-1',
  name: 'Mock',
  game: 'test',
  executable: 'x.exe',
  args: [],
  workingDir: '.',
  ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' as const }],
};

describe('MockDriver', () => {
  it('durchlaeuft den Zustandsautomaten', async () => {
    const driver = new MockDriver();
    await driver.initialize();
    await driver.registerServer(cfg);

    expect((await driver.getServerState('m-1')).status).toBe('offline');
    expect((await driver.startServer('m-1')).status).toBe('starting');

    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await driver.getServerState('m-1')).status).toBe('running');

    expect((await driver.stopServer('m-1')).status).toBe('stopping');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await driver.getServerState('m-1')).status).toBe('offline');

    await driver.shutdown();
  });

  it('liefert Statistiken', async () => {
    const driver = new MockDriver();
    await driver.initialize();
    await driver.registerServer(cfg);
    await driver.startServer('m-1');
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const stats = await driver.getServerStats('m-1');
    expect(stats.serverId).toBe('m-1');
    expect(stats.memoryMb).toBeGreaterThan(0);
    expect(stats.status).toBe('running');

    await driver.shutdown();
  });

  it('meldet Konsolenausgaben ueber den Log-Sink', async () => {
    const driver = new MockDriver();
    await driver.initialize();
    const lines: string[] = [];
    driver.setLogSink((line) => lines.push(line.line));
    await driver.registerServer(cfg);
    await driver.startServer('m-1');
    expect(lines.some((l) => l.includes('Starte Server'))).toBe(true);
    await driver.shutdown();
  });

  it('lehnt doppelte IDs ab und unbekannte Instanzen', async () => {
    const driver = new MockDriver();
    await driver.initialize();
    await driver.registerServer(cfg);
    await expect(driver.registerServer(cfg)).rejects.toThrow(/existiert/);
    await expect(driver.getServerState('gibtsnicht')).rejects.toThrow(/nicht registriert/);
    await driver.shutdown();
  });
});
