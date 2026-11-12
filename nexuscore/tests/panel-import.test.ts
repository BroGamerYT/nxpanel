import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { ServerRegistry } = await import('../src/store/registry.js');
const { LocalAccount, verifyPassword } = await import('../src/store/account.js');
const { SecretStore } = await import('../src/store/secrets.js');
const { SteamAccounts } = await import('../src/steam/accounts.js');
const { loadEggs } = await import('../src/eggs/loader.js');
const { importPanelData, decryptPanelSecret } = await import('../src/migrate/panel-import.js');
const { getAccess } = await import('../src/store/access.js');
const { getServerMeta } = await import('../src/http/routes/settings.js');
const { getNetwork } = await import('../src/network.js');
const { printReport } = await import('../src/cli/import-panel.js');

// Ein von @node-rs/argon2 (wie im Panel) erzeugter Hash fuer "test-passwort-123"
const PANEL_HASH = '$argon2id$v=19$m=19456,t=2,p=1$p2jaK7raGLsrRBWzKLs2gQ$j0OQpPGXfDkCFaMQ4dlRmoRzkH0sIpEJTjEr5TW/T4s';
const KEY = crypto.randomBytes(32).toString('hex');

/** Wie das Panel verschluesselt (src/crypto.ts): v1:<iv>:<tag>:<daten>, base64url, AES-256-GCM. */
function panelEncrypt(plain: string, keyHex = KEY): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const SRV = '33333333-3333-4333-8333-333333333333';

function exportData() {
  return {
    users: [
      { id: U1, username: 'Chef', email: 'chef@example.org', password_hash: PANEL_HASH, role: 'admin', can_create_servers: true, totp_enabled: true, totp_secret: panelEncrypt('JBSWY3DPEHPK3PXP'), totp_last_step: 7, suspended: false, server_limit: 0, ram_limit_mb: 0, disk_limit_mb: 0, created_at: '2026-11-06T10:00:00+01:00', last_login_at: '2026-11-10T10:00:00+01:00', locale: 'de', allowed_eggs: null, avatar: null, steam_id: '76561198000000001', steam_name: 'Chef', global_permissions: ['admin.nodes'] },
      { id: U2, username: 'Helfer', email: null, password_hash: PANEL_HASH, role: 'user', can_create_servers: false, totp_enabled: false, totp_secret: null, totp_last_step: 0, suspended: false, server_limit: 2, ram_limit_mb: 8192, disk_limit_mb: 0, created_at: '2026-11-09T10:00:00+01:00', last_login_at: null, locale: null, allowed_eggs: [], avatar: null, steam_id: null, steam_name: null, global_permissions: [] },
    ],
    passkeys: [{ id: 'pk-1', user_id: U1, credential_id: 'cred-abc', public_key: `\\x${Buffer.from('öffentlicher-schluessel').toString('hex')}`, counter: 5, device_name: 'Handy', transports: ['internal'], created_at: '2026-11-07T10:00:00+01:00', last_used_at: null }],
    nodes: [{ id: 'n1', name: 'local', type: 'local', address: null, public_host: '203.0.113.9', port_from: 28000, port_to: 28998 }],
    eggs: [{ id: 'egg-ts', name: 'TeamSpeak 6' }, { id: 'egg-x', name: 'Gibt es im Core nicht' }],
    servers: [
      { id: SRV, short_id: 'ts6abcd1', name: 'Mein TeamSpeak', owner_id: U1, egg_id: 'egg-ts', docker_image: 'teamspeaksystems/teamspeak6-server:latest', startup: '', ram_mb: 512, cpu_percent: 100, disk_mb: 5120, variables: { TSSERVER_LICENSE_ACCEPTED: 'accept' }, status: 'running', auto_restart: true, auto_sleep_minutes: 0, auto_backup_enabled: false, tags: ['voice'], is_favorite: true, subdomain: 'ts', custom_domain: null, srv_record_enabled: true, bandwidth_download_kbps: null, bandwidth_upload_kbps: null },
      { id: '44444444-4444-4444-8444-444444444444', short_id: 'unknown1', name: 'Fremdes Spiel', owner_id: U1, egg_id: 'egg-x', docker_image: 'x', startup: '', ram_mb: 512, cpu_percent: 100, disk_mb: 1024, variables: {}, status: 'offline', auto_restart: false, auto_sleep_minutes: 0, auto_backup_enabled: false, tags: [], is_favorite: false, subdomain: null, custom_domain: null, srv_record_enabled: true },
    ],
    allocations: [
      { server_id: SRV, port: 28000, protocol: 'udp', ref: 'voice', is_primary: true },
      { server_id: SRV, port: 28001, protocol: 'tcp', ref: 'files', is_primary: false },
      { server_id: SRV, port: 28002, protocol: 'tcp', ref: 'query', is_primary: false },
      { server_id: SRV, port: 28099, protocol: 'tcp', ref: 'seltsam', is_primary: false },
    ],
    subusers: [{ server_id: SRV, user_id: U2, permissions: ['control.start', 'control.console', 'file.read', 'gibt.es.nicht'] }],
    server_schedules: [{ server_id: SRV, name: 'Nachts neu starten', action: 'restart', payload: null, cron: '0 4 * * *', interval_minutes: null, active: true }],
    steam_accounts: [{ id: '55555555-5555-4555-8555-555555555555', owner_id: U1, label: 'Mein Konto', account_name: 'chef_steam', encrypted_password: panelEncrypt('steam-pw-geheim-1'), steam_id: null, is_shared: false, last_used_at: null, created_at: '2026-11-09T10:00:00+01:00' }],
    panel_settings: [{ key: 'curseforge_api_key', value: panelEncrypt('cf-key-geheim-123456'), encrypted: true }, { key: 'komische_einstellung', value: 'x', encrypted: false }],
    backups: [{ id: 'b1' }, { id: 'b2' }],
    recovery_codes: [{ id: 'r1' }],
    sftp_passwords: [],
  };
}

