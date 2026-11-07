import { open, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { config } from '../config.js';

/**
 * Logdatei eines Spiels mitlesen - fuer Spiele, deren eigentliches Log
 * nicht auf der Konsole landet (ARK: ShooterGame.log; dort stehen u. a.
 * alle Meldungen von Epic Online Services).
 *
 * Bewusst per Abfrage statt fs.watch: der Datenordner liegt bei Docker
 * Desktop auf einem Volume, dort kommen Dateiereignisse nicht zuverlaessig
 * an. Einmal pro Sekunde die Groesse pruefen kostet nichts.
 * Wird die Datei beim Neustart des Spiels ersetzt (kleiner, andere Inode),
 * geht es von vorn los.
 */
export function logFilePath(shortId: string, rel: string): string | null {
  const base = resolve(config.VOLUME_ROOT, shortId);
  const full = resolve(base, rel.replace(/^\/+/, ''));
  return full.startsWith(base + sep) ? full : null;
}

/** Die letzten n Zeilen (fuer den Verlauf beim Oeffnen der Konsole). */
export async function tailFile(path: string, n: number, maxBytes = 256 * 1024): Promise<string[]> {
  try {
    const st = await stat(path);
    const fh = await open(path, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.length);
      if (len < st.size) lines.shift(); // erste Zeile ist angeschnitten
      return lines.slice(-n);
    } finally { await fh.close(); }
  } catch { return []; }
}

export function followFile(path: string, onLine: (line: string) => void, opts: { fromStart?: boolean; intervalMs?: number } = {}): () => void {
  let pos = -1;
  let ino = -1;
  let rest = '';
  let stopped = false;
  let busy = false;

  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const st = await stat(path).catch(() => null);
      if (!st) { pos = 0; ino = -1; return; }
      if (pos < 0) pos = opts.fromStart ? 0 : st.size;
      // Datei ersetzt oder gekuerzt: neuer Lauf, von vorn lesen.
      if ((ino !== -1 && st.ino !== ino) || st.size < pos) { pos = 0; rest = ''; }
      ino = st.ino;
      if (st.size === pos) return;
      const fh = await open(path, 'r');
      try {
        const len = Math.min(st.size - pos, 1024 * 1024);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, pos);
        pos += len;
        const text = rest + buf.toString('utf8');
        const parts = text.split(/\r?\n/);
        rest = parts.pop() ?? '';
        for (const p of parts) if (p.length) onLine(p.replace(/^﻿/, ''));
      } finally { await fh.close(); }
    } finally { busy = false; }
  };

  const timer = setInterval(() => void tick(), opts.intervalMs ?? 1000);
  void tick();
  return () => { stopped = true; clearInterval(timer); };
}
