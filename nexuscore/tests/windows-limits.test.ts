import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import os from 'node:os';

const { jobArgs, wrapLaunch, findJobHelper } = await import('../src/drivers/job-helper.js');
const { WindowsNativeDriver } = await import('../src/drivers/windows-native.js');

describe('Argumente für nxjob', () => {
  it('ohne Durchsetzung gibt es keine Grenzen - nur das Aufräumen beim Beenden', () => {
    expect(jobArgs({ enforce: false, memoryMb: 2048, cpuPercent: 100, cores: 8 })).toEqual([]);
  });

  it('Speicher in MB, CPU in Hundertstel Prozent der gesamten Leistung', () => {
    expect(jobArgs({ enforce: true, memoryMb: 2048, cpuPercent: 200, cores: 8 })).toEqual(['--mem-mb', '2048', '--cpu-rate', '2500']);
    expect(jobArgs({ enforce: true, memoryMb: 4096.7, cpuPercent: 100, cores: 4 })).toEqual(['--mem-mb', '4096', '--cpu-rate', '2500']);
  });

  it('alle Kerne ausgeschöpft oder unsinnige Werte: keine Grenze', () => {
    expect(jobArgs({ enforce: true, cpuPercent: 800, cores: 8 })).toEqual([]);
    expect(jobArgs({ enforce: true, cpuPercent: 4000, cores: 8 })).toEqual([]);
    expect(jobArgs({ enforce: true, memoryMb: 10, cpuPercent: 0, cores: 8 })).toEqual([]);
    expect(jobArgs({ enforce: true, memoryMb: Number.NaN, cpuPercent: Number.NaN, cores: 8 })).toEqual([]);
    // sehr wenig CPU ergibt mindestens 1
    expect(jobArgs({ enforce: true, cpuPercent: 0.01, cores: 64 })).toEqual(['--cpu-rate', '1']);
  });

  it('baut den Aufruf mit -- vor dem Programm, ohne die Argumente anzufassen', () => {
    const call = wrapLaunch('C:\\h\\nxjob.exe', 'C:\\spiel\\server.exe', ['-name', 'Mein Server; calc', '--mem-mb', '1'], { enforce: true, memoryMb: 512, cores: 4 });
    expect(call).toEqual({ command: 'C:\\h\\nxjob.exe', args: ['--mem-mb', '512', '--', 'C:\\spiel\\server.exe', '-name', 'Mein Server; calc', '--mem-mb', '1'] });
  });
});

const helper = findJobHelper();
const windows = process.platform === 'win32' && helper !== null;

describe.skipIf(!windows)('nxjob.exe (Windows, mit gebautem Hilfsprogramm)', () => {
  const run = (args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string; err: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(helper!, args, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Zeitüberschreitung'));
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
  const node = process.execPath;

  it('reicht Ausgabe und Exit-Code durch', async () => {
    const r = await run(['--', node, '-e', "console.log('hallo'); process.exit(7)"]);
    expect(r.out.trim()).toBe('hallo');
    expect(r.code).toBe(7);
  });

  it('gibt Argumente unverändert weiter (auch mit Leerzeichen und Anführungszeichen)', async () => {
    const r = await run(['--', node, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'Mein Server', 'a"b', '--mem-mb', 'x&y']);
    expect(JSON.parse(r.out.trim())).toEqual(['Mein Server', 'a"b', '--mem-mb', 'x&y']);
  });

  it('die Speichergrenze greift - ohne Grenze läuft dasselbe Programm durch', async () => {
    const alloc = ['-e', "const b = Buffer.alloc(300 * 1024 * 1024, 1); console.log('ALLOK', b.length)"];
    const limited = await run(['--mem-mb', '100', '--', node, ...alloc]);
    expect(limited.out).not.toContain('ALLOK');
    expect(limited.code).not.toBe(0);
    const free = await run(['--mem-mb', '4000', '--', node, ...alloc]);
    expect(free.out).toContain('ALLOK');
    expect(free.code).toBe(0);
  });

  it('startet nicht, wenn es das Programm nicht gibt (Code 4) oder die Aufrufe falsch sind (Code 2)', async () => {
    const missing = await run(['--', 'C:\\gibt\\es\\nicht.exe']);
    expect(missing.code).toBe(4);
    expect(missing.err).toContain('[nxjob]');
    expect((await run(['--mem-mb', 'x', '--', node])).code).toBe(2);
    expect((await run(['--mem-mb', '0', '--', node])).code).toBe(2);
    expect((await run(['--cpu-rate', '10001', '--', node])).code).toBe(2);
    expect((await run(['--unbekannt'])).code).toBe(2);
    expect((await run([])).code).toBe(2);
  });

  it('endet das Hilfsprogramm hart, endet auch das Spiel (keine Waisen)', async () => {
    const child = spawn(helper!, ['--', node, '-e', "console.log('PID', process.pid); setInterval(() => {}, 1000)"], { windowsHide: true });
    const gamePid = await new Promise<number>((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('keine PID')), 15_000);
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        const m = /PID (\d+)/.exec(buf);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive(gamePid)).toBe(true);
    // Hart beenden, ohne den Prozessbaum: nur nxjob selbst
    child.kill('SIGKILL');
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      await new Promise((r) => setTimeout(r, 100));
      gone = !alive(gamePid);
    }
    expect(gone).toBe(true);
  });
});

