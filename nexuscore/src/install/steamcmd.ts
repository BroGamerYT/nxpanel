import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZip } from '../files/archive.js';
import { logger } from '../logger.js';
import { downloadFile, type FetchLike } from './download.js';

/**
 * SteamCMD besorgen und ein Spiel damit laden (Block B2, Teil 2).
 *
 * SteamCMD laedt der Core selbst von Valve (nur dieser Host, nur HTTPS) nach
 * `<runtimes>/steamcmd` und startet es nur von dort. Das Spiel selbst laedt
 * SteamCMD - die Dateien prueft Valve.
 *
 * **Keine feste Pruefsumme fuer steamcmd.zip:** Valve veroeffentlicht keine,
 * die Datei wird ohne Ankuendigung ersetzt (SteamCMD aktualisiert sich danach
 * ohnehin selbst). Der Core merkt sich die erhaltene SHA-256 im Marker und im
 * Protokoll und erzwingt sie, wenn `NEXUSCORE_STEAMCMD_SHA256` gesetzt ist.
 */

export const STEAMCMD_URL = 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip';
export const STEAMCMD_HOSTS = ['steamcdn-a.akamaihd.net'] as const;

export interface SteamCmdHooks {
  onProgress?: (fraction: number, message: string) => void;
  /** Jede Ausgabezeile von SteamCMD (fuer die Konsole der Instanz). */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/** Ersetzbar fuer Tests: startet SteamCMD mit Argumenten und liefert Ausgabe zeilenweise. */
export type SteamRunner = (exe: string, args: string[], hooks: { onLine: (line: string) => void; signal?: AbortSignal }) => Promise<number>;

export const defaultRunner: SteamRunner = (exe, args, hooks) =>
  new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let carry = '';
    // SteamCMD ueberschreibt Fortschrittszeilen mit "\r" - beides als Zeilenende behandeln
    const feed = (chunk: Buffer) => {
      carry += chunk.toString('utf8');
      const parts = carry.split(/\r\n|\r|\n/);
      carry = parts.pop() ?? '';
      for (const line of parts) if (line.trim()) hooks.onLine(line.trim());
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (carry.trim()) hooks.onLine(carry.trim());
      resolve(code ?? -1);
    });
    hooks.signal?.addEventListener('abort', () => proc.kill(), { once: true });
  });

export interface EnsureSteamCmdOptions extends SteamCmdHooks {
  runtimesDir: string;
  platform?: NodeJS.Platform;
  /** Nur fuer Tests. */
  runner?: SteamRunner;
  expectedSha256?: string | undefined;
}

interface Marker {
  sha256: string;
  installedAt: string;
}

