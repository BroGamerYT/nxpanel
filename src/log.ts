import pino from 'pino';
import { config, isProduction } from './config.js';

export const log = pino({
  level: config.LOG_LEVEL,
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
  redact: {
    // Nie im Log: alles, was ein Zugang sein koennte.
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.STEAM_PASS', '*.token'],
    censor: '[entfernt]',
  },
});
