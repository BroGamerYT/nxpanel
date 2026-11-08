import { engine, type DockerEvent } from '../docker/client.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import { setStatus } from './status.js';
import { findServer, bumpCrashCount } from './repo.js';
import { startServer, expectedStops } from './lifecycle.js';
import { reconcile } from './reconcile.js';
import { notifyServerStatus } from '../notifications/discord.js';

/** Nach 5 fehlgeschlagenen Starts/Abstuerzen hintereinander bleibt der Server aus ("Nicht startbar"). */
export const CRASH_LIMIT = 5;
const CRASH_WINDOW_MIN = 10;
const AUTO_RESTART_DELAY_MS = 3_000;

/** Sicherheitsnetz: auch ohne Ereignis wird regelmaessig abgeglichen. */
const RECONCILE_INTERVAL_MS = 60_000;

/** Verhindert Doppelzaehlung, wenn awaitReady und Docker-'die'-Event gleichzeitig feuern. */
const lastCrashHandledAt = new Map<string, number>();
const pendingRestarts = new Set<string>();

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
  if (!e.serverId) return;
  await handleUnexpectedExit(e.serverId, {
    containerId: e.containerId,
    exitCode: e.exitCode ?? -1,
    oom: e.attributes['oomKilled'] === 'true',
  });
}

/**
 * Zentrale Behandlung eines unerwarteten Container-Absturzes (beim Start oder im Betrieb).
 * Zaehlt Abstuerze exakt hoch (1..5), fuehrt bei aktivem Auto-Start bis zu 5 Startversuche
 * durch und laesst den Server nach dem 5. Absturz ausgeschaltet ("Nicht startbar").
 */
export async function handleUnexpectedExit(
  serverId: string,
  opts: { containerId?: string | null; exitCode?: number; oom?: boolean } = {},
): Promise<void> {
  // Entprellen: falls awaitReady (lifecycle.ts) und Docker-Event 'die' denselben Tod melden
  const now = Date.now();
  const prev = lastCrashHandledAt.get(serverId) ?? 0;
  if (now - prev < 2500) return;
  lastCrashHandledAt.set(serverId, now);

  const server = await findServer(serverId);
  if (!server) return;

  // Vom Panel selbst ausgeloest - kein Absturz.
  if (expectedStops.has(serverId)) return;
  if (server.status === 'stopping' || server.status === 'suspended' || server.status === 'installing') return;

  const exitCode = opts.exitCode ?? -1;
  const oom = opts.oom ?? false;
  const cid = opts.containerId ?? server.container_id;

  log.warn({ serverId, exitCode, oom }, 'Container unerwartet beendet');

  const lastLines = cid ? await engine.tailLogs(cid, 30).catch(() => []) : [];
  const hint = lastLines.length > 0 ? lastLines[lastLines.length - 1]!.slice(0, 160) : '';

  const crashes = await bumpCrashCount(serverId);

  await setStatus(serverId, 'crashed', {
    reason: oom
      ? 'Arbeitsspeicher erschoepft (OOM)'
      : crashes >= CRASH_LIMIT
        ? `Nicht startbar (${crashes}/${CRASH_LIMIT} Abstuerze)`
        : `Exit-Code ${exitCode} (${crashes}/${CRASH_LIMIT})`,
  });

  await writeEvent({
    serverId,
    kind: 'crash',
    severity: 'error',
    summary: oom
      ? `Abgestuerzt (${crashes}/${CRASH_LIMIT}): Arbeitsspeicher erschoepft`
      : hint
        ? `Abgestuerzt (${crashes}/${CRASH_LIMIT}, Exit ${exitCode}): ${hint}`
        : `Abgestuerzt (${crashes}/${CRASH_LIMIT}) mit Exit-Code ${exitCode}`,
    code: oom ? 'crash_oom' : 'crash_exit',
    params: { exitCode, hint: hint || '', crashes, limit: CRASH_LIMIT },
    payload: { exitCode, oomKilled: oom, lastLines, crashes, limit: CRASH_LIMIT },
  });

  if (!server.auto_restart) {
    await writeEvent({
      serverId,
      kind: 'restart_skipped',
      severity: 'warn',
      summary: 'Kein automatischer Neustart: Auto-Start ist ausgeschaltet',
      code: 'restart_skipped_disabled',
    });
    void notifyServerStatus('crash', server.name, hint || `Abgestürzt (Exit ${exitCode})`);
    return;
  }

  if (crashes >= CRASH_LIMIT) {
    await writeEvent({
      serverId,
      kind: 'restart_skipped',
      severity: 'error',
      summary: `Nicht startbar: ${crashes} fehlgeschlagene Startversuche hintereinander – Server bleibt ausgeschaltet`,
      code: 'restart_skipped_limit',
      params: { crashes, limit: CRASH_LIMIT, window: CRASH_WINDOW_MIN },
      payload: { crashes, limit: CRASH_LIMIT, unstartable: true },
    });
    log.error({ serverId, crashes }, 'Absturzschleife (5/5) - Server als nicht startbar markiert und ausgeschaltet');
    void notifyServerStatus('crash', server.name, `Nicht startbar nach ${crashes} Abstürzen – Server bleibt ausgeschaltet.`);
    return;
  }

  if (pendingRestarts.has(serverId)) return;
  pendingRestarts.add(serverId);

  await writeEvent({
    serverId,
    kind: 'restart_attempt',
    summary: `Auto-Start aktiv: Startversuch ${crashes} von ${CRASH_LIMIT} nach Absturz`,
    code: 'restart_attempt',
    params: { count: crashes, limit: CRASH_LIMIT },
    payload: { count: crashes, limit: CRASH_LIMIT },
  });

  setTimeout(() => {
    pendingRestarts.delete(serverId);
    void (async () => {
      const fresh = await findServer(serverId);
      if (!fresh || !fresh.auto_restart || fresh.status !== 'crashed' || fresh.suspended) return;
      try {
        await startServer(serverId);
      } catch (err) {
        log.error({ err, serverId, attempt: crashes }, 'Automatischer Neustart fehlgeschlagen');
      }
    })();
  }, AUTO_RESTART_DELAY_MS);
}
