// Einmal vor allen Tests: Testdatenbank anlegen, falls es sie noch nicht gibt.
// Migrationen fuehren die Tests selbst aus (runMigrations in beforeAll).
import postgres from 'postgres';
import { readDotEnv, testDatabaseUrl } from './test-db.js';

export default async function setup(): Promise<void> {
  const target = new URL(testDatabaseUrl({ ...(await readDotEnv()), ...process.env }));
  const name = decodeURIComponent(target.pathname.slice(1));
  const admin = new URL(target);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {}, connect_timeout: 3 });
  try {
    const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_database WHERE datname = ${name}`;
    if (!row?.n) {
      await sql.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
      console.log(`Testdatenbank ${name} angelegt`);
    }
  } catch (err) {
    // Kein Postgres erreichbar: nicht abbrechen. Reine Unit-Tests (wie in
    // deploy.ps1 ohne lokale Datenbank) brauchen sie nicht; Datenbanktests
    // scheitern dann selbst mit einer klaren Verbindungsmeldung.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tests] Testdatenbank ${name} nicht erreichbar (${msg}) - nur Tests ohne Datenbank laufen. Postgres starten: npm run db:up`);
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}
