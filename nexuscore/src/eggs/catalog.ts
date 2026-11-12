import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** docs/EGG-KATALOG.md: neben dem Core oder im Repository (eine Ebene darueber). */
function findCatalogDoc(): string {
  const candidates = [join(process.cwd(), 'docs', 'EGG-KATALOG.md'), join(process.cwd(), '..', 'docs', 'EGG-KATALOG.md')];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
}

/**
 * Online-Katalog aller verfuegbaren Eggs (Pelican-, Pterodactyl- und Community-Sammlungen).
 *
 * Kombiniert:
 *  1. Den kuratierten Katalog aus docs/EGG-KATALOG.md (263 Spiele mit
 *     Steam-ID, Laufzeit, Ports und Bewertung)
 *  2. Eine Live-Suche ueber die GitHub-Trees-API der offiziellen
 *     pelican-eggs UND pterodactyl/game-eggs Repositories (500+ Spiele),
 *     zwischengespeichert fuer 30 Minuten.
 *  3. Intelligente Such-Optimierung: Deutsche Begriffe, bekannte Abkuerzungen
 *     (LS25, CS2, GTA, MC, ARK, 7D2D ...), Duplikat-Bereinigung sowie
 *     Tippfehler-Toleranz (Levenshtein-Fuzzy-Suche).
 *  4. Automatischer GitHub-Community-Fallback fuer brandneue oder seltene Spiele.
 */

export interface CatalogEntry {
  name: string;
  category: string;
  steamId: number | null;
  runtime: string;
  ports: string;
  rating: string;
  url: string;
  rawUrl: string;
  repo: string;
  path: string;
}

const REPOS = [
  { repo: 'pelican-eggs/games-steamcmd', category: 'SteamCMD' },
  { repo: 'pelican-eggs/games-standalone', category: 'Standalone' },
  { repo: 'pelican-eggs/minecraft', category: 'Minecraft' },
  { repo: 'pelican-eggs/voice', category: 'Voice' },
  { repo: 'pelican-eggs/chatbots', category: 'Chatbots' },
  { repo: 'pterodactyl/game-eggs', category: 'Auto' },
] as const;

/**
 * Bekannte deutsche Begriffe, Abkuerzungen und Synonyme, damit man Spiele
 * auch unter ihrem Umgangsnamen sofort findet.
 */
const SEARCH_ALIASES: Record<string, string[]> = {
  ls: ['farming simulator', 'landwirtschafts'],
  ls19: ['farming simulator 19'],
  ls22: ['farming simulator 22'],
  ls25: ['farming simulator 25'],
  fs19: ['farming simulator 19'],
  fs22: ['farming simulator 22'],
  fs25: ['farming simulator 25'],
  landwirtschafts: ['farming simulator'],
  landwirtschaftssimulator: ['farming simulator'],
  cs: ['counter-strike', 'counter strike'],
  cs2: ['counter-strike 2', 'counter strike 2', 'csgo'],
  csgo: ['counter-strike', 'cs2'],
  css: ['counter-strike source'],
  gta: ['fivem', 'altv', 'alt:v', 'ragemp', 'grand theft auto', ' RedM'],
  gta5: ['fivem', 'altv', 'alt:v', 'ragemp'],
  gtav: ['fivem', 'altv', 'alt:v', 'ragemp'],
  rp: ['fivem', 'altv', 'garry', 'redm'],
  rdr2: ['redm'],
  mc: ['minecraft', 'paper', 'purpur', 'fabric', 'forge', 'spigot', 'vanilla', 'velocity', 'bungeecord'],
  bukkit: ['paper', 'spigot', 'purpur'],
  ark: ['ark survival evolved', 'ark survival ascended'],
  ase: ['ark survival evolved'],
  asa: ['ark survival ascended'],
  '7d2d': ['7 days to die'],
  '7days': ['7 days to die'],
  dst: ["don't starve together", 'dont starve together'],
  l4d: ['left 4 dead'],
  l4d2: ['left 4 dead 2'],
  tf2: ['team fortress 2'],
  gmod: ["garry's mod", 'garrys mod'],
  garrysmod: ["garry's mod", 'garrys mod'],
  sotf: ['sons of the forest'],
  forest: ['the forest', 'sons of the forest'],
  ets: ['euro truck simulator'],
  ets2: ['euro truck simulator 2'],
  ats: ['american truck simulator'],
  ac: ['assetto corsa'],
  assetto: ['assetto corsa'],
  ts: ['teamspeak', 'ts3'],
  ts3: ['teamspeak'],
  dc: ['discord', 'sinusbot', 'redbot', 'jmusicbot'],
  scpsl: ['scp secret laboratory'],
  scp: ['scp secret laboratory'],
  moria: ['return to moria', 'lord of the rings'],
  lotr: ['return to moria'],
  cod: ['call of duty', 'iw4x', 'plutonium'],
};

