import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { DockerDriver } = await import('../src/drivers/docker-driver.js');
const { FakeDocker } = await import('./helpers/fake-docker.js');

const posix = process.platform !== 'win32';
let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-datadir-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Datenordner eines Docker-Servers', () => {
  it.skipIf(!posix)('ist beim Start für jeden Benutzer im Container beschreibbar (wie im Panel), auch wenn er dem Core gehört oder 0755 hat', async () => {
    const workingDir = path.join(dir, 'srv-1');
    await fs.mkdir(workingDir, { mode: 0o755 });
    await fs.chmod(workingDir, 0o755);
    const driver = new DockerDriver(new FakeDocker());
    await driver.initialize();
    await driver.registerServer({ id: 'srv-1', name: 'S', game: 'x', executable: 'nginx', args: [], workingDir, ports: [], container: { image: 'nginx', dataDir: '/data' } });
    await driver.startServer('srv-1');
    expect((await fs.stat(workingDir)).mode & 0o777).toBe(0o777);
  });

  it.skipIf(!posix)('legt einen fehlenden Ordner mit denselben Rechten an', async () => {
    const workingDir = path.join(dir, 'neu', 'srv-2');
    const driver = new DockerDriver(new FakeDocker());
    await driver.initialize();
    await driver.registerServer({ id: 'srv-2', name: 'S', game: 'x', executable: 'nginx', args: [], workingDir, ports: [], container: { image: 'nginx', dataDir: '/data' } });
    await driver.startServer('srv-2');
    expect((await fs.stat(workingDir)).mode & 0o777).toBe(0o777);
  });
});
