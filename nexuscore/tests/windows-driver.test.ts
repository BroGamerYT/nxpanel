import { describe, expect, it } from 'vitest';
import { WindowsNativeDriver } from '../src/drivers/windows-native.js';

describe('WindowsNativeDriver', () => {
  it('startet einen echten Prozess und liefert seine Ausgaben', async () => {
    const driver = new WindowsNativeDriver();
    await driver.initialize();

    const lines: string[] = [];
    driver.setLogSink((l) => lines.push(l.line));

    await driver.registerServer({
      id: 'w-1',
      name: 'Win',
      game: 'test',
      executable: process.execPath,
      args: ['-e', 'console.log("nexuscore-test"); setTimeout(() => {}, 30)'],
      workingDir: process.cwd(),
      ports: [{ name: 'game', hostPort: 25570, protocol: 'tcp' }],
    });

    const state = await driver.startServer('w-1');
    expect(state.status).toBe('running');
    expect(state.pid).toBeGreaterThan(0);

    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(lines.join('\n')).toContain('nexuscore-test');

    const stats = await driver.getServerStats('w-1');
    expect(stats.serverId).toBe('w-1');

    await driver.killServer('w-1');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await driver.getServerState('w-1')).status).toBe('offline');

    await driver.shutdown();
  });

  it('meldet einen fehlgeschlagenen Start als Fehler', async () => {
    const driver = new WindowsNativeDriver();
    await driver.initialize();

    await driver.registerServer({
      id: 'w-2',
      name: 'Fehlt',
      game: 'test',
      executable: 'C:\\gibt-es-nicht-12345.exe',
      args: [],
      workingDir: process.cwd(),
      ports: [],
    });

    await driver.startServer('w-2');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await driver.getServerState('w-2')).status).toBe('error');

    await driver.shutdown();
  });
});