let cachedDocs: CatalogEntry[] | null = null;
let cachedLive: { at: number; items: CatalogEntry[] } | null = null;
const cachedCommunity = new Map<string, { at: number; items: CatalogEntry[] }>();
const LIVE_TTL_MS = 30 * 60_000;

export function toRawGithubUrl(url: string): string {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.trim());
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  return url.trim();
}

export function isAllowedEggUrl(url: string): boolean {
  try {
    const u = new URL(toRawGithubUrl(url));
    if (u.protocol !== 'https:') return false;
    return (
      u.hostname === 'raw.githubusercontent.com' ||
      u.hostname === 'github.com' ||
      u.hostname === 'gist.githubusercontent.com'
    ) && u.pathname.endsWith('.json');
  } catch {
    return false;
  }
}

/** Normalisiert einen Spielnamen fuer die Wort-Suche. */
export function normalizeSearchKey(input: string): string {
  return input
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/^pterodactyl[\s-_]+/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Kompakter Schluessel ohne Leerzeichen fuer Duplikat-Bereinigung (z. B. "Five M" == "FiveM", "Bep I Nex" == "BepINex"). */
function normalizeCompactKey(input: string): string {
  return normalizeSearchKey(input).replace(/\s+/g, '');
}

/** Berechnet die Levenshtein-Editierdistanz fuer Tippfehler-Toleranz (z. B. "valhiem" -> "valheim"). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > 3) return 99;

  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}

/** Leitet aus einem Dateipfad (z. B. in pterodactyl/game-eggs) die passende Kategorie ab. */
export function inferCategoryFromPath(path: string, fallback: string): string {
  if (fallback !== 'Auto') return fallback;
  const p = path.toLowerCase();
  if (p.startsWith('minecraft/')) return 'Minecraft';
  if (p.startsWith('voice') || p.includes('teamspeak') || p.includes('mumble')) return 'Voice';
  if (p.startsWith('chatbots/') || p.includes('discord') || p.includes('bot/')) return 'Chatbots';
  if (p.includes('steamcmd')) return 'SteamCMD';
  return 'Standalone';
}

/** Liest die kuratierte Tabelle aus docs/EGG-KATALOG.md ein. */
export async function loadCuratedCatalog(docPath = findCatalogDoc()): Promise<CatalogEntry[]> {
  if (cachedDocs) return cachedDocs;
  let text: string;
  try {
    text = await readFile(docPath, 'utf8');
  } catch {
    return [];
  }

  const out: CatalogEntry[] = [];
  let currentCategory = 'Sonstige';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const h2 = /^##\s+(.+?)(?:\s+\(\d+\))?$/.exec(line);
    if (h2) {
      const h = h2[1]!.trim();
      if (h.startsWith('Steam-Spiele')) currentCategory = 'SteamCMD';
      else if (h.startsWith('Eigenständige')) currentCategory = 'Standalone';
      else if (h.startsWith('Minecraft')) currentCategory = 'Minecraft';
      else if (h.startsWith('Sprachserver')) currentCategory = 'Voice';
      continue;
    }

    if (!line.startsWith('|') || line.includes('---|---')) continue;
    const cols = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cols.length < 7 || cols[0] === 'Spiel') continue;

    const [name, , steamCol, runtime, ports, rating, linkCol] = cols as [string, string, string, string, string, string, string];
    const urlMatch = /\((https:\/\/github\.com\/[^)]+\.json)\)/.exec(linkCol);
    if (!urlMatch) continue;

    const url = urlMatch[1]!;
    const rawUrl = toRawGithubUrl(url);
    const steamMatch = /\[(\d+)\]/.exec(steamCol);
    const steamId = steamMatch ? Number(steamMatch[1]) : null;
    const repoMatch = /github\.com\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)$/.exec(url);

    out.push({
      name,
      category: currentCategory,
      steamId,
      runtime: runtime === '–' ? 'Linux' : runtime,
      ports: ports === '–' ? '' : ports.replace(/`/g, ''),
      rating,
      url,
      rawUrl,
      repo: repoMatch?.[1] ?? 'pelican-eggs',
      path: repoMatch?.[2] ?? '',
    });
  }

  cachedDocs = out;
  return out;
}

/** Holt zusaetzlich live alle .json-Pfade aus den GitHub-Repos von pelican-eggs und pterodactyl/game-eggs. */
async function loadLiveGithubTrees(fetcher: typeof fetch = fetch): Promise<CatalogEntry[]> {
  if (cachedLive && Date.now() - cachedLive.at < LIVE_TTL_MS) return cachedLive.items;

  const items: CatalogEntry[] = [];
  await Promise.all(
    REPOS.map(async ({ repo, category }) => {
      try {
        // main oder master Branch abfragen (HEAD loest automatisch auf den Standard-Branch auf)
        const res = await fetcher(`https://api.github.com/repos/${repo}/git/trees/HEAD?recursive=1`, {
          headers: { 'User-Agent': 'NexusPanel-EggCatalog' },
          signal: AbortSignal.timeout(4500),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { tree?: Array<{ path?: string; type?: string }> };
        for (const node of data.tree ?? []) {
          const p = node.path ?? '';
          if (node.type !== 'blob' || !p.endsWith('.json') || p.startsWith('.')) continue;
          const file = p.split('/').pop() ?? '';
          if (!file.includes('egg')) continue;
          const pretty = prettyNameFromPath(p);
          const url = `https://github.com/${repo}/blob/HEAD/${p}`;
          items.push({
            name: pretty,
            category: inferCategoryFromPath(p, category),
            steamId: null,
            runtime: 'Linux',
            ports: '',
            rating: 'direkt',
            url,
            rawUrl: toRawGithubUrl(url),
            repo,
            path: p,
          });
        }
      } catch {
        /* GitHub-Rate-Limit oder offline -> lokaler Katalog reicht */
      }
    }),
  );

  if (items.length > 0) {
    cachedLive = { at: Date.now(), items };
  }
  return items;
}

