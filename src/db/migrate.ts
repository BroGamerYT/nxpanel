import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, closeDatabase } from './index.js';
import { log } from '../log.js';

/**
 * Migrationen laufen in einer Transaktion und werden in schema_migrations
 * festgehalten. Eine einmal angewendete Datei wird nie erneut ausgefuehrt und
 * nie veraendert - wer etwas aendern will, schreibt eine neue Datei.
 * Das ist die Grundlage dafuer, dass fremde Betreiber ohne Handarbeit
 * aktualisieren koennen.
 */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function runMigrations(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  const applied = new Set(
    (await sql<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version),
  );

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const content = await readFile(join(migrationsDir, file), 'utf8');
    log.info({ file }, 'Migration wird angewendet');

    await sql.begin(async (tx) => {
      await tx.unsafe(content);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });

    count++;
  }

  log.info(count === 0 ? 'Keine neuen Migrationen' : `${count} Migration(en) angewendet`);
}

// Direkt aufgerufen: npm run migrate
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => closeDatabase())
    .then(() => process.exit(0))
    .catch((err) => {
      log.error({ err }, 'Migration fehlgeschlagen');
      process.exit(1);
    });
}