describe.skipIf(!windows)('WindowsNativeDriver mit Hilfsprogramm', () => {
  const driver = new WindowsNativeDriver();
  const lines: string[] = [];
  driver.setLogSink((l) => lines.push(l.line));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (check: () => Promise<boolean> | boolean, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await wait(150);
    }
    return false;
  };

  afterEach(async () => {
    for (const s of await driver.listServers()) await driver.killServer(s.id).catch(() => {});
    lines.length = 0;
  });

  const config = (id: string, script: string, extra: object = {}) => ({
    id,
    name: id,
    game: 'x',
    executable: process.execPath,
    args: ['-e', script],
    workingDir: os.tmpdir(),
    ports: [],
    ...extra,
  });

  it('wird gebaut und gefunden', () => {
    expect(driver.hasJobHelper).toBe(true);
  });

  it('Statistik zählt das Spiel hinter dem Hilfsprogramm mit (nicht nur das Hilfsprogramm)', async () => {
    await driver.registerServer(config('stats-1', "const b = Buffer.alloc(120 * 1024 * 1024, 1); setInterval(() => b[0]++, 200)"));
    await driver.startServer('stats-1');
    const ok = await waitFor(async () => (await driver.getServerStats('stats-1')).memoryMb > 80, 20_000);
    expect(ok, `Speicher laut Statistik: ${(await driver.getServerStats('stats-1')).memoryMb} MB`).toBe(true);
  }, 40_000);

  it('Grenzen nur auf Wunsch: aus = läuft, an = wird bei Überschreitung beendet', async () => {
    const script = "const b = Buffer.alloc(300 * 1024 * 1024, 1); console.log('ALLOK'); setInterval(() => b[0]++, 200)";
    driver.setLimitsPolicy(() => false);
    await driver.registerServer(config('lim-off', script, { maxMemoryMb: 100 }));
    await driver.startServer('lim-off');
    expect(await waitFor(() => lines.includes('ALLOK'))).toBe(true);
    await driver.killServer('lim-off');
    lines.length = 0;

    driver.setLimitsPolicy(() => true);
    await driver.registerServer(config('lim-on', script, { maxMemoryMb: 100 }));
    await driver.startServer('lim-on');
    expect(await waitFor(async () => (await driver.getServerState('lim-on')).status === 'offline', 20_000)).toBe(true);
    expect(lines).not.toContain('ALLOK');
    expect(lines.some((l) => l.includes('Grenzen aktiv: RAM 100 MB'))).toBe(true);
    driver.setLimitsPolicy(() => false);
  }, 60_000);

  it('ein Programm, das es nicht gibt, ist ein Startfehler und kein stilles Ende', async () => {
    await driver.registerServer(config('fehlt', '', { executable: 'C:\\gibt\\es\\nicht.exe', args: [] }));
    await driver.startServer('fehlt');
    expect(await waitFor(async () => (await driver.getServerState('fehlt')).status === 'error')).toBe(true);
  });

  it('setPriority stellt den ganzen Prozessbaum um und wieder zurück', async () => {
    await driver.registerServer(config('prio', 'setInterval(() => {}, 1000)'));
    await driver.startServer('prio');
    await wait(800);
    const changed = await driver.setPriority('prio', 'low');
    expect(changed).toBeGreaterThanOrEqual(1);
    const pid = (await driver.getServerState('prio')).pid!;
    expect(os.getPriority(pid)).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    await driver.setPriority('prio', 'normal');
    expect(os.getPriority(pid)).toBe(os.constants.priority.PRIORITY_NORMAL);
    // Nicht laufend: nichts zu tun
    await driver.killServer('prio');
    expect(await driver.setPriority('prio', 'low')).toBe(0);
  }, 30_000);
});
