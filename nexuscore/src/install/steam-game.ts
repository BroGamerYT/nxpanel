import fs from 'node:fs/promises';
import path from 'node:path';
import { isInside } from '../protocol/paths.js';
import type { ServerInstanceConfig, SteamArg, SteamFile, SteamLaunch } from '../types.js';
import { patchIniFile, patchXmlFile, patchYamlFile, type ConfigValue, type YamlRaw } from './config-formats.js';
import { substitute } from './properties.js';
import { ensureSteamCmd, installSteamApp, type SteamCmdHooks, type SteamRunner } from './steamcmd.js';

/**
 * Ein Steam-Spiel (Windows-Server ueber SteamCMD) installieren und vor jedem
 * Start einrichten (Block B2, Teil 2).
 *
 * Was ein Spiel braucht, steht im Egg unter `windows`: App-ID, Programm,
 * Startargumente und die Konfigurationsdateien, die der Core aus den
 * Variablen schreibt. Platzhalter wie `{{SERVER_NAME}}` und `{{PORT_GAME}}`
 * werden bei jedem Start neu eingesetzt - so wirken geaenderte Ports und
 * Einstellungen ohne Neuinstallation.
 */

/** Werte fuer Platzhalter: Variablen des Eggs plus Ports (`PORT_<NAME>`, `SERVER_PORT` = Spielport). */
export function steamValues(
  c: Pick<ServerInstanceConfig, 'ports' | 'maxMemoryMb' | 'name'> & { workingDir?: string | undefined },
  variables: Record<string, string>,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(variables)) values[k.toUpperCase()] = v;
  for (const port of c.ports) {
    const n = port.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    // PORT_GAME und GAME_PORT: Eggs benutzen beide Schreibweisen (RCON_PORT, QUERY_PORT ...)
    values[`PORT_${n}`] = String(port.hostPort);
    values[`${n}_PORT`] = String(port.hostPort);
  }
  const game = c.ports.find((p) => p.name === 'game') ?? c.ports[0];
  if (game) values['SERVER_PORT'] = String(game.hostPort);
  values['MAX_MEMORY_MB'] = String(c.maxMemoryMb ?? 0);
  // Absoluter Ordner des Servers - manche Spiele finden Dateien nur ueber vollstaendige Pfade (Arma Reforger)
  if (c.workingDir) values['SERVER_DIR'] = path.resolve(c.workingDir);
  values['SERVER_NAME'] ??= c.name;
  return values;
}

/** `VAR` (gesetzt), `VAR=wert` oder `VAR!=wert` - Gross-/Kleinschreibung egal. */
export function conditionHolds(expr: string, values: Record<string, string>): boolean {
  const m = /^\s*([A-Za-z0-9_]+)\s*(!=|=)?\s*(.*?)\s*$/.exec(expr);
  if (!m) return false;
  const actual = (values[m[1]!.toUpperCase()] ?? '').trim();
  if (m[2] === undefined) return actual !== '';
  const same = actual.toLowerCase() === m[3]!.toLowerCase();
  return m[2] === '=' ? same : !same;
}

/**
 * Startargumente aus den Vorlagen. Leere Ergebnisse (nicht gesetzte Variable) fallen weg;
 * eine Gruppe mit `when` gilt nur, wenn ihre Bedingung stimmt.
 */
export function resolveArgs(templates: SteamArg[], values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const a of templates) {
    if (typeof a === 'string') out.push(substitute(a, values));
    else if (conditionHolds(a.when, values)) out.push(...a.args.map((x) => substitute(x, values)));
  }
  return out.filter((a) => a !== '');
}

// ------------------------------------------------------------------ Dateien schreiben

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur = obj;
  for (const key of parts.slice(0, -1)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
    const next = cur[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1]!;
  if (last === '__proto__' || last === 'constructor' || last === 'prototype') return;
  cur[last] = value;
}

function resolveValue(raw: SteamFile['set'][string], values: Record<string, string>): string | number | boolean {
  if (typeof raw === 'string') return substitute(raw, values);
  const text = substitute(raw.$number ?? raw.$boolean ?? '', values).trim();
  if (raw.$boolean !== undefined) return /^(true|1|yes|ja)$/i.test(text);
  const n = Number(text);
  if (text === '' || !Number.isFinite(n)) throw new Error(`„${text}“ ist keine Zahl (Vorlage ${raw.$number}).`);
  return n;
}

/** Programme (.exe) bis vier Ebenen tief - fuer die Fehlermeldung bei falschem Programmnamen. */
export async function listPrograms(dir: string, max = 15): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, depth: number): Promise<void> => {
    if (out.length >= max || depth > 4) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= max) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await walk(full, depth + 1);
      else if (entry.isFile() && /\.exe$/i.test(entry.name) && !/^(unins|vc_redist|vcredist|dxsetup|crashreport|ue4prereq)/i.test(entry.name)) {
        out.push(path.relative(dir, full).split(path.sep).join('/'));
      }
    }
  };
  await walk(dir, 0);
  return out;
}

