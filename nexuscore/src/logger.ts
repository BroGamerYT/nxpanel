import { createRequire } from 'node:module';
import pino from 'pino';
import { config, isProduction } from './config/index.js';

const isStandalone = typeof process.env.NEXUSCORE_STANDALONE !== 'undefined' || isProduction;

/**
 * Die letzten Logzeilen des Cores im Speicher (fuer Admin -> Host-Logs).
 * Mitgeschrieben wird die Ausgabe NACH der Schwärzung von Zugängen (`redact`),
 * nicht die rohen Argumente des Logaufrufs.
 */
const RING_SIZE = 2000;
const ring: string[] = [];
const ringStream = {
  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (!line) continue;
      ring.push(line.length > 4000 ? `${line.slice(0, 4000)}…` : line);
    }
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  },
};

/** Die letzten `lines` Zeilen als JSON-Text (pino-Format), aelteste zuerst. */
export function recentLogLines(lines: number): string[] {
  return ring.slice(-lines);
}

function prettyStream(): NodeJS.WritableStream {
  const require = createRequire(import.meta.url);
  const pretty = require('pino-pretty') as (o: object) => NodeJS.WritableStream;
  return pretty({ translateTime: 'HH:MM:ss', ignore: 'pid,hostname', sync: true });
}

export const logger = pino(
  {
    level: config.logLevel,
    redact: {
      // Nie im Log: alles, was ein Zugang sein koennte.
      paths: [
        'token',
        'pin',
        'secret',
        'password',
        'pairingPin',
        'req.headers.authorization',
        '*.token',
        '*.pin',
        '*.secret',
        '*.password',
        '*.pairingPin',
      ],
      censor: '[entfernt]',
    },
  },
  pino.multistream([
    { stream: isStandalone ? process.stdout : prettyStream() },
    // Der Ring bekommt immer JSON; die huebsche Ausgabe gilt nur fuer die Konsole.
    { stream: ringStream },
  ]),
);

export type Logger = typeof logger;
