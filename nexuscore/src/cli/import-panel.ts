import fs from 'node:fs/promises';
import net from 'node:net';
import { config } from '../config/index.js';
import { loadEggs } from '../eggs/loader.js';
import { importPanelData, type ImportReport, type PanelExport } from '../migrate/panel-import.js';
import { LocalAccount } from '../store/account.js';
import { ServerRegistry } from '../store/registry.js';
import { SecretStore } from '../store/secrets.js';
import { SteamAccounts } from '../steam/accounts.js';

/**
 * Datenuebernahme aus dem Panel.
 *
 *   node dist/cli/import-panel.js --export panel-export.json [--panel-key <64 Hex>] [--volumes /var/lib/panel/volumes] [--backups /var/lib/panel/backups] [--copy-backups] [--apply]
 *
 * Ohne --apply ist es ein Trockenlauf: Bericht, nichts wird geschrieben. Den Panel-Schluessel (ENCRYPTION_KEY des Panels)
 * auch ueber die Umgebung `PANEL_ENCRYPTION_KEY` geben - dann steht er nicht in der Befehlszeile.
 * Der Core darf waehrenddessen nicht laufen (gleiche Datenbank).
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

export function printReport(report: ImportReport, out: (line: string) => void = console.log): void {
  const mark = { ok: '  ok ', warn: ' warn', error: 'FEHLER' } as const;
  for (const l of report.lines) out(`${mark[l.level]}  [${l.area}] ${l.message}`);
  out('');
  out(`${report.dryRun ? 'TROCKENLAUF - nichts wurde geschrieben. ' : ''}Fehler: ${report.errors}, Hinweise: ${report.warnings}, ${Object.entries(report.counts).map(([k, v]) => `${k}: ${v}`).join(', ')}`);
}

async function main(): Promise<number> {
  const file = arg('export');
  if (!file) {
    console.error('Aufruf: node dist/cli/import-panel.js --export <datei.json> [--panel-key <hex>] [--volumes <ordner>] [--apply]');
    return 2;
  }
  const apply = process.argv.includes('--apply');
  if (apply && (await listening(config.port))) {
    console.error(`Der Core läuft noch (Port ${config.port}). Bitte zuerst beenden - er und die Übernahme teilen sich die Datenbank.`);
    return 2;
  }
  const data = JSON.parse(await fs.readFile(file, 'utf8')) as PanelExport;
  const registry = await ServerRegistry.open(config.dataDir);
  const account = await LocalAccount.open(config.dataDir);
  const secrets = new SecretStore(registry, { envKey: config.secretKey });
  const steamAccounts = new SteamAccounts(registry, secrets, () => null);
  const panelKey = arg('panel-key') ?? process.env.PANEL_ENCRYPTION_KEY;
  const report = await importPanelData(data, { registry, account, secrets, steamAccounts, eggs: await loadEggs() }, { dryRun: !apply, panelKey, volumesDir: arg('volumes') ?? '/var/lib/panel/volumes', backupsDir: arg('backups') ?? '/var/lib/panel/backups', copyBackups: process.argv.includes('--copy-backups') });
  printReport(report);
  registry.close();
  return report.errors > 0 ? 1 : 0;
}

if (process.argv[1] && /import-panel\.(js|ts)$/.test(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
