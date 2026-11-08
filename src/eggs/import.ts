import { readFile } from 'node:fs/promises';
import type { JSONValue } from 'postgres';
import { sql } from '../db/index.js';
import { log } from '../log.js';
import { GENERATE_PASSWORD, missingPlaceholders } from './variables.js';
import { filterCapabilities, sanitizeDataPath } from './capabilities.js';

/**
 * Liest ein Egg ein - sowohl das Pterodactyl-Format als auch das etwas
 * erweiterte NexusPanel-Format aus dem eggs/-Ordner.
 *
 * Das Original wird in raw_egg aufbewahrt. Damit laesst sich spaeter
 * nachvollziehen, woher eine Einstellung kam, auch wenn der Parser sich
 * aendert.
 */

export interface RawEgg {
  _comment?: string;
  name?: string;
  author?: string;
  nest?: string;
  cover?: { steam?: number };
  docker_images?: Record<string, string>;
  image?: string;
  startup?: string;
  console?: string;
  web_interface?: unknown;
  ready_check?: unknown;
  ports?: unknown;
  resources?: { base_ram_mb?: number; ram_per_player_mb?: number; min_cpu_percent?: number; disk_mb?: number; notes?: string };
  watchers?: unknown;
  config?: { files?: unknown; startup?: unknown; logs?: unknown; stop?: string };
  /** Pelican (PLCN_v3): mehrere benannte Startkommandos, das erste ist die Vorgabe. */
  startup_commands?: Record<string, string>;
  config_files?: unknown;
  stop?: { method?: string; timeout_seconds?: number } | string;
  scripts?: { installation?: { script?: string; container?: string; entrypoint?: string } };
  install_script?: string;
  install_image?: string;
  variables?: RawVariable[];
  features?: unknown;
  capabilities?: unknown;
  data_dir?: unknown;
  run_as?: unknown;
  tmp?: unknown;
  query?: { kind: 'minecraft' | 'ark' | 'palworld' | 'source'; port_ref?: string; rcon?: { port_ref?: string; password_var?: string; password_files?: string[] } };
  hints?: Array<{ match: string; flags?: string; level?: string; text: string; text_locales?: Record<string, string> }>;
  log_file?: string;
  log_dirs?: string[];
  import?: unknown;
  notes?: string[];
}

export interface RawVariable {
  name?: string;
  name_locales?: Record<string, string>;
  description?: string;
  description_locales?: Record<string, string>;
  env_variable?: string;
  default_value?: string | number | boolean | null;
  rules?: string | string[];
  requires?: string;
  secret?: boolean;
  user_viewable?: boolean;
  user_editable?: boolean;
}

export interface ImportResult {
  eggId: string;
  name: string;
  variables: number;
  warnings: string[];
}

export async function importEggFromFile(path: string, nestName = 'Importiert'): Promise<ImportResult> {
  const raw = JSON.parse(await readFile(path, 'utf8')) as RawEgg;
  return importEgg(raw, nestName);
}