let dir: string;
let volumes: string;
let registry: InstanceType<typeof ServerRegistry>;
let account: Awaited<ReturnType<typeof LocalAccount.open>>;
let secrets: InstanceType<typeof SecretStore>;
let steamAccounts: InstanceType<typeof SteamAccounts>;
let eggs: Awaited<ReturnType<typeof loadEggs>>;
const deps = () => ({ registry, account, secrets, steamAccounts, eggs });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-panelimport-'));
  volumes = path.join(dir, 'panel-volumes');
  await fs.mkdir(path.join(volumes, 'ts6abcd1'), { recursive: true });
  await fs.writeFile(path.join(volumes, 'ts6abcd1', 'ts3server.sqlitedb'), 'daten');
  registry = await ServerRegistry.open(path.join(dir, 'core'));
  account = await LocalAccount.open(path.join(dir, 'core'));
  secrets = new SecretStore(registry, { envKey: crypto.randomBytes(32).toString('hex') });
  steamAccounts = new SteamAccounts(registry, secrets, () => null);
  eggs = await loadEggs();
});
afterAll(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('Passwörter und Geheimnisse des Panels', () => {
  it('argon2id-Hashes des Panels gelten im Core weiter; falsche Passwörter und Müll nicht', async () => {
    expect(await verifyPassword('test-passwort-123', PANEL_HASH)).toBe(true);
    expect(await verifyPassword('falsches-passwort', PANEL_HASH)).toBe(false);
    expect(await verifyPassword('test-passwort-123', '$argon2id$v=19$m=19456,t=2,p=1$AAAA$BBBB')).toBe(false);
    expect(await verifyPassword('x', '$argon2id$kaputt')).toBe(false);
  });
  it('entschlüsselt das Panel-Format und lehnt falschen Schlüssel und Manipulation ab', () => {
    const c = panelEncrypt('geheim');
    expect(decryptPanelSecret(c, KEY)).toBe('geheim');
    expect(() => decryptPanelSecret(c, crypto.randomBytes(32).toString('hex'))).toThrow();
    expect(() => decryptPanelSecret(`${c.slice(0, -2)}AA`, KEY)).toThrow();
    expect(() => decryptPanelSecret(c, 'kurz')).toThrow(/64 Hex/);
  });
});

describe('Übernahme', () => {
  it('Trockenlauf: Bericht, aber nichts geschrieben', async () => {
    const before = account.list().length;
    const report = await importPanelData(exportData(), deps(), { dryRun: true, panelKey: KEY, volumesDir: volumes });
    expect(report.dryRun).toBe(true);
    expect(report.counts).toMatchObject({ users: 2, servers: 1, steamAccounts: 1 });
    expect(account.list()).toHaveLength(before);
    expect(registry.list()).toHaveLength(0);
    expect(steamAccounts.list({ id: null, username: 'x', admin: true })).toHaveLength(0);
    expect(getNetwork(registry).publicHost).toBeNull();
    expect(secrets.status('curseforge')).toBe('missing');
  });

  it('Bericht nennt, was nicht oder nur halb ging', async () => {
    const lines: string[] = [];
    const report = await importPanelData(exportData(), deps(), { dryRun: true, panelKey: KEY, volumesDir: volumes });
    printReport(report, (l) => lines.push(l));
    const text = lines.join('\n');
    expect(text).toContain('Das Spiel "Gibt es im Core nicht" kennt der Core nicht');
    expect(text).toContain('Port 28099 (seltsam)');
    expect(text).toContain('Automatischer Neustart');
    expect(text).toContain('2 Backups werden noch nicht übernommen');
    expect(text).toContain('Wiederherstellungscodes');
    expect(text).toContain('Einstellung "komische_einstellung"');
    expect(text).toContain('Zwei-Faktor');
  });

  it('übernimmt Benutzer mit Passwort, Rolle, Rechten, Passkey und Zwei-Faktor', async () => {
    const report = await importPanelData(exportData(), deps(), { dryRun: false, panelKey: KEY, volumesDir: volumes });
    expect(report.errors).toBe(1); // das unbekannte Spiel
    const chef = account.list().find((u) => u.username === 'Chef')!;
    expect(chef).toMatchObject({ id: U1, role: 'admin', canCreateServers: true, email: 'chef@example.org', totpEnabled: true, steamId: '76561198000000001', globalPermissions: ['admin.nodes'], locale: 'de' });
    const helper = account.list().find((u) => u.username === 'Helfer')!;
    expect(helper).toMatchObject({ role: 'user', serverLimit: 2, ramLimitMb: 8192, allowedEggs: [] });
    // Anmelden mit dem alten Passwort
    expect((await account.verify('Chef', 'test-passwort-123', '127.0.0.1'))?.username).toBe('Chef');
    expect(await account.verify('Chef', 'falsch-falsch-123', '127.0.0.2')).toBeNull();
    const users = JSON.parse(await fs.readFile(path.join(dir, 'core', 'users.json'), 'utf8')).users as Array<{ username: string; passkeys?: Array<{ credentialId: string; publicKey: string }>; totp?: { secret: string; lastStep: number } }>;
    const raw = users.find((u) => u.username === 'Chef')!;
    expect(raw.passkeys?.[0]).toMatchObject({ credentialId: 'cred-abc', publicKey: Buffer.from('öffentlicher-schluessel').toString('base64url') });
    expect(raw.totp).toEqual({ secret: 'JBSWY3DPEHPK3PXP', lastStep: 7 });
  });

  it('Netzwerk, Einstellungen und Steam-Konto: neu verschlüsselt im Core', () => {
    expect(getNetwork(registry)).toMatchObject({ publicHost: '203.0.113.9', portFrom: 28000, portTo: 28998 });
    expect(secrets.get('curseforge')).toBe('cf-key-geheim-123456');
    const steam = steamAccounts.list({ id: null, username: 'x', admin: true });
    expect(steam).toHaveLength(1);
    expect(steam[0]).toMatchObject({ accountName: 'chef_steam', hasPassword: true, guardStatus: 'none', ownerName: 'Chef' });
    expect(steamAccounts.credentials({ id: null, username: 'x', admin: true }, steam[0]!.id)).toEqual({ username: 'chef_steam', password: 'steam-pw-geheim-1' });
    expect(JSON.stringify(registry.getSetting('steam.accounts'))).not.toContain('steam-pw');
    expect(JSON.stringify(registry.getSetting('secret.curseforge'))).not.toContain('cf-key');
  });

  it('Server: Spiel, Image, Ports in der Reihenfolge des Eggs, Ordner des Panels, Besitzer, Mitnutzer, Merkmale', () => {
    const c = registry.get('ts6abcd1')!;
    expect(c).toMatchObject({ name: 'Mein TeamSpeak', game: 'teamspeak6', maxMemoryMb: 512, workingDir: path.join(volumes, 'ts6abcd1') });
    expect(c.container?.image).toBe('teamspeaksystems/teamspeak6-server:latest');
    expect(c.ports.map((p) => `${p.name}:${p.hostPort}/${p.protocol}`)).toEqual(['voice:28000/udp', 'files:28001/tcp', 'query:28002/tcp']);
    expect(c.env?.TSSERVER_LICENSE_ACCEPTED).toBe('accept');
    const access = getAccess(registry, 'ts6abcd1');
    expect(access.ownerId).toBe(U1);
    expect(access.subuserFlags ?? {}).toBeDefined();
    expect(getServerMeta(registry, 'ts6abcd1')).toMatchObject({ tags: ['voice'], isFavorite: true, diskMb: 5120, subdomain: 'ts', srvRecordEnabled: true });
    expect(registry.recentAudit({ serverId: 'ts6abcd1' }).some((a) => a.action === 'server.import_panel')).toBe(true);
    expect(registry.get('unknown1')).toBeUndefined();
  });

  it('noch einmal: nichts doppelt, nichts überschrieben', async () => {
    const usersBefore = account.list().length;
    const report = await importPanelData(exportData(), deps(), { dryRun: false, panelKey: KEY, volumesDir: volumes });
    expect(account.list()).toHaveLength(usersBefore);
    expect(registry.list()).toHaveLength(1);
    expect(steamAccounts.list({ id: null, username: 'x', admin: true })).toHaveLength(1);
    expect(report.lines.filter((l) => l.level === 'warn').map((l) => l.message).join('\n')).toContain('übersprungen');
  });

  it('falscher Panel-Schlüssel: Fehler statt stiller Lücken; ohne Schlüssel: Hinweis', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-panelimport2-'));
    const reg2 = await ServerRegistry.open(other);
    const acc2 = await LocalAccount.open(other);
    const sec2 = new SecretStore(reg2, { envKey: crypto.randomBytes(32).toString('hex') });
    const d2 = { registry: reg2, account: acc2, secrets: sec2, steamAccounts: new SteamAccounts(reg2, sec2, () => null), eggs };
    const wrong = await importPanelData(exportData(), d2, { dryRun: true, panelKey: crypto.randomBytes(32).toString('hex'), volumesDir: volumes });
    expect(wrong.lines.some((l) => l.level === 'error' && l.message.includes('nicht lesbar'))).toBe(true);
    const none = await importPanelData(exportData(), d2, { dryRun: true, volumesDir: volumes });
    expect(none.lines.some((l) => l.message.includes('kein Panel-Schlüssel'))).toBe(true);
    reg2.close();
    await fs.rm(other, { recursive: true, force: true });
  });
});
