import 'dotenv/config';
import { z } from 'zod';
import { platformFor } from '../platform/index.js';
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
    NEXUSCORE_ROLE: z.enum(['standalone', 'node']).default('standalone'),
    NEXUSCORE_HOST: z.string().default('127.0.0.1'),
    NEXUSCORE_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
    NEXUSCORE_RUNTIME: z.enum(['windows-native', 'docker', 'mock']).optional(),
    NEXUSCORE_DATA_DIR: z.string().default(path.resolve(process.cwd(), 'data')),
    NEXUSCORE_TOKEN: z.string().default(''),
    NEXUSCORE_PAIRING_PIN: z.string().default(''),
    NEXUSCORE_CORS_ORIGINS: z.string().default(''),
    NEXUSCORE_ALLOWED_HOSTS: z.string().default(''),
    NEXUSCORE_SERVER_ROOT: z.string().default(''),
    NEXUSCORE_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(102400).default(2048),
    NEXUSCORE_PORT_RANGE: z
      .string()
      .regex(/^\d+-\d+$/, 'NEXUSCORE_PORT_RANGE muss z. B. 25565-25664 sein')
      .default('25565-25664'),
    NEXUSCORE_ADMIN_USER: z.string().trim().min(1).max(64).default('admin'),
    NEXUSCORE_ADMIN_PASSWORD: z.string().default(''),
    NEXUSCORE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    NEXUSCORE_ALLOW_INSECURE_AUTH: envBool(false),
    NEXUSCORE_ALLOW_USER_FILE_WRITE: envBool(false),
    NEXUSCORE_SFTP_ENABLED: envBool(false),
    NEXUSCORE_SFTP_PORT: z.coerce.number().int().min(1).max(65535).default(2022),
    NEXUSCORE_SFTP_HOST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    const [rangeFrom, rangeTo] = env.NEXUSCORE_PORT_RANGE.split('-').map(Number);
    if (!rangeFrom || !rangeTo || rangeFrom > rangeTo || rangeTo > 65535) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXUSCORE_PORT_RANGE'],
        message: 'NEXUSCORE_PORT_RANGE: Anfang muss kleiner oder gleich Ende sein, hoechstens 65535',
      });
    }
    if (env.NEXUSCORE_ADMIN_PASSWORD !== '' && env.NEXUSCORE_ADMIN_PASSWORD.length < 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NEXUSCORE_ADMIN_PASSWORD'],
        message: 'NEXUSCORE_ADMIN_PASSWORD braucht mindestens 10 Zeichen',
      });
    }
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
  role: env.NEXUSCORE_ROLE,
  host: env.NEXUSCORE_HOST,
  port: env.NEXUSCORE_PORT,
  runtime: env.NEXUSCORE_RUNTIME ?? platformFor().defaultRuntime,
  dataDir: path.resolve(process.cwd(), env.NEXUSCORE_DATA_DIR),
  token: env.NEXUSCORE_TOKEN,
  pairingPin: env.NEXUSCORE_PAIRING_PIN,
  corsOrigins: env.NEXUSCORE_CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  /** Zusaetzliche Hostnamen, unter denen der Core angesprochen werden darf (Schutz gegen DNS-Rebinding). */
  allowedHosts: env.NEXUSCORE_ALLOWED_HOSTS.split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
  /** Verzeichnis, in dem alle Instanzen liegen muessen. Leer = `<dataDir>/servers`. */
  serverRoot: env.NEXUSCORE_SERVER_ROOT.trim(),
  /** Groesste Datei, die der Dateimanager hochladen darf (MB). */
  maxUploadMb: env.NEXUSCORE_MAX_UPLOAD_MB,
  /** Bereich, aus dem der Core Spielports vergibt. */
  portRange: {
    from: Number(env.NEXUSCORE_PORT_RANGE.split('-')[0]),
    to: Number(env.NEXUSCORE_PORT_RANGE.split('-')[1]),
  },
  /** Name des lokalen Kontos im Standalone-Modus. */
  adminUser: env.NEXUSCORE_ADMIN_USER,
  /** Optional: festes Passwort des lokalen Kontos. Leer = beim ersten Start erzeugt. */
  adminPassword: env.NEXUSCORE_ADMIN_PASSWORD,
  logLevel: env.NEXUSCORE_LOG_LEVEL,
  /** Nur fuer den lokalen Einstiegstest: erlaubt Zugriff ohne Token. */
  allowInsecureAuth: env.NEXUSCORE_ALLOW_INSECURE_AUTH,
  /**
   * Duerfen Benutzer ohne Administratorrolle Dateien ihrer Server aendern, hochladen und entpacken?
   * Auf dem nativen Treiber laufen Server ohne Schutz als Benutzer des Cores: wer eine Startdatei oder
   * ein Plugin ueberschreiben kann, fuehrt damit Programme auf diesem Rechner aus. Deshalb standardmaessig nein.
   */
  allowUserFileWrite: env.NEXUSCORE_ALLOW_USER_FILE_WRITE,
  /** SFTP-Zugang (Port 2022): standardmaessig aus. */
  sftpEnabled: env.NEXUSCORE_SFTP_ENABLED,
  sftpPort: env.NEXUSCORE_SFTP_PORT,
  /** Adresse fuer SFTP; leer = dieselbe wie die des Cores (also nur dieser Rechner, solange der Core es ist). */
  sftpHost: env.NEXUSCORE_SFTP_HOST.trim() || env.NEXUSCORE_HOST,
};

export const dataDir = config.dataDir;