export async function importEgg(input: RawEgg, nestName = 'Importiert'): Promise<ImportResult> {
  const { raw, notes } = normalizeForeignEgg(input);
  const warnings: string[] = [...notes];

  const name = raw.name?.trim();
  if (!name) throw new Error('Egg hat keinen Namen');

  const startup = raw.startup?.trim();
  if (!startup) throw new Error(`Egg "${name}" hat kein Startkommando`);

  const images = normalizeImages(raw);
  const imageKeys = Object.keys(images);
  if (imageKeys.length === 0) {
    throw new Error(`Egg "${name}" nennt kein Docker-Image`);
  }
  // Die erste Angabe im Egg ist die Vorgabe. Sie muss hier festgehalten
  // werden, weil JSONB die Reihenfolge beim Speichern verliert.
  const defaultImage = images[imageKeys[0]!]!;

  const stopCommand = normalizeStop(raw);
  const consoleMode = normalizeConsole(raw, warnings);
  const variables = (raw.variables ?? []).filter((v) => v.env_variable);

  // Platzhalter pruefen, die keine Variable deckt - ein haeufiger Fehler in
  // fremden Eggs, der sonst erst beim ersten Start auffaellt.
  const known = new Set([
    'SERVER_MEMORY', 'SERVER_MEMORY_HEAP', 'SERVER_IP', 'SERVER_PORT', 'SERVER_DIR', 'SERVER_NAME',
    ...variables.map((v) => v.env_variable!),
  ]);
  const missing = missingPlaceholders(startup, known);
  if (missing.length > 0) {
    warnings.push(`Startkommando nutzt Platzhalter ohne Variable: ${missing.join(', ')}`);
  }

  if (!raw.scripts?.installation?.script && !raw.install_script) {
    warnings.push('Kein Installationsskript - das Image muss die Spieldateien selbst holen (bei itzg, ARK, Enshrouded, TeamSpeak so gewollt)');
  }

  const caps = filterCapabilities(raw.capabilities);
  if (caps.rejected.length > 0) {
    warnings.push(`Verweigerte Rechte (nicht auf der Erlaubnisliste): ${caps.rejected.join(', ')}`);
  }
  const dataDir = sanitizeDataPath(raw.data_dir);
  if (raw.data_dir !== undefined && dataDir !== raw.data_dir) {
    warnings.push(`Datenpfad "${String(raw.data_dir)}" abgelehnt, nutze ${dataDir}`);
  }

  // Nur numerisch: ein Name wie "gameserver" existiert im Image, aber nicht
  // auf dem Host - der Datenordner liesse sich dann nicht zuweisen.
  let runAs: string | null = null;
  if (raw.run_as !== undefined) {
    if (typeof raw.run_as === 'string' && /^\d{1,7}:\d{1,7}$/.test(raw.run_as) && raw.run_as !== '0:0') runAs = raw.run_as;
    else warnings.push(`run_as "${String(raw.run_as)}" ignoriert - erwartet uid:gid, nicht 0:0`);
  }
  const stopRaw = typeof raw.stop === 'object' && raw.stop ? Number((raw.stop as { timeout_seconds?: unknown }).timeout_seconds) : NaN;
  const stopTimeout = Number.isFinite(stopRaw) ? Math.min(600, Math.max(5, Math.round(stopRaw))) : 30;

  const nestId = await ensureNest(raw.nest ?? nestName);

  const [egg] = await sql<{ id: string }[]>`
    INSERT INTO eggs (
      nest_id, name, author, docker_images, default_image, startup, stop_command, console_mode,
      web_interface, ready_check, ports, resources, watchers,
      config_files, config_startup, install_script, install_image, features, raw_egg,
      capabilities, data_dir, run_as, stop_timeout
    ) VALUES (
      ${nestId}, ${name}, ${raw.author ?? null}, ${sql.json(images)}, ${defaultImage}, ${startup},
      ${stopCommand}, ${consoleMode},
      ${json(raw.web_interface)}, ${json(raw.ready_check)}, ${json(raw.ports)},
      ${json(raw.resources)}, ${json(raw.watchers)},
      ${json(raw.config_files ?? raw.config?.files)}, ${json(raw.config?.startup)},
      ${raw.scripts?.installation?.script ?? raw.install_script ?? null},
      ${raw.scripts?.installation?.container ?? raw.install_image ?? null},
      ${json(raw.features)}, ${sql.json(raw as unknown as JSONValue)},
      ${caps.granted}, ${dataDir}, ${runAs}, ${stopTimeout}
    )
    RETURNING id
  `;

  const eggId = egg!.id;

  let order = 0;
  for (const v of variables) {
    await sql`
      INSERT INTO egg_variables (
        egg_id, name, name_locales, description, description_locales, env_variable, default_value, rules,
        requires, is_secret, user_viewable, user_editable, sort_order
      ) VALUES (
        ${eggId}, ${v.name ?? v.env_variable!}, ${v.name_locales ? sql.json(v.name_locales) : null},
        ${v.description ?? null}, ${v.description_locales ? sql.json(v.description_locales) : null},
        ${v.env_variable!},
        ${v.default_value === null || v.default_value === undefined ? null : String(v.default_value)},
        ${Array.isArray(v.rules) ? v.rules.join('|') : (v.rules ?? null)}, ${v.requires ?? null}, ${v.secret ?? false},
        ${v.user_viewable ?? true}, ${v.user_editable ?? true}, ${order++}
      )
      ON CONFLICT (egg_id, env_variable) DO UPDATE SET
        name = EXCLUDED.name,
        name_locales = EXCLUDED.name_locales,
        description = EXCLUDED.description,
        description_locales = EXCLUDED.description_locales,
        default_value = EXCLUDED.default_value,
        rules = EXCLUDED.rules,
        requires = EXCLUDED.requires,
        is_secret = EXCLUDED.is_secret,
        user_viewable = EXCLUDED.user_viewable,
        user_editable = EXCLUDED.user_editable,
        sort_order = EXCLUDED.sort_order
    `;
  }

  log.info({ egg: name, variables: variables.length, warnings: warnings.length }, 'Egg importiert');
  return { eggId, name, variables: variables.length, warnings };
}

