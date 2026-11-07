import yauzl from 'yauzl';
import { gunzipSync } from 'node:zlib';
import { matchEntry, type ImportRule } from './importer.js';

/**
 * Ein Backup ansehen, bevor es einen Server gibt: Welches Spiel ist das,
 * welche Version, wie hiess der Server?
 *
 * Auch hier kennt das Panel kein Spiel. Jedes Egg beschreibt unter
 * import.detect, woran man es erkennt (markers) und wo seine Einstellungen
 * stehen (vars). Die Analyse liest dafuer nur das Inhaltsverzeichnis des
 * Zips und die paar kleinen Dateien, die ein Egg nennt - auch bei einem
 * 15-GB-ARK-Backup dauert das Sekunden.
 */

export type VarSource =
  | { var: string; from: 'ini'; file: string; section: string; key: string }
  | { var: string; from: 'json'; file: string; key: string }
  | { var: string; from: 'properties'; file: string; key: string }
  | { var: string; from: 'nbt'; file: string; key: string }
  | { var: string; from: 'filename'; pattern: string }
  | { var: string; from: 'dir_child'; path: string }
  | { var: string; from: 'exists'; cases: Array<{ path: string; value: string }>; fallback?: string }
  | { var: string; from: 'set'; value: string };

export interface DetectSpec {
  /** Pfadstuecke, die nur dieses Spiel hat (z. B. "tsserver.sqlitedb"). */
  markers?: string[];
  vars?: Array<VarSource & { map?: Record<string, string>; label?: string }>;
}

export interface EggForDetect {
  id: string;
  name: string;
  rules: ImportRule[];
  detect: DetectSpec | null;
}

export interface DetectedVar {
  env: string;
  value: string;
  /** Woher der Wert stammt: Dateiname/Pfad, oder ein Code mit @ (@preset, @filename, @assumed), den die Oberflaeche uebersetzt. */
  source: string;
  /** Mehrere moegliche Werte gefunden: Nutzer soll waehlen. */
  options?: string[];
}

export interface Candidate {
  eggId: string;
  name: string;
  score: number;
  markers: string[];
  matched: string[];
  variables: DetectedVar[];
  warnings: string[];
  /** Bytes, die der Import tatsaechlich uebernehmen wuerde. */
  importBytes: number;
}

export interface Analysis {
  entries: number;
  totalBytes: number;
  candidates: Candidate[];
  /** Eindeutig erkannt - die Oberflaeche darf das Spiel vorauswaehlen. */
  confident: boolean;
}

const MAX_READ = 4 * 1024 * 1024;
const SKIP = ['.trash', 'Backups', '__MACOSX'];

function segs(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
}

/** Liegt das Pfadstueck "needle" irgendwo im Pfad? Liefert die Position dahinter. */
function findSeq(path: string[], needle: string[]): number {
  for (let i = 0; i + needle.length <= path.length; i++) {
    if (needle.every((x, j) => path[i + j] === x)) return i + needle.length;
  }
  return -1;
}

function fileSpecs(eggs: EggForDetect[]): string[] {
  const out = new Set<string>();
  for (const e of eggs) for (const v of e.detect?.vars ?? []) if ('file' in v) out.add(v.file);
  return [...out];
}

interface Entry { name: string; segs: string[]; dir: boolean; size: number }

