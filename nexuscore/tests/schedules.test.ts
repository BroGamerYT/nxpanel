import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { MockDriver } = await import('../src/drivers/mock-driver.js');
const { EventBus } = await import('../src/protocol/events.js');
const { ServerRegistry } = await import('../src/store/registry.js');
const { createCoreServer } = await import('../src/http/server.js');
const { Scheduler, MISSED_GRACE_MS } = await import('../src/schedules/scheduler.js');
const { nextRun, validateTiming, ScheduleError } = await import('../src/schedules/timing.js');

describe('Zeitberechnung', () => {
  const from = new Date(2026, 10, 11, 10, 30, 15); // 11.11.2026 10:30:15 Ortszeit

  it('Intervall zaehlt ab jetzt', () => {
    expect(nextRun(null, 90, from).getTime()).toBe(from.getTime() + 90 * 60_000);
  });

  it('HH:MM: heute, wenn noch nicht vorbei, sonst morgen', () => {
    expect(nextRun('12:00', null, from)).toEqual(new Date(2026, 10, 11, 12, 0, 0));
    expect(nextRun('10:30', null, from)).toEqual(new Date(2026, 10, 12, 10, 30, 0));
    expect(nextRun('03:05', null, from)).toEqual(new Date(2026, 10, 12, 3, 5, 0));
  });

  it('Cron: Schritte, Listen und Bereiche', () => {
    expect(nextRun('*/15 * * * *', null, from)).toEqual(new Date(2026, 10, 11, 10, 45, 0));
    expect(nextRun('0 4 * * *', null, from)).toEqual(new Date(2026, 10, 12, 4, 0, 0));
    expect(nextRun('0 6,18 * * *', null, from)).toEqual(new Date(2026, 10, 11, 18, 0, 0));
    expect(nextRun('0 0 1 12 *', null, from)).toEqual(new Date(2026, 11, 1, 0, 0, 0));
  });

  it('Cron: Wochentag, Sonntag als 0 und 7', () => {
    // 11.11.2026 ist ein Mittwoch -> naechster Sonntag 15.11.
    expect(nextRun('0 8 * * 0', null, from)).toEqual(new Date(2026, 10, 15, 8, 0, 0));
    expect(nextRun('0 8 * * 7', null, from)).toEqual(new Date(2026, 10, 15, 8, 0, 0));
  });

  it('lehnt Unsinn ab, statt ihn still umzudeuten', () => {
    for (const bad of ['24:00', '12:60', 'jeden Tag', '* * * *', '60 * * * *', '*/0 * * * *', '5-2 * * * *']) {
      expect(() => validateTiming(bad, null), bad).toThrow(ScheduleError);
    }
    expect(() => validateTiming(null, null)).toThrow(ScheduleError);
    expect(() => validateTiming('12:00', 30)).toThrow(ScheduleError);
    expect(() => nextRun('0 0 30 2 *', null, from)).toThrow(/nie/);
  });
});

