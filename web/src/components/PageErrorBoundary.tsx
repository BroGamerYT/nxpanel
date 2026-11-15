import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { isChunkLoadError } from '../lib/chunkError';

const RELOAD_KEY = 'nx.chunk-reload';

interface Props { children: ReactNode; resetKey: string }
interface State { error: Error | null }

/**
 * Faengt Fehler beim Anzeigen einer Seite ab. Ohne das wird bei jedem Fehler (z. B. eine Seitendatei, die nach einem
 * Update nicht mehr existiert) die ganze Oberflaeche leer. Bei einem Ladefehler einer Seitendatei laedt die Seite einmal
 * selbst neu; sonst gibt es eine Meldung mit Knopf. Beim Wechsel der Seite wird der Fehler zurueckgesetzt.
 */
class Boundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Seitenfehler', error, info.componentStack);
    if (isChunkLoadError(error)) {
      const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        window.location.reload();
      }
    }
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-lg border border-line bg-rack-2/40 p-6 max-w-xl">
        <p className="font-medium text-ink">Diese Seite konnte nicht angezeigt werden.</p>
        <p className="text-sm text-dim mt-1">
          {isChunkLoadError(this.state.error)
            ? 'Ein Teil der Oberfläche konnte nicht geladen werden (vermutlich nach einem Update).'
            : 'Beim Anzeigen ist ein Fehler aufgetreten.'}
        </p>
        <div className="flex gap-2 mt-4">
          <button type="button" className="rounded-md px-3 h-9 text-sm bg-rack-2 hover:bg-rack-2/70" onClick={() => window.location.reload()}>
            Neu laden
          </button>
          <button type="button" className="rounded-md px-3 h-9 text-sm text-dim hover:text-ink" onClick={() => this.setState({ error: null })}>
            Erneut versuchen
          </button>
        </div>
      </div>
    );
  }
}

export function PageErrorBoundary({ children }: { children: ReactNode }) {
  const loc = useLocation();
  return <Boundary resetKey={loc.pathname}>{children}</Boundary>;
}
