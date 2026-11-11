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

  it('bricht bei einer beschaedigten Datei ab und sichert sie weg (Block A5)', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'servers.json'), 'kein json');

    await expect(ServerRegistry.open(dir)).rejects.toThrow(/beschaedigt/);

    const files = await fs.readdir(dir);
    const backup = files.find((f) => f.startsWith('servers.json.korrupt-'));
    expect(backup).toBeDefined();
    expect(await fs.readFile(path.join(dir, backup!), 'utf8')).toBe('kein json');
    // Die kaputte Datei ist weg - ein bewusster Neustart beginnt leer.
    expect(files).not.toContain('servers.json');
    expect((await ServerRegistry.open(dir)).list()).toEqual([]);
  });

  it('bricht auch ab, wenn das Feld "servers" fehlt', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'servers.json'), '{"version":1}');
    await expect(ServerRegistry.open(dir)).rejects.toThrow(/beschaedigt/);
  });

  it('startet ohne Datei mit leerer Registry', async () => {
    const dir = await tempDir();
    expect((await ServerRegistry.open(dir)).list()).toEqual([]);
  });

  it('uebersteht gleichzeitige Schreibvorgaenge ohne Temp-Reste', async () => {
    const dir = await tempDir();
    const registry = await ServerRegistry.open(dir);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => registry.add({ ...sample, id: `srv-${i}` })),
    );

    const again = await ServerRegistry.open(dir);
    expect(again.list()).toHaveLength(12);
    expect((await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
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
