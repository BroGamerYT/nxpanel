import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ASSET_NAME, CoreUpdater, UpdateError, compareVersions, latestRelease, type UpdateRunner } from '../src/update/core-update.js';

const REPO = 'BroGamerYT/nxpanel';
const MSI = Buffer.from('so-tut-als-waere-das-ein-installer'.repeat(50));
const SHA = createHash('sha256').update(MSI).digest('hex');
const URL_BASE = `https://github.com/${REPO}/releases/download`;

function release(version: string, extra: Record<string, unknown> = {}, digest: string | null = `sha256:${SHA}`) {
  return {
    tag_name: `core-v${version}`,
    name: `NexusCore ${version}`,
    body: 'Neu: Dinge',
    draft: false,
    published_at: '2026-11-14T10:00:00Z',
    html_url: `https://github.com/${REPO}/releases/tag/core-v${version}`,
    assets: [{ name: ASSET_NAME, browser_download_url: `${URL_BASE}/core-v${version}/${ASSET_NAME}`, size: MSI.length, ...(digest ? { digest } : {}) }],
    ...extra,
  };
}

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-update-'));
  await fs.writeFile(path.join(dir, 'nexuscore.exe'), 'x');
  await fs.writeFile(path.join(dir, 'nxsvc.exe'), 'x');
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function fakeFetch(releases: unknown[], bytes: Buffer = MSI, status = 200) {
  const calls: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    calls.push(url);
    if (url.includes('/releases?')) return new Response(JSON.stringify(releases), { status });
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  };
  return { impl, calls };
}

function updater(over: Partial<ConstructorParameters<typeof CoreUpdater>[0]> & { runner?: UpdateRunner }, releases: unknown[], bytes?: Buffer) {
  const net = fakeFetch(releases, bytes);
  const launched: Array<{ msi: string; log: string }> = [];
  const audits: string[] = [];
  const u = new CoreUpdater({
    repo: REPO,
    dir: path.join(dir, 'updates'),
    fetchImpl: net.impl,
    platform: 'windows',
    execPath: path.join(dir, 'nexuscore.exe'),
    currentVersion: '0.3.7',
    runner: { launch: async (msi, log) => void launched.push({ msi, log }) },
    audit: (a) => void audits.push(a),
    ...over,
  });
  return { u, net, launched, audits };
}

