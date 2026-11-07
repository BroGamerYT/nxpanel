import { Socket } from 'node:net';

/**
 * Minecraft-Abfragen, die fuer jeden Servertyp funktionieren.
 *
 * Server List Ping: dasselbe, was der Client in der Serverliste macht -
 * Version, Spieler, MOTD, Icon und Antwortzeit. Braucht weder RCON noch
 * Plugins, geht also bei Vanilla, Paper, Fabric, Forge und NeoForge.
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
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return Buffer.from(out);
}
function readVarint(buf: Buffer, pos: number): [number, number] | null {
  let n = 0, shift = 0, i = pos;
  while (i < buf.length) {
    const b = buf[i++]!;
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [n >>> 0, i];
    shift += 7;
    if (shift > 35) throw new Error('Ungueltige VarInt');
  }
  return null;
}
const frame = (payload: Buffer) => Buffer.concat([varint(payload.length), payload]);

/** Chat-Komponente (JSON) in eine §-Zeichenkette, wie sie in server.properties steht. */
export function chatToLegacy(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!c || typeof c !== 'object') return '';
  const o = c as Record<string, unknown>;
  const COLORS: Record<string, string> = { black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7', dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f' };
  let s = '';
  if (typeof o.color === 'string' && COLORS[o.color]) s += `§${COLORS[o.color]}`;
  if (o.bold) s += '§l';
  if (o.italic) s += '§o';
  if (o.underlined) s += '§n';
  if (o.strikethrough) s += '§m';
  if (o.obfuscated) s += '§k';
  if (typeof o.text === 'string') s += o.text;
  if (Array.isArray(o.extra)) s += o.extra.map(chatToLegacy).join('');
  return s;
}

export function serverListPing(host: string, port: number, timeoutMs = 4000): Promise<SlpResult> {
  return new Promise((resolve, reject) => {
    const sock = new Socket();
    let buf = Buffer.alloc(0);
    let status: Omit<SlpResult, 'latencyMs'> | null = null;
    let sentAt = 0;
    const done = (err: Error | null, r?: SlpResult) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(r!); };
    const timer = setTimeout(() => done(new Error('Keine Antwort')), timeoutMs);
    sock.on('error', (e) => done(e));
    sock.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const ph = Buffer.alloc(2); ph.writeUInt16BE(port);
      sock.write(frame(Buffer.concat([varint(0), varint(767), varint(hostBuf.length), hostBuf, ph, varint(1)])));
      sock.write(frame(varint(0)));
    });
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
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
            description?: unknown; favicon?: string;
          };
          status = {
            version: json.version?.name ?? null,
            protocol: json.version?.protocol ?? null,
            players: { online: json.players?.online ?? 0, max: json.players?.max ?? 0, sample: (json.players?.sample ?? []).map((p) => p.name ?? '').filter(Boolean) },
            motd: chatToLegacy(json.description),
            favicon: typeof json.favicon === 'string' && json.favicon.startsWith('data:image/png;base64,') ? json.favicon : null,
          };
          const payload = Buffer.alloc(8); payload.writeBigInt64BE(BigInt(Date.now()));
          sentAt = Date.now();
          sock.write(frame(Buffer.concat([varint(1), payload])));
        } else if (id[0] === 1 && status) {
          done(null, { ...status, latencyMs: Date.now() - sentAt });
          return;
        }
      }
    });
  });
}

export interface TpsResult { tps: number; mspt: number | null; source: string }

const strip = (s: string) => s.replace(/§./g, '');

/**
 * TPS-Antworten der verschiedenen Servertypen deuten:
 *   Paper/Purpur/Spigot:  "TPS from last 1m, 5m, 15m: 20.0, 19.98, 20.0"
 *   spark:                "TPS from last 5s, 10s, 1m, 5m, 15m: 20.0, ..."
 *   NeoForge/Forge:       "Overall: Mean tick time: 0.512 ms. Mean TPS: 20.000"
 *   Vanilla (tick query): "Average time per tick: 0.6ms (Target: 50.0ms)"
 */
export function parseTps(raw: string, source: string): TpsResult | null {
  const s = strip(raw);
  const overall = /Overall:[^\n]*?Mean tick time:\s*([\d.]+)\s*ms[^\n]*?Mean TPS:\s*([\d.]+)/i.exec(s);
  if (overall) return { tps: Math.min(20, Number(overall[2])), mspt: Number(overall[1]), source };
  const list = /TPS from last[^:]*:\s*\*?([\d.]+)/i.exec(s);
  if (list) {
    const mspt = /MSPT[^:]*:[^\n]*?([\d.]+)\s*\/\s*([\d.]+)/i.exec(s); // spark: "min/med/95%ile/max"
    return { tps: Math.min(20, Number(list[1])), mspt: mspt ? Number(mspt[2]) : null, source };
  }
  const tick = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(s);
  if (tick) {
    const target = /Target tick rate:\s*([\d.]+)/i.exec(s);
    const rate = target ? Number(target[1]) : 20;
    const mspt = Number(tick[1]);
    return { tps: Math.round(Math.min(rate, 1000 / Math.max(mspt, 0.001)) * 100) / 100, mspt, source };
  }
  return null;
}

/** Welche Befehle versuchen, in dieser Reihenfolge - abhaengig vom Servertyp. */
export function tpsCommands(type: string | undefined): string[] {
  const t = (type ?? '').toUpperCase();
  if (['PAPER', 'PURPUR', 'SPIGOT', 'FOLIA', 'BUKKIT'].includes(t)) return ['tps', 'spark tps', 'tick query'];
  if (t === 'NEOFORGE') return ['neoforge tps', 'spark tps', 'tick query'];
  if (t === 'FORGE') return ['forge tps', 'neoforge tps', 'spark tps', 'tick query'];
  // Hybride (Mods + Plugins): Bukkit-"tps" zuerst, sonst Forge
  if (t === 'MOHIST' || t === 'ARCLIGHT') return ['tps', 'forge tps', 'neoforge tps', 'spark tps', 'tick query'];
  return ['tick query', 'spark tps', 'tps'];
}
