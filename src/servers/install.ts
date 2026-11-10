import { appendFile, mkdir, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { engine } from '../docker/client.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import { setStatus } from './status.js';
import { sql } from '../db/index.js';
import { substitute } from '../eggs/variables.js';
import { steamDevCfgShell, tuneSteamCmd } from './steam-tuning.js';
import type { ServerRecord } from '../types.js';

/**
 * Installiert die Serverdateien in einem eigenen Container.
 *
 * Das Log wird dabei live mitgeschrieben - in eine Datei und als Ereignisse.
 * Ohne das steht der Nutzer bei einem 8-GB-ARK-Download minutenlang vor einer
 * stummen Oberflaeche und haelt den Server fuer haengengeblieben.
 */

export interface InstallOptions {
  onLog?: (line: string) => void;
  actorId?: string | null | undefined;
}

export async function installServer(server: ServerRecord, opts: InstallOptions = {}): Promise<boolean> {
  const [egg] = await sql<{ install_script: string | null; install_image: string | null; run_as: string | null; shell: string | null }[]>`
    SELECT install_script, install_image, run_as,
           raw_egg->'scripts'->'installation'->>'entrypoint' AS shell FROM eggs WHERE id = ${server.egg_id}
  `;

  if (!egg?.install_script) {
    log.info({ server: server.name }, 'Egg hat kein Installationsskript');
    await setStatus(server.id, 'offline', { reason: 'Keine Installation noetig' });
    return true;
  }

  const image = egg.install_image ?? server.docker_image;
  const logPath = join(config.VOLUME_ROOT, server.short_id, '.panel', 'install.log');
  await mkdir(dirname(logPath), { recursive: true }).catch(() => {});

  await writeEvent({
    serverId: server.id,
    kind: 'install_start',
    summary: `Installation gestartet (${image})`,
    code: 'install_start',
    params: { image },
    logFile: 'install.log',
  });

  let lineCount = 0;
  const ringBuffer: string[] = [];
  const onLine = (line: string) => {
    lineCount++;
    opts.onLog?.(line);
    ringBuffer.push(line);
    if (ringBuffer.length > 50) ringBuffer.shift();
    void appendFile(logPath, `${line}\n`, 'utf8').catch(() => {});
  };

  const allocs = await sql<{ port: number; ref: string | null; is_primary: boolean }[]>`
    SELECT port, ref, is_primary FROM allocations WHERE server_id = ${server.id}
  `;
  const primaryPort = (allocs.find((a) => a.is_primary) ?? allocs[0])?.port ?? 0;
  const portsMap = Object.fromEntries(allocs.filter((a) => a.ref).map((a) => [a.ref!, a.port]));
  const subCtx = {
    variables: server.variables,
    ramMb: server.ram_mb,
    ip: '0.0.0.0',
    port: primaryPort,
    ports: portsMap,
    serverDir: '/mnt/server',
    serverName: server.name,
  };
  const resolvedVars = Object.fromEntries(
    Object.entries(server.variables).map(([k, v]) => [k, typeof v === 'string' && v.includes('{{') ? substitute(v, subCtx) : v]),
  );

  const env: Record<string, string> = {
    ...resolvedVars,
    SERVER_MEMORY: String(server.ram_mb),
    SERVER_IP: '0.0.0.0',
    SERVER_PORT: String(primaryPort),
    SERVER_NAME: server.name,
    SERVER_SHORT_ID: server.short_id,
  };

  // Am Ende (auch bei vorzeitigem "exit", darum als trap):
  // - steam_dev.cfg fuer schnellere SteamCMD-Updates beim Serverstart
  // - laeuft der Server spaeter als normaler Benutzer (run_as), bekommt er die
  //   Dateien, die der Installer als root angelegt hat.
  let body = substitute(egg.install_script.replace(/\r\n?/g, '\n'), subCtx);
  const onExit: string[] = [];
  if (config.STEAMCMD_FAST_DOWNLOAD) {
    const tuned = tuneSteamCmd(body);
    body = tuned.script;
    if (tuned.calls > 0 || /steamcmd/i.test(body)) onExit.push(steamDevCfgShell());
  }
  if (egg.run_as) onExit.push(`chown -R ${egg.run_as} /mnt/server 2>/dev/null || true`);
  const handOver = onExit.length ? `nxp_on_exit() {\n${onExit.map((l) => `  ${l}`).join('\n')}\n}\ntrap nxp_on_exit EXIT\n` : '';
  const shell = /(?:^|\/)ash$/.test((egg.shell ?? '').trim()) ? 'ash' : 'bash';
  const script = handOver + body;

  // Freien Speicher vorab pruefen: SteamCMD meldet volle Platten nur
  // kryptisch ("state is 0x202"), Spiele brechen mitten im Download ab.
  await warnIfLowDisk(server.disk_mb, onLine);

  const started = Date.now();
  let exitCode: number;

  try {
    exitCode = await engine.runInstaller({ shortId: server.short_id, image, script, env, shell }, onLine);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, server: server.name }, 'Installation abgebrochen');
    await setStatus(server.id, 'install_failed', { reason: message.slice(0, 160) });
    await writeEvent({
      serverId: server.id,
      kind: 'install_failed',
      severity: 'error',
      summary: `Installation abgebrochen: ${message.slice(0, 160)}`,
      code: 'install_failed',
      params: { error: message.slice(0, 160) },
      logFile: 'install.log',
    });
    return false;
  }

  const seconds = Math.round((Date.now() - started) / 1000);

  if (exitCode !== 0) {
    await setStatus(server.id, 'install_failed', { reason: `Installationsskript endete mit ${exitCode}` });
    await writeEvent({
      serverId: server.id,
      kind: 'install_failed',
      severity: 'error',
      summary: `Installation fehlgeschlagen (Code ${exitCode}, ${lineCount} Logzeilen)`,
      code: 'install_failed_code',
      params: { exitCode, lines: lineCount },
      payload: { exitCode, seconds, lines: lineCount, lastLines: ringBuffer },
      logFile: 'install.log',
    });
    return false;
  }

  await sql`UPDATE servers SET installed_at = now() WHERE id = ${server.id}`;
  await setStatus(server.id, 'offline', { reason: 'Installation abgeschlossen', actorId: opts.actorId });
  await writeEvent({
    serverId: server.id,
    kind: 'install_done',
    summary: `Installation abgeschlossen in ${seconds} s`,
    code: 'install_done',
    params: { seconds },
    payload: { seconds, lines: lineCount, lastLines: ringBuffer },
    logFile: 'install.log',
  });

  log.info({ server: server.name, seconds }, 'Installation abgeschlossen');
  return true;
}

/** Schreibt eine Warnung ins Installationsprotokoll, wenn auf dem Datentraeger weniger frei ist als zugeteilt. */
export async function warnIfLowDisk(diskMb: number, onLine: (line: string) => void, root = config.VOLUME_ROOT): Promise<number | null> {
  try {
    const st = await statfs(root);
    const freeMb = Math.floor((Number(st.bavail) * Number(st.bsize)) / (1024 * 1024));
    if (diskMb > 0 && freeMb < diskMb) {
      onLine(`[NexusPanel] WARNUNG: Nur ${(freeMb / 1024).toFixed(1)} GB frei auf dem Datentraeger, zugeteilt sind ${(diskMb / 1024).toFixed(1)} GB. Die Installation kann wegen voller Platte abbrechen.`);
    }
    return freeMb;
  } catch {
    return null;
  }
}