/**
 * Durchsucht GitHub-weit nach Community-Egg-Repositories, falls ein seltenes oder
 * ganz neues Spiel in den offiziellen Sammlungen nicht gefunden wurde.
 */
async function searchCommunityEggRepos(query: string, fetcher: typeof fetch = fetch): Promise<CatalogEntry[]> {
  const key = normalizeSearchKey(query);
  if (key.length < 3) return [];
  const cached = cachedCommunity.get(key);
  if (cached && Date.now() - cached.at < LIVE_TTL_MS) return cached.items;

  const found: CatalogEntry[] = [];
  try {
    const q = encodeURIComponent(`${key} egg pterodactyl OR pelican`);
    const res = await fetcher(`https://api.github.com/search/repositories?q=${q}&per_page=3`, {
      headers: { 'User-Agent': 'NexusPanel-EggCatalog' },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = (await res.json()) as { items?: Array<{ full_name?: string; default_branch?: string }> };
      const repos = (data.items ?? []).slice(0, 3);
      await Promise.all(
        repos.map(async (r) => {
          if (!r.full_name) return;
          const branch = r.default_branch ?? 'main';
          const treeRes = await fetcher(`https://api.github.com/repos/${r.full_name}/git/trees/${branch}?recursive=1`, {
            headers: { 'User-Agent': 'NexusPanel-EggCatalog' },
            signal: AbortSignal.timeout(3500),
          });
          if (!treeRes.ok) return;
          const treeData = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string }> };
          for (const node of treeData.tree ?? []) {
            const p = node.path ?? '';
            if (node.type !== 'blob' || !p.endsWith('.json') || p.startsWith('.')) continue;
            const file = (p.split('/').pop() ?? '').toLowerCase();
            if (!file.includes('egg') || file === 'package.json' || file === 'tsconfig.json') continue;
            const url = `https://github.com/${r.full_name}/blob/${branch}/${p}`;
            found.push({
              name: prettyNameFromPath(p),
              category: 'Community',
              steamId: null,
              runtime: 'Linux',
              ports: '',
              rating: 'direkt',
              url,
              rawUrl: toRawGithubUrl(url),
              repo: r.full_name,
              path: p,
            });
          }
        }),
      );
    }
  } catch {
    /* Netzwerkfehler oder Rate-Limit ignorieren */
  }

  cachedCommunity.set(key, { at: Date.now(), items: found });
  return found;
}