async function ensureNest(name: string): Promise<string> {
  const [existing] = await sql<{ id: string }[]>`SELECT id FROM nests WHERE name = ${name}`;
  if (existing) return existing.id;
  const [created] = await sql<{ id: string }[]>`
    INSERT INTO nests (name) VALUES (${name}) RETURNING id
  `;
  return created!.id;
}

const YOLK = /^ghcr\.io\/(pelican-eggs|parkervcp|pterodactyl)\//;
const PROTON_OR_WINE = /proton|wine/i;
const PASSWORD_VAR = /(^|_)(PASS|PASSWORD|PW|SECRET|RCON_PASS|ADMIN_PASS)($|_)/i;
const USER_ACCOUNT_VARS = new Set([
  'STEAM_USER', 'STEAM_PASS', 'SLG_USER', 'SLG_PW', 'PUBLIC_IP', 'OWNER_NAME',
  'OWNER_GUID', 'SERVER_TOKEN', 'FS_LICENSE_KEY', 'STEAM_ACC', 'GSLT',
]);

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t || t === '{}' ) return t === '{}' ? {} : undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Eggs aus Pterodactyl/Pelican (z. B. github.com/pelican-eggs, MIT) so
 * aufbereiten, dass sie hier laufen:
 *  - config.files/startup/logs stehen dort als JSON-Text, nicht als Objekt
 *  - "done" ist ein Text (oder eine Liste), kein regulaerer Ausdruck
 *  - PLCN_v3 hat startup_commands statt startup
 *  - Parser "yml" heisst hier "yaml"
 *  - die Yolk-Images laufen als normaler Benutzer; Wings setzt den Besitzer
 *    der Dateien nach der Installation - hier uebernimmt das run_as + chown
 *  - "image" ist bei PLCN_v3 ein Bild (URL/Data-URL), kein Docker-Image
 *  - Pflicht-Passwoerter ohne Vorgabe bekommen "{{GENERATE_PASSWORD}}"
 *  - andere leere Pflichtfelder (ausser echten Konten/Keys) werden auf "nullable" gelockert
 *  - Wine/Proton-Images bekommen automatisch "tmp": "disk" und passende Ressourcen
 */
