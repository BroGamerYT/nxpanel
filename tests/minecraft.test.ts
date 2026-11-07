import { describe, it, expect } from 'vitest';
import { createServer, type Socket } from 'node:net';
import { Rcon } from '../src/games/rcon.js';
import { parseTps, serverListPing, tpsCommands, chatToLegacy } from '../src/games/minecraft.js';

function listen(handler: (s: Socket) => void): Promise<{ port: number; close: () => void }> {
  return new Promise((res) => {
    const srv = createServer(handler);
    srv.listen(0, '127.0.0.1', () => res({ port: (srv.address() as { port: number }).port, close: () => srv.close() }));
  });
}

describe('TPS deuten', () => {
  it.each([
    ['§6TPS from last 1m, 5m, 15m: §a19.98, §a20.0, §a20.0', 'tps', 19.98],
    ['TPS from last 5s, 10s, 1m, 5m, 15m:\n *20.0, 20.0, 20.0, 20.0, 20.0\n\nTick durations (min/med/95%ile/max ms) from last 10s, 1m:\n 0.4/1.2/3.1/9.0', 'spark tps', 20],
    ['Overall: Mean tick time: 2.500 ms. Mean TPS: 20.000', 'neoforge tps', 20],
    ['The game is running normally\nTarget tick rate: 20.0 per second.\nAverage time per tick: 62.5ms (Target: 50.0ms)', 'tick query', 16],
  ])('%s', (raw, src, tps) => {
    expect(parseTps(raw, src)?.tps).toBe(tps);
  });
  it('unbekannter Befehl -> null, Reihenfolge je Typ', () => {
    expect(parseTps('Unknown or incomplete command, see below for error', 'tps')).toBeNull();
    expect(tpsCommands('VANILLA')[0]).toBe('tick query');
    expect(tpsCommands('PAPER')[0]).toBe('tps');
    expect(tpsCommands('NEOFORGE')[0]).toBe('neoforge tps');
  });
  it('MOTD aus Chat-Komponente', () => {
    expect(chatToLegacy({ text: '', extra: [{ text: 'Hallo ', color: 'gold', bold: true }, { text: 'Welt', color: 'green' }] })).toBe('§6§lHallo §aWelt');
  });
});

describe('RCON', () => {
  it('meldet sich an, schickt Befehle, erkennt falsches Passwort', async () => {
    const srv = await listen((s) => {
      let buf = Buffer.alloc(0);
      s.on('data', (c) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
          const len = buf.readInt32LE(0), id = buf.readInt32LE(4), type = buf.readInt32LE(8);
          const body = buf.toString('utf8', 12, 4 + len - 2);
          buf = buf.subarray(len + 4);
          const reply = (rid: number, t: number, text: string) => {
            const b = Buffer.from(text); const p = Buffer.alloc(14 + b.length);
            p.writeInt32LE(10 + b.length, 0); p.writeInt32LE(rid, 4); p.writeInt32LE(t, 8); b.copy(p, 12); s.write(p);
          };
          if (type === 3) reply(body === 'geheim' ? id : -1, 2, '');
          else reply(id, 0, `ok:${body}`);
        }
      });
    });
    const r = new Rcon('127.0.0.1', srv.port, 'geheim', 1000);
    expect(await r.command('tps')).toBe('ok:tps');
    expect(await r.command('list')).toBe('ok:list');
    r.close();
    const bad = new Rcon('127.0.0.1', srv.port, 'falsch', 1000);
    await expect(bad.command('tps')).rejects.toThrow(/Passwort/);
    srv.close();
  });
});

describe('Server List Ping', () => {
  it('liest Version, Spieler, MOTD', async () => {
    const status = JSON.stringify({ version: { name: 'Paper 26.3', protocol: 900 }, players: { online: 2, max: 20, sample: [{ name: 'BroGamerYT' }] }, description: { text: '§6Test' } });
    const vi = (n: number) => { const o: number[] = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
    const srv = await listen((s) => {
      let n = 0;
      s.on('data', (c) => {
        n++;
        if (c.includes(Buffer.from([0x01, 0x00])) || n === 1) {
          const body = Buffer.concat([vi(0), vi(Buffer.byteLength(status)), Buffer.from(status)]);
          s.write(Buffer.concat([vi(body.length), body]));
        }
        if (c.length >= 10 && c[1] === 0x01) s.write(c.subarray(0, 10));
      });
    });
    const r = await serverListPing('127.0.0.1', srv.port, 2000);
    expect(r).toMatchObject({ version: 'Paper 26.3', players: { online: 2, max: 20, sample: ['BroGamerYT'] }, motd: '§6Test' });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    srv.close();
  });
});
