/**
 * Dienstbetrieb: die Dienst-Huelle (nxsvc) startet den Core mit NEXUSCORE_SERVICE=1 und einem Stdin-Rohr.
 * Schliesst sie das Rohr, heisst das "sauber beenden" - Windows kennt kein SIGTERM fuer Dienste.
 */
export function watchServiceStdin(stream: NodeJS.ReadableStream, onStop: () => void): void {
  let done = false;
  const stop = (): void => {
    if (done) return;
    done = true;
    onStop();
  };
  stream.on('end', stop);
  stream.on('close', stop);
  stream.on('error', stop);
  // Eingaben werden gelesen und verworfen; das Rohr soll nur offen bleiben, bis es geschlossen wird
  stream.on('data', () => {});
  stream.resume();
}