/** @returns Pfad zu steamcmd.exe */
export async function ensureSteamCmd(options: EnsureSteamCmdOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') {
    throw new Error('SteamCMD wird derzeit nur unter Windows automatisch eingerichtet.');
  }
  const report = options.onProgress ?? (() => {});
  const dir = path.join(options.runtimesDir, 'steamcmd');
  const exe = path.join(dir, 'steamcmd.exe');
  const markerFile = path.join(dir, 'nexuscore.json');

  try {
    await fs.access(exe);
    JSON.parse(await fs.readFile(markerFile, 'utf8'));
    return exe; // schon eingerichtet und einmal gestartet
  } catch {
    /* einrichten */
  }

  await fs.mkdir(dir, { recursive: true });
  const archive = path.join(options.runtimesDir, `.download-${crypto.randomBytes(4).toString('hex')}-steamcmd.zip`);
  try {
    report(0.01, 'Lade SteamCMD');
    const expected = options.expectedSha256 ?? process.env['NEXUSCORE_STEAMCMD_SHA256'];
    const { sha256 } = await downloadFile(STEAMCMD_URL, archive, {
      sha256: expected ?? null,
      allowUnpinned: true,
      allowedHosts: STEAMCMD_HOSTS,
      maxBytes: 20 * 1024 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    logger.info({ sha256, pinned: Boolean(expected) }, 'steamcmd.zip geladen');

    report(0.03, 'Entpacke SteamCMD');
    const result = await extractZip(archive, dir);
    if (result.skipped > 0) logger.warn({ skipped: result.skipped }, 'Einträge in steamcmd.zip übersprungen');
    await fs.access(exe).catch(() => {
      throw new Error('Im SteamCMD-Paket wurde steamcmd.exe nicht gefunden.');
    });

    // Der erste Start laedt SteamCMD selbst nach (rund 60 MB) und endet mitunter mit Code 7 -
    // dann einmal wiederholen. Erst danach ist es benutzbar.
    const run = options.runner ?? defaultRunner;
    report(0.05, 'SteamCMD aktualisiert sich');
    let code = -1;
    for (let attempt = 0; attempt < 3; attempt++) {
      code = await run(exe, ['+quit'], {
        onLine: (line) => options.onLine?.(line),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (code === 0) break;
    }
    if (code !== 0) throw new Error(`SteamCMD konnte sich nicht einrichten (Code ${code}).`);

    const marker: Marker = { sha256, installedAt: new Date().toISOString() };
    await fs.writeFile(markerFile, JSON.stringify(marker, null, 2), 'utf8');
    report(0.08, 'SteamCMD bereit');
    return exe;
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------------ Spiel laden

export interface SteamAppOptions extends SteamCmdHooks {
  exe: string;
  installDir: string;
  appId: number;
  /** Beta-Zweig, z. B. "public" oder "experimental". */
  branch?: string | undefined;
  runner?: SteamRunner;
  /** Anteil der Gesamt-Fortschrittsleiste, den das Laden belegt. */
  range?: [number, number];
  /** Wie oft SteamCMD bei den bekannten Zufallsfehlern erneut versucht wird. */
  retries?: number;
  /** Abstand, in dem der Fortschritt aus dem Manifest gelesen wird (Tests: klein). */
  pollMs?: number;
}

/** Zeilen wie "Update state (0x61) downloading, progress: 45.56 (123 / 456)". */
const PROGRESS = /Update state \(0x([0-9a-f]+)\)\s+([a-z ]+?),\s+progress:\s+([\d.]+)/i;
const SUCCESS = /Success! App '(\d+)' fully installed/i;
const FAILURE = /ERROR! Failed to install app '(\d+)' \(([^)]*)\)/i;

/** Fehler, die sich nicht durch Wiederholen beheben - Platte voll, keine Berechtigung fuer anonyme Downloads. */
const PERMANENT = /no subscription|disk write failure|not enough disk space|invalid platform|no match/i;

export interface SteamAppResult {
  buildId: string | null;
}

export async function installSteamApp(options: SteamAppOptions): Promise<SteamAppResult> {
  if (!Number.isInteger(options.appId) || options.appId <= 0) throw new Error('Ungültige Steam-App-ID.');
  const run = options.runner ?? defaultRunner;
  const [from, to] = options.range ?? [0.1, 0.95];
  const report = options.onProgress ?? (() => {});
  // Das Zielverzeichnis kommt aus dem Core (unter dem Server-Verzeichnis); SteamCMD-Befehle trennt ein Leerzeichen,
  // darum keine Anfuehrungszeichen-Tricks zulassen.
  if (/["\r\n]/.test(options.installDir)) throw new Error('Ungültiger Installationsordner.');
  await fs.mkdir(options.installDir, { recursive: true });

  const args = [
    '+force_install_dir',
    options.installDir,
    '+login',
    'anonymous',
    '+app_update',
    String(options.appId),
    ...(options.branch && options.branch !== 'public' ? ['-beta', options.branch] : []),
    'validate',
    '+quit',
  ];

  // SteamCMD schreibt seine Fortschrittszeilen bei umgeleiteter Ausgabe oft erst am Ende.
  // Das Manifest neben dem Spiel (BytesToDownload/BytesDownloaded) ist waehrend des Ladens aktuell.
  const manifest = path.join(options.installDir, 'steamapps', `appmanifest_${options.appId}.acf`);
  let best = 0;
  const emit = (fraction: number, message: string): void => {
    if (fraction < best) return; // nie rueckwaerts
    best = fraction;
    report(from + (to - from) * fraction, message);
  };
  const poll = setInterval(() => {
    void fs
      .readFile(manifest, 'utf8')
      .then((text) => {
        const total = Number(/"BytesToDownload"\s+"(\d+)"/i.exec(text)?.[1] ?? 0);
        const done = Number(/"BytesDownloaded"\s+"(\d+)"/i.exec(text)?.[1] ?? 0);
        if (total > 0) {
          const pct = Math.min(100, (done / total) * 100);
          emit((pct / 100) * 0.9, `Lade Spieldateien: ${Math.floor(pct)} % (${Math.round(done / 1048576)} von ${Math.round(total / 1048576)} MB)`);
        }
      })
      .catch(() => {});
  }, options.pollMs ?? 2000);
  poll.unref();

  const attempts = 1 + Math.max(0, options.retries ?? 2);
  let lastError = '';
  try {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let success = false;
    let failure = '';
    const code = await run(options.exe, args, {
      onLine: (line) => {
        options.onLine?.(line);
        const p = PROGRESS.exec(line);
        if (p) {
          const state = p[2]!.trim();
          const pct = Math.min(100, Number(p[3]));
          // Laden und Pruefen laufen nacheinander; beides zusammen fuellt den Bereich
          const verifying = /verif/i.test(state);
          const fraction = verifying ? 0.9 + pct / 1000 : (pct / 100) * 0.9;
          emit(fraction, `${verifying ? 'Prüfe' : 'Lade'} Spieldateien: ${Math.floor(pct)} %`);
        }
        if (SUCCESS.test(line)) success = true;
        const f = FAILURE.exec(line);
        if (f) failure = f[2] ?? 'unbekannt';
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (success) {
      report(to, 'Spieldateien installiert');
      return { buildId: await readBuildId(options.installDir, options.appId) };
    }
    lastError = failure || `SteamCMD endete mit Code ${code} ohne Erfolgsmeldung`;
    if (PERMANENT.test(lastError) || options.signal?.aborted) break;
    logger.warn({ attempt, lastError }, 'SteamCMD-Versuch fehlgeschlagen');
    if (attempt < attempts) report(from, `SteamCMD-Versuch ${attempt} fehlgeschlagen, wiederhole`);
  }
  } finally {
    clearInterval(poll);
  }
  throw new Error(`Steam-Installation fehlgeschlagen: ${lastError}`);
}

/** Die Build-Nummer steht im Manifest, das SteamCMD neben das Spiel legt. */
export async function readBuildId(installDir: string, appId: number): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(installDir, 'steamapps', `appmanifest_${appId}.acf`), 'utf8');
    return /"buildid"\s+"(\d+)"/i.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}