export function normalizeForeignEgg(input: RawEgg): { raw: RawEgg; notes: string[] } {
  const raw: RawEgg = { ...input };
  if (input.config) raw.config = { ...input.config };
  if (input.scripts?.installation) {
    raw.scripts = {
      ...input.scripts,
      installation: {
        ...input.scripts.installation,
        ...(typeof input.scripts.installation.script === 'string'
          ? { script: input.scripts.installation.script.replace(/\r\n?/g, '\n') }
          : {}),
      },
    };
  }
  if (typeof raw.install_script === 'string') {
    raw.install_script = raw.install_script.replace(/\r\n?/g, '\n');
  }
  const notes: string[] = [];
  if (raw.config) {
    const files = parseMaybeJson(raw.config.files);
    if (files && typeof files === 'object') {
      for (const spec of Object.values(files as Record<string, { parser?: string }>)) {
        if (spec && spec.parser === 'yml') spec.parser = 'yaml';
      }
      raw.config.files = Object.keys(files).length ? files : undefined;
    } else raw.config.files = undefined;
    raw.config.startup = parseMaybeJson(raw.config.startup);
    raw.config.logs = parseMaybeJson(raw.config.logs);
  }
  if (!raw.startup && raw.startup_commands && typeof raw.startup_commands === 'object') {
    const first = Object.values(raw.startup_commands).find((v) => typeof v === 'string' && v.trim());
    if (first) raw.startup = first;
  }
  if (typeof raw.image === 'string' && (raw.image.includes('://') || raw.image.startsWith('data:'))) delete raw.image;
  if (!raw.ready_check) {
    const done = (raw.config?.startup as { done?: unknown } | undefined)?.done;
    const list = (Array.isArray(done) ? done : [done]).filter((d): d is string => typeof d === 'string' && d.trim() !== '');
    if (list.length) {
      raw.ready_check = { kind: 'done', regex: list.map(escapeRegex).join('|'), timeout_seconds: 900 };
    } else {
      raw.ready_check = {
        kind: 'done',
        regex: 'Server started|Listening on|Game server connected|Connection to Steam servers successful|Done \\(|Engine is initialized|Session running|HostOnline|Dedicated Server now running|Ready for connections',
        timeout_seconds: 900,
      };
      notes.push('Startmuster (done) fehlte: allgemeines Bereitschafts-Muster gesetzt');
    }
  }
  if (raw.variables?.length) {
    // 1. Doppelte Variablen nach env_variable entfernen (erster gewinnt)
    const seenVars = new Set<string>();
    raw.variables = raw.variables.filter((v) => {
      if (!v.env_variable) return true;
      if (seenVars.has(v.env_variable)) {
        notes.push(`Doppelte Variable entfernt: ${v.env_variable}`);
        return false;
      }
      seenVars.add(v.env_variable);
      return true;
    });

    raw.variables = raw.variables.map((v) =>
      Array.isArray(v.rules) ? { ...v, rules: v.rules.join('|') } : v,
    );
  }
  // Zusatzports: Pterodactyl kennt nur den Hauptport, weitere stehen als
  // Variable mit fester Zahl (QUERY_PORT=27016) oder leerer Port-Vorgabe.
  // Hier bekommt jede so eine Variable einen eigenen, vom Panel vergebenen
  // und freigegebenen Port. RCON bleibt intern (nur das Panel spricht es an).
  if (raw.ports === undefined) {
    const secondary: Array<Record<string, unknown>> = [];
    if (raw.variables?.length) {
      raw.variables = raw.variables.map((v) => {
        const m = /^([A-Z0-9_]+)_PORT$/.exec(v.env_variable ?? '');
        const rawDef = v.default_value;
        const isEmptyDef = rawDef === '' || rawDef === null || rawDef === undefined;
        const def = Number(rawDef);
        const isValidPortNum = !isEmptyDef && Number.isInteger(def) && def >= 1 && def <= 65535;
        if (!m || m[1] === 'SERVER' || (!isValidPortNum && !isEmptyDef)) return v;
        const ref = m[1]!.toLowerCase();
        secondary.push({ ref, name: v.name ?? m[1], protocol: 'both', optional: true, ...(ref === 'rcon' ? { internal: true } : {}) });
        // Regel lockern: der Wert ist jetzt eine Vorlage, keine Zahl mehr
        return { ...v, default_value: `{{${m[1]}_PORT}}`, rules: 'nullable|string', user_editable: false };
      });
    }
    // Rechnerische Zusatzports (z. B. $((SERVER_PORT + 1)) im Startkommando oder Unturned/Barotrauma Spielport + 1)
    const startupAndFiles = `${raw.startup ?? ''} ${JSON.stringify(raw.config?.files ?? '')}`;
    const offsetMatches = [
      ...startupAndFiles.matchAll(/\$\(\(\s*(?:\$\{)?SERVER_PORT(?:\})?\s*\+\s*(\d{1,4})\s*\)\)/g),
      ...startupAndFiles.matchAll(/\{\{\s*SERVER_PORT\s*\}\}\s*\+\s*(\d{1,4})/g),
    ];
    const seenOffsets = new Set<number>();
    for (const m of offsetMatches) {
      const off = Number(m[1]);
      if (Number.isInteger(off) && off >= 1 && off <= 1000 && !seenOffsets.has(off)) {
        seenOffsets.add(off);
      }
    }
    if (!seenOffsets.has(1) && /Unturned_Headless|\.\/DedicatedServer\s+-batchmode/i.test(raw.startup ?? '')) {
      seenOffsets.add(1);
    }
    for (const off of seenOffsets) {
      const ref = off === 1 && !secondary.some((p) => p.ref === 'query') ? 'query' : `plus${off}`;
      if (!secondary.some((p) => p.ref === ref)) {
        secondary.push({
          ref,
          name: off === 1 ? 'Steam Query (Port +1)' : `Zusatzport (+${off})`,
          offset: off,
          protocol: 'udp',
          optional: true,
        });
      }
    }
    if (secondary.length) {
      raw.ports = { primary: { ref: 'game', name: 'Spiel', protocol: 'both' }, secondary };
      notes.push(`Zusatzports automatisch vergeben: ${secondary.map((p) => p.offset ? `+${String(p.offset)}` : String(p.ref).toUpperCase() + '_PORT').join(', ')}`);
    }
  }
  // Pflichtfelder ohne Standardwert reparieren:
  // - Passwort-Pflichtfelder bekommen {{GENERATE_PASSWORD}} + secret: true
  // - Andere leere Pflichtfelder (ausser Lizenz-/Account-Feldern) werden auf nullable gesetzt
  if (raw.variables?.length) {
    const autoPw: string[] = [];
    const relaxed: string[] = [];
    raw.variables = raw.variables.map((v) => {
      const env = v.env_variable ?? '';
      const rules = typeof v.rules === 'string' ? v.rules : '';
      const def = (v.default_value ?? '').toString().trim();
      const isReq = /(^|\|)required(\||$)/.test(rules);
      const isPw = PASSWORD_VAR.test(env) && !USER_ACCOUNT_VARS.has(env);
      let next = { ...v };
      if (isPw && next.secret === undefined) {
        next.secret = true;
      }
      if (isReq && !def && !USER_ACCOUNT_VARS.has(env) && !/_PORT$/.test(env)) {
        if (isPw) {
          next.default_value = GENERATE_PASSWORD;
          next.secret = true;
          autoPw.push(env);
        } else {
          next.rules = rules.replace(/(^|\|)required(\||$)/, '$1nullable$2');
          relaxed.push(env);
        }
      }
      return next;
    });
    if (autoPw.length) notes.push(`Pflicht-Passwort automatisch auf Zufalls-Generator gesetzt: ${autoPw.join(', ')}`);
    if (relaxed.length) notes.push(`Leere Pflichtfelder auf optional (nullable) umgestellt: ${relaxed.join(', ')}`);
  }

  const images = Object.values(raw.docker_images ?? {});
  if (raw.run_as === undefined && images.length && images.every((i) => YOLK.test(i))) {
    raw.run_as = '1000:1000';
    notes.push('Pterodactyl-/Pelican-Image: laeuft als Benutzer 1000, Dateien werden nach der Installation uebergeben');
  }
  if (raw.tmp === undefined && images.some((i) => PROTON_OR_WINE.test(i))) {
    raw.tmp = 'disk';
    notes.push('Wine/Proton-Image erkannt: /tmp auf Festplatte ("disk") umgestellt');
  }
  return { raw, notes };
}