/** Setzt Schluessel in einer JSON-Datei; andere Schluessel bleiben, eine kaputte Datei wird neu angelegt. */
export function patchJsonFile(existing: string | null, set: SteamFile['set'], values: Record<string, string>): string {
  let doc: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
    } catch {
      /* neu anlegen */
    }
  }
  for (const [key, raw] of Object.entries(set)) setPath(doc, key, resolveValue(raw, values));
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Zerlegt "A=1,B=\"x,y\",C=(D=1,E=2)" an den Kommas ausserhalb von Anfuehrungszeichen und Klammern. */
export function splitOptions(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  const push = (end: number) => {
    const piece = body.slice(start, end);
    const eq = piece.indexOf('=');
    if (eq > 0) out.push([piece.slice(0, eq).trim(), piece.slice(eq + 1).trim()]);
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === '(') depth++;
    else if (!quoted && ch === ')') depth--;
    else if (!quoted && depth === 0 && ch === ',') {
      push(i);
      start = i + 1;
    }
  }
  push(body.length);
  return out;
}

/**
 * Unreal-Engine-Einstellungen (Palworld): `[Abschnitt]` / `Schluessel=(A=1,B="x")`.
 * Aendert nur die genannten Optionen, behaelt die anderen und alle uebrigen Zeilen.
 */
export function patchUnrealOptions(existing: string | null, section: string, key: string, set: SteamFile['set'], values: Record<string, string>): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing ? existing.split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  let sectionAt = lines.findIndex((l) => l.trim().toLowerCase() === `[${section}]`.toLowerCase());
  if (sectionAt < 0) {
    if (lines.length) lines.push('');
    lines.push(`[${section}]`);
    sectionAt = lines.length - 1;
  }
  let end = lines.length;
  for (let i = sectionAt + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  let keyAt = -1;
  for (let i = sectionAt + 1; i < end; i++) {
    if (new RegExp(`^\\s*${key}\\s*=`, 'i').test(lines[i]!)) keyAt = i;
  }

  let options: Array<[string, string]> = [];
  if (keyAt >= 0) {
    const m = /=\s*\((.*)\)\s*$/.exec(lines[keyAt]!);
    // Leere Werte ("Name=,") sind ungueltig - Reste aus frueheren Staenden entfernen
    if (m) options = splitOptions(m[1]!).filter(([, v]) => v !== '');
  }
  for (const [name, raw] of Object.entries(set)) {
    const value = resolveValue(raw, values);
    // Text steht in Anfuehrungszeichen, Zahlen und Wahrheitswerte nicht - die Vorlage entscheidet ueber \" selbst
    const text = typeof value === 'boolean' ? (value ? 'True' : 'False') : String(value);
    // Ohne Wert (Variable fehlt im Egg) bleibt die Option, wie sie ist - "Name=," ist keine gueltige Einstellung
    if (text === '') continue;
    const at = options.findIndex(([k]) => k === name);
    if (at >= 0) options[at] = [name, text];
    else options.push([name, text]);
  }
  const line = `${key}=(${options.map(([k, v]) => `${k}=${v}`).join(',')})`;
  if (keyAt >= 0) lines[keyAt] = line;
  else lines.splice(end, 0, line);
  return lines.join(eol) + eol;
}

/** Der neue Inhalt einer Konfigurationsdatei: der alte Stand mit den Werten aus der Vorlage. */
export function renderConfig(file: SteamFile, existing: string | null, values: Record<string, string>): string {
  switch (file.format) {
    case 'json':
      return patchJsonFile(existing, file.set, values);
    case 'unreal-options':
      return patchUnrealOptions(existing, file.section ?? '', file.key ?? 'OptionSettings', file.set, values);
    case 'ini': {
      const set: Record<string, ConfigValue> = {};
      for (const [k, raw] of Object.entries(file.set)) set[k] = resolveValue(raw, values);
      return patchIniFile(existing, file.section, set);
    }
    case 'xml': {
      const set: Record<string, ConfigValue> = {};
      for (const [k, raw] of Object.entries(file.set)) set[k] = resolveValue(raw, values);
      return patchXmlFile(existing, file.root ?? 'config', set);
    }
    case 'yaml': {
      const set: Record<string, YamlRaw> = {};
      for (const [k, raw] of Object.entries(file.set)) set[k] = { raw: typeof raw !== 'string', value: resolveValue(raw, values) };
      return patchYamlFile(existing, set);
    }
    case 'text': {
      // Ganze Datei aus einer Vorlage. Werte werden einzeilig: ein Servername darf keine neue Zeile (Einstellung) einschleusen.
      const oneLine: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) oneLine[k] = v.replace(/[\r\n]+/g, ' ');
      return substitute(file.content ?? '', oneLine).replace(/\r?\n/g, '\n').replace(/\n*$/, '\n');
    }
    default:
      throw new Error(`Unbekanntes Dateiformat: ${(file as { format: string }).format}`);
  }
}

