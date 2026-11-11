import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { downloadFile, fetchJson, type FetchLike } from './download.js';

const execFileAsync = promisify(execFile);

/**
 * Java-Laufzeiten, die der Core selbst verwaltet (Block B2).
 *
 * Java liegt unter `<Datenverzeichnis>/runtimes/java-<version>` und wird vom
 * Core geladen und gestartet. Ueber die Schnittstelle kommt nie ein Pfad zu
 * einem Programm - so bleibt die Pfadgrenze aus Block A3 dicht, und der
 * Nutzer muss Java nicht von Hand installieren.
 *
 * Quelle: Eclipse Temurin (Adoptium), mit SHA-256 aus deren Schnittstelle.
 */

const ADOPTIUM_HOSTS = ['api.adoptium.net', 'github.com'] as const;

interface AdoptiumAsset {
  release_name: string;
  binary: { package: { name: string; link: string; checksum: string; size: number } };
}

interface RuntimeMarker {
  major: number;
  release: string;
  /** Pfad zu java(.exe), relativ zum Laufzeit-Ordner. */
  executable: string;
  installedAt: string;
}

export interface JavaRuntime {
  major: number;
  release: string;
  /** Absoluter Pfad zu java(.exe). */
  executable: string;
  /** true, wenn in diesem Aufruf geladen wurde. */
  downloaded: boolean;
}

export interface EnsureJavaOptions {
  onProgress?: (fraction: number, message: string) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Nur fuer Tests: ersetzt das Entpacken. */
  extract?: (archive: string, destDir: string) => Promise<void>;
  platform?: NodeJS.Platform;
  arch?: string;
}

function adoptiumTarget(platform: NodeJS.Platform, arch: string): { os: string; architecture: string } {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'mac' : platform === 'linux' ? 'linux' : null;
  const architecture = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'aarch64' : null;
  if (!os || !architecture) {
    throw new Error(`Fuer ${platform}/${arch} gibt es keine automatische Java-Installation.`);
  }
  return { os, architecture };
}

/**
 * Entpackt ein Archiv mit dem tar des Systems.
 *
 * Unter Windows ist das bsdtar aus System32 - es kann auch .zip. Bewusst mit
 * vollem Pfad, damit kein anderes tar aus dem PATH (z. B. von Git) greift,
 * das .zip nicht versteht.
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const tar =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
  await execFileAsync(tar, ['-xf', archive, '-C', destDir], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

/** Sucht bin/java(.exe) im Ordner selbst oder eine Ebene darunter (Temurin packt in `jdk-…-jre/`). */
async function findJavaExecutable(dir: string, platform: NodeJS.Platform): Promise<string | null> {
  const name = platform === 'win32' ? 'java.exe' : 'java';
  const candidates = [path.join(dir, 'bin', name)];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    candidates.push(path.join(dir, entry.name, 'bin', name));
    // macOS: jdk-…-jre/Contents/Home/bin/java
    candidates.push(path.join(dir, entry.name, 'Contents', 'Home', 'bin', name));
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* naechster */
    }
  }
  return null;
}

async function readMarker(dir: string): Promise<RuntimeMarker | null> {
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, 'runtime.json'), 'utf8')) as RuntimeMarker;
    await fs.access(path.join(dir, marker.executable));
    return marker;
  } catch {
    return null;
  }
}

/** Laufende Installationen je Ordner - zwei Server zur selben Zeit laden Java nur einmal. */
const inFlight = new Map<string, Promise<JavaRuntime>>();

/**
 * Stellt sicher, dass Java in der gewuenschten Hauptversion vorhanden ist,
 * und liefert den Pfad zu java(.exe).
 */
export function ensureJava(major: number, runtimesDir: string, options: EnsureJavaOptions = {}): Promise<JavaRuntime> {
  if (!Number.isInteger(major) || major < 8 || major > 99) {
    return Promise.reject(new Error(`Ungueltige Java-Version: ${major}`));
  }
  const dir = path.resolve(runtimesDir, `java-${major}`);
  const running = inFlight.get(dir);
  if (running) return running;

  const job = installJava(major, dir, options).finally(() => inFlight.delete(dir));
  inFlight.set(dir, job);
  return job;
}

async function installJava(major: number, dir: string, options: EnsureJavaOptions): Promise<JavaRuntime> {
  const platform = options.platform ?? process.platform;
  const existing = await readMarker(dir);
  if (existing) {
    return { major, release: existing.release, executable: path.join(dir, existing.executable), downloaded: false };
  }

  const report = options.onProgress ?? (() => {});
  const { os, architecture } = adoptiumTarget(platform, options.arch ?? process.arch);
  report(0, `Suche Java ${major} (Temurin)`);

  const assets = await fetchJson<AdoptiumAsset[]>(
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?os=${os}&architecture=${architecture}&image_type=jre`,
    {
      allowedHosts: ADOPTIUM_HOSTS,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
  );
  const asset = assets[0];
  if (!asset) throw new Error(`Temurin bietet kein Java ${major} fuer ${os}/${architecture} an.`);
  const pkg = asset.binary.package;

  const parent = path.dirname(dir);
  await fs.mkdir(parent, { recursive: true });
  // Der Dateiname kommt von aussen - nur der letzte Teil, ohne Pfadanteile.
  const archive = path.join(parent, `.download-${crypto.randomBytes(4).toString('hex')}-${path.basename(pkg.name)}`);
  const staging = `${dir}.tmp-${crypto.randomBytes(4).toString('hex')}`;

  try {
    await downloadFile(pkg.link, archive, {
      sha256: pkg.checksum,
      allowedHosts: ADOPTIUM_HOSTS,
      maxBytes: 600 * 1024 * 1024,
      onProgress: (done, total) => {
        const size = total ?? pkg.size;
        report(size > 0 ? Math.min(0.9, (done / size) * 0.9) : 0, `Lade Java ${major}: ${mb(done)} von ${mb(size)} MB`);
      },
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });

    report(0.92, `Entpacke Java ${major}`);
    await (options.extract ?? extractArchive)(archive, staging);

    const executable = await findJavaExecutable(staging, platform);
    if (!executable) throw new Error('Im Java-Paket wurde kein bin/java gefunden.');

    const marker: RuntimeMarker = {
      major,
      release: asset.release_name,
      executable: path.relative(staging, executable),
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(staging, 'runtime.json'), JSON.stringify(marker, null, 2), 'utf8');

    await fs.rm(dir, { recursive: true, force: true });
    await fs.rename(staging, dir);
    report(1, `Java ${major} bereit (${asset.release_name})`);
    return { major, release: asset.release_name, executable: path.join(dir, marker.executable), downloaded: true };
  } finally {
    await fs.rm(archive, { force: true }).catch(() => {});
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(0);
}
