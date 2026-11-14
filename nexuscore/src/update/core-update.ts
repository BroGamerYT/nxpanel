import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Fetcher } from '../http/covers.js';
import { platformFor, type PlatformInfo } from '../platform/index.js';
import { CORE_VERSION } from '../version.js';

/**
 * Update des Cores von GitHub: neueste Version abfragen und - unter Windows - den Installer (MSI) laden und still einspielen.
 *
 * Sicherheit: Die Adresse des Installers kommt aus der GitHub-Antwort und muss auf `github.com/<Repository>/releases/download/` zeigen.
 * Der Installer wird nur gestartet, wenn seine SHA-256-Pruefsumme mit der von GitHub genannten uebereinstimmt; ohne Pruefsumme wird
 * nicht installiert. Gestartet wird nur auf Anfrage eines Administrators (siehe Route).
 */

export type FetchLike = Fetcher;

export const RELEASE_TAG = /^core-v(\d+\.\d+\.\d+)$/;
export const ASSET_NAME = 'NexusCore-Setup.msi';
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const CACHE_MS = 15 * 60_000;
const TASK_NAME = 'NexusCoreUpdate';

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  notes: string;
  publishedAt: string | null;
  url: string;
  asset: { name: string; url: string; size: number; sha256: string | null } | null;
}

export type UpdateState = 'idle' | 'downloading' | 'installing' | 'failed';

export interface UpdateStatus {
  current: string;
  platform: PlatformInfo['id'];
  /** Kann dieser Core sich selbst aktualisieren? */
  supported: boolean;
  /** Warum nicht (fuer die Anzeige). */
  reason: string | null;
  latest: ReleaseInfo | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  /** Fehler bei der Abfrage von GitHub (der Core laeuft trotzdem). */
  error: string | null;
  state: UpdateState;
  message: string | null;
  /** Fortschritt des laufenden Updates (null, wenn keins laeuft). */
  progress: UpdateProgress | null;
}

export type UpdatePhase = 'check' | 'download' | 'verify' | 'backup' | 'install';

export interface UpdateProgress {
  phase: UpdatePhase;
  /** 0-100, nur beim Download bekannt. */
  percent: number | null;
  bytes: number;
  total: number;
  startedAt: string;
  /** Seit wann der Installer laeuft (der Core ist dann kurz weg). */
  installStartedAt: string | null;
  version: string | null;
}

export interface UpdateLogLine { ts: string; text: string }

/** Liest die letzten Zeilen einer Textdatei (auch UTF-16 vom Windows Installer). */
export async function tailFile(file: string, lines: number): Promise<string[]> {
  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return [];
  }
  let text: string;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.subarray(2).toString('utf16le');
  else if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) text = buf.subarray(3).toString('utf8');
  else text = buf.toString('utf8');
  const all = text.split(/\r?\n/).filter((l) => l.length > 0);
  return all.slice(-lines);
}

export class UpdateError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'update_error') {
    super(message);
  }
}

/** -1, 0 oder 1 wie bei Array.sort. Nur Zahlen mit Punkten (x.y.z). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

interface GhAsset { name?: string; browser_download_url?: string; size?: number; digest?: string | null }
interface GhRelease { tag_name?: string; name?: string; body?: string; draft?: boolean; published_at?: string | null; html_url?: string; assets?: GhAsset[] }

/** Das neueste Core-Release (Tag `core-vX.Y.Z`, kein Entwurf) aus der Liste von GitHub. */
export function latestRelease(list: unknown, repo: string): ReleaseInfo | null {
  if (!Array.isArray(list)) return null;
  let best: ReleaseInfo | null = null;
  for (const raw of list as GhRelease[]) {
    if (!raw || raw.draft) continue;
    const m = RELEASE_TAG.exec(String(raw.tag_name ?? ''));
    if (!m) continue;
    const version = m[1]!;
    if (best && compareVersions(version, best.version) <= 0) continue;
    const a = (raw.assets ?? []).find((x) => x.name === ASSET_NAME);
    const prefix = `https://github.com/${repo}/releases/download/`;
    const digest = typeof a?.digest === 'string' && /^sha256:[0-9a-f]{64}$/i.test(a.digest) ? a.digest.slice(7).toLowerCase() : null;
    best = {
      version,
      tag: raw.tag_name!,
      name: raw.name || raw.tag_name!,
      notes: String(raw.body ?? '').slice(0, 4000),
      publishedAt: raw.published_at ?? null,
      url: raw.html_url ?? `https://github.com/${repo}/releases`,
      asset: a?.browser_download_url?.startsWith(prefix)
        ? { name: a.name!, url: a.browser_download_url, size: Number(a.size ?? 0), sha256: digest }
        : null,
    };
  }
  return best;
}

export interface UpdateRunner {
  /** Startet den Installer unabhaengig vom Core (der dabei beendet wird). */
  launch(msiPath: string, logPath: string, dir: string): Promise<void>;
}

