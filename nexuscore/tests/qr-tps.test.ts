import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { qrMatrix, qrSvg, qrDataUrl, QrTooLongError } = await import('../src/store/qr.js');
const { parseTps, parseMspt, parseTickQuery, plainLine, TpsReader } = await import('../src/players/tps.js');
const { EventBus } = await import('../src/protocol/events.js');

describe('QR-Code', () => {
  it('hat die richtige Größe je Version und die drei Suchmuster', () => {
    const small = qrMatrix('A');
    expect(small).toHaveLength(21); // Version 1
    const m = qrMatrix('otpauth://totp/NexusCore:admin?secret=JBSWY3DPEHPK3PXP&issuer=NexusCore');
    expect(m.length).toBe(m[0]!.length);
    expect((m.length - 17) % 4).toBe(0);
    const n = m.length;
    // Suchmuster: 7x7-Rahmen, heller Ring, dunkler 3x3-Kern - links oben, rechts oben, links unten
    for (const [ox, oy] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const edge = x === 0 || x === 6 || y === 0 || y === 6;
          const core = x >= 2 && x <= 4 && y >= 2 && y <= 4;
          expect(m[oy + y]![ox + x], `Suchmuster ${ox},${oy} bei ${x},${y}`).toBe(edge || core);
        }
      }
    }
    // Zeitmuster und das feste dunkle Modul
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0);
      expect(m[i]![6]).toBe(i % 2 === 0);
    }
    expect(m[n - 8]![8]).toBe(true);
  });

  it('ist bei gleicher Eingabe immer gleich, bei anderer anders', () => {
    expect(qrMatrix('abc')).toEqual(qrMatrix('abc'));
    expect(qrMatrix('abc')).not.toEqual(qrMatrix('abd'));
  });

  it('lehnt zu lange Texte ab, statt einen kaputten Code zu liefern', () => {
    expect(() => qrMatrix('x'.repeat(300))).toThrow(QrTooLongError);
    expect(() => qrMatrix('x'.repeat(214))).toThrow(QrTooLongError); // Platz für Kopf fehlt
    expect(qrMatrix('x'.repeat(213)).length).toBe(57); // Version 10, genau voll
  });

  it('SVG und data:-Adresse', () => {
    const svg = qrSvg('hallo');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 29 29"'); // 21 + 2 x 4 Ruhezone
    const url = qrDataUrl('hallo');
    expect(url.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(Buffer.from(url.split(',')[1]!, 'base64').toString('utf8')).toBe(svg);
    // Keine Skripte, keine fremden Adressen im Bild
    expect(svg.replace('xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/<script|href=|<image|http:/i);
  });

  const hasCv = spawnSync('python', ['-c', 'import cv2'], { windowsHide: true }).status === 0;

  it.skipIf(!hasCv)('ein echter Decoder (OpenCV) liest jeden Code richtig zurück - alle Versionen 1 bis 10', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-qr-'));
    try {
      const texts = [
        'A',
        'HELLO WORLD',
        'otpauth://totp/NexusCore:admin?secret=JBSWY3DPEHPK3PXP&issuer=NexusCore',
        'otpauth://totp/NexusCore:ein-langer-name:admin?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=NexusCore&algorithm=SHA1&digits=6&period=30',
        'Grüße ÄÖÜ ß € – Umlaute',
        ...[10, 17, 32, 53, 78, 106, 134, 154, 192, 213].map((n) => `${n}:`.padEnd(n, 'q')),
      ];
      texts.forEach((text, i) => {
        const m = qrMatrix(text);
        const scale = 8;
        const border = 4;
        const n = (m.length + border * 2) * scale;
        const rows: string[] = [];
        for (let y = 0; y < n; y++) {
          const row: string[] = [];
          for (let x = 0; x < n; x++) {
            const mx = Math.floor(x / scale) - border;
            const my = Math.floor(y / scale) - border;
            row.push(mx >= 0 && my >= 0 && mx < m.length && my < m.length && m[my]![mx] ? '1' : '0');
          }
          rows.push(row.join(' '));
        }
        fs.writeFileSync(path.join(dir, `q${i}.pbm`), `P1\n${n} ${n}\n${rows.join('\n')}\n`);
        fs.writeFileSync(path.join(dir, `q${i}.json`), JSON.stringify(text), 'utf8');
      });
      // Der robuste Decoder (Aruco) muss JEDEN Code lesen. Der einfache von OpenCV hat bekannte Schwächen bei sehr
      // dichten Codes (ab etwa 180 Bytes); bei Längen, wie sie die Einrichtung braucht (bis 140 Bytes), muss auch er bestehen.
      const script = [
        'import sys, json, glob, cv2',
        'bad_aruco = []; bad_std = []',
        'files = sorted(glob.glob(sys.argv[1] + "/q*.pbm"), key=lambda s: int(s.rsplit("q", 1)[1].split(".")[0]))',
        'for f in files:',
        '    want = json.load(open(f[:-4] + ".json", encoding="utf8"))',
        '    img = cv2.imread(f, cv2.IMREAD_GRAYSCALE)',
        '    def read(det):',
        '        for v in (img, 255 - img):',
        '            data, _, _ = det.detectAndDecode(v)',
        '            if data: return data',
        '        return ""',
        '    if read(cv2.QRCodeDetectorAruco()) != want: bad_aruco.append(want[:12])',
        '    if len(want.encode("utf8")) <= 140 and read(cv2.QRCodeDetector()) != want: bad_std.append(want[:12])',
        'print("BAD", len(bad_aruco), len(bad_std), "OF", len(files), bad_aruco, bad_std)',
        'sys.exit(1 if bad_aruco or bad_std else 0)',
      ].join('\n');
      const r = spawnSync('python', ['-c', script, dir], { windowsHide: true, encoding: 'utf8' });
      expect(r.stdout.trim(), r.stderr).toMatch(/^BAD 0 0 OF 15 /);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('TPS-Zeilen lesen', () => {
  it('Paper: TPS der letzten Minute, mit Farbcodes und Sternchen', () => {
    expect(parseTps('TPS from last 1m, 5m, 15m: 20.0, 20.0, 19.98')).toBe(20);
    expect(parseTps('[12:00:01 INFO]: §6TPS from last 1m, 5m, 15m: §a18.4§r, §a19.2§r, §a19.9')).toBe(18.4);
    expect(parseTps('TPS from last 1m, 5m, 15m: *20.0, *20.0, *20.0')).toBe(20);
    expect(parseTps('TPS from last 1m, 5m, 15m: 21.7, 20.0, 20.0')).toBe(20); // gekappt
    expect(parseTps('\u001b[33mTPS from last 1m, 5m, 15m: 12.5, 19.0, 20.0\u001b[m')).toBe(12.5);
    expect(parseTps('Steve joined the game')).toBeNull();
    expect(parseTps('')).toBeNull();
  });

  it('Paper: Tickzeit der letzten 5 Sekunden', () => {
    expect(parseMspt('Server tick times (avg/min/max) from last 5s, 10s, 1m: ◴ 1.4/0.9/6.3, ◴ 1.5/0.9/12.2, ◴ 1.6/0.8/40.1')).toBe(1.4);
    expect(parseMspt('Server tick times (avg/min/max) from last 5s, 10s, 1m: 2.0/1.0/3.0, 1/1/1, 1/1/1')).toBe(2);
    expect(parseMspt('irgendwas')).toBeNull();
  });

  it('Vanilla: tick query', () => {
    expect(parseTickQuery('Average time per tick: 3.4ms (Target: 50.0ms)')).toBe(3.4);
    expect(parseTickQuery('Average tick time: 52.5 ms (Target: 50.0ms)')).toBe(52.5);
    expect(parseTickQuery('The game is running normally')).toBeNull();
  });

  it('entfernt Farbcodes', () => {
    expect(plainLine('§aGrün §r normal')).toBe('Grün  normal');
  });
});

describe('TpsReader', () => {
  const setup = (reply: (command: string, emit: (line: string) => void) => void, opts: { timeoutMs?: number; ttlMs?: number } = {}) => {
    const bus = new EventBus();
    const commands: string[] = [];
    let clock = 1_000_000;
    const driver = {
      sendCommand: async (id: string, command: string) => {
        commands.push(`${id}:${command}`);
        reply(command, (line) => bus.emit({ type: 'console', serverId: id, line, stream: 'stdout', ts: new Date().toISOString() }));
      },
    };
    const reader = new TpsReader({ driver: driver as never, bus, timeoutMs: opts.timeoutMs ?? 300, ttlMs: opts.ttlMs ?? 60_000, now: () => clock });
    return { reader, commands, bus, advance: (ms: number) => (clock += ms) };
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('Paper: fragt tps und mspt, liefert den Wert aus der Konsole', async () => {
    const { reader, commands } = setup((cmd, emit) => {
      if (cmd === 'tps') emit('TPS from last 1m, 5m, 15m: 19.5, 20.0, 20.0');
      if (cmd === 'mspt') emit('Server tick times (avg/min/max) from last 5s, 10s, 1m: ◴ 2.5/1.0/9.0, ◴ 2.0/1.0/9.0, ◴ 2.0/1.0/9.0');
    });
    const r = await reader.refresh('s1', 'paper');
    expect(r).toEqual({ tps: 19.5, mspt: 2.5, source: 'Paper (tps)' });
    expect(commands).toEqual(['s1:tps', 's1:mspt']);
  });

  it('Vanilla: tick query, TPS aus der Tickzeit', async () => {
    const { reader } = setup((cmd, emit) => {
      if (cmd === 'tick query') emit('Average time per tick: 100.0ms (Target: 50.0ms)');
    });
    expect(await reader.refresh('s1', 'vanilla')).toEqual({ tps: 10, mspt: 100, source: 'Vanilla (tick query)' });
  });

  it('keine Antwort: ein Fehler, kein Hängenbleiben - und Zeilen anderer Server zählen nicht', async () => {
    const { reader, bus } = setup(() => {}, { timeoutMs: 200 });
    const pending = reader.refresh('s1', 'paper');
    bus.emit({ type: 'console', serverId: 'anderer', line: 'TPS from last 1m, 5m, 15m: 1.0, 1.0, 1.0', stream: 'stdout', ts: '' });
    const r = await pending;
    expect(r).toMatchObject({ error: expect.stringContaining('Keine Antwort') });
  });

  it('get() antwortet sofort, fragt im Hintergrund und höchstens einmal je Intervall', async () => {
    const { reader, commands, advance } = setup((cmd, emit) => {
      if (cmd === 'tps') emit('TPS from last 1m, 5m, 15m: 17.0, 18.0, 19.0');
    });
    expect(reader.get('s1', 'paper')).toBeNull(); // noch nichts bekannt
    await wait(700);
    expect(reader.get('s1', 'paper')).toMatchObject({ tps: 17 });
    const asked = commands.length;
    // Innerhalb des Intervalls keine neue Abfrage
    reader.get('s1', 'paper');
    reader.get('s1', 'paper');
    await wait(100);
    expect(commands.length).toBe(asked);
    // Nach dem Intervall wieder
    advance(61_000);
    reader.get('s1', 'paper');
    await wait(700);
    expect(commands.length).toBeGreaterThan(asked);
    // Eine laufende Abfrage wird nicht doppelt gestellt
    advance(61_000);
    reader.get('s1', 'paper');
    reader.get('s1', 'paper');
    reader.get('s1', 'paper');
    await wait(700);
    expect(commands.filter((c) => c.endsWith(':tps')).length).toBe(3);
  });

  it('ohne Konsolen-Treiber ein Fehler', async () => {
    const reader = new TpsReader({ driver: {} as never, bus: new EventBus() });
    expect(await reader.refresh('s1', 'paper')).toMatchObject({ error: expect.stringContaining('Konsolenbefehle') });
  });
});
