import { totalmem } from 'node:os';
import { statfs, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { importEggFromFile, normalizeForeignEgg } from '../eggs/import.js';

/**
 * Das Panel verwaltet zunaechst genau einen Host: den, auf dem es laeuft.
 * Die Tabelle nodes gibt es trotzdem von Anfang an, damit spaeter weitere
 * Hosts dazukommen koennen, ohne jeden Server umzuschreiben.
 */
export async function ensureLocalNode(): Promise<string> {
  const [found] = await sql<{ id: string }[]>`SELECT id FROM nodes ORDER BY created_at LIMIT 1`;
  if (found) return found.id;

  const ramMb = Math.floor(totalmem() / 1024 / 1024);
  let diskMb = 100_000;
  try {
    const st = await statfs(config.VOLUME_ROOT);
    diskMb = Math.floor((st.blocks * st.bsize) / 1024 / 1024);
  } catch {
    /* Ordner gibt es noch nicht - Schaetzwert reicht, ist nur Anzeige */
  }
  const [node] = await sql<{ id: string }[]>`
    INSERT INTO nodes (name, fqdn, ram_total_mb, disk_total_mb)
    VALUES ('local', 'localhost', ${ramMb}, ${diskMb}) RETURNING id`;
  log.info({ ramMb, diskMb }, 'Lokaler Host angelegt');
  return node!.id;
}

export async function defaultNodeId(): Promise<string> {
  return ensureLocalNode();
}

/**
 * Mitgelieferte Eggs (Ordner eggs/) beim Start einspielen, sofern noch
 * nicht vorhanden. Vorhandene werden NICHT ueberschrieben - wer ein Egg
 * angepasst hat, verliert sonst beim Update seine Aenderungen.
 */
export async function seedBundledEggs(dir = join(process.cwd(), 'eggs')): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  } catch {
    return;
  }
  const existing = new Set((await sql<{ name: string }[]>`SELECT name FROM eggs`).map((r) => r.name));
  for (const f of files) {
    try {
      const raw = JSON.parse(await readFile(join(dir, f), 'utf8')) as BundledEgg;
      if (raw.name && existing.has(raw.name)) {
        await syncBundledVariables(raw);
        continue;
      }
      const r = await importEggFromFile(join(dir, f), 'Mitgeliefert');
      log.info({ egg: r.name, warnings: r.warnings }, 'Mitgeliefertes Egg eingespielt');
    } catch (err) {
      log.warn({ err, file: f }, 'Mitgeliefertes Egg konnte nicht eingespielt werden');
    }
  }
}

interface BundledEgg {
  name?: string;
  author?: string;
  variables?: Array<{
    name?: string; name_locales?: Record<string, string>; env_variable?: string; description?: string; description_locales?: Record<string, string>;
    default_value?: string | number | boolean | null; rules?: string | string[];
    requires?: string; secret?: boolean; user_editable?: boolean; user_viewable?: boolean;
  }>;
}

/**
 * Mitgelieferte Eggs (Ordner eggs/) bekommen beim Update neue
 * Variablen-Beschreibungen, Regeln, Vorgaben, Startkommandos und Skripte.
 * Werte, die Nutzer an ihren Servern gesetzt haben, bleiben unberuehrt -
 * die stehen am Server, nicht am Egg.
 */
