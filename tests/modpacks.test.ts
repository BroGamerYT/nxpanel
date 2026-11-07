import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearPackCache, javaFor, packOf, packStatus, presetFor, rank, ramFor, searchPacks, type PackHit,
} from '../src/games/modpacks.js';

/** Antwortet je nach URL-Teil mit festen Daten - kein Netz noetig. */
function fakeFetch(routes: Record<string, unknown>, seen: string[] = []) {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url + ' ' + JSON.stringify((init?.headers as Record<string, string>)?.['x-api-key'] ?? ''));
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const CF_ATM10 = {
  id: 925200, name: 'All the Mods 10 - ATM10', slug: 'all-the-mods-10', summary: 'Kitchen sink', downloadCount: 5_000_000,
  logo: { thumbnailUrl: 'https://media.forgecdn.net/atm10.png' }, links: { websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10' },
  latestFiles: [
    { id: 600, displayName: 'All the Mods 10-4.0', fileName: 'a.zip', fileDate: '2026-10-01T00:00:00Z', releaseType: 1, gameVersions: ['1.21.1', 'NeoForge'] },
    { id: 650, displayName: 'All the Mods 10-4.1-beta', fileName: 'b.zip', fileDate: '2026-10-20T00:00:00Z', releaseType: 2, gameVersions: ['1.21.1', 'NeoForge'] },
  ],
  latestFilesIndexes: [{ gameVersion: '1.21.1', fileId: 600, modLoader: 6 }],
  allowModDistribution: true,
};

describe('Modpack-Suche', () => {
  beforeEach(() => clearPackCache());

  it('findet ATM10 auf CurseForge mit Schluessel und setzt die neueste Release-Datei fest', async () => {
    const seen: string[] = [];
    const f = fakeFetch({
      'api.curseforge.com/v1/mods/search': { data: [CF_ATM10] },
      'api.modrinth.com/v2/search': { hits: [] },
      'modpack/search/8': { packs: [] },
    }, seen);
    const r = await searchPacks('atm10', { cfKey: 'schluessel-123', fetcher: f });
    expect(r.curseforge).toBe('ok');
    const hit = r.hits[0]!;
    expect(hit.name).toContain('All the Mods 10');
    expect(hit.loaders).toEqual(['neoforge']);
    expect(hit.latest?.id).toBe('600'); // Beta 650 nicht
    expect(seen.find((s) => s.includes('curseforge'))).toContain('schluessel-123');
    const p = presetFor(hit);
    expect(p.values).toEqual({ TYPE: 'AUTO_CURSEFORGE', CF_SLUG: 'all-the-mods-10', CF_FILE_ID: '600' });
    expect(p.java).toBe(21);
    expect(p.ramMb).toBe(12288);
  });

  it('ohne Schluessel nur Modrinth und FTB - und sagt das', async () => {
    const seen: string[] = [];
    const f = fakeFetch({
      'api.modrinth.com/v2/search': { hits: [{ project_id: 'p1', slug: 'cobblemon-fabric', title: 'Cobblemon Official Modpack', description: 'Pokemon', downloads: 900000, versions: ['1.20.1', '1.21.1'], categories: ['fabric'], latest_version: 'ver9' }] },
      'modpack/search/8': { packs: [125] },
      'modpack/125': { id: 125, name: 'FTB Evolution', synopsis: 'FTB', installs: 400000, art: [{ type: 'square', url: 'https://ftb/evo.png' }],
        versions: [{ id: 100130, name: '1.22.0', type: 'Release', updated: 1790000000, targets: [{ name: 'minecraft', type: 'game', version: '1.21.1' }, { name: 'neoforge', type: 'modloader', version: '21.1' }] },
                   { id: 100200, name: '1.23.0-beta', type: 'Beta', targets: [] }] },
    }, seen);
    const r = await searchPacks('cobblemon', { cfKey: null, fetcher: f });
    expect(r.curseforge).toBe('no_key');
    expect(seen.some((s) => s.includes('curseforge'))).toBe(false);
    const mr = r.hits.find((h) => h.source === 'modrinth')!;
    expect(presetFor(mr).values).toEqual({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'cobblemon-fabric', MODRINTH_VERSION: 'ver9' });
    const ftb = r.hits.find((h) => h.source === 'ftb')!;
    expect(ftb.latest?.id).toBe('100130');
    expect(ftb.loaders).toEqual(['neoforge']);
    expect(presetFor(ftb).values).toEqual({ TYPE: 'FTBA', FTB_MODPACK_ID: '125', FTB_MODPACK_VERSION_ID: '100130' });
  });

  it('eine ausgefallene Quelle verdirbt nicht die anderen', async () => {
    const f = fakeFetch({ 'api.modrinth.com/v2/search': { hits: [] } }); // FTB -> 404
    const r = await searchPacks('stoneblock', { cfKey: null, fetcher: f });
    expect(r.errors.ftb).toBeTruthy();
    expect(r.hits).toEqual([]);
  });

  it('Abkuerzungen landen oben', () => {
    const h = (name: string, downloads: number, ref = name): PackHit => ({ source: 'modrinth', ref, name, summary: '', icon: null, downloads, url: '', mcVersions: [], loaders: [], latest: null });
    const r = rank('atm10', [h('Big Popular Pack', 9e9), h('All the Mods 10', 1, 'all-the-mods-10'), h('ATM10 Sky', 5)]);
    expect(r[0]!.name).toMatch(/All the Mods 10|ATM10/);
    expect(r.at(-1)!.name).toBe('Big Popular Pack');
  });
});

describe('Vorschlaege', () => {
  it('Java passend zur Minecraft-Version', () => {
    expect(javaFor('1.12.2')).toBe(8);
    expect(javaFor('1.18.2')).toBe(17);
    expect(javaFor('1.20.4')).toBe(17);
    expect(javaFor('1.20.6')).toBe(21);
    expect(javaFor('1.21.1')).toBe(21);
    expect(javaFor('26.1')).toBe(25);
  });
  it('RAM nach Packgroesse', () => {
    expect(ramFor({ name: 'Fabulously Optimized', loaders: ['fabric'] })).toBe(6144);
    expect(ramFor({ name: 'Some Forge Pack', loaders: ['forge'] })).toBe(8192);
    expect(ramFor({ name: 'All the Mods 9', loaders: ['neoforge'] })).toBe(12288);
  });
});

describe('Installiertes Pack und Updates', () => {
  beforeEach(() => clearPackCache());

  it('erkennt Pack und festgesetzte Version aus den Variablen', () => {
    expect(packOf({ TYPE: 'AUTO_CURSEFORGE', CF_SLUG: 'all-the-mods-10', CF_FILE_ID: '600' }))
      .toEqual({ source: 'curseforge', ref: 'all-the-mods-10', versionVar: 'CF_FILE_ID', version: '600' });
    expect(packOf({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'https://modrinth.com/modpack/cobblemon-fabric' })?.ref).toBe('cobblemon-fabric');
    expect(packOf({ TYPE: 'MODRINTH', MODRINTH_MODPACK: '/data/packs/mein.mrpack' })).toBeNull();
    expect(packOf({ TYPE: 'PAPER' })).toBeNull();
    expect(packOf({ TYPE: 'FTBA', FTB_MODPACK_ID: 'abc' })).toBeNull();
  });

  it('meldet ein Update und einen Wechsel der Minecraft-Version', async () => {
    const f = fakeFetch({
      'modpack/125': { id: 125, name: 'FTB Evolution', versions: [
        { id: 2, name: '2.0.0', type: 'Release', updated: 1795000000, targets: [{ name: 'minecraft', type: 'game', version: '1.21.4' }] },
        { id: 1, name: '1.0.0', type: 'Release', updated: 1790000000, targets: [{ name: 'minecraft', type: 'game', version: '1.21.1' }] },
      ] },
    });
    const st = await packStatus({ source: 'ftb', ref: '125', versionVar: 'FTB_MODPACK_VERSION_ID', version: '1' }, null, f);
    expect(st.current?.name).toBe('1.0.0');
    expect(st.latest?.name).toBe('2.0.0');
    expect(st.updateAvailable).toBe(true);
    expect(st.mcChange).toBe(true);
  });

  it('kein Update, wenn die neueste schon laeuft; nicht festgesetzt wird gemeldet', async () => {
    const f = fakeFetch({ 'project/cobblemon-fabric/version': [
      { id: 'v2', name: 'x', version_number: '1.6', version_type: 'release', game_versions: ['1.21.1'], date_published: '2026-10-01T00:00:00Z' },
      { id: 'v1', name: 'x', version_number: '1.5', version_type: 'release', game_versions: ['1.21.1'], date_published: '2026-09-01T00:00:00Z' },
    ], 'v2/search': { hits: [] } });
    const same = await packStatus({ source: 'modrinth', ref: 'cobblemon-fabric', versionVar: 'MODRINTH_VERSION', version: 'v2' }, null, f);
    expect(same.updateAvailable).toBe(false);
    clearPackCache();
    const loose = await packStatus({ source: 'modrinth', ref: 'cobblemon-fabric', versionVar: 'MODRINTH_VERSION', version: null }, null, f);
    expect(loose.unpinned).toBe(true);
    expect(loose.latest?.name).toBe('1.6');
  });

  it('CurseForge-Status ohne Schluessel ist ein klarer Fehler', async () => {
    await expect(packStatus({ source: 'curseforge', ref: 'x', versionVar: 'CF_FILE_ID', version: '1' }, null, fakeFetch({}))).rejects.toThrow(/Schluessel/);
  });
});