describe('Scheduler', () => {
  let dataDir: string;
  let registry: InstanceType<typeof ServerRegistry>;
  let now: Date;
  let calls: string[];
  let failNext: boolean;
  let scheduler: InstanceType<typeof Scheduler>;

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-sched-'));
    registry = await ServerRegistry.open(dataDir);
  });
  afterAll(async () => {
    registry.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const make = () => {
    now = new Date(2026, 10, 11, 10, 0, 0);
    calls = [];
    failNext = false;
    scheduler = new Scheduler(
      registry,
      {
        restart: async (id) => {
          calls.push(`restart:${id}`);
          if (failNext) throw new Error('kaputt');
        },
        command: async (id, line) => {
          calls.push(`command:${id}:${line}`);
        },
      },
      () => now,
    );
  };

  it('fuehrt Faelliges aus, nicht Zukuenftiges, und plant neu', async () => {
    make();
    const s = scheduler.create('srv', { name: 'Nachts', action: 'restart', interval_minutes: 60 });
    expect(await scheduler.tick()).toBe(0);
    now = new Date(now.getTime() + 61 * 60_000);
    expect(await scheduler.tick()).toBe(1);
    expect(calls).toEqual(['restart:srv']);
    const after = registry.getSchedule(s.id)!;
    expect(after.last_status).toBe('success');
    expect(new Date(after.next_run_at!).getTime()).toBe(now.getTime() + 60 * 60_000);
    expect(await scheduler.tick()).toBe(0);
    registry.deleteSchedule(s.id);
  });

  it('merkt sich Fehler und laeuft trotzdem weiter', async () => {
    make();
    const s = scheduler.create('srv', { name: 'x', action: 'restart', interval_minutes: 5 });
    failNext = true;
    const result = await scheduler.run(s.id, true);
    expect(result).toMatchObject({ ok: false, error: 'kaputt' });
    const row = registry.getSchedule(s.id)!;
    expect(row.last_status).toBe('failed');
    expect(row.last_error).toBe('kaputt');
    expect(row.next_run_at).not.toBeNull();
    registry.deleteSchedule(s.id);
  });

  it('holt Verpasstes nicht nach (Core war aus)', async () => {
    make();
    const s = scheduler.create('srv', { name: 'x', action: 'restart', interval_minutes: 10 });
    now = new Date(now.getTime() + MISSED_GRACE_MS + 60 * 60_000);
    expect(await scheduler.tick()).toBe(0);
    expect(calls).toEqual([]);
    const row = registry.getSchedule(s.id)!;
    expect(new Date(row.next_run_at!).getTime()).toBe(now.getTime() + 10 * 60_000);
    expect(registry.recentAudit({ serverId: 'srv' }).some((a) => a.action === 'schedule.skipped')).toBe(true);
    registry.deleteSchedule(s.id);
  });

  it('inaktive Plaene laufen nicht; Aktivieren plant ein', async () => {
    make();
    const s = scheduler.create('srv', { name: 'x', action: 'restart', interval_minutes: 1, active: false });
    expect(s.next_run_at).toBeNull();
    now = new Date(now.getTime() + 10 * 60_000);
    expect(await scheduler.tick()).toBe(0);
    const on = scheduler.update('srv', s.id, { active: true });
    expect(on.next_run_at).not.toBeNull();
    registry.deleteSchedule(s.id);
  });

  it('Befehl braucht Text; Backup wird abgelehnt, solange es keine Backups gibt', () => {
    make();
    expect(() => scheduler.create('srv', { name: 'x', action: 'command', interval_minutes: 5 })).toThrow(ScheduleError);
    expect(() => scheduler.create('srv', { name: 'x', action: 'backup', interval_minutes: 5 })).toThrow(/Backups/);
  });

  it('Aenderung der Zeitangabe ersetzt die alte; fremder Server wird nicht angefasst', () => {
    make();
    const s = scheduler.create('srv', { name: 'x', action: 'restart', cron: '04:00' });
    const u = scheduler.update('srv', s.id, { interval_minutes: 30, cron: null });
    expect(u.cron).toBeNull();
    expect(u.interval_minutes).toBe(30);
    expect(() => scheduler.update('anderer', s.id, { name: 'y' })).toThrow(ScheduleError);
    scheduler.remove('anderer', s.id);
    expect(registry.getSchedule(s.id)).toBeDefined();
    scheduler.remove('srv', s.id);
    expect(registry.getSchedule(s.id)).toBeUndefined();
  });

  it('Server loeschen entfernt dessen Zeitplaene', async () => {
    make();
    await registry.add({ id: 'weg', name: 'weg', game: 'x', executable: 'x', args: [], workingDir: dataDir, ports: [] });
    const s = scheduler.create('weg', { name: 'x', action: 'restart', interval_minutes: 5 });
    await registry.remove('weg');
    expect(registry.getSchedule(s.id)).toBeUndefined();
  });
});

