import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { BRANDING, brandingFor, coverFor, isValidChoice, looksLikeImage, readCustomCover, removeCustomCover, saveCustomCover, steamAppId, steamCover } from '../src/eggs/cover.js';

const ID = '11111111-2222-3333-4444-555555555555';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('Titelbilder', () => {
  beforeAll(() => { (config as { VOLUME_ROOT: string }).VOLUME_ROOT = mkdtempSync(join(tmpdir(), 'cover-')); });

  it('nimmt Steam fuer bekannte Spiele, sonst ein Panel-Motiv', () => {
    expect(coverFor({ id: ID, name: 'Valheim', raw: {}, choice: null }).source).toBe('steam');
    const own = coverFor({ id: ID, name: 'Eigenes Spiel', raw: {}, choice: null });
    expect(own.source).toBe('branding');
    expect(own.src).toBe(`/branding/${brandingFor(ID)}`);
  });

  it('cover.steam im Egg schlaegt die eingebaute Liste', () => {
    expect(steamAppId('Valheim', { cover: { steam: 42 } })).toBe(42);
    expect(steamAppId('Valheim', { cover: { steam: 'x' } })).toBe(892970);
    expect(steamAppId('Unbekannt', null)).toBeNull();
  });

  it('Zufall ist je Egg fest, Wahl eines Motivs wirkt', () => {
    expect(brandingFor(ID)).toBe(brandingFor(ID));
    expect(coverFor({ id: ID, name: 'Valheim', raw: {}, choice: 'random' }).source).toBe('branding');
    const b = coverFor({ id: ID, name: 'Valheim', raw: {}, choice: 'branding:themes/arctic-cyan/banner.png' });
    expect(b).toEqual({ src: '/branding/themes/arctic-cyan/banner.png', fit: 'banner', source: 'branding' });
    expect(coverFor({ id: ID, name: 'X', raw: {}, choice: `branding:${BRANDING[1]}` }).fit).toBe('icon');
  });

  it('laesst nur bekannte Motive zu - kein Pfad ausserhalb', () => {
    expect(isValidChoice('branding:../../etc/passwd')).toBe(false);
    expect(isValidChoice('branding:themes/stealth-mono/icon-256.png')).toBe(true);
    expect(isValidChoice('http://evil')).toBe(false);
  });

  it('prueft Bilddaten an den ersten Bytes', () => {
    expect(looksLikeImage(PNG)).toBe(true);
    expect(looksLikeImage(Buffer.from('<svg onload=alert(1)>....'))).toBe(false);
  });

  it('speichert und entfernt eigene Bilder', async () => {
    await expect(saveCustomCover(ID, `data:image/png;base64,${Buffer.from('kein bild hier').toString('base64')}`)).rejects.toThrow();
    await expect(saveCustomCover(ID, 'data:image/svg+xml;base64,PHN2Zz4=')).rejects.toThrow();
    await saveCustomCover(ID, `data:image/png;base64,${PNG.toString('base64')}`);
    expect((await readCustomCover(ID))?.type).toBe('image/png');
    await removeCustomCover(ID);
    expect(await readCustomCover(ID)).toBeNull();
  });

  it('holt Steam-Bilder einmal und nimmt danach den Zwischenspeicher', async () => {
    let calls = 0;
    const fake = (async () => { calls++; return new Response(new Uint8Array(PNG), { status: 200 }); }) as unknown as typeof fetch;
    expect(await steamCover(777, fake)).not.toBeNull();
    expect(await steamCover(777, fake)).not.toBeNull();
    expect(calls).toBe(1);
  });

  it('merkt sich Fehlschlaege bei Steam', async () => {
    let calls = 0;
    const fail = (async () => { calls++; return new Response('nope', { status: 404 }); }) as unknown as typeof fetch;
    expect(await steamCover(778, fail)).toBeNull();
    expect(await steamCover(778, fail)).toBeNull();
    expect(calls).toBe(2); // beide URLs einmal, dann Pause
  });
});
