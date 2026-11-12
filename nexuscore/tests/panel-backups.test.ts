import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { ServerRegistry } = await import('../src/store/registry.js');
const { LocalAccount } = await import('../src/store/account.js');
const { SecretStore } = await import('../src/store/secrets.js');
const { SteamAccounts } = await import('../src/steam/accounts.js');
const { loadEggs } = await import('../src/eggs/loader.js');
const { importPanelData } = await import('../src/migrate/panel-import.js');
const { BackupManager, compression } = await import('../src/backups/manager.js');
const { serverRootFor } = await import('../src/protocol/paths.js');
const { tarBinary } = await import('../src/platform/index.js');

const U1 = '11111111-1111-4111-8111-111111111111';
const SRV = '33333333-3333-4333-8333-333333333333';
const B_OK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_BAD_SIZE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const B_MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const B_FAILED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let dir: string;
let registry: InstanceType<typeof ServerRegistry>;
let account: Awaited<ReturnType<typeof LocalAccount.open>>;
let secrets: InstanceType<typeof SecretStore>;
let steamAccounts: InstanceType<typeof SteamAccounts>;
let eggs: Awaited<ReturnType<typeof loadEggs>>;
let panelBackups: string;
let archivePath: string;
let archiveSha: string;
let archiveSize: number;

/** Legt ein echtes .tar.zst an - nur wenn das tar dieses Rechners zstd kann. */
function makeZst(srcDir: string, out: string): boolean {
  const r = spawnSync(tarBinary(), ['--zstd', '-cf', out, '-C', srcDir, '.'], { encoding: 'utf8' });
  return r.status === 0;
}
// Schon beim Einlesen der Datei klaeren (fuer skipIf): kann das tar dieses Rechners zstd?
const zstdOk = ((): boolean => {
  const probe = fsSync.mkdtempSync(path.join(os.tmpdir(), 'nx-zstdprobe-'));
  try {
    fsSync.writeFileSync(path.join(probe, 'a.txt'), 'a');
    return makeZst(probe, path.join(os.tmpdir(), `nx-zstdprobe-${path.basename(probe)}.tar.zst`));
  } finally {
    fsSync.rmSync(probe, { recursive: true, force: true });
  }
})();

const rows = () => [
  { id: B_OK, server_id: SRV, name: 'Vor Server-Update', filename: 'Vor-Server-Update.tar.zst', bytes: archiveSize, checksum: archiveSha, locked: true, status: 'completed', ignored_files: ['cache'], created_at: '2026-11-08T13:06:00+01:00', completed_at: '2026-11-08T13:07:00+01:00', verification_status: 'valid', verified_at: '2026-11-08T13:10:00+01:00' },
  { id: B_BAD_SIZE, server_id: SRV, name: 'Zu klein', filename: 'x.tar.zst', bytes: archiveSize + 5, checksum: archiveSha, locked: false, status: 'completed', created_at: '2026-11-09T10:00:00+01:00' },
  { id: B_MISSING, server_id: SRV, name: 'Datei weg', filename: 'y.tar.zst', bytes: 10, checksum: 'x', locked: false, status: 'completed', created_at: '2026-11-09T10:00:00+01:00' },
  { id: B_FAILED, server_id: SRV, name: 'Fehlgeschlagen', filename: 'z.tar.zst', bytes: 0, checksum: null, locked: false, status: 'failed', created_at: '2026-11-09T10:00:00+01:00' },
];
const exportData = () => ({
  users: [{ id: U1, username: 'Chef', password_hash: '$argon2id$v=19$m=19456,t=2,p=1$p2jaK7raGLsrRBWzKLs2gQ$j0OQpPGXfDkCFaMQ4dlRmoRzkH0sIpEJTjEr5TW/T4s', role: 'admin', created_at: '2026-11-06T10:00:00+01:00' }],
  eggs: [{ id: 'egg-ts', name: 'TeamSpeak 6' }],
  servers: [{ id: SRV, short_id: 'bkpsrv01', name: 'Mit Backups', owner_id: U1, egg_id: 'egg-ts', docker_image: 'teamspeaksystems/teamspeak6-server:latest', startup: '', ram_mb: 512, cpu_percent: 100, disk_mb: 5120, variables: {}, status: 'offline', auto_restart: false, tags: [], is_favorite: false },
  ],
  allocations: [
    { server_id: SRV, port: 28100, protocol: 'udp', ref: 'voice' },
    { server_id: SRV, port: 28101, protocol: 'tcp', ref: 'files' },
    { server_id: SRV, port: 28102, protocol: 'tcp', ref: 'query' },
  ],
  backups: rows(),
});