/**
 * Bereitet ein fremdes Egg vollstaendig als saubere NexusPanel-Vorlage auf
 * (fuer den Export in den Ordner eggs/ per CLI "npm run egg -- convert"):
 *  - Fuehrt normalizeForeignEgg() aus
 *  - Entfernt unschoene Praefixe wie "[SERVER] " oder "[STEAM] " aus Variablennamen
 *  - Ergaenzt fehlende name_locales / description_locales (de & en)
 *  - Ergaenzt fehlende resources (bei Proton/Wine mehr RAM & CPU)
 *  - Ergaenzt nest ("Importiert", falls leer)
 *  - Erkennt Source-Query-Ports automatisch fuer die Live-Spielerabfrage
 */
export function convertForeignEggToBundled(input: RawEgg, sourceHint?: string): { egg: RawEgg; report: string[] } {
  const { raw, notes } = normalizeForeignEgg(input);
  const report = [...notes];
  const images = Object.values(raw.docker_images ?? {});
  const isProtonOrWine = images.some((i) => PROTON_OR_WINE.test(i));

  if (!raw._comment && sourceHint) {
    raw._comment = `NexusPanel-Egg, konvertiert aus ${sourceHint}.`;
  }

  if (!raw.nest) {
    raw.nest = 'Survival';
    report.push('Kategorie (nest) auf "Survival" gesetzt (bitte pruefen)');
  }

  if (!raw.resources) {
    raw.resources = isProtonOrWine
      ? { base_ram_mb: 6144, ram_per_player_mb: 150, min_cpu_percent: 200, disk_mb: 25000 }
      : { base_ram_mb: 2048, ram_per_player_mb: 100, min_cpu_percent: 100, disk_mb: 15000 };
    report.push(`Ressourcen-Vorschlag ergaenzt (${raw.resources.base_ram_mb} MB RAM)`);
  }

  // Variablen-Namen saeubern ([SERVER] / [STEAM] entfernen) und Locales ergaenzen
  if (raw.variables?.length) {
    let cleanedLabels = 0;
    raw.variables = raw.variables.map((v) => {
      const next = { ...v };
      if (typeof next.name === 'string') {
        const cleaned = next.name.replace(/^\s*\[[A-Za-z0-9_-]+\]\s*/, '').trim();
        if (cleaned && cleaned !== next.name) {
          next.name = cleaned;
          cleanedLabels++;
        }
      }
      const label = next.name ?? next.env_variable ?? '';
      if (label && !next.name_locales) {
        next.name_locales = { de: label, en: label };
      } else if (next.name_locales) {
        next.name_locales = {
          de: next.name_locales.de ?? next.name_locales.en ?? label,
          en: next.name_locales.en ?? next.name_locales.de ?? label,
          ...next.name_locales,
        };
      }
      if (typeof next.description === 'string' && next.description.trim() && !next.description_locales) {
        next.description_locales = { de: next.description, en: next.description };
      }
      return next;
    });
    if (cleanedLabels > 0) report.push(`${cleanedLabels} Variablen-Namen von [PRAEFIX]-Tags bereinigt und Locales (de/en) angelegt`);
  }

  // Wenn ein Query-Port existiert und noch kein query-Block da ist -> Source Query vorschlagen
  if (!raw.query && raw.ports && typeof raw.ports === 'object') {
    const sec = (raw.ports as { secondary?: Array<{ ref?: string }> }).secondary ?? [];
    const hasQuery = sec.some((p) => p.ref === 'query' || p.ref === 'steam_query' || p.ref === 'server_query');
    if (hasQuery) {
      const qRef = sec.find((p) => p.ref === 'query' || p.ref === 'steam_query' || p.ref === 'server_query')!.ref!;
      raw.query = { kind: 'source', port_ref: qRef };
      report.push(`Live-Spielerabfrage (query: source) auf Port "${qRef}" eingerichtet`);
    }
  }

  // Bei Proton/Wine die Proton-Standardhinweise ergaenzen, falls noch keine hints existieren
  if (isProtonOrWine && (!raw.hints || raw.hints.length === 0)) {
    raw.hints = [
      {
        match: 'ProtonFixes\\[\\d+\\] WARN|fsync: up and running|wine: RLIMIT',
        flags: '',
        level: 'ignore',
        text: 'Harmlose Meldung von Proton/Wine – kann ignoriert werden.',
        text_locales: {
          de: 'Harmlose Meldung von Proton/Wine – kann ignoriert werden.',
          en: 'Harmless message from Proton/Wine – safe to ignore.',
        },
      },
    ];
    report.push('Proton/Wine-Konsolenfilter (hints) ergaenzt');
  }

  return { egg: raw, report };
}

function normalizeImages(raw: RawEgg): Record<string, string> {
  if (raw.docker_images && Object.keys(raw.docker_images).length > 0) return raw.docker_images;
  if (raw.image) return { Standard: raw.image };
  return {};
}

/**
 * Pterodactyl schreibt das Stop-Verhalten in config.stop, das eigene Format
 * in stop.method. "^C" bedeutet: kein Konsolenbefehl, direkt SIGINT/SIGTERM.
 */
function normalizeStop(raw: RawEgg): string {
  if (typeof raw.stop === 'string') return raw.stop;
  if (raw.stop?.method) return raw.stop.method === 'SIGTERM' ? '^C' : raw.stop.method;
  if (raw.config?.stop) return raw.config.stop;
  return '^C';
}

function normalizeConsole(raw: RawEgg, warnings: string[]): 'full' | 'readonly' | 'none' {
  const value = raw.console;
  if (value === 'readonly' || value === 'none' || value === 'full') return value;
  if (value) warnings.push(`Unbekannter Konsolenmodus "${value}", nutze "full"`);
  return 'full';
}

function json(value: unknown) {
  return value === undefined || value === null ? null : sql.json(value as JSONValue);
}
