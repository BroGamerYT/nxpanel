/**
 * Eggs importieren und ansehen.
 *
 *   npm run egg -- import eggs/farming-simulator-25.json
 *   npm run egg -- list
 *   npm run egg -- show "Farming Simulator 25"
 */
import 'dotenv/config';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { importEggFromFile } from '../eggs/import.js';
import { parseRules } from '../eggs/rules.js';
import { log } from '../log.js';

async function main() {
  await waitForDatabase();
  // Auch die Werkzeuge migrieren selbst. Sonst bricht nach jeder neuen
  // Migration das erste CLI-Kommando mit "column does not exist" ab, obwohl
  // nur das Panel noch nicht gestartet wurde.
  await runMigrations();
  const [cmd, arg] = process.argv.slice(2);

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
