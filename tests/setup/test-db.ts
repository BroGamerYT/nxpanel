/**
 * Eigene Testdatenbank.
 *
 * Die Datenbanktests leeren Tabellen. Damit sie nie die Betriebs- oder
 * Entwicklungsdatenbank treffen (und nicht mit einem laufenden Panel um
 * dieselben Zeilen streiten), laufen sie immer gegen eine eigene Datenbank:
 *
 * - TEST_DATABASE_URL, wenn gesetzt
 * - sonst DATABASE_URL mit angehaengtem "_test" am Datenbanknamen
 *   (postgres://panel@host/panel -> postgres://panel@host/panel_test)
 *
 * Steht im Namen kein "test", wird abgebrochen.
 */
export function testDatabaseUrl(env: Record<string, string | undefined>): string {
  const explicit = env.TEST_DATABASE_URL?.trim();
  const base = explicit || env.DATABASE_URL?.trim();
  if (!base) throw new Error('Weder TEST_DATABASE_URL noch DATABASE_URL gesetzt - siehe tests/README.md');
  const url = new URL(base);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name) throw new Error('Die Datenbank-URL enthaelt keinen Datenbanknamen');
  if (!explicit && !/test/i.test(name)) url.pathname = `/${name}_test`;
  const finalName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!/test/i.test(finalName)) {
    throw new Error(`Testdatenbank "${finalName}" enthaelt kein "test" im Namen - Abbruch, um echte Daten zu schuetzen`);
  }
  return url.toString();
}

/** Redis fuer Tests: eigene Datenbanknummer 15, damit Ratelimits des Panels unberuehrt bleiben. */
export function testRedisUrl(env: Record<string, string | undefined>): string {
  const url = new URL(env.REDIS_URL?.trim() || 'redis://127.0.0.1:6379/0');
  url.pathname = '/15';
  return url.toString();
}

/** Liest .env, ohne process.env zu veraendern. */
export async function readDotEnv(): Promise<Record<string, string>> {
  const { readFile } = await import('node:fs/promises');
  const { parse } = await import('dotenv');
  try {
    return parse(await readFile('.env', 'utf8'));
  } catch {
    return {};
  }
}
