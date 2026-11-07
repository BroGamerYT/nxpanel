// Laeuft in jedem Test-Worker vor allen Importen: lenkt Postgres und Redis
// auf die Testdatenbanken um (siehe test-db.ts). dotenv ueberschreibt
// bereits gesetzte Variablen nicht, also gilt das auch fuer src/config.ts.
import { readDotEnv, testDatabaseUrl, testRedisUrl } from './test-db.js';

const merged = { ...(await readDotEnv()), ...process.env };
process.env.DATABASE_URL = testDatabaseUrl(merged);
process.env.REDIS_URL = testRedisUrl(merged);