/** Schreibt die Konfigurationsdateien des Spiels in den Server-Ordner. */
export async function writeSteamFiles(serverDir: string, files: SteamFile[], values: Record<string, string>): Promise<void> {
  for (const file of files) {
    if (file.unless) {
      const [name, expected] = file.unless.split('=');
      if (name && values[name.toUpperCase()] === (expected ?? '')) continue;
    }
    const target = path.resolve(serverDir, file.path);
    if (!isInside(path.resolve(serverDir), target)) throw new Error(`Konfigurationsdatei außerhalb des Server-Ordners: ${file.path}`);
    const existing = await fs.readFile(target, 'utf8').catch(() => null);
    const text = renderConfig(file, existing, values);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
  }
}

// ------------------------------------------------------------------ Installation

export interface SteamInstallInput {
  serverDir: string;
  runtimesDir: string;
  launch: SteamLaunch;
  variables: Record<string, string>;
  ports: ServerInstanceConfig['ports'];
  ramMb: number;
  serverName: string;
}

export interface SteamInstallHooks extends SteamCmdHooks {
  runner?: SteamRunner;
  login?: { username: string; password: string } | undefined;
  /** Nur fuer Tests: ersetzt die Einrichtung von SteamCMD. */
  steamExe?: string;
  platform?: NodeJS.Platform;
}

export interface SteamInstallResult {
  executable: string;
  args: string[];
  buildId: string | null;
}

export async function installSteamGame(input: SteamInstallInput, hooks: SteamInstallHooks = {}): Promise<SteamInstallResult> {
  const { launch } = input;
  const exe =
    hooks.steamExe ??
    (await ensureSteamCmd({
      runtimesDir: input.runtimesDir,
      ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
      ...(hooks.onLine ? { onLine: hooks.onLine } : {}),
      ...(hooks.signal ? { signal: hooks.signal } : {}),
      ...(hooks.fetchImpl ? { fetchImpl: hooks.fetchImpl } : {}),
      ...(hooks.runner ? { runner: hooks.runner } : {}),
      ...(hooks.platform ? { platform: hooks.platform } : {}),
    }));

  if (launch.appId === undefined) throw new Error('Für dieses Spiel fehlt die Steam-App-ID im Egg.');
  const { buildId } = await installSteamApp({
    exe,
    installDir: input.serverDir,
    appId: launch.appId,
    branch: launch.branch,
    login: hooks.login,
    ...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
    ...(hooks.onLine ? { onLine: hooks.onLine } : {}),
    ...(hooks.signal ? { signal: hooks.signal } : {}),
    ...(hooks.runner ? { runner: hooks.runner } : {}),
  });

  const executable = path.resolve(input.serverDir, launch.executable);
  if (!isInside(path.resolve(input.serverDir), executable)) throw new Error('Programm außerhalb des Server-Ordners.');
  await fs.access(executable).catch(async () => {
    // Hilfe fuer die Vorlage: welche Programme liegen denn da?
    const found = await listPrograms(input.serverDir).catch(() => [] as string[]);
    throw new Error(
      `Nach der Installation fehlt ${launch.executable} - das Spiel hat dort keinen Windows-Server.` +
        (found.length ? ` Gefundene Programme: ${found.join(', ')}` : ' Es wurden keine Programme (.exe) gefunden.'),
    );
  });

  hooks.onProgress?.(0.97, 'Schreibe Einstellungen');
  const values = steamValues({ ports: input.ports, maxMemoryMb: input.ramMb, name: input.serverName, workingDir: input.serverDir }, input.variables);
  await writeSteamFiles(input.serverDir, launch.files ?? [], values);
  hooks.onProgress?.(1, 'Fertig');
  return { executable, args: resolveArgs(launch.args, values), buildId };
}

/**
 * Vor jedem Start: Argumente und Dateien aus den aktuellen Variablen und Ports neu bauen.
 * @returns die frischen Startargumente
 */
export async function prepareSteamStart(c: ServerInstanceConfig): Promise<string[]> {
  const steam = c.install?.steam;
  if (!steam) return c.args;
  const values = steamValues(c, c.install?.variables ?? {});
  await writeSteamFiles(c.workingDir, steam.files ?? [], values);
  return resolveArgs(steam.args, values);
}
