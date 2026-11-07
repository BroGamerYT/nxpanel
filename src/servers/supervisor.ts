import { engine, type DockerEvent } from '../docker/client.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import { setStatus } from './status.js';
import { findServer, bumpCrashCount, recentCrashCount } from './repo.js';
import { startServer, expectedStops } from './lifecycle.js';
import { reconcile } from './reconcile.js';

/** Nach so vielen Abstuerzen in CRASH_WINDOW_MIN gibt das Panel auf. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MIN = 10;

/** Sicherheitsnetz: auch ohne Ereignis wird regelmaessig abgeglichen. */
const RECONCILE_INTERVAL_MS = 60_000;

let stopStream: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;

/**
 * Beobachtet alle Panel-Container zentral ueber den Docker-Ereignisstrom.
 *
 * Zustaendig fuer alles, was ohne Zutun des Panels passiert: ein Container
 * stirbt, jemand startet ihn von aussen, der Kernel beendet ihn wegen
 * Speichermangel.
 */
export async function startSupervisor(): Promise<void> {
  stopStream = await engine.subscribeEvents((e) => void handleEvent(e));

  timer = setInterval(() => {
    void reconcile().catch((err) => log.error({ err }, 'Regelmaessiger Abgleich fehlgeschlagen'));
  }, RECONCILE_INTERVAL_MS);

  log.info('Beobachter laeuft');
}

export function stopSupervisor(): void {
  stopStream?.();
  stopStream = null;
  if (timer) clearInterval(timer);
  timer = null;
}

async function handleEvent(e: DockerEvent): Promise<void> {
  if (!e.serverId) return;

  switch (e.action) {
    case 'start':
      await onStarted(e);
      break;
    case 'die':
      await onDied(e);
      break;
    case 'oom':
      await writeEvent({
        serverId: e.serverId,
        kind: 'oom',
        severity: 'error',
        summary: 'Arbeitsspeicher erschoepft - der Kernel hat Prozesse beendet',
      });
      break;
    default:
      break;
  }
}

async function onStarted(e: DockerEvent): Promise<void> {
  const server = await findServer(e.serverId);
  if (!server) return;

  // Steht der Server auf 'starting', hat das Panel den Start selbst
  // ausgeloest und wartet gerade auf die Bereitschaft (Done-Regex oder
  // Porttest). Dann hier NICHTS tun - sonst springt der Status auf
  // 'running', bevor der Server Spieler annehmen kann, und die ganze
  // Bereitschaftspruefung waere wirkungslos.
  if (server.status === 'starting' || server.status === 'running') return;

  // Von aussen gestartet, etwa ueber Docker Desktop: Status nachziehen.
  await setStatus(e.serverId, 'starting', { reason: 'Container von aussen gestartet' });
  await setStatus(e.serverId, 'running', { reason: 'Container laeuft (von aussen gestartet)' });
}

async function onDied(e: DockerEvent): Promise<void> {
  const server = await findServer(e.serverId);
  if (!server) return;

  // Vom Panel selbst ausgeloest - kein Absturz.
  if (expectedStops.has(e.serverId)) return;
  if (server.status === 'stopping' || server.status === 'suspended') return;

  const exitCode = e.exitCode ?? -1;
  const oom = e.attributes['oomKilled'] === 'true';

  log.warn({ serverId: e.serverId, exitCode, oom }, 'Container unerwartet beendet');

  // Die letzten Zeilen sagen fast immer, WARUM. Ohne sie steht in der
  // Zeitachse nur "Exit-Code 1" - und der Nutzer muss erst docker logs
  // kennen, um weiterzukommen.
  const lastLines = await engine.tailLogs(e.containerId, 30);
  const hint = lastLines.length > 0 ? lastLines[lastLines.length - 1]!.slice(0, 160) : '';

  await setStatus(e.serverId, 'crashed', {
    reason: oom ? 'Arbeitsspeicher erschoepft (OOM)' : `Exit-Code ${exitCode}`,
  });

  await writeEvent({
    serverId: e.serverId,
    kind: 'crash',
    severity: 'error',
    summary: oom
      ? 'Abgestuerzt: Arbeitsspeicher erschoepft'
      : hint
        ? `Abgestuerzt (Exit ${exitCode}): ${hint}`
        : `Abgestuerzt mit Exit-Code ${exitCode}`,
    code: oom ? 'crash_oom' : 'crash_exit',
    params: { exitCode, hint: hint || '' },
    payload: { exitCode, oomKilled: oom, lastLines },
  });

  await bumpCrashCount(e.serverId);

  if (!server.auto_restart) {
    await writeEvent({
      serverId: e.serverId,
      kind: 'restart_skipped',
      severity: 'warn',
      summary: 'Kein automatischer Neustart: auto_restart ist ausgeschaltet',
      code: 'restart_skipped_disabled',
    });
    return;
  }

  const crashes = await recentCrashCount(e.serverId, CRASH_WINDOW_MIN);
  if (crashes >= CRASH_LIMIT) {
    await writeEvent({
      serverId: e.serverId,
      kind: 'restart_skipped',
      severity: 'error',
      summary: `Kein automatischer Neustart: ${crashes} Abstuerze in ${CRASH_WINDOW_MIN} Minuten`,
      code: 'restart_skipped_limit',
      params: { crashes, limit: CRASH_LIMIT, window: CRASH_WINDOW_MIN },
      payload: { crashes, limit: CRASH_LIMIT },
    });
    log.error({ serverId: e.serverId, crashes }, 'Absturzschleife - Auto-Restart ausgesetzt');
    return;
  }

  await writeEvent({
    serverId: e.serverId,
    kind: 'restart_attempt',
    summary: `Automatischer Neustart (Absturz ${crashes} von ${CRASH_LIMIT})`,
    code: 'restart_attempt',
    params: { count: crashes, limit: CRASH_LIMIT },
  });

  try {
    await startServer(e.serverId);
  } catch (err) {
    log.error({ err, serverId: e.serverId }, 'Automatischer Neustart fehlgeschlagen');
  }
}
