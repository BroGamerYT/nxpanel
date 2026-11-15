import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { urlForLog } from '../src/protocol/security.js';
import { ASSET_NAME, CoreUpdater, HELPER_PICKUP_MS, INSTALL_TIMEOUT_MS, UpdateError, compareVersions, latestRelease, type UpdateRunner } from '../src/update/core-update.js';

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

  it('Windows aus dem Installer und Linux mit Update-Dienst können sich selbst aktualisieren, macOS nicht', async () => {
    expect((await updater({}, []).u.status()).supported).toBe(true);
    const linux = await updater({ platform: 'linux' }, []).u.status();
    expect(linux.supported).toBe(false);
    expect(linux.reason).toContain('install-core.sh');
    const mac = await updater({ platform: 'darwin' }, []).u.status();
    expect(mac.supported).toBe(false);
    expect(mac.reason).toContain('macOS');
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

describe('Kanal: stabil oder Vorabversionen', () => {
  it('Vorabversionen werden nur auf Wunsch angeboten; die Wahl übersteht den Neustart', async () => {
    const list = [release('0.3.8'), release('0.3.9', { prerelease: true })];
    expect(latestRelease(list, REPO)!.version).toBe('0.3.8');
    expect(latestRelease(list, REPO, true)).toMatchObject({ version: '0.3.9', prerelease: true });
    expect(latestRelease([release('0.3.9', { prerelease: true })], REPO)).toBeNull();

    const sub = path.join(dir, 'kanal');
    const { u, audits } = updater({ dir: sub }, list);
    expect(await u.status()).toMatchObject({ channel: 'stable', latest: { version: '0.3.8' } });
    await u.setChannel('prerelease');
    // ohne refresh: der Wechsel verwirft die gemerkte Antwort
    expect(await u.status()).toMatchObject({ channel: 'prerelease', latest: { version: '0.3.9', prerelease: true } });
    expect(audits).toContain('core.update.channel');
    expect(updater({ dir: sub }, list).u.channel()).toBe('prerelease');
    await u.setChannel('stable');
    expect(updater({ dir: sub }, list).u.channel()).toBe('stable');
  });
});

describe('Hängendes Update', () => {
  it('beendet der Installer den Core nicht, gilt das Update nach der Frist als gescheitert und ein neuer Versuch geht', async () => {
    let now = Date.parse('2026-11-14T12:00:00Z');
    const { u, launched } = updater({ dir: path.join(dir, 'haengt'), now: () => now }, [release('0.3.8')]);
    await u.install();
    expect((await u.status()).state).toBe('installing');
    await expect(u.install()).rejects.toMatchObject({ code: 'conflict' });
    now += INSTALL_TIMEOUT_MS - 1000;
    expect((await u.status()).state).toBe('installing');
    now += 2000;
    const st = await u.status();
    expect(st.state).toBe('failed');
    expect(st.message).toContain('nicht neu gestartet');
    expect(st.progress).toBeNull();
    await u.install();
    expect(launched).toHaveLength(2);
  });
});

describe('Adresse im Log', () => {
  it('ersetzt Zugänge in der Abfrage, lässt den Rest stehen', () => {
    expect(urlForLog('/api/v1/servers/a/ws?token=geheim123')).toBe('/api/v1/servers/a/ws?token=[entfernt]');
    expect(urlForLog('/api/v1/live/ws?serverId=x&ticket=abc.def&lines=5')).toBe('/api/v1/live/ws?serverId=x&ticket=[entfernt]&lines=5');
    expect(urlForLog('/core/v1/stream?TOKEN=a%2Fb')).toBe('/core/v1/stream?TOKEN=[entfernt]');
    expect(urlForLog('/api/v1/admin/core-update?refresh=1')).toBe('/api/v1/admin/core-update?refresh=1');
    expect(urlForLog('/api/v1/servers/tokenizer')).toBe('/api/v1/servers/tokenizer');
  });
});

describe('Linux: Update über den Root-Dienst', () => {
  const LINUX = 'NexusCore-linux.tar.gz';
  function linuxRelease(version: string, withAsset = true, digest: string | null = `sha256:${SHA}`) {
    const r = release(version);
    if (withAsset) r.assets.push({ name: LINUX, browser_download_url: `${URL_BASE}/core-v${version}/${LINUX}`, size: 1234, ...(digest ? { digest } : {}) });
    return r;
  }
  async function linuxUpdater(name: string, releases: unknown[], extra: Partial<ConstructorParameters<typeof CoreUpdater>[0]> = {}) {
    const base = path.join(dir, name);
    const helper = { unit: path.join(base, 'nexuscore-update.path'), runDir: path.join(base, 'run'), logDir: path.join(base, 'log') };
    await fs.mkdir(helper.runDir, { recursive: true });
    await fs.mkdir(helper.logDir, { recursive: true });
    const net = fakeFetch(releases);
    const audits: string[] = [];
    const u = new CoreUpdater({
      repo: REPO, dir: path.join(base, 'updates'), fetchImpl: net.impl, platform: 'linux', currentVersion: '0.3.19',
      linuxHelper: helper, audit: (a) => void audits.push(a), ...extra,
    });
    return { u, helper, net, audits, requestFile: path.join(base, 'updates', 'request') };
  }

  it('findet das Linux-Paket mit Prüfsumme im Release', () => {
    const r = latestRelease([linuxRelease('0.3.20')], REPO)!;
    expect(r.linuxAsset).toMatchObject({ name: LINUX, sha256: SHA });
    expect(latestRelease([linuxRelease('0.3.20', false)], REPO)!.linuxAsset).toBeNull();
  });

  it('ohne den Update-Dienst ist das Update nicht möglich und sagt, was zu tun ist', async () => {
    const { u } = await linuxUpdater('lx-ohne', [linuxRelease('0.3.20')]);
    const st = await u.status();
    expect(st.supported).toBe(false);
    expect(st.reason).toContain('install-core.sh');
    await expect(u.install()).rejects.toMatchObject({ code: 'not_supported' });
  });

  it('legt nur die Anforderung mit dem Tag ab, sichert vorher und lädt selbst nichts', async () => {
    let backups = 0;
    const { u, helper, net, audits, requestFile } = await linuxUpdater('lx-ok', [linuxRelease('0.3.20')], { beforeInstall: async () => void backups++ });
    await fs.writeFile(helper.unit, '[Path]');
    expect((await u.status()).supported).toBe(true);
    expect(await u.install()).toEqual({ version: '0.3.20' });
    expect(backups).toBe(1);
    expect((await fs.readFile(requestFile, 'utf8')).trim()).toBe('core-v0.3.20');
    expect(net.calls.some((c) => c.endsWith(LINUX))).toBe(false);
    expect(audits).toContain('core.update');
    expect((await u.status()).state).toBe('installing');
    await expect(u.install()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('bricht ab, wenn das Linux-Paket oder seine Prüfsumme fehlt, und legt nichts ab', async () => {
    for (const [name, rel, code] of [['lx-nopkg', linuxRelease('0.3.20', false), 'no_asset'], ['lx-nosum', linuxRelease('0.3.20', true, null), 'no_checksum']] as const) {
      const { u, helper, requestFile } = await linuxUpdater(name, [rel]);
      await fs.writeFile(helper.unit, '[Path]');
      await expect(u.install()).rejects.toMatchObject({ code });
      await expect(fs.access(requestFile)).rejects.toThrow();
    }
  });

  it('meldet einen Fehler des Root-Dienstes und lässt einen neuen Versuch zu', async () => {
    const { u, helper } = await linuxUpdater('lx-fehler', [linuxRelease('0.3.20')]);
    await fs.writeFile(helper.unit, '[Path]');
    await u.install();
    await fs.writeFile(path.join(helper.runDir, 'result'), 'failed\nDie Prüfsumme des Pakets stimmt nicht - es wird nicht installiert.\n');
    const st = await u.status();
    expect(st.state).toBe('failed');
    expect(st.message).toContain('Prüfsumme');
    // Der Root-Dienst löscht das alte Ergebnis, sobald er die nächste Anforderung abholt
    await fs.rm(path.join(helper.runDir, 'result'));
    await u.install();
    expect((await u.status()).state).toBe('installing');
  });

  it('ein Ergebnis von früher (vor dem Start) zählt nicht als Fehler dieses Versuchs', async () => {
    const { u, helper } = await linuxUpdater('lx-alt', [linuxRelease('0.3.20')]);
    await fs.writeFile(helper.unit, '[Path]');
    const old = path.join(helper.runDir, 'result');
    await fs.writeFile(old, 'failed\nalter Fehler\n');
    await fs.utimes(old, new Date('2020-01-01'), new Date('2020-01-01'));
    await u.install();
    expect((await u.status()).state).toBe('installing');
  });

  it('holt der Dienst die Anforderung nicht ab, scheitert das Update nach der Frist', async () => {
    let now = Date.now();
    const { u, helper, requestFile } = await linuxUpdater('lx-pickup', [linuxRelease('0.3.20')], { now: () => now });
    await fs.writeFile(helper.unit, '[Path]');
    await u.install();
    now += HELPER_PICKUP_MS + 1000;
    const st = await u.status();
    expect(st.state).toBe('failed');
    expect(st.message).toContain('nicht abgeholt');
    await expect(fs.access(requestFile)).rejects.toThrow();
  });

  it('ein zurückgespieltes Update (Fehler nach dem Neustart) bleibt sichtbar, ein erfolgreiches nicht', async () => {
    const a = await linuxUpdater('lx-rollback', [linuxRelease('0.3.19')]);
    await fs.writeFile(path.join(a.helper.runDir, 'result'), 'failed\nDer Core 0.3.20 antwortet nicht - der bisherige Stand 0.3.19 läuft wieder.\n');
    const st = await a.u.status();
    expect(st.state).toBe('failed');
    expect(st.message).toContain('läuft wieder');
    const b = await linuxUpdater('lx-erfolg', [linuxRelease('0.3.19')]);
    await fs.writeFile(path.join(b.helper.runDir, 'result'), 'ok\n0.3.19\n');
    expect((await b.u.status()).state).toBe('idle');
  });

  it('liest das Protokoll des Root-Dienstes aus dessen Ordner', async () => {
    const { u, helper } = await linuxUpdater('lx-log', [linuxRelease('0.3.20')]);
    await fs.writeFile(path.join(helper.logDir, 'install-0.3.20.log'), 'Zeile 1\nZeile 2\n');
    expect(await u.logs('installer')).toEqual(['# install-0.3.20.log', 'Zeile 1', 'Zeile 2']);
  });
});

describe('Linux-Skripte', () => {
  const lin = (f: string) => readFileSync(path.join(__dirname, '..', 'deploy', 'linux', f), 'utf8');
  it('apply-update.sh prüft Tag, Version und Prüfsumme selbst und schreibt nur in root-eigene Ordner', () => {
    const s = lin('apply-update.sh');
    expect(s).not.toContain('\r');
    expect(s).toContain('^core-v([0-9]+\\.[0-9]+\\.[0-9]+)$');
    expect(s).toContain('sha256sum');
    expect(s).toContain('sort -V');
    expect(s).toContain('/run/nexuscore-update');
    expect(s).toContain('/var/log/nexuscore-update');
    // Rückspielen, wenn die Installation fehlschlägt oder die neue Version nicht antwortet
    expect(s).toContain('rollback');
  });
  it('install-core.sh richtet Dienst und Pfad-Einheit ein und startet einen laufenden Core neu', () => {
    const s = lin('install-core.sh');
    expect(s).toContain('nexuscore-update.path');
    expect(s).toContain('apply-update.sh');
    expect(s).toContain('systemctl restart nexuscore');
    expect(lin('nexuscore-update.path')).toContain('PathExists=');
    expect(lin('nexuscore-update.service')).toContain('Type=oneshot');
  });
});