const deps = () => ({ registry, account, secrets, steamAccounts, eggs });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-panelbackups-'));
  registry = await ServerRegistry.open(path.join(dir, 'core'));
  account = await LocalAccount.open(path.join(dir, 'core'));
  secrets = new SecretStore(registry, { envKey: crypto.randomBytes(32).toString('hex') });
  steamAccounts = new SteamAccounts(registry, secrets, () => null);
  eggs = await loadEggs();

  // Der Server-Ordner des "Panels" liegt im Server-Verzeichnis des Cores (so wie NEXUSCORE_SERVER_ROOT es auf dem Panel-Rechner einrichtet)
  const serverDir = path.join(serverRootFor(registry.dir), 'bkpsrv01');
  await fs.mkdir(serverDir, { recursive: true });
  await fs.writeFile(path.join(serverDir, 'alt.txt'), 'wird ueberschrieben');

  const content = path.join(dir, 'inhalt');
  await fs.mkdir(content, { recursive: true });
  await fs.writeFile(path.join(content, 'ts3server.sqlitedb'), 'datenbank-inhalt');
  await fs.writeFile(path.join(content, 'files.txt'), 'dateien');
  panelBackups = path.join(dir, 'panel-backups', SRV);
  await fs.mkdir(panelBackups, { recursive: true });
  archivePath = path.join(panelBackups, `${B_OK}.tar.zst`);
  if (!makeZst(content, archivePath)) await fs.writeFile(archivePath, 'kein zstd auf diesem Rechner');
  const buf = await fs.readFile(archivePath);
  archiveSha = crypto.createHash('sha256').update(buf).digest('hex');
  archiveSize = buf.length;
  await fs.copyFile(archivePath, path.join(panelBackups, `${B_BAD_SIZE}.tar.zst`));
});
afterAll(async () => {
  registry.close();
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(serverRootFor(path.join(dir, 'core')), 'bkpsrv01'), { recursive: true, force: true }).catch(() => {});
});

const opts = (extra: Record<string, unknown> = {}) => ({ dryRun: false, volumesDir: serverRootFor(registry.dir), backupsDir: path.join(dir, 'panel-backups'), ...extra });