async function syncBundledVariables(rawInput: BundledEgg) {
  const { raw: normalized } = normalizeForeignEgg(rawInput as never);
  const raw = normalized as BundledEgg;
  const [egg] = await sql<{ id: string }[]>`SELECT id FROM eggs WHERE name = ${raw.name!}`;
  if (!egg) return;
  // Auch Docker-Images, Startbefehle, Konfig-Regeln, Bereitschaft und Ressourcen nachziehen -
  // sonst erreichen Korrekturen (z. B. korrigierte Docker-Images) bestehende Installationen nie.
  const r = raw as BundledEgg & {
    docker_images?: Record<string, string>;
    image?: string;
    default_image?: string;
    startup?: string;
    ports?: unknown;
    resources?: unknown;
    scripts?: { installation?: { script?: string; container?: string } };
    install_script?: string;
    install_image?: string;
    config?: { files?: unknown; startup?: unknown };
    config_files?: unknown;
    ready_check?: unknown;
    data_dir?: string;
    run_as?: unknown;
    capabilities?: unknown;
    stop?: { timeout_seconds?: number };
  };

  const images = (r.docker_images && Object.keys(r.docker_images).length > 0)
    ? r.docker_images
    : (r.image ? { Standard: r.image } : {});
  const defaultImage = r.default_image ?? Object.values(images)[0] ?? null;
  const caps = Array.isArray(r.capabilities) ? r.capabilities.filter((c) => typeof c === 'string') : null;
  const installScript = r.scripts?.installation?.script ?? r.install_script;
  const installImage = r.scripts?.installation?.container ?? r.install_image;
  const configFiles = r.config_files ?? r.config?.files;
  const configStartup = r.config?.startup;

  await sql`
    UPDATE eggs SET
      docker_images = ${Object.keys(images).length > 0 ? sql.json(images) : sql`docker_images`},
      default_image = ${defaultImage ?? sql`default_image`},
      startup = ${r.startup ? r.startup : sql`startup`},
      ports = ${r.ports ? sql.json(r.ports as never) : sql`ports`},
      resources = ${r.resources ? sql.json(r.resources as never) : sql`resources`},
      install_script = ${installScript !== undefined ? installScript : sql`install_script`},
      install_image = ${installImage !== undefined ? installImage : sql`install_image`},
      config_files = ${configFiles ? sql.json(configFiles as never) : null},
      config_startup = ${configStartup ? sql.json(configStartup as never) : sql`config_startup`},
      ready_check = ${r.ready_check ? sql.json(r.ready_check as never) : null},
      data_dir = ${typeof r.data_dir === 'string' && r.data_dir.startsWith('/') ? r.data_dir : sql`data_dir`},
      capabilities = ${caps && caps.length > 0 ? caps : sql`capabilities`},
      run_as = ${typeof r.run_as === 'string' && /^\d{1,7}:\d{1,7}$/.test(r.run_as) ? r.run_as : null},
      stop_timeout = ${Math.min(600, Math.max(5, Number(r.stop?.timeout_seconds) || 30))},
      raw_egg = ${sql.json(raw as never)},
      updated_at = now()
    WHERE id = ${egg.id}`;
  let order = 0;
  for (const v of (raw.variables ?? []).filter((x) => x.env_variable)) {
    const defVal = v.default_value === null || v.default_value === undefined ? null : String(v.default_value);
    const rulesVal = Array.isArray(v.rules) ? v.rules.join('|') : (v.rules ?? null);
    await sql`
      INSERT INTO egg_variables (egg_id, name, name_locales, description, description_locales, env_variable, default_value, rules, requires,
                                 is_secret, user_viewable, user_editable, sort_order)
      VALUES (${egg.id}, ${v.name ?? v.env_variable!}, ${v.name_locales ? sql.json(v.name_locales) : null}, ${v.description ?? null},
              ${v.description_locales ? sql.json(v.description_locales) : null}, ${v.env_variable!}, ${defVal},
              ${rulesVal}, ${v.requires ?? null}, ${v.secret ?? false}, ${v.user_viewable ?? true},
              ${v.user_editable ?? true}, ${order++})
      ON CONFLICT (egg_id, env_variable) DO UPDATE SET
        name = EXCLUDED.name, name_locales = EXCLUDED.name_locales,
        description = EXCLUDED.description, description_locales = EXCLUDED.description_locales,
        default_value = EXCLUDED.default_value,
        rules = EXCLUDED.rules, requires = EXCLUDED.requires, is_secret = EXCLUDED.is_secret,
        user_viewable = EXCLUDED.user_viewable, user_editable = EXCLUDED.user_editable, sort_order = EXCLUDED.sort_order`;
  }
}
