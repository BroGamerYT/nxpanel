import { engine } from '../docker/client.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import { setStatus, getStatus } from './status.js';
import { findServer, listPorts } from './repo.js';
import { sql } from '../db/index.js';
import { parseReadyCheck, matchesDone, waitForPort } from '../eggs/ready.js';
import { existsSync } from 'node:fs';
import { applyConfigFiles, ensureRuntimeCurrent } from './create.js';
import { followFile, logFilePath } from './logfile.js';
import { diskCollector } from './stats.js';
import { stopWakeProxy } from './wake-proxy.js';
import { notifyServerStatus } from '../notifications/discord.js';
import type { ConfigFileSpec } from '../eggs/config-files.js';
import type { ServerRecord } from '../types.js';

/** Server, deren Stopp das Panel selbst ausgeloest hat - fuer die Absturzerkennung. */
const expectedStops = new Set<string>();

export interface ActorContext {
  actorId?: string | null | undefined;
}

export async function startServer(serverId: string, ctx: ActorContext = {}): Promise<void> {
  stopWakeProxy(serverId);
  let server = await requireServer(serverId);

  // Container passt nicht mehr zum Egg (z. B. /tmp zu klein fuer Proton)? Erst neu anlegen.
  if (server.container_id && !server.suspended && await ensureRuntimeCurrent(serverId, ctx.actorId ?? null).catch((err: unknown) => {
    log.warn({ err, serverId }, 'Container-Abgleich fehlgeschlagen');
    return false;
  })) server = await requireServer(serverId);

  if (server.suspended) throw new Error('Server ist gesperrt');

  // Speicher-Limit: Docker kann es bei Ordnern nicht erzwingen, also das
  // Panel. Ueber dem Limit startet der Server nicht - sonst fuellt ein
  // einzelner Server irgendwann die ganze Platte der VM.
  const used = diskCollector.serverMb().get(serverId);
  if (used !== undefined && server.disk_mb > 0 && used > server.disk_mb) {
    const msg = `Speicher-Limit überschritten: ${Math.round(used / 102.4) / 10} GB belegt, ${Math.round(server.disk_mb / 102.4) / 10} GB zugeteilt. Platz schaffen (Dateien, alte Backups) oder in den Einstellungen mehr Speicher zuteilen.`;
    await writeEvent({ serverId, kind: 'start_failed', severity: 'error', actorId: ctx.actorId ?? null, summary: msg, payload: { usedMb: used, limitMb: server.disk_mb } });
    throw new Error(msg);
  }
  if (!server.container_id) throw new Error('Kein Container vorhanden - erst installieren');

  // Konfiguration vor JEDEM Start schreiben: Port und IP koennen sich seit
  // dem letzten Mal geaendert haben, etwa nach einem Umzug.
  await writeConfigBeforeStart(server);

  // Aeltere Container stecken noch im Docker-Standardnetz - nachziehen.
  await engine.joinGameNetwork(server.container_id).catch(() => {});

  await setStatus(serverId, 'starting', { reason: 'angefordert', actorId: ctx.actorId });

  try {
    await engine.start(server.container_id);
  } catch (err) {
    // Wichtig: Scheitert der Start, darf der Server nicht auf 'starting'
    // stehen bleiben. Sonst zeigt das Panel dauerhaft einen Zustand an, der
    // nie eintritt, und kein Neustart ist mehr moeglich.
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, serverId }, 'Start fehlgeschlagen');

    await setStatus(serverId, 'offline', { reason: 'Start fehlgeschlagen', actorId: ctx.actorId });
    await writeEvent({
      serverId,
      kind: 'start_failed',
      severity: 'error',
      actorId: ctx.actorId ?? null,
      summary: kurzfassung(message),
      code: 'start_failed',
      params: { error: kurzfassung(message) },
      payload: { error: message },
    });
    throw err;
  }

  // Bereitschaft nach Vorgabe des Eggs abwarten.
  const ready = await awaitReady(server);

  if (ready.exited) {
    // Der Container ist gestorben, bevor er bereit war. Hat der Beobachter
    // das schon eingetragen, nicht doppelt melden.
    const current = await getStatus(serverId);
    if (current !== 'crashed') {
      const lastLines = await engine.tailLogs(server.container_id, 30);
      const hint = lastLines.at(-1)?.slice(0, 160) ?? '';
      await setStatus(serverId, 'crashed', { reason: 'Beim Start beendet', actorId: ctx.actorId });
      await writeEvent({
        serverId,
        kind: 'crash',
        severity: 'error',
        summary: hint ? `Beim Start abgestuerzt: ${hint}` : 'Beim Start abgestuerzt',
        code: 'crash_on_start',
        params: { hint: hint || '' },
        payload: { phase: 'start', seconds: ready.seconds, lastLines },
      });
      void notifyServerStatus('crash', server.name, hint || 'Beim Start abgestürzt');
    }
    throw new Error('Server ist beim Start abgestuerzt - siehe Zeitachse');
  }

  await setStatus(serverId, 'running', {
    reason: ready.reason,
    actorId: ctx.actorId,
    payload: { seconds: ready.seconds },
  });
  void notifyServerStatus('start', server.name, `Server erfolgreich gestartet in ${ready.seconds}s`);

}

