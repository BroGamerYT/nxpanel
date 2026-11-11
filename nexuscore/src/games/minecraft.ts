import { Socket } from 'node:net';

/**
 * Server List Ping: dasselbe, was der Minecraft-Client in der Serverliste macht -
 * Version, Spieler, MOTD, Icon und Antwortzeit. Braucht weder RCON noch Plugins.
 * (Bewusst nachgebaut statt aus dem Panel geteilt: der Core importiert dessen src/ nicht.)
 */
export interface SlpResult {
  version: string | null;
  protocol: number | null;
  players: { online: number; max: number; sample: string[] };
  motd: string;
  favicon: string | null;
  latencyMs: number;
}

function varint(n: number): Buffer {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf: Buffer, pos: number): [number, number] | null {
  let n = 0;
  let shift = 0;
  let i = pos;
  while (i < buf.length) {
    const b = buf[i++]!;
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n >>> 0, i];
    shift += 7;
    if (shift > 35) throw new Error('Ungültige VarInt');
  }
  return null;
}

const frame = (payload: Buffer) => Buffer.concat([varint(payload.length), payload]);

const COLORS: Record<string, string> = {
  black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
  dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f',
};

/** Chat-Komponente (JSON) als §-Zeichenkette, wie sie in server.properties steht. */
export function chatToLegacy(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!c || typeof c !== 'object') return '';
  const o = c as Record<string, unknown>;
  let s = '';
  if (typeof o['color'] === 'string' && COLORS[o['color']]) s += `§${COLORS[o['color']]}`;
  if (typeof o['text'] === 'string') s += o['text'];
  if (Array.isArray(o['extra'])) s += o['extra'].map(chatToLegacy).join('');
  return s;
}

export function serverListPing(host: string, port: number, timeoutMs = 4000): Promise<SlpResult> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let buf = Buffer.alloc(0);
    let status: Omit<SlpResult, 'latencyMs'> | null = null;
    let sentAt = 0;
    let finished = false;
    const done = (err: Error | null, r?: SlpResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(r!);
    };
    const timer = setTimeout(() => done(new Error('Keine Antwort')), timeoutMs);
    sock.on('error', (e) => done(e));
    sock.on('close', () => done(new Error('Verbindung geschlossen')));
    sock.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      sock.write(frame(Buffer.concat([varint(0), varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)])));
      sock.write(frame(varint(0)));
    });
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const len = readVarint(buf, 0);
          if (!len || buf.length < len[1] + len[0]) return;
          const pkt = buf.subarray(len[1], len[1] + len[0]);
          buf = buf.subarray(len[1] + len[0]);
          const id = readVarint(pkt, 0)!;
          if (id[0] === 0 && !status) {
            const sl = readVarint(pkt, id[1])!;
            const json = JSON.parse(pkt.toString('utf8', sl[1], sl[1] + sl[0])) as {
              version?: { name?: string; protocol?: number };
              players?: { online?: number; max?: number; sample?: Array<{ name?: string }> };
              description?: unknown;
              favicon?: string;
            };
            status = {
              version: json.version?.name ?? null,
              protocol: json.version?.protocol ?? null,
              players: {
                online: json.players?.online ?? 0,
                max: json.players?.max ?? 0,
                sample: (json.players?.sample ?? []).map((p) => p.name ?? '').filter(Boolean),
              },
              motd: chatToLegacy(json.description),
              favicon: typeof json.favicon === 'string' && json.favicon.startsWith('data:image/png;base64,') ? json.favicon : null,
            };
            const payload = Buffer.alloc(8);
            payload.writeBigInt64BE(BigInt(Date.now()));
            sentAt = Date.now();
            sock.write(frame(Buffer.concat([varint(1), payload])));
          } else if (id[0] === 1 && status) {
            done(null, { ...status, latencyMs: Date.now() - sentAt });
            return;
          }
        }
      } catch (err) {
        done(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}
