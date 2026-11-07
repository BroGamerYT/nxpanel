import { sql } from '../db/index.js';
import { log } from '../log.js';
import { writeEvent } from '../events.js';
import { createBackup, listBackups } from './backups.js';
import { rebuildContainer, STOPPED_STATES } from './create.js';
import { startServer, stopServer } from './lifecycle.js';
import { clearPackCache } from '../games/modpacks.js';

/**
 * Modpack-Update mit einem Klick:
 *   1. Server stoppen (falls er laeuft)
 *   2. Backup anlegen und abwarten - ohne fertiges Backup kein Update
 *   3. neue Version festsetzen, Container neu bauen
 *   4. wieder starten, wenn er vorher lief
 * Das itzg-Image spielt die neue Pack-Version beim Start selbst ein.
 */

export type UpdateStep = 'stopping' | 'backup' | 'updating' | 'starting' | 'done' | 'failed';
export interface UpdateState { step: UpdateStep; from: string | null; to: string; message?: string; backupId?: string; at: number }

const jobs = new Map<string, UpdateState>();

export function updateState(serverId: string): UpdateState | null {
  const s = jobs.get(serverId);
  // Abgeschlossene Meldungen nach 10 Minuten vergessen
  if (s && (s.step === 'done' || s.step === 'failed') && Date.now() - s.at > 10 * 60_000) { jobs.delete(serverId); return null; }
  return s ?? null;
}

export function isUpdating(serverId: string) {
  const s = jobs.get(serverId);
  return !!s && s.step !== 'done' && s.step !== 'failed';
}

async function status(serverId: string): Promise<string> {
  const [r] = await sql<{ status: string }[]>`SELECT status FROM servers WHERE id = ${serverId}`;
  return r?.status ?? 'unknown';
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, everyMs = 2000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return false;
}

export interface UpdateInput {
  serverId: string;
  versionVar: string;
  from: string | null;
  to: string;
  label: string;
  actor: { id: string; username: string };
  ip: string;
}

/** Startet das Update im Hintergrund. Wirft, wenn schon eines laeuft. */
export function startPackUpdate(input: UpdateInput): UpdateState {
  if (isUpdating(input.serverId)) throw new Error('Fuer diesen Server laeuft bereits ein Update');
  const state: UpdateState = { step: 'stopping', from: input.from, to: input.to, at: Date.now() };
  jobs.set(input.serverId, state);
  void runUpdate(input, state);
  return state;
}

async function runUpdate(input: UpdateInput, state: UpdateState): Promise<void> {
  const { serverId, actor } = input;
  const set = (step: UpdateStep, extra: Partial<UpdateState> = {}) => Object.assign(state, { step, at: Date.now(), ...extra });
  const wasRunning = !(STOPPED_STATES as readonly string[]).includes(await status(serverId));
  try {
    await writeEvent({ serverId, kind: 'modpack_update', actorId: actor.id, summary: `Modpack-Update gestartet: ${input.label}` });

    if (wasRunning) {
      await stopServer(serverId, { actorId: actor.id });
      const stopped = await waitFor(async () => (STOPPED_STATES as readonly string[]).includes(await status(serverId)), 5 * 60_000);
      if (!stopped) throw new Error('Server liess sich nicht stoppen');
    }

    set('backup');
    const backup = await createBackup(serverId, actor, input.ip, `Vor Modpack-Update ${input.label}`);
    state.backupId = backup.id;
    let final = 'running';
    await waitFor(async () => {
      final = (await listBackups(serverId)).find((b) => b.id === backup.id)?.status ?? 'missing';
      return final !== 'running';
    }, 2 * 60 * 60_000, 3000);
    if (final !== 'completed') throw new Error(`Backup nicht fertig (${final}) - Update abgebrochen, nichts geaendert`);

    set('updating');
    await sql`UPDATE servers SET variables = variables || ${sql.json({ [input.versionVar]: input.to })} WHERE id = ${serverId}`;
    await rebuildContainer(serverId, { actorId: actor.id, reason: `Modpack-Update ${input.label}` });
    clearPackCache();

    if (wasRunning) {
      set('starting');
      await startServer(serverId, { actorId: actor.id });
    }
    set('done', { message: wasRunning ? 'Aktualisiert und gestartet - der erste Start dauert, bis alle Mods geladen sind.' : 'Aktualisiert. Beim naechsten Start wird die neue Version eingespielt.' });
    await writeEvent({ serverId, kind: 'modpack_update', actorId: actor.id, summary: `Modpack aktualisiert: ${input.label}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, serverId }, 'Modpack-Update fehlgeschlagen');
    set('failed', { message });
    await writeEvent({ serverId, kind: 'modpack_update', severity: 'error', actorId: actor.id, summary: `Modpack-Update fehlgeschlagen: ${message}` });
  }
}
