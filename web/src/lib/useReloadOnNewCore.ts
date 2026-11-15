import { useEffect } from 'react';
import { parseCoreVersion, shouldReload } from './coreVersionCheck';

const POLL_MS = 20_000;

/** Fragt die oeffentliche Info-Route; null, wenn der Core gerade nicht antwortet (Neustart) oder es kein Core ist (Panel). */
async function readCoreVersion(): Promise<string | null> {
  try {
    const res = await fetch('/core/v1/info', { cache: 'no-store' });
    if (!res.ok) return null;
    return parseCoreVersion(await res.json());
  } catch {
    return null;
  }
}

/**
 * Laedt die Seite neu, sobald der Core eine andere Version meldet als beim Oeffnen der Seite.
 * Ohne das laeuft nach einem Update die alte Oberflaeche weiter (alter Code im Browser) - besonders, wenn der Neustart
 * abmeldet und dabei die Update-Karte verschwindet, die sonst selbst neu laedt. Funktioniert auch auf der Anmeldeseite.
 */
export function useReloadOnNewCore(): void {
  useEffect(() => {
    let baseline: string | null = null;
    let stopped = false;
    const check = async () => {
      const current = await readCoreVersion();
      if (stopped) return;
      if (baseline === null) {
        baseline = current;
        return;
      }
      if (shouldReload(baseline, current)) window.location.reload();
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
