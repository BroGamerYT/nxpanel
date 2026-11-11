import fs from 'node:fs/promises';
import path from 'node:path';
import { downloadFile, sha256OfFile, type FetchLike } from './download.js';
import { ensureJava, type EnsureJavaOptions } from './java.js';
import { PAPER_HOSTS, resolvePaperBuild } from './paper.js';
import { patchProperties, substitute } from './properties.js';

/**
 * Installiert einen Minecraft-Server (Paper) in einen Server-Ordner (Block B2).
 *
 * Ablauf: Version bestimmen -> passendes Java sicherstellen -> Server-Jar
 * laden und pruefen -> eula.txt und server.properties schreiben.
 * Das Ergebnis ist das Startkommando, das der Treiber ausfuehrt.
 */

export interface MinecraftInstallInput {
  /** Ordner der Instanz - liegt im Server-Verzeichnis. */
  serverDir: string;
  /** Ordner fuer Java-Laufzeiten des Cores. */
  runtimesDir: string;
  /** Variablen aus dem Egg, vom Nutzer ueberschrieben. */
  variables: Record<string, string>;
  /** Zuordnung aus dem Egg: Schluessel in server.properties -> Vorlage mit Platzhaltern. */
  propertiesTemplate: Record<string, string>;
  ramMb: number;
  port: number;
  serverName: string;
}

export interface MinecraftInstallResult {
  executable: string;
  args: string[];
  stopCommand: string;
  version: string;
  build: number;
  javaMajor: number;
  javaRelease: string;
}

export interface InstallHooks {
  /** fraction 0..1 ueber die gesamte Installation */
  onProgress?: (fraction: number, message: string) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  /** Nur fuer Tests: ersetzt das Entpacken von Java. */
  extract?: EnsureJavaOptions['extract'];
}

const JAR_NAME = 'server.jar';

/** Schluessel, die der Core selbst regelt - die Konsole laeuft ueber stdin, RCON braucht es nicht. */
const SKIPPED_PROPERTIES = new Set(['enable-rcon', 'rcon.port', 'rcon.password']);

/**
 * Heap fuer die JVM: nicht das volle Limit, die JVM braucht selbst Speicher
 * (Metaspace, Threads, Puffer). Dieselbe Regel wie im Panel (85 %).
 */
export function heapMb(ramMb: number): number {
  return Math.max(512, Math.floor(ramMb * 0.85));
}

export async function installMinecraftPaper(
  input: MinecraftInstallInput,
  hooks: InstallHooks = {},
): Promise<MinecraftInstallResult> {
  const report = hooks.onProgress ?? (() => {});
  const net = {
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
  };

  // Die EULA von Mojang muss der Nutzer selbst annehmen - der Core setzt sie nie von sich aus.
  if ((input.variables.EULA ?? '').trim().toLowerCase() !== 'true') {
    throw new Error('Die Minecraft-EULA wurde nicht akzeptiert (Variable EULA=TRUE setzen).');
  }

  // 1) Version und Build
  report(0.01, 'Suche Paper-Version');
  const build = await resolvePaperBuild(input.variables.VERSION ?? 'LATEST', net);
  report(0.05, `Paper ${build.version} (Build ${build.build}), braucht Java ${build.javaMajor}`);

  // 2) Java
  const java = await ensureJava(build.javaMajor, input.runtimesDir, {
    ...net,
    ...(hooks.extract ? { extract: hooks.extract } : {}),
    onProgress: (fraction, message) => report(0.05 + fraction * 0.45, message),
  });
  report(0.5, java.downloaded ? `Java ${java.release} installiert` : `Java ${java.release} ist schon vorhanden`);

  // 3) Server-Jar - nur laden, wenn nicht schon genau diese Datei da liegt
  await fs.mkdir(input.serverDir, { recursive: true });
  const jar = path.join(input.serverDir, JAR_NAME);
  if ((await sha256OfFile(jar))?.toLowerCase() === build.sha256.toLowerCase()) {
    report(0.95, 'Server-Datei ist schon vorhanden und unveraendert');
  } else {
    await downloadFile(build.url, jar, {
      sha256: build.sha256,
      allowedHosts: PAPER_HOSTS,
      maxBytes: 500 * 1024 * 1024,
      onProgress: (done, total) => {
        const size = total ?? build.size;
        report(
          0.5 + (size > 0 ? Math.min(1, done / size) : 0) * 0.45,
          `Lade Paper: ${(done / 1048576).toFixed(0)} von ${(size / 1048576).toFixed(0)} MB`,
        );
      },
      ...net,
    });
  }

  // 4) Konfiguration
  report(0.96, 'Schreibe Konfiguration');
  await fs.writeFile(
    path.join(input.serverDir, 'eula.txt'),
    '# Vom Nutzer im NexusCore akzeptiert (https://aka.ms/MinecraftEULA)\neula=true\n',
    'utf8',
  );
  await writeServerProperties(input);

  await fs.writeFile(
    path.join(input.serverDir, 'nexuscore-install.json'),
    JSON.stringify(
      {
        type: 'PAPER',
        version: build.version,
        build: build.build,
        sha256: build.sha256,
        javaMajor: java.major,
        javaRelease: java.release,
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf8',
  );

  report(1, `Installation fertig: Paper ${build.version} (Build ${build.build})`);
  return {
    executable: java.executable,
    args: [`-Xmx${heapMb(input.ramMb)}M`, '-Dfile.encoding=UTF-8', '-jar', JAR_NAME, '--nogui'],
    stopCommand: 'stop',
    version: build.version,
    build: build.build,
    javaMajor: java.major,
    javaRelease: java.release,
  };
}

/**
 * Schreibt die Werte aus dem Egg in die server.properties.
 *
 * Wird auch vor jedem Start aufgerufen: Port und Einstellungen koennen sich
 * seit der Installation geaendert haben.
 */
export async function writeServerProperties(
  input: Pick<MinecraftInstallInput, 'serverDir' | 'variables' | 'propertiesTemplate' | 'ramMb' | 'port' | 'serverName'>,
): Promise<void> {
  const context: Record<string, string> = {
    ...input.variables,
    SERVER_PORT: String(input.port),
    SERVER_MEMORY: String(input.ramMb),
    SERVER_MEMORY_HEAP: String(heapMb(input.ramMb)),
    SERVER_NAME: input.serverName,
    SERVER_IP: '0.0.0.0',
  };

  const values: Record<string, string> = {};
  for (const [key, template] of Object.entries(input.propertiesTemplate)) {
    if (SKIPPED_PROPERTIES.has(key)) continue;
    const value = substitute(String(template), context);
    // Leer heisst "nichts eingestellt" - dann gilt der Standard des Spiels.
    if (value !== '') values[key] = value;
  }
  values['server-port'] = String(input.port);
  values['enable-rcon'] = 'false';

  const file = path.join(input.serverDir, 'server.properties');
  let current = '';
  try {
    current = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.writeFile(file, patchProperties(current, values), 'utf8');
}