/** Windows: ein einmaliger Aufgabenplaner-Eintrag als SYSTEM - er ueberlebt das Beenden des Dienstes, das der Installer ausloest. */
export const windowsRunner: UpdateRunner = {
  async launch(msiPath, logPath, dir) {
    const script = path.join(dir, 'apply-update.cmd');
    const text = ['@echo off', `msiexec.exe /i "${msiPath}" /qn /norestart /l*v "${logPath}"`, `schtasks.exe /Delete /TN ${TASK_NAME} /F`, ''].join('\r\n');
    await writeFile(script, text, 'utf8');
    const run = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile('schtasks.exe', args, { windowsHide: true }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve()));
      });
    await run(['/Create', '/TN', TASK_NAME, '/SC', 'ONCE', '/ST', '23:59', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/F', '/TR', script]);
    await run(['/Run', '/TN', TASK_NAME]);
  },
};

export interface CoreUpdaterOptions {
  /** `Besitzer/Repository` auf GitHub. */
  repo: string;
  /** Ordner fuer heruntergeladene Installer. */
  dir: string;
  fetchImpl?: FetchLike;
  platform?: PlatformInfo['id'];
  /** Pfad der laufenden Programmdatei (zeigt, ob der Core aus dem Installer laeuft). */
  execPath?: string;
  runner?: UpdateRunner;
  currentVersion?: string;
  audit?: (action: string, detail: Record<string, unknown>) => void;
  /** false: gar nicht bei GitHub nachfragen. */
  enabled?: boolean;
  /** Wird vor dem Start des Installers aufgerufen (Sicherung des Cores); schlaegt sie fehl, wird nicht aktualisiert. */
  beforeInstall?: () => Promise<void>;
}

export class CoreUpdater {
  private readonly f: FetchLike;
  private readonly platform: PlatformInfo['id'];
  private readonly execPath: string;
  private readonly runner: UpdateRunner;
  private readonly current: string;
  private cache: { at: number; release: ReleaseInfo | null; error: string | null } | null = null;
  private state: UpdateState = 'idle';
  private message: string | null = null;
  private progress: UpdateProgress | null = null;
  private readonly lines: UpdateLogLine[] = [];

  constructor(private readonly o: CoreUpdaterOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.platform = o.platform ?? platformFor().id;
    this.execPath = o.execPath ?? process.execPath;
    this.runner = o.runner ?? windowsRunner;
    this.current = o.currentVersion ?? CORE_VERSION;
  }

  /** Windows und aus dem Installer (nexuscore.exe neben nxsvc.exe) - nur dort ersetzt ein MSI die laufende Version. */
  support(): { supported: boolean; reason: string | null } {
    if (this.o.enabled === false) return { supported: false, reason: 'Die Update-Abfrage ist abgeschaltet (NEXUSCORE_UPDATE_CHECK=0).' };
    if (this.platform !== 'windows') return { supported: false, reason: 'Das Update per Knopf gibt es bisher nur unter Windows. Auf Linux den neuen Stand von Hand einspielen.' };
    const dir = path.dirname(this.execPath);
    if (path.basename(this.execPath).toLowerCase() !== 'nexuscore.exe' || !existsSync(path.join(dir, 'nxsvc.exe'))) {
      return { supported: false, reason: 'Dieser Core läuft nicht aus dem Windows-Installer (kein Dienst). Das Update gilt nur für installierte Versionen.' };
    }
    return { supported: true, reason: null };
  }

  async status(refresh = false): Promise<UpdateStatus> {
    const { supported, reason } = this.support();
    if (this.o.enabled !== false && (refresh || !this.cache || Date.now() - this.cache.at > CACHE_MS)) {
      try {
        const res = await this.f(`https://api.github.com/repos/${this.o.repo}/releases?per_page=30`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`GitHub antwortet ${res.status}`);
        this.cache = { at: Date.now(), release: latestRelease(await res.json(), this.o.repo), error: null };
      } catch (err) {
        this.cache = { at: Date.now(), release: this.cache?.release ?? null, error: err instanceof Error ? err.message : String(err) };
      }
    }
    const latest = this.cache?.release ?? null;
    return {
      current: this.current,
      platform: this.platform,
      supported,
      reason,
      latest,
      updateAvailable: !!latest && compareVersions(latest.version, this.current) > 0,
      checkedAt: this.cache ? new Date(this.cache.at).toISOString() : null,
      error: this.cache?.error ?? null,
      state: this.state,
      message: this.message,
      progress: this.progress,
    };
  }

  private log(text: string): void {
    const ts = new Date().toISOString();
    this.lines.push({ ts, text });
    if (this.lines.length > 500) this.lines.shift();
    void mkdir(this.o.dir, { recursive: true })
      .then(() => appendFile(path.join(this.o.dir, 'update.log'), `${ts} ${text}\n`))
      .catch(() => undefined);
  }

  private step(phase: UpdatePhase, message: string, extra: Partial<UpdateProgress> = {}): void {
    this.message = message;
    this.progress = { ...(this.progress ?? { phase, percent: null, bytes: 0, total: 0, startedAt: new Date().toISOString(), installStartedAt: null, version: null }), phase, ...extra };
    this.log(message);
  }

