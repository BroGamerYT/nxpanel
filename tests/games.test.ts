import { describe, it, expect } from 'vitest';
import { createSocket } from 'node:dgram';
import { parseArkList, parsePalworldList, ADAPTERS } from '../src/games/adapters.js';
import { a2sInfo, a2sPlayers } from '../src/games/a2s.js';

describe('Spielerlisten', () => {
  it('ARK ListPlayers', () => {
    expect(parseArkList('No Players Connected')).toEqual([]);
    expect(parseArkList('0. BroGamerYT, 0002a1b2c3d4e5f60718293a4b5c6d7e\n1. Simon Ark, 00029f8e7d6c5b4a39281706f5e4d3c2\n'))
      .toEqual([{ name: 'BroGamerYT', id: '0002a1b2c3d4e5f60718293a4b5c6d7e' }, { name: 'Simon Ark', id: '00029f8e7d6c5b4a39281706f5e4d3c2' }]);
    expect(ADAPTERS.ark!.command('ban', 'abc123')).toBe('BanPlayer abc123');
  });
  it('Palworld ShowPlayers', () => {
    expect(parsePalworldList('name,playeruid,steamid\nBro, Gamer,1234567,steam_76561198000000001\n'))
      .toEqual([{ name: 'Bro, Gamer', id: 'steam_76561198000000001' }]);
    expect(parsePalworldList('Unknown command')).toBeNull();
  });
});

describe('Valve-Abfrage (A2S) mit Challenge', () => {
  it('Info und Spieler', async () => {
    const sock = createSocket('udp4');
    const H = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const ch = Buffer.from([1, 2, 3, 4]);
    sock.on('message', (m, r) => {
      const send = (b: Buffer) => sock.send(Buffer.concat([H, b]), r.port, r.address);
      const hasCh = m.subarray(m.length - 4).equals(ch);
      if (!hasCh) { send(Buffer.concat([Buffer.from([0x41]), ch])); return; }
      if (m[4] === 0x54) {
        const s = (x: string) => Buffer.from(x + '\0');
        send(Buffer.concat([Buffer.from([0x49, 17]), s('Mein Valheim'), s('Dedicated'), s('valheim'), s('Valheim'), Buffer.from([0, 0, 3, 10, 0, 0x64, 0x6c, 0, 0]), s('0.219.16')]));
      } else if (m[4] === 0x55) {
        const p = (n: string) => Buffer.concat([Buffer.from([0]), Buffer.from(n + '\0'), Buffer.alloc(4), (() => { const b = Buffer.alloc(4); b.writeFloatLE(125); return b; })()]);
        send(Buffer.concat([Buffer.from([0x44, 2]), p('BroGamerYT'), p('Simon')]));
      }
    });
    await new Promise<void>((res) => sock.bind(0, '127.0.0.1', () => res()));
    const port = sock.address().port;
    const info = await a2sInfo('127.0.0.1', port, 1000);
    expect(info).toMatchObject({ name: 'Mein Valheim', map: 'Dedicated', players: 3, maxPlayers: 10, version: '0.219.16' });
    expect(await a2sPlayers('127.0.0.1', port, 1000)).toEqual([{ name: 'BroGamerYT', score: 0, seconds: 125 }, { name: 'Simon', score: 0, seconds: 125 }]);
    sock.close();
  });
});
