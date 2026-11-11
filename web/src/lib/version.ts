export interface GitHubUpdateInfo {
  hasUpdate: boolean;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
}

export interface DevlogEntry {
  date: string;
  time: string;
  text: string;
  files: string;
}

export interface DocMeta {
  slug: string;
  filename: string;
  relativePath: string;
  title: string;
  category: string;
  categoryLabel: string;
  description: string;
  size: number;
  sizeFormatted: string;
  lineCount: number;
  updatedAt: string;
}

export interface DocDetail extends DocMeta {
  content: string;
}

export interface About {
  version: string; build: number | null; builtAt: string | null; dev: boolean;
  update?: GitHubUpdateInfo;
  /** Von aussen erreichbarer SFTP-Port */
  sftp?: { enabled: boolean; port: number };
  changelog: Array<{ version: string; date: string | null; title: string | null; sections: Array<{ title: string; items: string[] }> }>;
  todo: Array<{ title: string; items: Array<{ text: string; done: boolean; version: string | null }> }>;
  devlog?: DevlogEntry[];
  docs?: DocMeta[];
  /** Nur der eigenstaendige NexusCore: er kann nicht alles. Fehlt die Angabe (Panel), ist alles verfuegbar. */
  standalone?: boolean;
  features?: string[];
}

const KEY = 'nxp.seenVersion';

/** Welche Version hat dieser Browser zuletzt unter "Was ist neu" gesehen? Nur Komfort - darf fehlen. */
export function seenVersion(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export function markVersionSeen(v: string) {
  try { localStorage.setItem(KEY, v); } catch { /* privat-Modus o. ae. */ }
  window.dispatchEvent(new Event('nxp-version-seen'));
}