describe('Zeitplan-Routen', () => {
  let server: Awaited<ReturnType<typeof createCoreServer>>;
  let registry: InstanceType<typeof ServerRegistry>;
  let driver: InstanceType<typeof MockDriver>;
  let dataDir: string;
  let auth: Record<string, string>;
  const json = { 'content-type': 'application/json' };

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-sched-routes-'));
    registry = await ServerRegistry.open(dataDir);
    driver = new MockDriver();
    await driver.initialize();
    server = await createCoreServer(driver, new EventBus(), registry, { installs: null });
    const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
    auth = { authorization: `Bearer ${login.json().accessToken}` };
    for (const id of ['sc-1', 'sc-2']) {
      const config = { id, name: id, game: 'x', executable: 'x', args: [], workingDir: dataDir, ports: [] };
      await registry.add(config);
      await driver.registerServer(config);
    }
  });
  afterAll(async () => {
    await server.close();
    registry.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers = auth) =>
    server.inject({ method, url, headers: payload === undefined ? headers : { ...headers, ...json }, ...(payload === undefined ? {} : { payload: payload as object }) });

  it('Feature und Rechte sind sichtbar', async () => {
    const me = await call('GET', '/api/v1/servers/sc-1');
    expect(JSON.stringify(me.json())).toContain('schedule.read');
  });

  it('braucht Anmeldung', async () => {
    expect((await call('GET', '/api/v1/servers/sc-1/schedules', undefined, {})).statusCode).toBe(401);
  });

  it('anlegen, listen, aendern, ausfuehren, loeschen', async () => {
    const created = await call('POST', '/api/v1/servers/sc-1/schedules', { name: 'Befehl', action: 'command', payload: 'say hi', interval_minutes: 60 });
    expect(created.statusCode).toBe(201);
    const id = created.json().schedule.id as string;

    const list = await call('GET', '/api/v1/servers/sc-1/schedules');
    expect(list.json().schedules).toHaveLength(1);
    expect((await call('GET', '/api/v1/servers/sc-2/schedules')).json().schedules).toHaveLength(0);

    const patched = await call('PATCH', `/api/v1/servers/sc-1/schedules/${id}`, { name: 'Neu', active: false });
    expect(patched.json().schedule).toMatchObject({ name: 'Neu', active: false, next_run_at: null });

    const run = await call('POST', `/api/v1/servers/sc-1/schedules/${id}/run`);
    expect(run.statusCode).toBe(200);
    expect(run.json().result.action).toBe('command');
    expect(registry.recentAudit({ serverId: 'sc-1' }).some((a) => a.action === 'schedule.run')).toBe(true);

    expect((await call('DELETE', `/api/v1/servers/sc-1/schedules/${id}`)).statusCode).toBe(200);
    expect((await call('GET', '/api/v1/servers/sc-1/schedules')).json().schedules).toHaveLength(0);
  });

  it('lehnt ungueltige Angaben mit 400 ab', async () => {
    const url = '/api/v1/servers/sc-1/schedules';
    expect((await call('POST', url, { name: 'x', action: 'restart', cron: 'kaputt' })).statusCode).toBe(400);
    expect((await call('POST', url, { name: 'x', action: 'restart' })).statusCode).toBe(400);
    expect((await call('POST', url, { name: 'x', action: 'reboot', interval_minutes: 5 })).statusCode).toBe(400);
    expect((await call('POST', url, { name: 'x', action: 'command', interval_minutes: 5 })).statusCode).toBe(400);
    expect((await call('POST', url, { name: '', action: 'restart', interval_minutes: 5 })).statusCode).toBe(400);
  });

  it('ein Zeitplan gehoert zu seinem Server', async () => {
    const created = await call('POST', '/api/v1/servers/sc-1/schedules', { name: 'x', action: 'restart', interval_minutes: 5 });
    const id = created.json().schedule.id as string;
    expect((await call('POST', `/api/v1/servers/sc-2/schedules/${id}/run`)).statusCode).toBe(404);
    expect((await call('PATCH', `/api/v1/servers/sc-2/schedules/${id}`, { name: 'y' })).statusCode).toBe(404);
    expect((await call('DELETE', `/api/v1/servers/sc-2/schedules/${id}`)).statusCode).toBe(404);
    expect((await call('DELETE', '/api/v1/servers/sc-1/schedules/kein-uuid')).statusCode).toBe(404);
    expect((await call('GET', '/api/v1/servers/gibt-es-nicht/schedules')).statusCode).toBe(404);
    await call('DELETE', `/api/v1/servers/sc-1/schedules/${id}`);
  });
});
