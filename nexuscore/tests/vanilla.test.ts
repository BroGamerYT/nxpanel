import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { resolveVanillaBuild } = await import('../src/install/vanilla.js');
const { downloadFile, sha1OfFile } = await import('../src/install/download.js');
const { installKindFor } = await import('../src/install/manager.js');
const { isMinecraftKind } = await import('../src/install/minecraft.js');

type FetchLike = import('../src/install/download.js').FetchLike;

const JAR = Buffer.from('vanilla-server-jar '.repeat(500));
const sha1 = crypto.createHash('sha1').update(JAR).digest('hex');
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

function fakeMojang(versionInfo: unknown = { downloads: { server: { sha1, size: JAR.length, url: 'https://piston-data.mojang.com/v1/objects/x/server.jar' } }, javaVersion: { majorVersion: 21 } }): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    if (url.endsWith('version_manifest_v2.json')) {
      return json({ latest: { release: '1.21.4', snapshot: '25w01a' }, versions: [
        { id: '25w01a', type: 'snapshot', url: 'https://piston-meta.mojang.com/v1/packages/s/25w01a.json' },
        { id: '1.21.4', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/a/1.21.4.json' },
        { id: '1.7.10', type: 'release', url: 'https://piston-meta.mojang.com/v1/packages/b/1.7.10.json' },
      ] });
    }
    if (url.endsWith('1.21.4.json') || url.endsWith('25w01a.json')) return json(versionInfo);
    if (url.endsWith('1.7.10.json')) return json({ downloads: { server: { sha1, size: 1, url: 'https://piston-data.mojang.com/old.jar' } } });
    if (url.endsWith('server.jar')) return new Response(new Uint8Array(JAR), { status: 200, headers: { 'content-length': String(JAR.length) } });
    return new Response('nicht da', { status: 404 });
  };
  return { fetchImpl, calls };
}

describe('Vanilla: Version und Download', () => {
  it('LATEST und feste Version werden aufgelöst, mit SHA-1 und Java-Version', async () => {
    const net = fakeMojang();
    const latest = await resolveVanillaBuild('LATEST', { fetchImpl: net.fetchImpl });
    expect(latest).toMatchObject({ version: '1.21.4', javaMajor: 21, sha1, size: JAR.length });
    expect((await resolveVanillaBuild('', { fetchImpl: net.fetchImpl })).version).toBe('1.21.4');
    expect((await resolveVanillaBuild('1.7.10', { fetchImpl: net.fetchImpl })).javaMajor).toBe(8); // ohne Angabe: Java 8
  });

  it('lehnt unbekannte und unsinnige Versionen ab, ohne etwas anzufragen', async () => {
    const net = fakeMojang();
    await expect(resolveVanillaBuild('9.9.9', { fetchImpl: net.fetchImpl })).rejects.toThrow(/kennt die Minecraft-Version/);
    await expect(resolveVanillaBuild('../../etc', { fetchImpl: net.fetchImpl })).rejects.toThrow(/Ungueltige/);
    expect(net.calls.every((u) => u.startsWith('https://piston-meta.mojang.com/'))).toBe(true);
  });

  it('ohne Server-Datei oder mit schlechter Prüfsumme gibt es einen klaren Fehler', async () => {
    await expect(resolveVanillaBuild('1.21.4', { fetchImpl: fakeMojang({ downloads: {} }).fetchImpl })).rejects.toThrow(/keinen Server-Download/);
    await expect(resolveVanillaBuild('1.21.4', { fetchImpl: fakeMojang({ downloads: { server: { sha1: 'xyz', size: 1, url: 'https://piston-data.mojang.com/s.jar' } } }).fetchImpl })).rejects.toThrow(/Pruefsumme/);
  });

  it('fremde Hosts werden nicht angesprochen', async () => {
    const evil: FetchLike = async () => json({ latest: { release: '1' }, versions: [{ id: '1', type: 'release', url: 'https://evil.example/x.json' }] });
    await expect(resolveVanillaBuild('1', { fetchImpl: evil })).rejects.toThrow(/nicht erlaubt/);
  });

  it('Download prüft SHA-1: richtige Datei wird gespeichert, falsche nie', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-van-'));
    try {
      const net = fakeMojang();
      const dest = path.join(dir, 'server.jar');
      const ok = await downloadFile('https://piston-data.mojang.com/v1/objects/x/server.jar', dest, { sha256: null, sha1, allowedHosts: ['piston-data.mojang.com'], fetchImpl: net.fetchImpl });
      expect(ok.bytes).toBe(JAR.length);
      expect(await sha1OfFile(dest)).toBe(sha1);

      const bad = path.join(dir, 'bad.jar');
      await expect(downloadFile('https://piston-data.mojang.com/v1/objects/x/server.jar', bad, { sha256: null, sha1: 'a'.repeat(40), allowedHosts: ['piston-data.mojang.com'], fetchImpl: net.fetchImpl })).rejects.toThrow(/Pruefsumme stimmt nicht/);
      await expect(fs.stat(bad)).rejects.toThrow();
      expect((await fs.readdir(dir)).filter((f) => f.includes('.part'))).toEqual([]);
      // Ohne jede Prüfsumme bleibt es verboten
      await expect(downloadFile('https://piston-data.mojang.com/v1/objects/x/server.jar', bad, { sha256: null, allowedHosts: ['piston-data.mojang.com'], fetchImpl: net.fetchImpl })).rejects.toThrow(/Pruefsumme/);
      expect(await sha1OfFile(path.join(dir, 'gibt-es-nicht'))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('Typ-Zuordnung', () => {
    expect(installKindFor('minecraft-paper', {})).toBe('minecraft-paper');
    expect(installKindFor('minecraft-paper', { TYPE: 'vanilla' })).toBe('minecraft-vanilla');
    expect(installKindFor('minecraft-paper', { TYPE: 'FORGE' })).toBeNull();
    expect(isMinecraftKind('minecraft-vanilla')).toBe(true);
    expect(isMinecraftKind('steamcmd')).toBe(false);
  });
});
