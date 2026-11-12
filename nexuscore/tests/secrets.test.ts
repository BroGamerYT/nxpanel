import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { ServerRegistry } = await import('../src/store/registry.js');
const { SecretStore, SecretKeyError, parseMasterKey } = await import('../src/store/secrets.js');

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
const HEX = 'ab'.repeat(32);
const PLAIN = 'super-geheimer-schluessel-0123456789';

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-secrets-'));
  registry = await ServerRegistry.open(dir);
});
afterAll(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Hauptschlüssel', () => {
  it('64 Hex-Zeichen oder 32 Byte Base64 - alles andere wird mit klarer Meldung abgelehnt', () => {
    expect(parseMasterKey(HEX)).toHaveLength(32);
    expect(parseMasterKey(Buffer.alloc(32, 7).toString('base64'))).toHaveLength(32);
    for (const bad of ['', 'kurz', 'zz'.repeat(32), Buffer.alloc(16).toString('base64'), `${HEX}00`]) {
      expect(() => parseMasterKey(bad), bad).toThrow(SecretKeyError);
    }
  });

  it('ohne Angabe legt der Core eine Schlüsseldatei an - einmal, nur für den Besitzer lesbar, und liest sie danach wieder', async () => {
    const file = path.join(dir, 'secret.key');
    const first = new SecretStore(registry);
    first.set('a', PLAIN);
    const written = await fs.readFile(file, 'utf8');
    expect(written.trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o077).toBe(0);
    // Ein neuer Prozess (neuer Speicher) findet dieselbe Datei und liest das Geheimnis
    const second = new SecretStore(registry);
    expect(second.get('a')).toBe(PLAIN);
    expect((await fs.readFile(file, 'utf8')).trim()).toBe(written.trim());
    first.delete('a');
  });
});

