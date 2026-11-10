import postgres from 'postgres';
import { config, isProduction } from '../config.js';
import { log } from '../log.js';

export const sql = postgres(config.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  onnotice: isProduction ? () => {} : (n) => log.debug({ notice: n.message }, 'postgres'),
});

export async function checkDatabase(): Promise<boolean> {
  try {
    await sql`SELECT 1`;
    return true;
  } catch (err) {
    log.error({ err }, 'Datenbank nicht erreichbar');
    return false;
  }
}

/**
 * Wartet, bis die Datenbank antwortet.
 *
 * Noetig, weil das Panel im Compose-Stack haeufig vor Postgres bereit ist.
 * Ohne das Warten stirbt der Container beim ersten Start und laeuft erst nach
 * einem Neustart an - ein Verhalten, das bei fremden Betreibern wie ein
 * Fehler aussieht.
 */
export async function waitForDatabase(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  for (;;) {
    try {
      await sql`SELECT 1`;
      if (attempt > 0) log.info(`Datenbank erreichbar nach ${attempt} Versuchen`);
      return;
    } catch (err) {
      attempt++;
      if (Date.now() >= deadline) {
        throw new DatabaseUnreachableError(config.DATABASE_URL, err);
      }
      const wait = Math.min(1000 * attempt, 3000);
      if (attempt === 1) log.warn('Datenbank noch nicht bereit, warte ...');
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export class DatabaseUnreachableError extends Error {
  constructor(url: string, override readonly cause: unknown) {
    const target = url.replace(/\/\/[^@]*@/, '//***@');
    super(`Postgres ist unter ${target} nicht erreichbar`);
    this.name = 'DatabaseUnreachableError';
  }
}

export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 }).catch(() => {});
}
