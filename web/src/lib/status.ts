import type { ServerStatus } from './types';
import { t } from './i18n';

/** Ein Ort fuer Farbe und Wortlaut jedes Zustands - Liste, Kopf und Konsole sprechen dieselbe Sprache. */
export const STATUS: Record<ServerStatus, { label: string; led: string; busy: boolean }> = {
  // label als Getter: der Text kommt bei jedem Zugriff aus der aktuellen Sprache.
  running:        { get label() { return t('status.running'); },        led: 'bg-led-run',     busy: false },
  starting:       { get label() { return t('status.starting'); },       led: 'bg-led-start',   busy: true },
  stopping:       { get label() { return t('status.stopping'); },       led: 'bg-led-start',   busy: true },
  offline:        { get label() { return t('status.offline'); },        led: 'bg-led-stop',    busy: false },
  crashed:        { get label() { return t('status.crashed'); },        led: 'bg-led-crash',   busy: false },
  installing:     { get label() { return t('status.installing'); },     led: 'bg-led-install', busy: true },
  install_failed: { get label() { return t('status.install_failed'); }, led: 'bg-led-crash',   busy: false },
  suspended:      { get label() { return t('status.suspended'); },      led: 'bg-led-crash',   busy: false },
};

/** Welche Knoepfe ergeben in welchem Zustand Sinn - deckungsgleich mit der API. */
export const POWER_ALLOWED: Record<'start' | 'stop' | 'restart' | 'kill', ServerStatus[]> = {
  start: ['offline', 'crashed'],
  stop: ['running', 'starting'],
  restart: ['running', 'starting', 'crashed', 'offline'],
  kill: ['running', 'starting', 'stopping'],
};

export function formatMb(mb: number) {
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`;
}

/** Netzwerk-Rate in Bit pro Sekunde - so, wie Leitungen angegeben werden. */
export function formatRate(bytesPerS: number) {
  const bits = bytesPerS * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(1)} Gbit/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kbit/s`;
  return `${Math.round(bits)} bit/s`;
}
