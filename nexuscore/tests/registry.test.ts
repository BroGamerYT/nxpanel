import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerRegistry } from '../src/store/registry.js';

const sample = {
  id: 'srv-1',
  name: 'Test',
  game: 'minecraft',
  executable: 'cmd.exe',
  args: ['/c', 'echo hi'],
  workingDir: '.',
  ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' as const }],
};

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'nx-reg-'));
}

describe('Registry', () => {
  it('legt an, persistiert und laedt wieder', async () => {
    const dir = await tempDir();
    const registry = await ServerRegistry.open(dir);
    await registry.add(sample);

    const again = await ServerRegistry.open(dir);
    expect(again.get('srv-1')?.name).toBe('Test');
    expect(again.list()).toHaveLength(1);
  });

  it('lehnt doppelte IDs ab', async () => {
    const dir = await tempDir();
    const registry = await ServerRegistry.open(dir);
    await registry.add(sample);
    await expect(registry.add(sample)).rejects.toThrow(/existiert/);
  });

  it('verträgt eine beschaedigte Datei', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'servers.json'), 'kein json');
    const registry = await ServerRegistry.open(dir);
    expect(registry.list()).toEqual([]);
  });

  it('entfernt Instanzen wieder', async () => {
    const dir = await tempDir();
    const registry = await ServerRegistry.open(dir);
    await registry.add(sample);
    expect(await registry.remove('srv-1')).toBe(true);

    const again = await ServerRegistry.open(dir);
    expect(again.list()).toEqual([]);
  });
});