function prettyNameFromPath(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file
    .replace(/^(pterodactyl-)?egg-(pterodactyl-)?/i, '')
    .replace(/\.json$/i, '')
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Erweitert Suchbegriffe um bekannte deutsche Namen und Abkuerzungen (Aliase).
 */
export function expandSearchAliases(query: string): string[] {
  const norm = normalizeSearchKey(query);
  if (!norm) return [];
  const words = norm.split(/\s+/).filter(Boolean);
  const extra = new Set<string>();

  if (SEARCH_ALIASES[norm]) {
    for (const a of SEARCH_ALIASES[norm]!) extra.add(normalizeSearchKey(a));
  }
  for (const w of words) {
    if (SEARCH_ALIASES[w]) {
      for (const a of SEARCH_ALIASES[w]!) extra.add(normalizeSearchKey(a));
    }
  }
  return [...extra];
}

/**
 * Berechnet einen Relevanz-Score (0 = kein Treffer, >0 = Treffer, je hoeher desto besser).
 * Beruecksichtigt exakte Treffer, Wortanfaenge, Aliase (z. B. LS25 -> Farming Simulator 25)
 * und Tippfehler (Fuzzy-Matching via Levenshtein-Distanz).
 */
export function scoreCatalogItem(item: CatalogEntry, query: string, aliasPhrases: string[]): number {
  const qNorm = normalizeSearchKey(query);
  if (!qNorm) return 1;

  const nameNorm = normalizeSearchKey(item.name);
  const hayNorm = normalizeSearchKey(`${item.name} ${item.category} ${item.runtime} ${item.path} ${item.steamId ?? ''}`);
  const terms = qNorm.split(/\s+/).filter(Boolean);

  // 1. Exakter Namens-Treffer oder Start-Treffer
  if (nameNorm === qNorm || String(item.steamId ?? '') === qNorm) return 1000;
  if (nameNorm.startsWith(qNorm)) return 850;

  // 2. Alle Suchwoerter kommen direkt im Namen vor
  if (terms.every((t) => nameNorm.includes(t))) return 700;

  // 3. Alias-Treffer (z. B. "ls25" -> "farming simulator 25", "cs2" -> "counter-strike 2")
  for (const alias of aliasPhrases) {
    if (!alias) continue;
    if (nameNorm === alias) return 900;
    if (nameNorm.includes(alias)) return 750;
    const aliasWords = alias.split(/\s+/).filter(Boolean);
    if (aliasWords.length > 0 && aliasWords.every((w) => hayNorm.includes(w))) return 600;
  }

  // 4. Alle Suchwoerter kommen im gesamten Eintrag (inkl. Pfad/Kategorie/AppID) vor
  if (terms.every((t) => hayNorm.includes(t))) return 500;

  // 5. Tippfehler-Toleranz (Fuzzy-Suche) auf den Woertern des Spielnamens
  const nameWords = nameNorm.split(/\s+/).filter(Boolean);
  const allFuzzyMatched = terms.every((t) => {
    if (hayNorm.includes(t)) return true;
    if (t.length < 4) return false;
    const maxDist = t.length >= 7 ? 2 : 1;
    return nameWords.some((nw) => {
      if (nw.length < 3) return false;
      if (nw.length >= 4 && (nw.startsWith(t) || t.startsWith(nw))) return true;
      return levenshteinDistance(t, nw) <= maxDist;
    });
  });

  if (allFuzzyMatched) return 250;

  return 0;
}

/**
 * Durchsucht alle bekannten Eggs (lokaler Katalog + GitHub-Live-Baeume + Community-Fallback).
 */
export async function searchEggCatalog(
  query: string,
  opts: { category?: string; includeLive?: boolean; existingNames?: Set<string> } = {},
): Promise<(CatalogEntry & { installed: boolean })[]> {
  const curated = await loadCuratedCatalog();

  // Deduplizierung nach kompaktem Namen (z. B. "Five M" === "FiveM",
  // "egg-valheim.json" === "egg-pterodactyl-valheim.json").
  // Prioritaet: 1. Kuratierter Katalog (hat Steam-ID, Laufzeit & Ports), 2. pelican-eggs, 3. pterodactyl/game-eggs
  const byDedupKey = new Map<string, CatalogEntry>();
  for (const item of curated) {
    byDedupKey.set(normalizeCompactKey(item.name), item);
  }

  if (opts.includeLive) {
    const live = await loadLiveGithubTrees();
    for (const item of live) {
      const key = normalizeCompactKey(item.name);
      const existingItem = byDedupKey.get(key);
      if (!existingItem) {
        byDedupKey.set(key, item);
      } else if (
        existingItem.rating === 'direkt' &&
        existingItem.path.includes('egg-pterodactyl-') &&
        !item.path.includes('egg-pterodactyl-') &&
        item.repo.startsWith('pelican-eggs/')
      ) {
        // Bevorzuge die neuere Pelican-Datei gegenueber dem Legacy-Pterodactyl-Klon im selben Ordner
        byDedupKey.set(key, item);
      }
    }
  }

  const aliasPhrases = expandSearchAliases(query);
  const existing = new Set([...(opts.existingNames ?? [])].map((n) => normalizeCompactKey(n)));

  const scoreAndFilter = (entries: Iterable<CatalogEntry>) => {
    const scored: Array<{ item: CatalogEntry & { installed: boolean }; score: number }> = [];
    for (const item of entries) {
      if (opts.category && opts.category !== 'all' && item.category.toLowerCase() !== opts.category.toLowerCase()) {
        continue;
      }
      const score = scoreCatalogItem(item, query, aliasPhrases);
      if (score <= 0) continue;
      scored.push({
        item: {
          ...item,
          installed: existing.has(normalizeCompactKey(item.name)),
        },
        score,
      });
    }
    return scored;
  };

  let scored = scoreAndFilter(byDedupKey.values());

  // 4. Community-Fallback: Wenn der Nutzer konkret sucht und kaum Treffer in den
  // offiziellen Repos existieren, durchsuche automatisch oeffentliche GitHub-Community-Repos
  if (opts.includeLive && query.trim().length >= 3 && scored.length < 3) {
    const community = await searchCommunityEggRepos(query);
    for (const item of community) {
      const key = normalizeCompactKey(item.name);
      if (!byDedupKey.has(key)) byDedupKey.set(key, item);
    }
    scored = scoreAndFilter(byDedupKey.values());
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.item.name.localeCompare(b.item.name);
  });

  return scored.slice(0, 100).map((s) => s.item);
}
