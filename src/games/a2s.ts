import { createSocket } from 'node:dgram';

/**
 * Valve-Serverabfrage (A2S) ueber UDP - fuer Spiele, die sie anbieten:
 * Counter-Strike 2, Valheim, 7 Days to Die, Sons of the Forest u. a.
 * Liefert Name, Karte, Spielerzahl und - je nach Spiel - Spielernamen.
 * Seit 2020 verlangen die meisten Server vorher eine "Challenge"-Nummer;
 * die wird transparent nachgereicht.
 */
export interface A2sInfo { name: string; map: string; game: string; players: number; maxPlayers: number; version: string | null; latencyMs: number }
export interface A2sPlayer { name: string; score: number; seconds: number }

const HEAD = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function request(host: string, port: number, build: (challenge: Buffer | null) => Buffer, expect: number, timeoutMs: number): Promise<{ data: Buffer; ms: number }> {
  return new Promise((resolve, reject) => {
    const sock = createSocket('udp4');
    const started = Date.now();
    let tries = 0;
    const done = (err: Error | null, r?: { data: Buffer; ms: number }) => { clearTimeout(timer); sock.close(); err ? reject(err) : resolve(r!); };
    const timer = setTimeout(() => done(new Error('Keine Antwort auf die Serverabfrage')), timeoutMs);
    sock.on('error', (e) => done(e));
    sock.on('message', (msg) => {
      if (msg.length < 5 || msg.readInt32LE(0) !== -1) return; // geteilte Pakete kommen hier nicht vor
      const type = msg[4];
      if (type === 0x41 && tries++ < 3) { sock.send(build(msg.subarray(5, 9)), port, host); return; }
      if (type === expect) done(null, { data: msg.subarray(5), ms: Date.now() - started });
    });
    sock.send(build(null), port, host);
  });
}

function cstr(buf: Buffer, pos: number): [string, number] {
  const end = buf.indexOf(0, pos);
  const e = end < 0 ? buf.length : end;
  return [buf.toString('utf8', pos, e), e + 1];
}

export async function a2sInfo(host: string, port: number, timeoutMs = 3000): Promise<A2sInfo> {
  const q = Buffer.concat([HEAD, Buffer.from('TSource Engine Query\0', 'latin1')]);
  const { data, ms } = await request(host, port, (c) => (c ? Buffer.concat([q, c]) : q), 0x49, timeoutMs);
  let p = 1; // Protokoll-Byte
  let name: string, map: string, game: string;
  [name, p] = cstr(data, p);
  [map, p] = cstr(data, p);
  [, p] = cstr(data, p); // folder
  [game, p] = cstr(data, p);
  p += 2; // App-Id
  const players = data[p] ?? 0, maxPlayers = data[p + 1] ?? 0;
  p += 2 + 1 + 1 + 1 + 1 + 1; // bots, server type, environment, visibility, vac
  let version: string | null = null;
  if (p < data.length) [version] = cstr(data, p);
  return { name, map, game, players, maxPlayers, version: version || null, latencyMs: ms };
}

export async function a2sPlayers(host: string, port: number, timeoutMs = 3000): Promise<A2sPlayer[]> {
  const base = Buffer.concat([HEAD, Buffer.from('U', 'latin1')]);
  const { data } = await request(host, port, (c) => Buffer.concat([base, c ?? Buffer.from([0xff, 0xff, 0xff, 0xff])]), 0x44, timeoutMs);
  const n = data[0] ?? 0;
  const out: A2sPlayer[] = [];
  let p = 1;
  for (let i = 0; i < n && p < data.length; i++) {
    p += 1; // Index
    let name: string;
    [name, p] = cstr(data, p);
    const score = data.readInt32LE(p); p += 4;
    const seconds = data.readFloatLE(p); p += 4;
    // Verbindende Spieler haben noch keinen Namen - nicht mitzaehlen.
    if (name) out.push({ name, score, seconds: Math.round(seconds) });
  }
  return out;
}
