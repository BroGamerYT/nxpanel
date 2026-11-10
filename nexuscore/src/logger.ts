import pino from 'pino';
import { config, isProduction } from './config/index.js';

const isStandalone = typeof process.env.NEXUSCORE_STANDALONE !== 'undefined' || isProduction;

export const logger = pino({
  level: config.logLevel,
  ...(isStandalone
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
  redact: {
    // Nie im Log: alles, was ein Zugang sein koennte.
    paths: [
      'req.headers.authorization',
      '*.token',
      '*.pin',
      '*.secret',
      '*.password',
      '*.pairingPin',
    ],
    censor: '[entfernt]',
  },
});

export type Logger = typeof logger;
