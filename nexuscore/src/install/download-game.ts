import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { extractZip } from '../files/archive.js';
import { isInside } from '../protocol/paths.js';
import type { ServerInstanceConfig, SteamLaunch } from '../types.js';
import { downloadFile, type FetchLike } from './download.js';
import { listPrograms, resolveArgs, steamValues, writeSteamFiles } from './steam-game.js';
import { resolveSource } from './sources.js';

/**
 * Ein Spiel aus einem Archiv installieren (Terraria, TeamSpeak, Bedrock ...): laden, pruefen, auspacken,
 * einrichten. Die Vorlage (`windows.download.source`) waehlt nur die Quelle - siehe sources.ts.
 */

export interface DownloadInstallInput {
  serverDir: string;
  runtimesDir: string;
  launch: SteamLaunch;
  variables: Record<string, string>;
  ports: ServerInstanceConfig['ports'];
  ramMb: number;
  serverName: string;
}

export interface DownloadInstallHooks {
  onProgress?: (fraction: number, message: string) => void;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface DownloadInstallResult {
  executable: string;
  args: string[];
  version: string;
  sha256: string;
}

/**
 * Verschiebt den Inhalt von `from` nach `to`; vorhandene Dateien werden ueberschrieben, Ordner zusammengefuehrt.
 * Dateien in `keep` (relativ, mit /) bleiben, wenn es sie schon gibt - Einstellungen und Listen des Servers.
 */
async function moveContents(from: string, to: string, keep: ReadonlySet<string>, rel = ''): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const here = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await moveContents(source, target, keep, here);
    } else if (keep.has(here.toLowerCase()) && (await fs.access(target).then(() => true, () => false))) {
      continue;
    } else {
      await fs.rm(target, { force: true });
      await fs.rename(source, target);
    }
  }
}

const mb = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(0);

export async function installDownloadGame(input: DownloadInstallInput, hooks: DownloadInstallHooks = {}): Promise<DownloadInstallResult> {
  const { launch } = input;
  const spec = launch.download;
  if (!spec) throw new Error('Für dieses Spiel fehlen die Download-Angaben im Egg.');
  const progress = hooks.onProgress ?? (() => {});

  progress(0.02, 'Prüfe die aktuelle Version');
  const source = await resolveSource(spec.source, {
    ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    ...(hooks.env ? { env: hooks.env } : {}),
  });
  hooks.onLine?.(`${source.label}: ${source.url}`);

  const archive = path.join(input.runtimesDir, 'downloads', `${spec.source}-${source.version}.zip`);
  const downloaded = await downloadFile(source.url, archive, {
    sha256: source.sha256,
    // Nur wo der Hersteller keine Summe veroeffentlicht - sie steht dann im Protokoll
    allowUnpinned: source.sha256 === null,
    allowedHosts: source.allowedHosts,
    maxBytes: 2 * 1024 ** 3,
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
    onProgress: (done, total) => {
      const frac = total ? done / total : 0;
      progress(0.05 + 0.6 * frac, `Lade ${source.label}: ${mb(done)} von ${total ? mb(total) : '?'} MB`);
    },
  });
  hooks.onLine?.(
    source.sha256
      ? `Prüfsumme stimmt (SHA-256 ${downloaded.sha256})`
      : `Der Hersteller veröffentlicht keine Prüfsumme. SHA-256 dieser Datei: ${downloaded.sha256} (mit NEXUSCORE_${spec.source.toUpperCase()}_SHA256 festlegbar)`,
  );

  // In einen eigenen Ordner auspacken, dann in den Server-Ordner schieben: so bleibt ein halbes Auspacken ohne Folgen
  progress(0.7, 'Packe aus');
  await fs.mkdir(input.serverDir, { recursive: true });
  const scratch = path.join(input.serverDir, `.nx-extract-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await fs.mkdir(scratch, { recursive: true });
    const extracted = await extractZip(archive, scratch);
    if (extracted.skipped > 0) hooks.onLine?.(`${extracted.skipped} unsichere Einträge im Archiv wurden übersprungen`);
    let from = scratch;
    if (spec.stripTop) {
      const top = await fs.readdir(scratch, { withFileTypes: true });
      if (top.length === 1 && top[0]!.isDirectory()) from = path.join(scratch, top[0]!.name);
    }
    progress(0.9, 'Kopiere in den Server-Ordner');
    const keep = new Set((spec.keep ?? []).map((k) => k.split('\\').join('/').toLowerCase()));
    await moveContents(from, input.serverDir, keep);
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  for (const dir of spec.mkdirs ?? []) {
    const full = path.resolve(input.serverDir, dir);
    if (!isInside(path.resolve(input.serverDir), full)) throw new Error(`Ordner außerhalb des Server-Ordners: ${dir}`);
    await fs.mkdir(full, { recursive: true });
  }

  const executable = path.resolve(input.serverDir, launch.executable);
  if (!isInside(path.resolve(input.serverDir), executable)) throw new Error('Programm außerhalb des Server-Ordners.');
  await fs.access(executable).catch(async () => {
    const found = await listPrograms(input.serverDir).catch(() => [] as string[]);
    throw new Error(
      `Nach der Installation fehlt ${launch.executable}.` +
        (found.length ? ` Gefundene Programme: ${found.join(', ')}` : ' Es wurden keine Programme (.exe) gefunden.'),
    );
  });

  progress(0.97, 'Schreibe Einstellungen');
  const values = steamValues({ ports: input.ports, maxMemoryMb: input.ramMb, name: input.serverName }, input.variables);
  await writeSteamFiles(input.serverDir, launch.files ?? [], values);
  progress(1, 'Fertig');
  return { executable, args: resolveArgs(launch.args, values), version: source.version, sha256: downloaded.sha256 };
}
