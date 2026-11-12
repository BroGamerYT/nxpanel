import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { assertRuntimeSupported, describePlatform, placeholderScript, platformFor, RuntimeNotSupportedError, tarBinary } = await import('../src/platform/index.js');
const { FirewallManager } = await import('../src/system/firewall.js');
const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');

const MASTER = { authorization: 'Bearer test-token-0123456789abcdefghij' };

describe('Plattform-Schicht', () => {
  it('ordnet jedes System zu; unbekannte Unix-Systeme verhalten sich wie Linux', () => {
    expect(platformFor('win32').id).toBe('windows');
    expect(platformFor('linux').id).toBe('linux');
    expect(platformFor('darwin').id).toBe('darwin');
    expect(platformFor('freebsd').id).toBe('linux');
  });

  it('Docker läuft überall; Spiele direkt als Prozess nur unter Windows', () => {
    for (const p of ['win32', 'linux', 'darwin'] as const) {
      expect(platformFor(p).runtimes, p).toContain('docker');
      expect(platformFor(p).runtimes, p).toContain('mock');
    }
    expect(platformFor('win32').runtimes).toContain('windows-native');
    expect(platformFor('linux').runtimes).not.toContain('windows-native');
    expect(platformFor('darwin').runtimes).not.toContain('windows-native');
    expect(platformFor('win32').defaultRuntime).toBe('windows-native');
    expect(platformFor('linux').defaultRuntime).toBe('docker');
    expect(platformFor('darwin').defaultRuntime).toBe('docker');
  });

  it('ein Treiber, der auf dem System nicht geht, wird beim Start mit klarer Meldung abgelehnt', () => {
    expect(() => assertRuntimeSupported('windows-native', platformFor('linux'))).toThrow(RuntimeNotSupportedError);
    expect(() => assertRuntimeSupported('windows-native', platformFor('darwin'))).toThrow(/macOS.*docker, mock/s);
    expect(() => assertRuntimeSupported('windows-native', platformFor('win32'))).not.toThrow();
    expect(() => assertRuntimeSupported('docker', platformFor('darwin'))).not.toThrow();
    expect(() => assertRuntimeSupported('docker', platformFor('win32'))).not.toThrow();
    expect(() => assertRuntimeSupported('gibtsnicht', platformFor('linux'))).toThrow(/Möglich/);
  });

  it('jedes System weiß, wie der Core dort als Dienst läuft', () => {
    expect(platformFor('win32').service).toMatchObject({ kind: 'windows-service', install: 'scripts/install-service.ps1' });
    expect(platformFor('linux').service).toMatchObject({ kind: 'systemd', install: 'deploy/linux/install-core.sh' });
    expect(platformFor('darwin').service).toMatchObject({ kind: 'launchd', install: 'deploy/macos/install-core.sh' });
  });

  it('Firewall-Freigaben je Programm gibt es nur unter Windows - sonst mit Begründung statt stiller Lücke', async () => {
    expect(platformFor('win32').firewall).toEqual({ available: true });
    for (const p of ['linux', 'darwin'] as const) {
      expect(platformFor(p).firewall.available, p).toBe(false);
      expect(platformFor(p).firewall.reason, p).toBeTruthy();
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-plat-'));
    try {
      const linux = new FirewallManager(path.join(dir, 'f.json'), async () => ({ code: 0, out: '' }), 'linux');
      expect(linux.available).toBe(false);
      expect(linux.reason).toMatch(/Docker/);
      await expect(linux.open('s', 'C:\\x.exe')).rejects.toMatchObject({ code: 'unsupported' });
      expect(new FirewallManager(path.join(dir, 'g.json'), async () => ({ code: 0, out: '' }), 'win32').available).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('Platzhalter-Startdatei und tar passen zum System', () => {
    expect(platformFor('win32').scriptName).toBe('start.bat');
    expect(platformFor('linux').scriptName).toBe('start.sh');
    expect(placeholderScript(platformFor('win32'), 'A', 'egg', 25565)).toContain('@echo off');
    expect(placeholderScript(platformFor('darwin'), 'A', 'egg', 25565)).toMatch(/^#!\/bin\/sh/);
    // Unter Windows das mitgelieferte tar, wenn es da ist - sonst das aus dem PATH
    const env = { SystemRoot: 'C:\\Windows' } as NodeJS.ProcessEnv;
    expect(tarBinary(platformFor('win32'), env, () => true)).toBe('C:\\Windows\\System32\\tar.exe');
    expect(tarBinary(platformFor('win32'), env, () => false)).toBe('tar');
    expect(tarBinary(platformFor('linux'), env, () => true)).toBe('tar');
  });

  it('beschreibt das System für die Oberfläche', () => {
    expect(describePlatform('docker', platformFor('linux'))).toMatchObject({ id: 'linux', label: 'Linux', runtime: 'docker', runtimes: ['docker', 'mock'], firewall: { available: false } });
  });
});

describe('Die API meldet das System - die Oberfläche blendet Unmögliches aus', () => {
  const made: Array<{ close: () => Promise<void>; registry: { close: () => void }; dir: string }> = [];
  afterAll(async () => {
    for (const m of made) {
      await m.close();
      m.registry.close();
      await fs.rm(m.dir, { recursive: true, force: true });
    }
  });

  async function about(platform: NodeJS.Platform) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-plat-api-'));
    const registry = await ServerRegistry.open(dir);
    const driver = new MockDriver();
    await driver.initialize();
    const server = await createCoreServer(driver, new EventBus(), registry, {
      installs: null,
      scheduler: false,
      firewall: new FirewallManager(path.join(dir, 'f.json'), async () => ({ code: 0, out: '' }), platform),
    });
    made.push({ close: () => server.close(), registry, dir });
    const res = await server.inject({ method: 'GET', url: '/api/v1/about', headers: MASTER });
    const fw = await server.inject({ method: 'GET', url: '/api/v1/admin/firewall', headers: MASTER });
    return { about: res.json(), firewall: fw.json() };
  }

  it('Windows: Firewall-Funktion ist da', async () => {
    const { about: a, firewall } = await about('win32');
    expect(a.features).toContain('firewall');
    expect(firewall.available).toBe(true);
    expect(firewall.reason).toBeUndefined();
  });

  it('Linux und macOS: keine Firewall-Funktion in der Liste, die Seite erfährt den Grund', async () => {
    for (const p of ['linux', 'darwin'] as const) {
      const { about: a, firewall } = await about(p);
      expect(a.features, p).not.toContain('firewall');
      expect(a.features, p).toContain('passkeys'); // alles andere bleibt überall gleich
      expect(firewall.available, p).toBe(false);
      expect(firewall.reason, p).toBeTruthy();
    }
  });

  it('der Core meldet sein System und die möglichen Treiber', async () => {
    const { about: a } = await about(process.platform);
    expect(a.platform).toMatchObject({ id: platformFor().id, runtime: expect.any(String), runtimes: expect.arrayContaining(['docker']) });
    expect(a.platform.service.kind).toMatch(/windows-service|systemd|launchd/);
  });
});

describe('Systemabhängiges steht nur in der Plattform-Schicht', () => {
  it('kein neuer Code benutzt process.platform oder win32 außerhalb der erlaubten Stellen', async () => {
    // Erlaubt: die Schicht selbst, die Windows-Treiber, Installer-Werkzeuge je System und reine Anzeige.
    const allowed = new Set([
      'platform/index.ts',
      'drivers/windows-native.ts', // nur Windows
      'drivers/job-helper.ts', // nxjob nur Windows
      'drivers/docker-driver.ts', // chown des Datenordners gibt es unter Windows nicht
      'install/java.ts', // Java-Download je System
      'install/steamcmd.ts', // SteamCMD-Download je System
      'files/files.ts', // Windows-Sondernamen in Dateinamen
      'system/firewall.ts', // Schalter der Firewall-Schicht (platform-Parameter)
      'http/routes/info.ts', // nur Anzeige
      'http/routes/pair.ts', // nur Anzeige
      'index.ts', // nur Anzeige
    ]);
    const root = path.resolve(import.meta.dirname, '..', 'src');
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.ts')) {
          const rel = path.relative(root, full).replace(/\\/g, '/');
          if (allowed.has(rel)) continue;
          const text = await fs.readFile(full, 'utf8');
          if (/process\.platform|'win32'|"win32"/.test(text)) found.push(rel);
        }
      }
    };
    await walk(root);
    expect(found, `Systemabhängiger Code gehört nach src/platform/index.ts: ${found.join(', ')}`).toEqual([]);
  });
});
