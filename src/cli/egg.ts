/**
 * Eggs suchen, importieren, konvertieren, pruefen und ansehen.
 *
 *   npm run egg -- search <suchbegriff>
 *   npm run egg -- convert <datei-oder-url> [ziel-datei.json]
 *   npm run egg -- check [datei.json]
 *   npm run egg -- import eggs/farming-simulator-25.json
 *   npm run egg -- reimport eggs/farming-simulator-25.json
 *   npm run egg -- list
 *   npm run egg -- show "Farming Simulator 25"
 */
import 'dotenv/config';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { searchEggCatalog, toRawGithubUrl } from '../eggs/catalog.js';
import { convertForeignEggToBundled, importEggFromFile, normalizeForeignEgg, type RawEgg } from '../eggs/import.js';
import { parseRules } from '../eggs/rules.js';
import { fillGeneratedValues, missingPlaceholders, validateVariables } from '../eggs/variables.js';
import { log } from '../log.js';

function slugifyEggName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'neues-spiel';
}

async function loadEggSource(arg: string): Promise<{ raw: RawEgg; source: string }> {
  if (/^https?:\/\//i.test(arg)) {
    const url = toRawGithubUrl(arg);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`);
    const text = await res.text();
    return { raw: JSON.parse(text) as RawEgg, source: url };
  }
  const text = await readFile(arg, 'utf8');
  return { raw: JSON.parse(text) as RawEgg, source: arg };
}

export function validateEggOffline(input: RawEgg): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input.name?.trim()) errors.push('Name ("name") fehlt');
  const images = input.docker_images ? Object.values(input.docker_images) : input.image ? [input.image] : [];
  if (images.length === 0) errors.push('Kein Docker-Image ("docker_images") angegeben');
  if (!input.startup?.trim() && (!input.startup_commands || Object.keys(input.startup_commands).length === 0)) {
    errors.push('Kein Startbefehl ("startup") angegeben');
  }

  // Doppelte Variablen pruefen
  const names = (input.variables ?? []).map((v) => v.env_variable).filter((n): n is string => Boolean(n));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) errors.push(`Doppelte Variablen: ${dupes.join(', ')}`);

  // Pflichtfelder ohne Vorgabe pruefen
  const USER_INPUT = new Set(['STEAM_USER', 'STEAM_PASS', 'SLG_USER', 'SLG_PW', 'PUBLIC_IP', 'OWNER_NAME', 'OWNER_GUID',
    'SERVER_TOKEN', 'FS_LICENSE_KEY', 'STEAM_ACC', 'GSLT']);
  for (const v of input.variables ?? []) {
    if (!v.env_variable) continue;
    const rules = Array.isArray(v.rules) ? v.rules.join('|') : (v.rules ?? '');
    if (/(^|\|)required(\||$)/.test(rules) && !USER_INPUT.has(v.env_variable) && !/_PORT$/.test(v.env_variable)) {
      if (!(v.default_value ?? '').toString().trim()) {
        errors.push(`Pflichtfeld "${v.env_variable}" hat keinen Standardwert (default_value)`);
      }
    }
    if (v.name_locales && (!v.name_locales.de || !v.name_locales.en)) {
      warnings.push(`Variable "${v.env_variable}": name_locales sollte sowohl "de" als auch "en" enthalten`);
    }
  }

  // Hinweise (hints) Regex pruefen
  for (const h of input.hints ?? []) {
    try {
      new RegExp(h.match, h.flags ?? '');
    } catch {
      errors.push(`Ungueltiger Regex in hints: ${h.match}`);
    }
  }

  // Nach Normalisierung gegen validateVariables pruefen
  const { raw } = normalizeForeignEgg(input);
  const defs = (raw.variables ?? [])
    .filter((v) => v.env_variable)
    .map((v) => ({
      env_variable: v.env_variable!,
      default_value: v.default_value === null || v.default_value === undefined ? null : String(v.default_value),
      rules: Array.isArray(v.rules) ? v.rules.join('|') : (v.rules ?? null),
      user_editable: v.user_editable ?? true,
    }));
  const customDefaults: Record<string, string> = {};
  for (const k of USER_INPUT) customDefaults[k] = 'TEST-DUMMY-VALUE';
  const filled = fillGeneratedValues(defs, customDefaults, () => 'RandomPass123456');
  const validated = validateVariables(defs, filled.values);
  for (const err of validated.errors) {
    errors.push(`Standardwert von "${err.variable}" verletzt eigene Regel: ${err.message}`);
  }

  // Fehlende Platzhalter im Startkommando
  if (raw.startup) {
    const known = new Set([
      'SERVER_MEMORY', 'SERVER_MEMORY_HEAP', 'SERVER_IP', 'SERVER_PORT', 'SERVER_DIR', 'SERVER_NAME',
      ...defs.map((d) => d.env_variable),
    ]);
    const missing = missingPlaceholders(raw.startup, known);
    if (missing.length > 0) {
      warnings.push(`Startkommando nutzt Platzhalter ohne Variable: ${missing.join(', ')}`);
    }
  }

  if (!raw.cover?.steam) {
    warnings.push('Kein Steam-Titelbild ("cover": { "steam": <AppID> }) hinterlegt');
  }

  return { errors, warnings };
}

async function main() {
  const [cmd, arg, outArg] = process.argv.slice(2);

  // Offline-Befehle (brauchen keine laufende Datenbank)
  if (cmd === 'search') {
    const query = process.argv.slice(3).join(' ').trim();
    const items = await searchEggCatalog(query, { includeLive: true });
    if (items.length === 0) {
      console.log(`Keine Eggs gefunden fuer "${query}".`);
      process.exit(0);
    }
    console.log(`\nGefunden: ${items.length} Egg(s):\n`);
    for (const item of items) {
      const cat = `[${item.category}]`.padEnd(13);
      const rt = (item.runtime || 'Unbekannt').padEnd(18);
      console.log(`  ${cat} ${item.name.padEnd(34)} ${rt} ${item.url}`);
    }
    console.log('\nDirekt konvertieren mit:');
    console.log('  npm run egg -- convert "<GitHub-URL>"');
    process.exit(0);
  }

  if (cmd === 'convert') {
    if (!arg) {
      console.error('Aufruf: npm run egg -- convert <datei.json oder github-url> [ziel-datei.json]');
      process.exit(1);
    }
    const { raw, source } = await loadEggSource(arg);
    const { egg, report } = convertForeignEggToBundled(raw, source);
    const slug = slugifyEggName(egg.name ?? 'neues-spiel');
    const outPath = outArg ?? join('eggs', `${slug}.json`);
    await writeFile(outPath, JSON.stringify(egg, null, 2) + '\n', 'utf8');

    console.log(`\n✓ Egg erfolgreich konvertiert und gespeichert: ${outPath}`);
    console.log(`  Spielname : ${egg.name}`);
    console.log(`  Kategorie : ${egg.nest}`);
    console.log(`  Variablen : ${(egg.variables ?? []).length}`);
    if (report.length > 0) {
      console.log('\nAutomatische Anpassungen:');
      for (const line of report) console.log(`  • ${line}`);
    }

    const check = validateEggOffline(egg);
    if (check.warnings.length > 0) {
      console.log('\nNoch manuell pruefen:');
      for (const w of check.warnings) console.log(`  ! ${w}`);
    }
    if (check.errors.length > 0) {
      console.error('\nFEHLER (bitte in der Datei beheben):');
      for (const e of check.errors) console.error(`  ✗ ${e}`);
      process.exit(1);
    } else {
      console.log('\n✓ Alle Qualitaets- und Variablen-Pruefungen bestanden!');
    }
    process.exit(0);
  }

  if (cmd === 'check') {
    const files = arg
      ? [arg]
      : (await readdir('eggs')).filter((f) => f.endsWith('.json')).map((f) => join('eggs', f));
    let failed = 0;
    for (const file of files) {
      const raw = JSON.parse(await readFile(file, 'utf8')) as RawEgg;
      const { errors, warnings } = validateEggOffline(raw);
      if (errors.length > 0) {
        failed++;
        console.error(`✗ ${file} (${raw.name ?? 'unbekannt'}):`);
        for (const e of errors) console.error(`    FEHLER : ${e}`);
        for (const w of warnings) console.warn(`    HINWEIS: ${w}`);
      } else if (arg && warnings.length > 0) {
        console.log(`✓ ${file} (${raw.name}) - OK mit Hinweisen:`);
        for (const w of warnings) console.log(`    HINWEIS: ${w}`);
      } else if (arg) {
        console.log(`✓ ${file} (${raw.name}) - 100 % fehlerfrei!`);
      }
    }
    if (failed === 0 && !arg) {
      console.log(`✓ Alle ${files.length} Eggs im Ordner eggs/ sind fehlerfrei!`);
    }
    process.exit(failed > 0 ? 1 : 0);
  }

  if (cmd !== 'import' && cmd !== 'reimport' && cmd !== 'list' && cmd !== 'show') {
    console.log('Verfuegbare Befehle:');
    console.log('  npm run egg -- search <suchbegriff>');
    console.log('  npm run egg -- convert <datei.json oder github-url> [ziel-datei.json]');
    console.log('  npm run egg -- check [datei.json]');
    console.log('  npm run egg -- import <datei.json>');
    console.log('  npm run egg -- reimport <datei.json>');
    console.log('  npm run egg -- list');
    console.log('  npm run egg -- show "<Name>"');
    process.exit(0);
  }

  await waitForDatabase();
  // Auch die Werkzeuge migrieren selbst. Sonst bricht nach jeder neuen
  // Migration das erste CLI-Kommando mit "column does not exist" ab, obwohl
  // nur das Panel noch nicht gestartet wurde.
  await runMigrations();

  switch (cmd) {
    case 'import': {
      if (!arg) { console.error('Pfad zur Egg-Datei fehlt.'); break; }
      const r = await importEggFromFile(arg);
      console.log(`Importiert: ${r.name}  (${r.variables} Variablen)`);
      if (r.warnings.length) {
        console.log('\nHinweise:');
        for (const w of r.warnings) console.log('  - ' + w);
      }
      break;
    }

    case 'reimport': {
      // Eggs aendern sich - und ein Egg, das vor einer Migration importiert
      // wurde, kann Felder vermissen, die es inzwischen gibt.
      if (!arg) { console.error('Pfad zur Egg-Datei fehlt.'); break; }
      const raw = JSON.parse(await (await import('node:fs/promises')).readFile(arg, 'utf8')) as { name?: string };
      if (!raw.name) { console.error('Egg hat keinen Namen.'); break; }

      const [old] = await sql<{ id: string }[]>`SELECT id FROM eggs WHERE name = ${raw.name}`;
      if (old) {
        const used = await sql<{ count: string }[]>`
          SELECT count(*) FROM servers WHERE egg_id = ${old.id}`;
        const count = Number(used[0]?.count ?? 0);
        if (count > 0) {
          console.error(`${raw.name} wird von ${count} Server(n) genutzt.`);
          console.error('Erst die Server entfernen, dann erneut importieren.');
          break;
        }
        await sql`DELETE FROM eggs WHERE id = ${old.id}`;
        console.log(`Altes Egg entfernt: ${raw.name}`);
      }

      const r = await importEggFromFile(arg);
      console.log(`Neu importiert: ${r.name}  (${r.variables} Variablen)`);
      for (const w of r.warnings) console.log('  Hinweis:', w);
      const [check] = await sql<{ default_image: string | null }[]>`
        SELECT default_image FROM eggs WHERE id = ${r.eggId}`;
      console.log(`Vorgabe-Image: ${check?.default_image ?? 'keines'}`);
      break;
    }

    case 'list': {
      const rows = await sql<{ name: string; nest: string; vars: string; console_mode: string }[]>`
        SELECT e.name, n.name AS nest, e.console_mode,
               (SELECT count(*) FROM egg_variables v WHERE v.egg_id = e.id) AS vars
        FROM eggs e JOIN nests n ON n.id = e.nest_id
        ORDER BY n.name, e.name
      `;
      if (rows.length === 0) { console.log('Noch keine Eggs importiert.'); break; }
      console.log('Gruppe'.padEnd(16), 'Egg'.padEnd(28), 'Vars', ' Konsole');
      for (const r of rows) {
        console.log(r.nest.padEnd(16), r.name.padEnd(28), String(r.vars).padEnd(4), r.console_mode);
      }
      break;
    }

    case 'show': {
      if (!arg) { console.error('Name des Eggs fehlt.'); break; }
      const [egg] = await sql<{ id: string; name: string; startup: string; stop_command: string; console_mode: string }[]>`
        SELECT id, name, startup, stop_command, console_mode FROM eggs WHERE name = ${arg}
      `;
      if (!egg) { console.log('Nicht gefunden.'); break; }

      console.log(`\n${egg.name}`);
      console.log('Start   :', egg.startup);
      console.log('Stop    :', egg.stop_command);
      console.log('Konsole :', egg.console_mode);

      const vars = await sql<{ name: string; env_variable: string; rules: string | null; default_value: string | null; requires: string | null }[]>`
        SELECT name, env_variable, rules, default_value, requires
        FROM egg_variables WHERE egg_id = ${egg.id} ORDER BY sort_order
      `;

      console.log('\nFormular, das daraus entsteht:');
      for (const v of vars) {
        const p = parseRules(v.rules, v.env_variable);
        const bits = [
          p.widget.padEnd(9),
          p.required ? 'pflicht' : 'optional',
          p.options ? `(${p.options.join(', ')})` : '',
          p.min !== undefined || p.max !== undefined ? `[${p.min ?? ''}..${p.max ?? ''}]` : '',
          v.requires ? `nur wenn ${v.requires}` : '',
        ].filter(Boolean).join('  ');
        console.log(`  ${v.name.padEnd(26)} ${bits}`);
      }
      break;
    }

    default:
      console.log('import <datei> | reimport <datei> | list | show <name>');
  }

  await closeDatabase();
  process.exit(0);
}

main().catch((err) => { log.error({ err }, 'Fehlgeschlagen'); process.exit(1); });