/**
 * Stoppen in drei Stufen, wie im Konzept beschrieben:
 *   1. Stop-Kommando des Spiels an stdin (z. B. "stop" bei Minecraft)
 *   2. nach Ablauf der Frist SIGTERM
 *   3. zuletzt SIGKILL
 *
 * Nie direkt ContainerRestart von Docker nutzen - das ueberspringt Schritt 1,
 * und ein Minecraft-Server verliert dann die letzten Aenderungen.
 */
export async function stopServer(
  serverId: string,
  opts: { stopCommand?: string | undefined; graceSeconds?: number | undefined } & ActorContext = {},
): Promise<void> {
  const server = await requireServer(serverId);
  if (!server.container_id) return;

  // Stopp-Befehl und Zeitlimit kommen aus dem Egg. Vorher wurde hier immer
  // nur SIGTERM mit 15 s geschickt: Minecraft bekam nie sein "stop", und
  // ARK haette beim Speichern hart abgebrochen werden koennen.
  const [egg] = await sql<{ stop_command: string; stop_timeout: number }[]>`
    SELECT stop_command, stop_timeout FROM eggs WHERE id = ${server.egg_id}`;
  const grace = opts.graceSeconds ?? egg?.stop_timeout ?? 30;
  expectedStops.add(serverId);

  await setStatus(serverId, 'stopping', { reason: 'angefordert', actorId: opts.actorId });
  void notifyServerStatus('stop', server.name, opts.actorId ? 'Server wird heruntergefahren' : 'Server wird gestoppt');

  const cmd = opts.stopCommand ?? egg?.stop_command ?? '^C';

  try {
    if (cmd && cmd !== '^C') {
      log.debug({ serverId, cmd }, 'Stop-Kommando an die Konsole');
      await engine.sendToStdin(server.container_id, cmd);

      const exited = await waitWithTimeout(engine.waitForExit(server.container_id), grace * 1000);
      if (exited) {
        await finishStop(serverId);
        return;
      }
      log.warn({ serverId }, 'Stop-Kommando blieb wirkungslos, sende SIGTERM');
    }

    await engine.stopGraceful(server.container_id, grace);
    await finishStop(serverId);
  } catch (err) {
    log.warn({ err, serverId }, 'Sauberes Stoppen fehlgeschlagen, SIGKILL folgt');
    try {
      await engine.kill(server.container_id);
    } catch {
      /* Container ist vermutlich schon weg */
    }
    await finishStop(serverId);
  }
}

export async function restartServer(
  serverId: string,
  opts: { stopCommand?: string | undefined } & ActorContext = {},
): Promise<void> {
  await stopServer(serverId, opts);
  await startServer(serverId, opts);
}

export async function killServer(serverId: string, ctx: ActorContext = {}): Promise<void> {
  const server = await requireServer(serverId);
  if (!server.container_id) return;

  expectedStops.add(serverId);
  await engine.kill(server.container_id);
  await setStatus(serverId, 'offline', { reason: 'hart beendet (SIGKILL)', actorId: ctx.actorId });
  await writeEvent({
    serverId,
    kind: 'killed',
    severity: 'warn',
    actorId: ctx.actorId ?? null,
    summary: 'Server hart beendet - Datenverlust moeglich',
    code: 'server_killed',
  });
  expectedStops.delete(serverId);
}

async function finishStop(serverId: string): Promise<void> {
  await setStatus(serverId, 'offline', { reason: 'gestoppt' });
  expectedStops.delete(serverId);
}

async function writeConfigBeforeStart(server: ServerRecord): Promise<void> {
  const [egg] = await sql<{ config_files: Record<string, ConfigFileSpec> | null }[]>`
    SELECT config_files FROM eggs WHERE id = ${server.egg_id}
  `;
  if (!egg?.config_files) return;

  const ports = await listPorts(server.id);
  const primary = ports.find((p) => p.is_primary) ?? ports[0];

  await applyConfigFiles(server, egg.config_files, {
    variables: server.variables,
    ramMb: server.ram_mb,
    ip: '0.0.0.0',
    port: primary?.port ?? 0,
    ports: Object.fromEntries(ports.filter((p) => p.ref).map((p) => [p.ref!, p.port])),
    serverDir: '/home/container',
    serverName: server.name,
  });
}

