import { describe, it, expect } from 'vitest';
import { tmpFromEgg } from '../src/servers/create.js';
import { runtimeKey, DEFAULT_TMP } from '../src/docker/client.js';
import { classify } from '../web/src/lib/loglevel.js';

describe('/tmp im Container', () => {
  it('Vorgabe 256 MB RAM-Disk, "disk" fuer Proton-Spiele, Groesse begrenzt', () => {
    expect(tmpFromEgg(undefined)).toEqual(DEFAULT_TMP);
    expect(tmpFromEgg('disk')).toEqual({ mode: 'disk' });
    expect(tmpFromEgg({ size_mb: 99999 })).toEqual({ mode: 'tmpfs', sizeMb: 4096 });
    expect(tmpFromEgg('quatsch')).toEqual(DEFAULT_TMP);
    expect(runtimeKey()).toBe('tmp=disk');
    expect(runtimeKey({ mode: 'tmpfs', sizeMb: 256 })).toBe('tmp=tmpfs:256');
    expect(runtimeKey({ mode: 'disk' })).toBe('tmp=disk');
  });
});

describe('Fehler in der Konsole erkennen', () => {
  it.each([
    ["Cannot write to '/tmp/GE-Proton10-17.tar.gz' (No space left on device).", 'error'],
    ['Error: Error while downloading Proton (3)', 'error'],
    ['[12:00:01] [Server thread/ERROR]: Could not load plugin', 'error'],
    ['java.lang.NullPointerException: x', 'error'],
    ['[12:00:01] [Server thread/WARN]: Can\'t keep up! Is the server overloaded?', 'warn'],
    ['\u001b[33m[12:00:01 WARN]: deprecated thing\u001b[0m', 'warn'],
    ['\tat net.minecraft.server.Main.main(Main.java:42)', 'info'],
    ['Update state (0x61) downloading, progress: 40.07 (4916384498 / 12270964554)', 'info'],
    ['[12:00:05 INFO]: Done (18.097s)! For help, type "help"', 'info'],
  ])('%s -> %s', (line, level) => {
    expect(classify(line)).toBe(level);
  });
});