  /** Protokoll des Updates: das Update selbst (auch nach dem Neustart aus der Datei), das Installer-Protokoll der neuesten Version. */
  async logs(source: 'update' | 'installer', lines = 300): Promise<string[]> {
    if (source === 'update') {
      // Im Speicher steht alles seit dem Start; nach einem Neustart (Speicher leer) kommt es aus der Datei
      if (this.lines.length) return this.lines.slice(-lines).map((l) => `${l.ts} ${l.text}`);
      return tailFile(path.join(this.o.dir, 'update.log'), lines);
    }

    let names: string[] = [];
    try {
      names = (await readdir(this.o.dir)).filter((n) => /^install-\d+\.\d+\.\d+\.log$/.test(n));
    } catch {
      return [];
    }
    names.sort((a, b) => compareVersions(a.slice(8, -4), b.slice(8, -4)));
    const last = names.at(-1);
    return last ? [`# ${last}`, ...(await tailFile(path.join(this.o.dir, last), lines))] : [];
  }

  /** Laedt den neuesten Installer, prueft die Pruefsumme und startet ihn. Kehrt zurueck, sobald der Installer laeuft (der Core wird dabei neu gestartet). */
  async install(): Promise<{ version: string }> {
    if (this.state === 'downloading' || this.state === 'installing') throw new UpdateError('Ein Update läuft bereits.', 409, 'conflict');
    const { supported, reason } = this.support();
    if (!supported) throw new UpdateError(reason ?? 'Update nicht möglich.', 409, 'not_supported');
    // Sofort belegen: ein zweiter Aufruf waehrend der Abfrage von GitHub darf nicht auch loslaufen
    this.state = 'downloading';
    this.progress = null;
    this.step('check', 'Prüfe die neueste Version …');
    let latest: ReleaseInfo | null;
    let asset: NonNullable<ReleaseInfo['asset']>;
    try {
      const st = await this.status(true);
      latest = st.latest;
      if (!latest || !st.updateAvailable) throw new UpdateError('Es gibt keine neuere Version.', 409, 'no_update');
      if (!latest.asset) throw new UpdateError(`Im Release ${latest.tag} fehlt ${ASSET_NAME}.`, 409, 'no_asset');
      if (!latest.asset.sha256) throw new UpdateError('GitHub nennt keine Prüfsumme für den Installer - ohne sie wird nicht installiert.', 409, 'no_checksum');
      asset = latest.asset;
    } catch (err) {
      this.state = 'idle';
      this.message = null;
      this.progress = null;
      this.log(`Abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    this.step('download', `Lade ${ASSET_NAME} ${latest.version} …`, { version: latest.version, total: asset.size, percent: 0 });
    const file = path.join(this.o.dir, `NexusCore-${latest.version}.msi`);
    try {
      await mkdir(this.o.dir, { recursive: true });
      const res = await this.f(asset.url, { signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`Download: GitHub antwortet ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > MAX_DOWNLOAD_BYTES) throw new Error('Der Installer ist unerwartet groß.');
      const hash = createHash('sha256');
      let size = 0;
      const body = Readable.fromWeb(res.body as never);
      body.on('data', (chunk: Buffer) => {
        size += chunk.length;
        const total = asset.size || declared;
        if (this.progress) { this.progress.bytes = size; if (total) this.progress.percent = Math.min(100, Math.round((size / total) * 100)); }
        if (size > MAX_DOWNLOAD_BYTES) body.destroy(new Error('Der Installer ist unerwartet groß.'));
        hash.update(chunk);
      });
      await pipeline(body, createWriteStream(file));
      this.step('verify', 'Prüfe die Prüfsumme …', { percent: 100 });
      const digest = hash.digest('hex');
      if (digest !== asset.sha256) throw new Error('Die Prüfsumme des Installers stimmt nicht - er wird nicht installiert.');

      this.log('Prüfsumme stimmt.');
      this.step('backup', 'Sichere den Core vor dem Update …', { percent: null });
      try {
        await this.o.beforeInstall?.();
      } catch (err) {
        throw new Error(`Sicherung vor dem Update fehlgeschlagen - es wird nicht aktualisiert: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.log('Sicherung fertig.');
      this.state = 'installing';
      this.step('install', `Installiere Version ${latest.version} - der Core startet gleich neu.`, { installStartedAt: new Date().toISOString() });
      this.o.audit?.('core.update', { from: this.current, to: latest.version, sha256: digest });
      await this.runner.launch(file, path.join(this.o.dir, `install-${latest.version}.log`), this.o.dir);
      this.log('Installer gestartet (Aufgabenplaner, SYSTEM). Der Core wird beendet und neu gestartet.');
      return { version: latest.version };
    } catch (err) {
      await rm(file, { force: true }).catch(() => undefined);
      this.state = 'failed';
      this.message = err instanceof Error ? err.message : String(err);
      this.progress = null;
      this.log(`Fehler: ${this.message}`);
      throw new UpdateError(this.message, 502, 'update_failed');
    }
  }
}