describe('Backups aus dem Panel', () => {
  it('Kompression nach Endung: .zst → zstd, sonst gzip', () => {
    expect(compression('/x/abc.tar.zst')).toEqual(['--zstd']);
    expect(compression('/x/abc.tar.gz')).toEqual(['-z']);
  });

  it('Trockenlauf: Bericht, aber weder Zeile noch Datei', async () => {
    const report = await importPanelData(exportData(), deps(), opts({ dryRun: true }));
    expect(report.counts.backups).toBe(1);
    expect(registry.listBackups('bkpsrv01')).toHaveLength(0);
    expect(registry.get('bkpsrv01')).toBeUndefined();
    const text = report.lines.map((l) => l.message).join('\n');
    expect(text).toContain('Vor Server-Update');
    await expect(fs.stat(path.join(registry.dir, 'backups', 'bkpsrv01', `${B_OK}.tar.zst`))).rejects.toThrow();
  });

  it('übernimmt das Backup (verknüpft, ohne Kopie); Größe, fehlende Datei und Fehlgeschlagenes werden gemeldet', async () => {
    const report = await importPanelData(exportData(), deps(), opts());
    const text = report.lines.map((l) => `${l.level}:${l.message}`).join('\n');
    expect(report.counts.backups).toBe(1);
    expect(text).toContain('error:Zu klein');
    expect(text).toContain('Größe stimmt nicht');
    expect(text).toContain('warn:Datei weg');
    expect(text).toContain('Status "failed"');
    const row = registry.getBackup(B_OK)!;
    expect(row).toMatchObject({ server_id: 'bkpsrv01', name: 'Vor Server-Update', filename: 'Vor-Server-Update.tar.zst', bytes: archiveSize, checksum: archiveSha, locked: true, status: 'completed', verification_status: 'valid', ignored_files: ['cache'] });
    expect(registry.listBackups('bkpsrv01')).toHaveLength(1);
    const target = path.join(registry.dir, 'backups', 'bkpsrv01', `${B_OK}.tar.zst`);
    const [a, b] = await Promise.all([fs.stat(archivePath), fs.stat(target)]);
    expect(b.size).toBe(a.size);
    if (a.ino && b.ino) expect(b.ino).toBe(a.ino); // harte Verknüpfung: kein zweites Exemplar
  });

  it.skipIf(!zstdOk)('das Core-Backup-System prüft und stellt ein übernommenes .tar.zst wieder her', async () => {
    const manager = new BackupManager({ registry, isStopped: async () => true, gameName: async () => 'TeamSpeak 6' });
    const v = await manager.verify('bkpsrv01', B_OK);
    expect(v).toMatchObject({ status: 'valid', sha256Match: true, archiveIntact: true });
    expect(v.criticalFilesFound.length).toBeGreaterThan(0);
    await manager.restore('bkpsrv01', B_OK);
    const dest = path.join(serverRootFor(registry.dir), 'bkpsrv01');
    expect(await fs.readFile(path.join(dest, 'ts3server.sqlitedb'), 'utf8')).toBe('datenbank-inhalt');
    expect(await fs.readFile(path.join(dest, 'files.txt'), 'utf8')).toBe('dateien');
  });

  it('eine veränderte Datei wird bei der Prüfung erkannt', async () => {
    const manager = new BackupManager({ registry, isStopped: async () => true, gameName: async () => 'TeamSpeak 6' });
    const target = path.join(registry.dir, 'backups', 'bkpsrv01', `${B_OK}.tar.zst`);
    // Die Verknüpfung teilt die Datei mit dem "Panel": eine Kopie veraendern, damit nichts anderes mitleidet
    const copy = `${target}.kopie`;
    await fs.copyFile(target, copy);
    await fs.rm(target);
    await fs.rename(copy, target);
    await fs.appendFile(target, 'x');
    const v = await manager.verify('bkpsrv01', B_OK);
    expect(v.status).toBe('corrupted');
    expect(v.sha256Match).toBe(false);
  });

  it('wiederholt: nichts doppelt; Kopiermodus legt eine eigene Datei an', async () => {
    const again = await importPanelData(exportData(), deps(), opts());
    expect(again.counts.backups ?? 0).toBe(0);
    expect(again.lines.map((l) => l.message).join('\n')).toContain('gibt es im Core schon');

    registry.deleteBackup(B_OK);
    await fs.rm(path.join(registry.dir, 'backups', 'bkpsrv01', `${B_OK}.tar.zst`), { force: true });
    const copied = await importPanelData(exportData(), deps(), opts({ copyBackups: true }));
    expect(copied.counts.backups).toBe(1);
    const [a, b] = await Promise.all([fs.stat(archivePath), fs.stat(path.join(registry.dir, 'backups', 'bkpsrv01', `${B_OK}.tar.zst`))]);
    expect(b.size).toBe(a.size);
    if (a.ino && b.ino) expect(b.ino).not.toBe(a.ino);
  });

  it('liegt der Server-Ordner außerhalb des Server-Verzeichnisses, steht der Hinweis auf NEXUSCORE_SERVER_ROOT im Bericht', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-panelbackups2-'));
    const reg2 = await ServerRegistry.open(other);
    const acc2 = await LocalAccount.open(other);
    const sec2 = new SecretStore(reg2, { envKey: crypto.randomBytes(32).toString('hex') });
    const report = await importPanelData(exportData(), { registry: reg2, account: acc2, secrets: sec2, steamAccounts: new SteamAccounts(reg2, sec2, () => null), eggs }, { dryRun: true, volumesDir: path.join(other, 'anderswo'), backupsDir: path.join(dir, 'panel-backups') });
    expect(report.lines.map((l) => l.message).join('\n')).toContain('NEXUSCORE_SERVER_ROOT=');
    reg2.close();
    await fs.rm(other, { recursive: true, force: true });
  });
});