describe('Verschlüsselt speichern', () => {
  it('Klartext steht nie in der Datenbank; lesen geht nur mit dem Schlüssel', () => {
    const s = new SecretStore(registry, { envKey: HEX });
    s.set('dienst.eins', PLAIN);
    const raw = JSON.stringify(registry.getSetting('secret.dienst.eins'));
    expect(raw).not.toContain(PLAIN);
    expect(raw).toMatch(/"v":1/);
    expect(s.get('dienst.eins')).toBe(PLAIN);
    expect(s.status('dienst.eins')).toBe('ok');
    expect(s.has('dienst.eins')).toBe(true);
    // Jedes Speichern hat eine neue Zufallszahl: gleicher Wert, anderer Chiffretext
    const before = JSON.stringify(registry.getSetting('secret.dienst.eins'));
    s.set('dienst.eins', PLAIN);
    expect(JSON.stringify(registry.getSetting('secret.dienst.eins'))).not.toBe(before);
    // Auch Umlaute und lange Werte
    s.set('dienst.zwei', 'Pässwörd-€-' + 'x'.repeat(5000));
    expect(s.get('dienst.zwei')).toBe('Pässwörd-€-' + 'x'.repeat(5000));
  });

  it('mit einem anderen Schlüssel unlesbar - gemeldet, nicht still leer', () => {
    const a = new SecretStore(registry, { envKey: HEX });
    a.set('dienst.drei', PLAIN);
    const b = new SecretStore(registry, { envKey: 'cd'.repeat(32) });
    expect(b.get('dienst.drei')).toBeNull();
    expect(b.status('dienst.drei')).toBe('unreadable');
    expect(b.has('dienst.drei')).toBe(false);
    expect(b.status('gibtsnicht')).toBe('missing');
  });

  it('jede Veränderung fällt auf; ein Chiffretext lässt sich nicht unter anderem Namen einschleusen', () => {
    const s = new SecretStore(registry, { envKey: HEX });
    s.set('dienst.vier', PLAIN);
    s.set('dienst.fuenf', 'anderer Wert');
    // Daten verändern
    const stored = registry.getSetting<{ v: number; iv: string; tag: string; data: string }>('secret.dienst.vier')!;
    const flipped = Buffer.from(stored.data, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    registry.setSetting('secret.dienst.vier', { ...stored, data: flipped.toString('base64') });
    expect(s.get('dienst.vier')).toBeNull();
    expect(s.status('dienst.vier')).toBe('unreadable');
    // Chiffretext von "fuenf" unter dem Namen "vier": Name ist Teil der Prüfung
    registry.setSetting('secret.dienst.vier', registry.getSetting('secret.dienst.fuenf'));
    expect(s.get('dienst.vier')).toBeNull();
    expect(s.get('dienst.fuenf')).toBe('anderer Wert');
    // kaputte Einträge
    registry.setSetting('secret.dienst.vier', { v: 2 });
    expect(s.get('dienst.vier')).toBeNull();
    registry.setSetting('secret.dienst.vier', 'Klartext');
    expect(s.get('dienst.vier')).toBeNull();
  });

  it('Namen und Werte werden geprüft; löschen entfernt es', () => {
    const s = new SecretStore(registry, { envKey: HEX });
    for (const bad of ['', 'Gross', '../x', 'a b', 'x'.repeat(65)]) expect(() => s.set(bad, 'v'), bad).toThrow(/Ungültiger Name/);
    expect(() => s.get('../x')).toThrow(/Ungültiger Name/);
    expect(() => s.set('dienst.sechs', '')).toThrow(/leer/);
    s.set('dienst.sechs', 'weg');
    s.delete('dienst.sechs');
    expect(s.status('dienst.sechs')).toBe('missing');
    expect(registry.getSetting('secret.dienst.sechs')).toBeUndefined();
  });

  it('ein ungültiger Schlüssel in der Umgebung bricht beim Gebrauch ab - er wird nie stillschweigend ersetzt', () => {
    const s = new SecretStore(registry, { envKey: 'kaputt' });
    expect(() => s.set('dienst.sieben', 'x')).toThrow(SecretKeyError);
    expect(() => s.get('dienst.eins')).toThrow(SecretKeyError);
  });
});

describe('Umzug aus dem Klartext', () => {
  it('ein früher im Klartext gespeicherter Wert wird verschlüsselt und der Klartext gelöscht', () => {
    const s = new SecretStore(registry, { envKey: HEX });
    registry.setSetting('modpacks.curseforgeKey', PLAIN);
    expect(s.migrateFromPlain('modpacks.curseforgeKey', 'curseforge')).toBe(true);
    expect(registry.getSetting('modpacks.curseforgeKey')).toBeUndefined();
    expect(s.get('curseforge')).toBe(PLAIN);
    expect(JSON.stringify(registry.getSetting('secret.curseforge'))).not.toContain(PLAIN);
    // zweites Mal: nichts zu tun
    expect(s.migrateFromPlain('modpacks.curseforgeKey', 'curseforge')).toBe(false);
  });

  it('ein schon vorhandenes, lesbares Geheimnis wird nicht überschrieben', () => {
    const s = new SecretStore(registry, { envKey: HEX });
    s.set('curseforge', 'neuer-wert-0123456789012345');
    registry.setSetting('modpacks.curseforgeKey', 'alter-klartext-0123456789012');
    s.migrateFromPlain('modpacks.curseforgeKey', 'curseforge');
    expect(s.get('curseforge')).toBe('neuer-wert-0123456789012345');
    expect(registry.getSetting('modpacks.curseforgeKey')).toBeUndefined();
  });
});

describe('Beim Start des Cores', () => {
  it('zieht einen früheren Klartext-Schlüssel ohne Zutun um - und die Oberfläche sieht ihn weiter als hinterlegt', async () => {
    const { MockDriver } = await import('../src/drivers/mock-driver.js');
    const { EventBus } = await import('../src/protocol/events.js');
    const { createCoreServer } = await import('../src/http/server.js');
    const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-secrets-core-'));
    const reg = await ServerRegistry.open(d);
    reg.setSetting('modpacks.curseforgeKey', PLAIN);
    const driver = new MockDriver();
    await driver.initialize();
    const server = await createCoreServer(driver, new EventBus(), reg, { installs: null, scheduler: false });
    try {
      expect(reg.getSetting('modpacks.curseforgeKey')).toBeUndefined();
      expect(JSON.stringify(reg.getSetting('secret.curseforge'))).not.toContain(PLAIN);
      const res = await server.inject({ method: 'GET', url: '/api/v1/modpacks/curseforge', headers: { authorization: 'Bearer test-token-0123456789abcdefghij' } });
      expect(res.json()).toEqual({ configured: true });
      expect((await fs.stat(path.join(d, 'secret.key'))).isFile()).toBe(true);
    } finally {
      await server.close();
      reg.close();
      await fs.rm(d, { recursive: true, force: true });
    }
  });
});