export async function analyzeArchive(path: string, eggs: EggForDetect[]): Promise<Analysis> {
  const wanted = fileSpecs(eggs).map((f) => ({ spec: f, s: segs(f) }));
  const entries: Entry[] = [];
  // Je gesuchter Datei der flachste Treffer: bei AMP liegen manchmal Kopien
  // in Unterordnern, die eigentliche Datei ist die weiter oben.
  const contents = new Map<string, { depth: number; data: Buffer }>();
  let totalBytes = 0;

  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (err, z) => (err || !z ? rej(err ?? new Error('Archiv nicht lesbar')) : res(z))));

  await new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const s = segs(entry.fileName);
        const dir = entry.fileName.endsWith('/');
        if (s.some((x) => SKIP.includes(x))) { zip.readEntry(); return; }
        entries.push({ name: entry.fileName, segs: s, dir, size: entry.uncompressedSize });
        totalBytes += entry.uncompressedSize;
        if (!dir && entry.uncompressedSize <= MAX_READ) {
          const hit = wanted.find((w) => s.length >= w.s.length && w.s.every((x, j) => s[s.length - w.s.length + j] === x));
          const prev = hit ? contents.get(hit.spec) : undefined;
          if (hit && (!prev || prev.depth > s.length)) {
            const data = await new Promise<Buffer>((res, rej) => zip.openReadStream(entry, (err, st) => {
              if (err || !st) return rej(err ?? new Error('Eintrag nicht lesbar'));
              const chunks: Buffer[] = [];
              st.on('data', (c: Buffer) => chunks.push(c));
              st.on('end', () => res(Buffer.concat(chunks)));
              st.on('error', rej);
            }));
            contents.set(hit.spec, { depth: s.length, data });
          }
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });

  const candidates: Candidate[] = [];
  for (const egg of eggs) {
    if (!egg.rules.length) continue;
    const markers = (egg.detect?.markers ?? []).filter((m) => entries.some((e) => findSeq(e.segs, segs(m)) >= 0));
    const matched = new Set<string>();
    let importBytes = 0;
    for (const e of entries) {
      if (e.dir) continue;
      const hit = matchEntry(e.name, egg.rules);
      if (hit) { matched.add(hit.rule.match); importBytes += e.size; }
    }
    if (!markers.length && !matched.size) continue;

    const variables: DetectedVar[] = [];
    const warnings: string[] = [];
    for (const v of egg.detect?.vars ?? []) {
      // Mehrere Quellen fuer dieselbe Variable: die erste, die etwas findet, gewinnt.
      if (variables.some((x) => x.env === v.var)) continue;
      try {
        const got = extract(v, entries, contents);
        if (!got) continue;
        const value = v.map?.[got.value] ?? got.value;
        variables.push({ env: v.var, value, source: got.source, ...(got.options ? { options: got.options.map((o) => v.map?.[o] ?? o) } : {}) });
      } catch (err) {
        warnings.push(`${v.var}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Marker zaehlen doppelt: "world" haben viele Spiele, "tsserver.sqlitedb" nur eines.
    const score = markers.length * 3 + matched.size;
    candidates.push({ eggId: egg.id, name: egg.name, score, markers, matched: [...matched], variables, warnings, importBytes });
  }
  candidates.sort((a, b) => b.score - a.score);

  const [top, second] = candidates;
  const confident = !!top && top.markers.length > 0 && (!second || second.score * 2 <= top.score);
  return { entries: entries.length, totalBytes, candidates, confident };
}

type Contents = Map<string, { depth: number; data: Buffer }>;

function extract(v: VarSource, entries: Entry[], contents: Contents): { value: string; source: string; options?: string[] } | null {
  switch (v.from) {
    case 'set':
      return { value: v.value, source: '@preset' };
    case 'ini': {
      const text = contents.get(v.file)?.data.toString('utf8');
      if (text === undefined) return null;
      const val = readIni(text, v.section, v.key);
      return val === null ? null : { value: val, source: basename(v.file) };
    }
    case 'properties': {
      const text = contents.get(v.file)?.data.toString('utf8');
      if (text === undefined) return null;
      const val = readProperties(text, v.key);
      return val === null ? null : { value: val, source: basename(v.file) };
    }
    case 'json': {
      const text = contents.get(v.file)?.data.toString('utf8');
      if (text === undefined) return null;
      const val = dig(JSON.parse(stripBom(text)), v.key);
      return val === undefined || val === null || typeof val === 'object' ? null : { value: String(val), source: basename(v.file) };
    }
    case 'nbt': {
      const data = contents.get(v.file)?.data;
      if (!data) return null;
      const val = dig(readNbt(data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data) : data), v.key);
      return val === undefined || val === null || typeof val === 'object' ? null : { value: String(val), source: basename(v.file) };
    }
    case 'filename': {
      const re = new RegExp(v.pattern);
      const found = new Set<string>();
      for (const e of entries) {
        if (e.dir) continue;
        const m = re.exec(e.segs[e.segs.length - 1] ?? '');
        if (m?.[1]) found.add(m[1]);
      }
      if (!found.size) return null;
      const list = [...found].sort(compareVersions).reverse();
      return { value: list[0]!, source: '@filename', ...(list.length > 1 ? { options: list } : {}) };
    }
    case 'dir_child': {
      const needle = segs(v.path);
      const kids = new Map<string, number>();
      for (const e of entries) {
        const at = findSeq(e.segs, needle);
        // Nur echte Unterordner: dahinter muss noch etwas kommen.
        if (at >= 0 && e.segs.length > at + 1) kids.set(e.segs[at]!, (kids.get(e.segs[at]!) ?? 0) + e.size);
      }
      if (!kids.size) return null;
      // Der Ordner mit den meisten Daten ist vermutlich der benutzte.
      const list = [...kids.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
      return { value: list[0]!, source: v.path, ...(list.length > 1 ? { options: list } : {}) };
    }
    case 'exists': {
      for (const c of v.cases) {
        const needle = segs(c.path);
        if (entries.some((e) => findSeq(e.segs, needle) >= 0)) return { value: c.value, source: c.path };
      }
      return v.fallback !== undefined ? { value: v.fallback, source: '@assumed' } : null;
    }
  }
}

function basename(p: string) { return segs(p).pop() ?? p; }
function stripBom(s: string) { return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s; }

function dig(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** Abschnitte koennen Punkte enthalten ("/Script/Engine.GameSession") - daher getrennt angegeben. */
export function readIni(text: string, section: string, key: string): string | null {
  let current = '';
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { current = sec[1]!; continue; }
    if (current.toLowerCase() !== section.toLowerCase()) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim().toLowerCase() === key.toLowerCase()) return line.slice(eq + 1).trim();
  }
  return null;
}

export function readProperties(text: string, key: string): string | null {
  for (const raw of stripBom(text).split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^([^=:\s]+)\s*[=:]\s?(.*)$/.exec(line);
    if (m && m[1] === key) {
      return m[2]!.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, '$1');
    }
  }
  return null;
}

/** Versionen absteigend sinnvoll sortieren: 1.21.10 > 1.21.9, 26.3 > 1.21. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-_]/), pb = b.split(/[.\-_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? '';
    const nx = Number(x), ny = Number(y);
    const d = !Number.isNaN(nx) && !Number.isNaN(ny) && x !== '' && y !== '' ? nx - ny : x.localeCompare(y);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Minimaler NBT-Leser (Minecraft level.dat): genug, um Data.Version.Name zu
 * finden. Listen und Arrays werden gelesen, aber Byte-/Int-/Long-Arrays
 * nicht in Objekte verwandelt, um bei grossen Dateien nichts aufzublaehen.
 */
export function readNbt(buf: Buffer): Record<string, unknown> {
  let o = 0;
  const u16 = () => { const v = buf.readUInt16BE(o); o += 2; return v; };
  const i32 = () => { const v = buf.readInt32BE(o); o += 4; return v; };
  const str = () => { const n = u16(); const s = buf.toString('utf8', o, o + n); o += n; return s; };
  const payload = (t: number): unknown => {
    switch (t) {
      case 1: { const v = buf.readInt8(o); o += 1; return v; }
      case 2: { const v = buf.readInt16BE(o); o += 2; return v; }
      case 3: return i32();
      case 4: { const v = buf.readBigInt64BE(o); o += 8; return v.toString(); }
      case 5: { const v = buf.readFloatBE(o); o += 4; return v; }
      case 6: { const v = buf.readDoubleBE(o); o += 8; return v; }
      case 7: { const n = i32(); o += n; return null; }
      case 8: return str();
      case 9: { const et = buf.readUInt8(o); o += 1; const n = i32(); const out: unknown[] = []; for (let i = 0; i < n; i++) out.push(payload(et)); return out; }
      case 10: {
        const out: Record<string, unknown> = {};
        for (;;) {
          const tt = buf.readUInt8(o); o += 1;
          if (tt === 0) return out;
          const name = str();
          out[name] = payload(tt);
        }
      }
      case 11: { const n = i32(); o += n * 4; return null; }
      case 12: { const n = i32(); o += n * 8; return null; }
      default: throw new Error(`NBT: unbekannter Typ ${t}`);
    }
  };
  const root = buf.readUInt8(o); o += 1;
  if (root !== 10) throw new Error('keine NBT-Datei');
  str();
  return payload(10) as Record<string, unknown>;
}
