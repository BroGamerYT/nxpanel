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
const { DiscordNotifier, DISCORD_WEBHOOK_PATTERN } = await import('../src/notifications/discord.js');

const HOOK = 'https://discord.com/api/webhooks/123456789/abcDEF-ghi_JKL';

let dataDir: string;
let registry: InstanceType<typeof ServerRegistry>;
let server: Awaited<ReturnType<typeof createCoreServer>>;
let auth: Record<string, string>;
const json = { 'content-type': 'application/json' };
const get = (url: string, headers = auth) => server.inject({ method: 'GET', url, headers });
const post = (url: string, payload: unknown) => server.inject({ method: 'POST', url, headers: { ...auth, ...json }, payload: payload as object });

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-int-'));
  registry = await ServerRegistry.open(dataDir);
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus(), registry, { installs: null, scheduler: false });
  const login = await server.inject({ method: 'POST', url: '/api/v1/auth/login', headers: json, payload: { login: 'admin', password: 'nur-fuer-tests-0815' } });
  auth = { authorization: `Bearer ${login.json().accessToken}` };
});

afterAll(async () => {
  await server.close();
  registry.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Webhook-Adresse', () => {
  it('erlaubt nur Discord', () => {
    expect(DISCORD_WEBHOOK_PATTERN.test(HOOK)).toBe(true);
    expect(DISCORD_WEBHOOK_PATTERN.test('https://canary.discord.com/api/v10/webhooks/1/x')).toBe(true);
    for (const bad of [
      'http://discord.com/api/webhooks/1/x',
      'https://discord.com.evil.example/api/webhooks/1/x',
      'https://evil.example/https://discord.com/api/webhooks/1/x',
      'https://127.0.0.1/api/webhooks/1/x',
      'https://discord.com/api/webhooks/1/x?redirect=http://127.0.0.1',
      'https://discord.com@127.0.0.1/api/webhooks/1/x',
    ]) expect(DISCORD_WEBHOOK_PATTERN.test(bad), bad).toBe(false);
  });
});

describe('Integrationen-Routen', () => {
  it('verlangen eine Anmeldung', async () => {
    expect((await get('/api/v1/admin/integrations', {})).statusCode).toBe(401);
  });

  it('starten leer', async () => {
    const body = (await get('/api/v1/admin/integrations')).json();
    expect(body.discord).toEqual({ configured: false, url: '', enabled: true });
    expect(body.playit.configured).toBe(false);
  });

  it('lehnen fremde Adressen ab und testen ohne Webhook nicht', async () => {
    expect((await post('/api/v1/admin/integrations/discord', { url: 'http://127.0.0.1:9/x' })).statusCode).toBe(400);
    expect((await post('/api/v1/admin/integrations/discord/test', {})).statusCode).toBe(400);
  });

  it('speichern den Webhook, ohne ihn zurückzugeben oder zu protokollieren', async () => {
    expect((await post('/api/v1/admin/integrations/discord', { url: HOOK })).statusCode).toBe(200);
    const body = (await get('/api/v1/admin/integrations')).json();
    expect(body.discord.configured).toBe(true);
    expect(JSON.stringify(body)).not.toContain('abcDEF-ghi_JKL');
    expect((await post('/api/v1/admin/integrations/discord', { enabled: false })).statusCode).toBe(200);
    expect((await get('/api/v1/admin/integrations')).json().discord.enabled).toBe(false);
    const audit = JSON.stringify((await get('/api/v1/admin/audit?action=admin.discord')).json());
    expect(audit).toContain('admin.discord_update');
    expect(audit).not.toContain('abcDEF');
  });

  it('entfernen den Webhook wieder', async () => {
    expect((await post('/api/v1/admin/integrations/discord', { url: null })).statusCode).toBe(200);
    expect((await get('/api/v1/admin/integrations')).json().discord.configured).toBe(false);
  });
});

describe('Playit-Schlüssel', () => {
  const KEY = 'a1b2c3d4e5f6-geheimer-playit-schluessel';
  it('wird verschlüsselt gespeichert, nur der Anfang kommt zurück, nichts im Protokoll', async () => {
    expect((await post('/api/v1/admin/integrations/playit', { secretKey: KEY })).statusCode).toBe(200);
    const body = (await get('/api/v1/admin/integrations')).json();
    expect(body.playit).toEqual({ configured: true, secretKey: 'a1b2...' });
    expect(JSON.stringify(registry.getSetting('secret.playit'))).not.toContain('geheimer');
    expect(JSON.stringify((await get('/api/v1/admin/audit?action=admin.playit')).json())).not.toContain('geheimer');
    expect(JSON.stringify((await get('/api/v1/admin/audit?action=admin.playit')).json())).toContain('admin.playit_update');
  });
  it('lehnt Unbrauchbares ab und entfernt auf Wunsch', async () => {
    expect((await post('/api/v1/admin/integrations/playit', { secretKey: 'zu kurz & <b>' })).statusCode).toBe(400);
    expect((await get('/api/v1/admin/integrations')).json().playit.configured).toBe(true);
    expect((await post('/api/v1/admin/integrations/playit', { secretKey: null })).statusCode).toBe(200);
    expect((await get('/api/v1/admin/integrations')).json().playit).toEqual({ configured: false, secretKey: '' });
  });
  it('braucht Administratorrechte', async () => {
    expect((await server.inject({ method: 'POST', url: '/api/v1/admin/integrations/playit', headers: json, payload: { secretKey: KEY } })).statusCode).toBe(401);
  });
});

