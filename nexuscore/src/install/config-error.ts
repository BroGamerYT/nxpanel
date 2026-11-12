/** Ein Fehler, den der Betreiber beheben kann (fehlendes Skript, Image, Treiber) - nicht der Spieler. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