/**
 * Wartet darauf, dass der Server bereit ist - ueber das Muster im Log oder
 * ueber einen Porttest. Laeuft die Frist ab, gilt er trotzdem als laufend:
 * ein Server, der laenger braucht als gedacht, ist kein Fehlerfall, und ARK
 * braucht beim ersten Start gern zehn Minuten.
 */
async function awaitReady(
  server: ServerRecord,
): Promise<{ reason: string; seconds: number; exited?: boolean }> {
  const [egg] = await sql<{ ready_check: unknown; config_startup: { done?: string } | null; log_file: string | null }[]>`
    SELECT ready_check, config_startup, raw_egg->>'log_file' AS log_file FROM eggs WHERE id = ${server.egg_id}
  `;
  // Spiele mit eigener Logdatei (ARK): das Startmuster kann auch dort stehen.
  const logFile = egg?.log_file ? logFilePath(server.short_id, egg.log_file) : null;

  const ports = await listPorts(server.id);
  const refMap = Object.fromEntries(ports.filter((p) => p.ref).map((p) => [p.ref!, p.port]));
  const check = parseReadyCheck(egg?.ready_check as never, egg?.config_startup?.done, refMap);

  const started = Date.now();
  const since = () => Math.round((Date.now() - started) / 1000);

  if (check.kind === 'none') {
    return { reason: 'Container gestartet', seconds: 0 };
  }

  if (check.kind === 'tcp_port') {
    // Laeuft das Panel selbst im Container, ist 127.0.0.1 der Panel-Container -
    // dort lauscht kein Spiel. Dann direkt die IP des Spielcontainers im
    // gemeinsamen Spielnetz nehmen (gleicher Port, das Panel vergibt 1:1).
    const host = existsSync('/.dockerenv') ? (await engine.gameNetworkIp(server.container_id!)) ?? '127.0.0.1' : '127.0.0.1';
    const ok = await waitForPort(host, check.port, check.timeoutSeconds ?? 600, 2000,
      async () => !!(await engine.inspect(server.container_id!))?.running);
    if (!ok) {
      const state = await engine.inspect(server.container_id!);
      if (!state?.running) return { reason: 'Beim Start beendet', seconds: since(), exited: true };
    }
    return ok
      ? { reason: `bereit, Port ${check.port} antwortet nach ${since()} s`, seconds: since() }
      : { reason: `Zeitablauf beim Porttest (${check.port})`, seconds: since() };
  }

  return await new Promise((resolve) => {
    const timeout = (check.timeoutSeconds ?? 600) * 1000;
    let stop: (() => void) | null = null;
    let done = false;

    const finish = (reason: string, exited = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop?.();
      resolve({ reason, seconds: since(), exited });
    };

    const timer = setTimeout(() => finish('Zeitablauf beim Warten auf das Startmuster'), timeout);

    // Endet der Logstrom ohne Startmuster, nachsehen: laeuft der Container
    // noch? Wenn nicht, ist er beim Start gestorben - das ist ein Absturz,
    // kein "noch nicht bereit".
    const onEnd = () => {
      if (done) return;
      void engine.inspect(server.container_id!).then((state) => {
        if (!state || !state.running) finish('Beim Start beendet', true);
      });
    };

    const onLine = (line: string) => { if (matchesDone(line, check.regex)) finish(`bereit nach ${since()} s`); };
    // Ab dem aktuellen Ende lesen - was vom letzten Lauf in der Datei steht, zaehlt nicht.
    const stopFile = logFile ? followFile(logFile, onLine) : null;
    void engine
      .streamLogs(server.container_id!, onLine, onEnd)
      .then((s) => { stop = () => { s(); stopFile?.(); }; if (done) stop(); })
      .catch(() => { stopFile?.(); finish('Container gestartet'); });
  });
}

async function requireServer(serverId: string): Promise<ServerRecord> {
  const server = await findServer(serverId);
  if (!server) throw new Error(`Server ${serverId} nicht gefunden`);
  return server;
}

/**
 * Docker-Fehlermeldungen sind mehrzeilige runc-Ketten. Fuer die Zeitachse
 * zaehlt der Kern, nicht der Stacktrace.
 */
function kurzfassung(message: string): string {
  const io = message.includes('io.weight');
  if (io) return 'Start fehlgeschlagen: Host unterstuetzt keine IO-Gewichtung (ENABLE_IO_WEIGHT=false setzen)';
  const oci = message.match(/unable to start container process: ([^"]+?)(?:: unknown)?$/);
  if (oci?.[1]) return `Start fehlgeschlagen: ${oci[1].trim()}`;
  return `Start fehlgeschlagen: ${message.slice(0, 200)}`;
}

function waitWithTimeout<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((res) => setTimeout(() => res(false), ms)),
  ]);
}

export { expectedStops };