describe('Versionen und Release-Auswahl', () => {
  it('vergleicht Versionsnummern zahlenweise', () => {
    expect(compareVersions('0.3.10', '0.3.9')).toBe(1);
    expect(compareVersions('0.3.7', '0.3.7')).toBe(0);
    expect(compareVersions('0.2.9', '0.3.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
  });

  it('nimmt das höchste Core-Release; Entwürfe und fremde Tags zählen nicht', () => {
    const list = [release('0.3.8'), release('0.4.0', { draft: true }), { ...release('0.9.0'), tag_name: 'v0.9.0' }, release('0.3.10')];
    const r = latestRelease(list, REPO)!;
    expect(r.version).toBe('0.3.10');
    expect(r.asset).toMatchObject({ name: ASSET_NAME, sha256: SHA });
    expect(latestRelease([], REPO)).toBeNull();
    expect(latestRelease('kaputt', REPO)).toBeNull();
  });

  it('ein Installer von einer fremden Adresse wird nicht angeboten; fehlt die Prüfsumme, ist sie leer', () => {
    const fremd = release('0.4.0');
    (fremd.assets[0] as { browser_download_url: string }).browser_download_url = `https://evil.example/${ASSET_NAME}`;
    expect(latestRelease([fremd], REPO)!.asset).toBeNull();
    expect(latestRelease([release('0.4.0', {}, null)], REPO)!.asset!.sha256).toBeNull();
    expect(latestRelease([release('0.4.0', {}, 'sha256:zzz')], REPO)!.asset!.sha256).toBeNull();
  });
});

describe('Stand', () => {
  it('meldet eine neuere Version; eine gleiche oder ältere ist kein Update', async () => {
    expect((await updater({}, [release('0.3.8')]).u.status()).updateAvailable).toBe(true);
    expect((await updater({}, [release('0.3.7')]).u.status()).updateAvailable).toBe(false);
    expect((await updater({}, [release('0.3.6')]).u.status()).updateAvailable).toBe(false);
  });

  it('fragt GitHub nur alle 15 Minuten (außer mit refresh)', async () => {
    const { u, net } = updater({}, [release('0.3.8')]);
    await u.status();
    await u.status();
    expect(net.calls).toHaveLength(1);
    await u.status(true);
    expect(net.calls).toHaveLength(2);
  });

  it('GitHub antwortet nicht: Fehler im Stand statt Absturz', async () => {
    const { u } = updater({ fetchImpl: async () => { throw new Error('offline'); } }, []);
    const st = await u.status();
    expect(st.error).toBe('offline');
    expect(st.updateAvailable).toBe(false);
  });

  it('abgeschaltet: keine Anfrage an GitHub', async () => {
    const { u, net } = updater({ enabled: false }, [release('0.3.8')]);
    const st = await u.status(true);
    expect(net.calls).toHaveLength(0);
    expect(st.supported).toBe(false);
  });

  it('nur Windows aus dem Installer kann sich selbst aktualisieren', async () => {
    expect((await updater({}, []).u.status()).supported).toBe(true);
    const linux = await updater({ platform: 'linux' }, []).u.status();
    expect(linux.supported).toBe(false);
    expect(linux.reason).toContain('Windows');
    const dev = await updater({ execPath: path.join(dir, 'node.exe') }, []).u.status();
    expect(dev.supported).toBe(false);
  });
});

describe('Installieren', () => {
  it('lädt, prüft die Prüfsumme und startet den Installer', async () => {
    const { u, launched, audits } = updater({}, [release('0.3.8')]);
    expect(await u.install()).toEqual({ version: '0.3.8' });
    expect(launched).toHaveLength(1);
    expect(path.basename(launched[0]!.msi)).toBe('NexusCore-0.3.8.msi');
    expect(await fs.readFile(launched[0]!.msi)).toEqual(MSI);
    expect(audits).toEqual(['core.update']);
    expect((await u.status()).state).toBe('installing');
  });

  it('zeigt Fortschritt und führt ein Update-Protokoll; Installer-Protokoll wird UTF-16-fest gelesen', async () => {
    const { u } = updater({}, [release('0.3.8')]);
    await u.install();
    const st = await u.status();
    expect(st.progress?.phase).toBe('install');
    expect(st.progress?.installStartedAt).toBeTruthy();
    const lines = await u.logs('update');
    expect(lines.join('\n')).toContain('Prüfsumme stimmt');
    await fs.writeFile(path.join(dir, 'updates', 'install-0.3.8.log'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Zeile eins\r\nZeile zwei\r\n', 'utf16le')]));
    expect(await u.logs('installer')).toEqual(['# install-0.3.8.log', 'Zeile eins', 'Zeile zwei']);
  });

  it('sichert den Core vor dem Installer; schlägt die Sicherung fehl, wird nicht aktualisiert', async () => {
    const order: string[] = [];
    const ok = updater({ beforeInstall: async () => void order.push('sicherung'), runner: { launch: async () => void order.push('installer') } }, [release('0.3.8')]);
    await ok.u.install();
    expect(order).toEqual(['sicherung', 'installer']);

    const bad = updater({ beforeInstall: async () => { throw new Error('Platte voll'); } }, [release('0.3.8')]);
    await expect(bad.u.install()).rejects.toThrow(/Sicherung vor dem Update fehlgeschlagen.*Platte voll/);
    expect(bad.launched).toHaveLength(0);
  });

  it('falsche Prüfsumme: nichts wird gestartet, die Datei ist weg', async () => {
    const { u, launched } = updater({}, [release('0.3.8')], Buffer.from('manipuliert'));
    await expect(u.install()).rejects.toThrow(/Prüfsumme/);
    expect(launched).toHaveLength(0);
    await expect(fs.stat(path.join(dir, 'updates', 'NexusCore-0.3.8.msi'))).rejects.toThrow();
    expect((await u.status()).state).toBe('failed');
  });

  it('ohne Prüfsumme von GitHub wird nicht installiert', async () => {
    const { u, launched } = updater({}, [release('0.3.8', {}, null)]);
    await expect(u.install()).rejects.toMatchObject({ code: 'no_checksum' });
    expect(launched).toHaveLength(0);
  });

  it('abgelehnt: kein Update da, Linux, zweites Update gleichzeitig', async () => {
    await expect(updater({}, [release('0.3.7')]).u.install()).rejects.toMatchObject({ code: 'no_update', statusCode: 409 });
    await expect(updater({ platform: 'linux' }, [release('0.3.8')]).u.install()).rejects.toMatchObject({ code: 'not_supported' });
    const slow: UpdateRunner = { launch: () => new Promise((r) => setTimeout(r, 50)) };
    const { u } = updater({ runner: slow }, [release('0.3.8')]);
    const first = u.install();
    await expect(u.install()).rejects.toBeInstanceOf(UpdateError);
    await first;
  });
});
