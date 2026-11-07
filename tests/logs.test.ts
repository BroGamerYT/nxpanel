import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, appendFile, rm, rename, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../src/config.js';
import { followFile, tailFile, logFilePath } from '../src/servers/logfile.js';
import { listLogs } from '../src/http/routes/logs.js';
import { cleanHints } from '../src/http/routes/servers.js';
import { networkCheck } from '../src/netcheck.js';

const short = 'logtest1';
const root = join(config.VOLUME_ROOT, short);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Logdatei mitlesen', () => {
  it('liest nur Neues, beginnt nach Austausch der Datei von vorn', async () => {
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, 'ShooterGame/Saved/Logs'), { recursive: true });
    const path = logFilePath(short, 'ShooterGame/Saved/Logs/ShooterGame.log')!;
    await writeFile(path, 'alter Lauf: advertising for join\n');
    const got: string[] = [];
    const stop = followFile(path, (l) => got.push(l), { intervalMs: 30 });
    await wait(80);
    await appendFile(path, 'LogEOS: Warning: x\nhalbe');
    await wait(80);
    expect(got).toEqual(['LogEOS: Warning: x']);
    await rename(path, path + '.alt');
    await writeFile(path, 'neu 1\n');
    await wait(100);
    expect(got).toEqual(['LogEOS: Warning: x', 'neu 1']);
    stop();
    expect(await tailFile(path, 5)).toEqual(['neu 1']);
    expect(logFilePath(short, '../../etc/passwd')).toBeNull();
  });

  it('listet Logs neueste zuerst, auch .gz', async () => {
    await mkdir(join(root, 'logs'), { recursive: true });
    await writeFile(join(root, 'logs', 'latest.log'), 'a');
    await writeFile(join(root, 'logs', '2026-11-05-1.log.gz'), gzipSync('b'));
    await writeFile(join(root, 'logs', 'notes.json'), '{}');
    await utimes(join(root, 'logs', '2026-11-05-1.log.gz'), new Date('2026-11-05'), new Date('2026-11-05'));
    const l = await listLogs(short, ['logs', '../../etc']);
    expect(l.map((f) => f.path)).toEqual(['logs/latest.log', 'logs/2026-11-05-1.log.gz']);
  });
});

describe('Hinweise aus dem Egg', () => {
  it('laesst nur gueltige durch', () => {
    expect(cleanHints([{ match: 'a(', text: 'x' }, { match: 'ok', text: 'y', level: 'ignore', flags: 'i' }, 'quatsch'])).toEqual([
      { match: 'ok', flags: 'i', level: 'ignore', text: 'y' },
    ]);
  });
});

describe('Verbindungstest', () => {
  it('erkennt abweichende Adresse und falsche Uhr', async () => {
    const skewed = new Date(Date.now() + 120_000).toUTCString();
    const fake = (async (url: string) => {
      if (String(url).includes('ipify')) return new Response(JSON.stringify({ ip: '203.0.113.9' }), { headers: { date: skewed } });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const r = await networkCheck('193.34.69.60', fake);
    const by = Object.fromEntries(r.map((x) => [x.key, x]));
    expect(by.https).toMatchObject({ ok: true, value: 'HTTP 404' });
    expect(by.publicIp).toMatchObject({ ok: false, value: '203.0.113.9' });
    expect(by.clock!.ok).toBe(false);
    expect(Number(by.clock!.value)).toBeGreaterThan(100);
  });
});
