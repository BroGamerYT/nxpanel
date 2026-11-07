import { engine } from '../docker/client.js';
import { StatsCollector } from './stats-collector.js';
import { DiskCollector } from './disk-collector.js';

/** Der eine Sammler des Panels. Startet erst, wenn Docker erreichbar ist (index.ts). */
export const statsCollector = new StatsCollector((cid, cb) => engine.streamStats(cid, cb));

/** Belegter Platz je Server und von Docker, alle 5 Minuten gemessen. */
export const diskCollector = new DiskCollector(() => engine.diskUsage());
