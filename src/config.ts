import 'dotenv/config';
import { z } from 'zod';

/**
 * Umgebungsvariablen sind immer Strings. z.coerce.boolean() waere hier eine
 * Falle: Boolean("false") ist in JavaScript true, weil jeder nichtleere
 * String wahr ist. Deshalb wird ausdruecklich auf die erlaubten Schreibweisen
 * geprueft.
 */
const envBool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');


/**
 * Konfiguration kommt ausschliesslich aus der Umgebung.
 * Faellt hier etwas aus, startet das Panel gar nicht erst - besser als
 * ein Dienst, der halb laeuft und erst beim ersten Zugriff umkippt.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PANEL_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  PANEL_URL: z.string().url().default('http://localhost:8080'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL fehlt'),
  REDIS_URL: z.string().min(1, 'REDIS_URL fehlt'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET muss mindestens 32 Zeichen haben'),
  ENCRYPTION_KEY: z.string().length(64, 'ENCRYPTION_KEY muss 64 Hexzeichen sein (32 Byte)'),

  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  /**
   * Blkio-Gewichtung (io.weight) verlangt cgroup v2 mit passendem
   * IO-Scheduler. Der WSL2-Kernel von Docker Desktop bringt das nicht mit:
   * der Container laesst sich dann anlegen, aber nicht starten.
   * Auf einem echten Linux-Host kann es eingeschaltet werden.
   */
  ENABLE_IO_WEIGHT: envBool(false),
  /**
   * DNS-Server fuer Spielcontainer, kommagetrennt. Leer = Dockers Vorgabe,
   * also der Resolver des Hosts. Das ist fast immer richtig: fest
   * eingetragene oeffentliche Server wie 8.8.8.8 scheitern hinter VPNs,
   * Pi-hole oder Firmen-Firewalls, die DNS nur ueber den eigenen Resolver
   * zulassen.
   */
  CONTAINER_DNS: z.string().default(''),
  /**
   * SteamCMD schneller machen: HTTP/2 aus, mehr parallele Content-Server
   * (siehe src/servers/steam-tuning.ts). Abschalten mit false, falls Steam
   * die Einstellungen irgendwann nicht mehr kennt.
   */
  STEAMCMD_FAST_DOWNLOAD: envBool(true),
  VOLUME_ROOT: z.string().default('/var/lib/panel/volumes'),
  BACKUP_ROOT: z.string().default('/var/lib/panel/backups'),
  NAS_BACKUP_ROOT: z.string().default('/mnt/ugreen-backups/nexuspanel'),
  /**
   * Zusaetzliche Ordner fuer den Admin-Dateimanager, z. B.
   * "Panel-Installation=/opt/nxpanel;Logs=/var/log". Sie muessen im
   * Panel-Container eingebunden sein (deploy/docker-compose.yml).
   */
  ADMIN_FILE_ROOTS: z.string().default(''),

  SFTP_PORT: z.coerce.number().int().min(1).max(65535).default(2022),
  SFTP_ENABLED: envBool(true),
  PORT_RANGE: z.string().regex(/^\d+-\d+$/, 'PORT_RANGE muss z. B. 25500-25600 sein').default('25500-25600'),
  TZ: z.string().default('Europe/Berlin'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Konfiguration unvollstaendig:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = parsed.data;

const [portFrom, portTo] = config.PORT_RANGE.split('-').map(Number) as [number, number];
export const portRange = { from: portFrom, to: portTo };

export const isProduction = config.NODE_ENV === 'production';

export const containerDns: string[] = config.CONTAINER_DNS
  .split(',')
  .map((s) => s.trim())
  .filter((s) => /^[0-9a-fA-F.:]+$/.test(s));
