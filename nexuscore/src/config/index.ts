import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Boolean aus der Umgebung: nur ausdruecklich erlaubte Schreibweisen sind
 * "wahr". Boolean("false") waere in JavaScript true, weil jeder nichtleere
 * String wahr ist - deshalb wird hier nicht auf z.coerce(boolean) gesetzt.
 */
const envBool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const here =
  typeof import.meta !== 'undefined' && import.meta.url
    ? path.dirname(fileURLToPath(import.meta.url))
    : path.dirname(process.execPath);

/**
 * Die Konfiguration kommt ausschliesslich aus der Umgebung.
 * Faellt hier etwas aus, startet der Daemon gar nicht erst - besser als ein
 * Dienst, der halb laeuft und erst beim ersten Zugriff umkippt.
 */
const schema = z
  .object({
    NEXUSCORE_MODE: z.enum(['test', 'production']).default('test'),
    NEXUSCORE_HOST: z.string().default('127.0.0.1'),
    NEXUSCORE_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
    NEXUSCORE_RUNTIME: z.enum(['windows-native', 'docker', 'mock']).optional(),
    NEXUSCORE_DATA_DIR: z.string().default(path.resolve(process.cwd(), 'data')),
    NEXUSCORE_TOKEN: z.string().default(''),
    NEXUSCORE_PAIRING_PIN: z.string().default(''),
    NEXUSCORE_CORS_ORIGINS: z.string().default(''),
    NEXUSCORE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    NEXUSCORE_ALLOW_INSECURE_AUTH: envBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NEXUSCORE_MODE !== 'production') return;
    if (env.NEXUSCORE_TOKEN.length < 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXUSCORE_TOKEN'],
        message: 'NEXUSCORE_TOKEN muss im Production-Modus mindestens 24 Zeichen haben',
      });
    }
    if (env.NEXUSCORE_PAIRING_PIN.length < 6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXUSCORE_PAIRING_PIN'],
        message: 'NEXUSCORE_PAIRING_PIN muss im Production-Modus mindestens 6 Zeichen haben',
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('NexusCore-Konfiguration unvollstaendig:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const isProduction = env.NEXUSCORE_MODE === 'production';

export const config = {
  mode: env.NEXUSCORE_MODE,
  host: env.NEXUSCORE_HOST,
  port: env.NEXUSCORE_PORT,
  runtime:
    env.NEXUSCORE_RUNTIME ??
    (process.platform === 'win32' ? ('windows-native' as const) : ('docker' as const)),
  dataDir: path.resolve(process.cwd(), env.NEXUSCORE_DATA_DIR),
  token: env.NEXUSCORE_TOKEN,
  pairingPin: env.NEXUSCORE_PAIRING_PIN,
  corsOrigins: env.NEXUSCORE_CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logLevel: env.NEXUSCORE_LOG_LEVEL,
  /** Nur fuer den lokalen Einstiegstest: erlaubt Zugriff ohne Token. */
  allowInsecureAuth: env.NEXUSCORE_ALLOW_INSECURE_AUTH,
};

export const dataDir = config.dataDir;
