import { filterCapabilities, sanitizeDataPath } from '../eggs/capabilities.js';
import type { LoadedEgg } from '../eggs/loader.js';
import { substitute, type SubstitutionContext } from '../eggs/substitute.js';
import type { ContainerSpec, ServerInstanceConfig, ServerPort } from '../types.js';

/**
 * Aus einem Egg wird die Konfiguration eines Docker-Servers - dieselben Regeln wie im Panel:
 * Image nach Auswahl, Startkommando und Variablen mit Platzhaltern, nur erlaubte Linux-Rechte,
 * interne Ports (RCON) werden nicht am Host freigegeben.
 */

/** Leere optionale Modpack-Variablen duerfen dem Container nicht uebergeben werden (itzg liest "" als aktuellen Ordner). */
const OMIT_IF_EMPTY = new Set(['CF_MODPACK_ZIP', 'CF_API_KEY', 'CF_SLUG', 'CF_FILE_ID', 'MODRINTH_MODPACK', 'MODRINTH_VERSION', 'FTB_MODPACK_ID', 'FTB_MODPACK_VERSION_ID']);

export class EggContainerError extends Error {}

interface RawPorts {
  primary?: { ref?: string; protocol?: string };
  secondary?: Array<{ ref?: string; protocol?: string; internal?: boolean }>;
}

export interface DockerInstanceInput {
  id: string;
  name: string;
  egg: LoadedEgg;
  serverDir: string;
  ramMb: number;
  cpuPercent: number;
  /** Variablen: Vorgaben des Eggs plus Eingaben. */
  variables: Record<string, string>;
  /** Schon vergebene Host-Ports (erster = Spielport), in der Reihenfolge Hauptport, dann weitere. */
  ports: ServerPort[];
  imageKey?: string | undefined;
  timezone?: string;
}

/** "disk" (Standard) oder { size_mb }: /tmp im Arbeitsspeicher, 64 bis 4096 MB. */
export function tmpfsFromEgg(raw: unknown): number | undefined {
  if (raw && typeof raw === 'object' && typeof (raw as { size_mb?: unknown }).size_mb === 'number') {
    return Math.min(4096, Math.max(64, Math.round((raw as { size_mb: number }).size_mb)));
  }
  return undefined;
}

/**
 * Umgebung des Containers: Variablen mit aufgeloesten Platzhaltern (leere optionale Modpack-Variablen weg)
 * plus Zeitzone, Speicher, Spielport und Startkommando. Wird beim Anlegen und bei jeder Aenderung der
 * Einstellungen gebraucht.
 */
export function dockerEnv(
  egg: LoadedEgg,
  variables: Record<string, string>,
  at: { name: string; ramMb: number; port: number; refPorts: Record<string, number>; serverDir: string; timezone?: string },
): Record<string, string> {
  const ctx: SubstitutionContext = { variables, ramMb: at.ramMb, ip: '0.0.0.0', port: at.port, ports: at.refPorts, serverDir: at.serverDir, serverName: at.name };
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    const v = substitute(value ?? '', ctx);
    if (OMIT_IF_EMPTY.has(key) && !v.trim()) continue;
    env[key] = v;
  }
  Object.assign(env, {
    TZ: at.timezone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
    SERVER_MEMORY: String(at.ramMb),
    SERVER_PORT: String(at.port),
    STARTUP: substitute(egg.raw.startup ?? '', ctx),
  });
  return env;
}

export function buildDockerInstance(input: DockerInstanceInput): ServerInstanceConfig {
  const { egg } = input;
  const image = input.imageKey ? egg.images.find((i) => i.key === input.imageKey) : (egg.images.find((i) => i.default) ?? egg.images[0]);
  if (!image) throw new EggContainerError(input.imageKey ? 'Dieses Image gibt es für das Spiel nicht.' : 'Dieses Spiel hat kein Docker-Image.');

  const spec = (egg.raw.ports ?? {}) as RawPorts;
  const refs = [spec.primary, ...(spec.secondary ?? [])];
  const internal = new Set<string>();
  const hostPorts: Record<string, number> = {};
  const ports: ServerPort[] = [];
  input.ports.forEach((p, i) => {
    const rawSpec = refs[i];
    const ref = p.name;
    hostPorts[ref] = p.hostPort;
    if ((rawSpec as { internal?: boolean } | undefined)?.internal) {
      internal.add(ref);
      return; // RCON und Ähnliches bleiben im Container
    }
    // "both": TCP und UDP, sonst blieben UDP-Spiele von außen stumm
    const protocols: Array<'tcp' | 'udp'> = rawSpec?.protocol === 'both' ? ['tcp', 'udp'] : [p.protocol];
    for (const protocol of protocols) ports.push({ name: ref, hostPort: p.hostPort, containerPort: p.hostPort, protocol });
  });
  const primary = input.ports[0]?.hostPort ?? 0;

  const env = dockerEnv(egg, input.variables, { name: input.name, ramMb: input.ramMb, port: primary, refPorts: hostPorts, serverDir: input.serverDir, ...(input.timezone ? { timezone: input.timezone } : {}) });

  const caps = filterCapabilities(egg.raw.capabilities).granted;
  const stop = egg.raw.stop;
  const entrypoint = egg.raw.entrypoint;
  const tmpfs = tmpfsFromEgg(egg.raw.tmp);
  const configFiles = egg.raw.config_files;
  const container: ContainerSpec = {
    image: image.image,
    refPorts: hostPorts,
    ...(configFiles && Object.keys(configFiles).length
      ? {
          configFiles: Object.fromEntries(
            Object.entries(configFiles)
              .filter((e): e is [string, { parser: string; find?: Record<string, unknown> }] => typeof e[1]?.parser === 'string')
              .map(([file, spec]) => [file, { parser: spec.parser, ...(spec.find ? { find: spec.find } : {}) }]),
          ),
        }
      : {}),
    dataDir: sanitizeDataPath(egg.raw.data_dir),
    ...(caps.length ? { capAdd: caps } : {}),
    ...(egg.raw.run_as && /^\d+:\d+$/.test(egg.raw.run_as) ? { user: egg.raw.run_as } : {}),
    ...(Array.isArray(entrypoint) && entrypoint.every((x) => typeof x === 'string') && entrypoint.length ? { entrypoint } : {}),
    ...(tmpfs ? { tmpfsMb: tmpfs } : {}),
    ...(stop && typeof stop === 'object' && typeof stop.method === 'string' && /^SIG[A-Z0-9]{2,10}$/.test(stop.method) ? { stopSignal: stop.method } : {}),
  };

  return {
    id: input.id,
    name: input.name,
    game: egg.id,
    executable: image.image,
    args: [],
    workingDir: input.serverDir,
    maxMemoryMb: input.ramMb,
    maxCpuPercent: input.cpuPercent,
    ports,
    env,
    ...(typeof stop === 'string' && stop.trim() ? { stopCommand: stop.trim() } : {}),
    ...(stop && typeof stop === 'object' && typeof stop.timeout_seconds === 'number' ? { stopTimeoutSeconds: Math.min(600, Math.max(5, Math.round(stop.timeout_seconds))) } : {}),
    container,
  };
}