describe('Meldungen', () => {
  function setup() {
    const sent: Array<{ url: string; body: { embeds: Array<{ title: string; description: string }>; allowed_mentions: unknown } }> = [];
    const bus = new EventBus();
    const notifier = new DiscordNotifier({
      registry,
      bus,
      fetcher: async (url, init) => {
        sent.push({ url, body: JSON.parse(init.body) });
        return { ok: true, status: 204 };
      },
    });
    registry.setSetting('integrations.discord', { url: HOOK, enabled: true });
    notifier.start();
    return { sent, bus, notifier };
  }
  const state = (bus: InstanceType<typeof EventBus>, id: string, status: 'running' | 'offline' | 'starting', exitCode?: number) =>
    bus.emit({ type: 'state', serverId: id, state: { id, status, ...(exitCode !== undefined ? { exitCode } : {}) }, ts: new Date().toISOString() });
  const wait = () => new Promise((r) => setTimeout(r, 30));

  beforeAll(async () => {
    for (const id of ['n-1', 'n-2', 'selftest-x']) {
      await registry.add({ id, name: id === 'n-1' ? '@everyone Test' : id, game: 'x', executable: 'x', args: [], workingDir: dataDir, ports: [] });
    }
  });

  it('meldet Start, gewollten Stopp und Absturz verschieden', async () => {
    const { sent, bus, notifier } = setup();
    state(bus, 'n-1', 'running');
    registry.audit('server.stop', 'n-1', 'standalone');
    state(bus, 'n-1', 'offline');
    state(bus, 'n-2', 'running');
    state(bus, 'n-2', 'offline', 1);
    await wait();
    notifier.stop();
    const titles = sent.map((s) => s.body.embeds[0]!.title);
    expect(titles).toEqual(expect.arrayContaining(['🟢 Server gestartet: @everyone Test', '⏹️ Server gestoppt: @everyone Test', '🚨 Server abgestürzt: n-2']));
    expect(titles.filter((t) => t.includes('abgestürzt'))).toHaveLength(1);
    // Erwähnungen sind abgeschaltet
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(sent.every((s) => s.url === HOOK)).toBe(true);
  });

  it('bleibt bei Testservern, gelöschten Servern und ausgeschalteten Meldungen still', async () => {
    const { sent, bus, notifier } = setup();
    state(bus, 'selftest-x', 'running');
    state(bus, 'gibt-es-nicht', 'running');
    registry.setSetting('integrations.discord', { url: HOOK, enabled: false });
    state(bus, 'n-2', 'offline');
    state(bus, 'n-2', 'running');
    await wait();
    notifier.stop();
    expect(sent).toHaveLength(0);
  });

  it('meldet Backups, aber nicht ohne Server', async () => {
    const { sent, notifier } = setup();
    registry.audit('backup.create', 'n-2', 'core', { name: 'x', bytes: 5 * 1024 * 1024 });
    registry.audit('backup.failed', 'n-2', 'core', { error: 'voll' });
    registry.audit('backup.create', 'weg', 'core', { bytes: 1 });
    await wait();
    notifier.stop();
    expect(sent.map((s) => s.body.embeds[0]!.title)).toEqual(['💾 Backup erstellt: n-2', '⚠️ Backup fehlgeschlagen: n-2']);
    expect(sent[0]!.body.embeds[0]!.description).toContain('5.0 MB');
  });

  it('Testnachricht geht auch bei ausgeschalteten Meldungen raus; Fehler werden gemeldet', async () => {
    const bus = new EventBus();
    registry.setSetting('integrations.discord', { url: HOOK, enabled: false });
    const ok = new DiscordNotifier({ registry, bus, fetcher: async () => ({ ok: true, status: 204 }) });
    expect(await ok.sendTest('admin')).toBe(true);
    const bad = new DiscordNotifier({ registry, bus, fetcher: async () => ({ ok: false, status: 404 }) });
    expect(await bad.sendTest('admin')).toBe(false);
    const down = new DiscordNotifier({ registry, bus, fetcher: async () => { throw new Error('offline'); } });
    expect(await down.sendTest('admin')).toBe(false);
  });
});
