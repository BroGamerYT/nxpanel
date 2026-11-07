import { log } from '../log.js';
import { PANEL_VERSION } from '../version.js';

/**
 * Modpacks von CurseForge, Modrinth und Feed the Beast.
 *
 * Das Panel sucht selbst (der Browser fragt keine Drittseiten an) und gibt
 * pro Treffer alles mit, was das Minecraft-Egg braucht: Servertyp, Feld fuer
 * das Pack, die aktuelle Version zum Festsetzen (Pinning) und Vorschlaege fuer
 * Java und RAM. Die Version wird festgesetzt, weil das itzg-Image sonst bei
 * jedem Neustart still auf die neueste Pack-Version springt - ohne Backup.
 * Updates laufen stattdessen ueber den Update-Knopf (mit Backup vorher).
 */

export type PackSource = 'curseforge' | 'modrinth' | 'ftb';
export type Fetcher = typeof fetch;

export interface PackVersion { id: string; name: string; mcVersion: string | null; date: string | null }

export interface PackHit {
  source: PackSource;
  /** Kennung fuer das Egg: CurseForge-Slug, Modrinth-Slug, FTB-ID. */
  ref: string;
  name: string;
  summary: string;
  icon: string | null;
  downloads: number;
  url: string;
  mcVersions: string[];
  loaders: string[];
  latest: PackVersion | null;
  /** CurseForge: Autor erlaubt keinen automatischen Download - Server kann das Pack nicht selbst holen. */
  manualDownload?: boolean;
}

export interface PackPreset {
  values: Record<string, string>;
  java: number;
  ramMb: number;
}

const UA = `NexusPanel/${PANEL_VERSION} (self-hosted game server panel)`;
const TIMEOUT = 8000;

async function getJson<T>(f: Fetcher, url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await f(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`${new URL(url).host} antwortet ${res.status}`);
  return (await res.json()) as T;
}

const LOADERS = ['neoforge', 'forge', 'fabric', 'quilt'];

// ------------------------------------------------------------- Modrinth

interface MrHit {
  project_id: string; slug: string; title: string; description: string; icon_url?: string | null;
  downloads: number; versions?: string[]; categories?: string[]; display_categories?: string[]; latest_version?: string;
}
interface MrVersion { id: string; name: string; version_number: string; version_type: string; game_versions: string[]; date_published: string; loaders?: string[] }

export async function searchModrinth(q: string, f: Fetcher = fetch): Promise<PackHit[]> {
  const url = `https://api.modrinth.com/v2/search?limit=12&index=relevance&query=${encodeURIComponent(q)}&facets=${encodeURIComponent('[["project_type:modpack"]]')}`;
  const data = await getJson<{ hits: MrHit[] }>(f, url);
  return data.hits.map((h) => {
    const cats = [...(h.categories ?? []), ...(h.display_categories ?? [])];
    const versions = (h.versions ?? []).filter((v) => /^\d/.test(v));
    return {
      source: 'modrinth' as const,
      ref: h.slug,
      name: h.title,
      summary: h.description,
      icon: h.icon_url || null,
      downloads: h.downloads,
      url: `https://modrinth.com/modpack/${h.slug}`,
      mcVersions: versions.slice(-3).reverse(),
      loaders: LOADERS.filter((l) => cats.includes(l)),
      latest: h.latest_version ? { id: h.latest_version, name: '', mcVersion: versions.at(-1) ?? null, date: null } : null,
    };
  });
}

export async function modrinthVersions(slug: string, f: Fetcher = fetch): Promise<PackVersion[]> {
  const list = await getJson<MrVersion[]>(f, `https://api.modrinth.com/v2/project/${encodeURIComponent(slug)}/version`);
  return list
    .filter((v) => v.version_type === 'release')
    .sort((a, b) => b.date_published.localeCompare(a.date_published))
    .map((v) => ({ id: v.id, name: v.version_number || v.name, mcVersion: v.game_versions.at(-1) ?? null, date: v.date_published }));
}

// ----------------------------------------------------------- CurseForge

interface CfFile { id: number; displayName: string; fileName: string; fileDate: string; releaseType: number; gameVersions: string[] }
interface CfMod {
  id: number; name: string; slug: string; summary: string; downloadCount: number;
  logo?: { thumbnailUrl?: string; url?: string } | null; links?: { websiteUrl?: string };
  latestFiles?: CfFile[]; latestFilesIndexes?: Array<{ gameVersion: string; fileId: number; modLoader?: number | null }>;
  allowModDistribution?: boolean | null;
}
const CF_LOADER: Record<number, string> = { 1: 'forge', 4: 'fabric', 5: 'quilt', 6: 'neoforge' };
const CF_API = 'https://api.curseforge.com/v1';

/** Neueste Release-Datei; ohne Release die neueste ueberhaupt. */
function newestFile(files: CfFile[] = []): CfFile | null {
  const sorted = [...files].sort((a, b) => b.fileDate.localeCompare(a.fileDate));
  return sorted.find((x) => x.releaseType === 1) ?? sorted[0] ?? null;
}
function mcOf(file: CfFile | null): string | null {
  return file?.gameVersions.filter((v) => /^\d+\.\d+/.test(v)).sort(compareMc).at(-1) ?? null;
}

function cfHit(m: CfMod): PackHit {
  const file = newestFile(m.latestFiles);
  const versions = [...new Set((m.latestFilesIndexes ?? []).map((i) => i.gameVersion).filter((v) => /^\d/.test(v)))].sort(compareMc);
  const loaders = [...new Set((m.latestFilesIndexes ?? []).map((i) => CF_LOADER[i.modLoader ?? 0]).filter(Boolean) as string[])];
  return {
    source: 'curseforge',
    ref: m.slug,
    name: m.name,
    summary: m.summary,
    icon: m.logo?.thumbnailUrl || m.logo?.url || null,
    downloads: m.downloadCount,
    url: m.links?.websiteUrl || `https://www.curseforge.com/minecraft/modpacks/${m.slug}`,
    mcVersions: versions.slice(-3).reverse(),
    loaders: LOADERS.filter((l) => loaders.includes(l)),
    latest: file ? { id: String(file.id), name: file.displayName, mcVersion: mcOf(file), date: file.fileDate } : null,
    ...(m.allowModDistribution === false ? { manualDownload: true } : {}),
  };
}

function cfHeaders(apiKey: string): Record<string, string> {
  const clean = apiKey.trim();
  const headers: Record<string, string> = {
    'x-api-key': clean,
    'User-Agent': UA,
  };
  // Neuer CurseForge-Header für Personal Access Tokens (cfc_pat_...)
  if (clean.startsWith('cfc_pat_')) {
    headers['Authorization'] = `Key ${clean}`;
  }
  return headers;
}

export async function searchCurseForge(q: string, apiKey: string, f: Fetcher = fetch): Promise<PackHit[]> {
  const url = `${CF_API}/mods/search?gameId=432&classId=4471&sortField=2&sortOrder=desc&pageSize=12&searchFilter=${encodeURIComponent(q)}`;
  const data = await getJson<{ data: CfMod[] }>(f, url, cfHeaders(apiKey));
  return data.data.map(cfHit);
}

async function cfModBySlug(slug: string, apiKey: string, f: Fetcher): Promise<CfMod | null> {
  const data = await getJson<{ data: CfMod[] }>(f, `${CF_API}/mods/search?gameId=432&classId=4471&slug=${encodeURIComponent(slug)}`, cfHeaders(apiKey));
  return data.data.find((m) => m.slug === slug) ?? data.data[0] ?? null;
}

export async function curseForgeVersions(slug: string, apiKey: string, f: Fetcher = fetch): Promise<{ mod: PackHit | null; versions: PackVersion[] }> {
  const mod = await cfModBySlug(slug, apiKey, f);
  if (!mod) return { mod: null, versions: [] };
  const files = await getJson<{ data: CfFile[] }>(f, `${CF_API}/mods/${mod.id}/files?pageSize=50`, cfHeaders(apiKey));
  const versions = files.data
    .filter((x) => x.releaseType === 1)
    .sort((a, b) => b.fileDate.localeCompare(a.fileDate))
    .map((x) => ({ id: String(x.id), name: x.displayName, mcVersion: mcOf(x), date: x.fileDate }));
  return { mod: cfHit(mod), versions };
}

/** Schluessel pruefen, bevor er gespeichert wird (prueft gegen Mod 238222 = JEI, erfordert gueltigen Key). */
export async function checkCurseForgeKey(apiKey: string, f: Fetcher = fetch): Promise<boolean> {
  try {
    const res = await f(`${CF_API}/mods/238222`, { headers: cfHeaders(apiKey), signal: AbortSignal.timeout(TIMEOUT) });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- Feed the Beast

const FTB_API = 'https://api.feed-the-beast.com/v1/modpacks/public/modpack';
interface FtbTarget { name: string; version: string; type: string }
interface FtbVersion { id: number; name: string; type: string; updated?: number; targets?: FtbTarget[] }
interface FtbPack {
  id: number; name: string; synopsis?: string; installs?: number; plays?: number;
  art?: Array<{ url: string; type: string }>; versions?: FtbVersion[]; tags?: Array<{ name: string }>;
}

function ftbVersion(v: FtbVersion): PackVersion {
  return {
    id: String(v.id),
    name: v.name,
    mcVersion: v.targets?.find((t) => t.type === 'game' || t.name === 'minecraft')?.version ?? null,
    date: v.updated ? new Date(v.updated * 1000).toISOString() : null,
  };
}
function ftbReleases(p: FtbPack): FtbVersion[] {
  return [...(p.versions ?? [])].filter((v) => v.type?.toLowerCase() === 'release').sort((a, b) => b.id - a.id);
}

function ftbHit(p: FtbPack): PackHit {
  const rel = ftbReleases(p);
  const newest = rel[0] ?? null;
  const loaders = (newest?.targets ?? []).filter((t) => t.type === 'modloader').map((t) => t.name.toLowerCase());
  const mc = [...new Set(rel.map((v) => ftbVersion(v).mcVersion).filter((x): x is string => !!x))].sort(compareMc);
  const art = p.art?.find((a) => a.type === 'square') ?? p.art?.[0];
  const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    source: 'ftb',
    ref: String(p.id),
    name: p.name,
    summary: p.synopsis ?? '',
    icon: art?.url ?? null,
    downloads: p.installs ?? p.plays ?? 0,
    url: `https://www.feed-the-beast.com/modpacks/${p.id}-${slug}`,
    mcVersions: mc.slice(-3).reverse(),
    loaders: LOADERS.filter((l) => loaders.includes(l)),
    latest: newest ? ftbVersion(newest) : null,
  };
}

export async function ftbPack(id: string, f: Fetcher = fetch): Promise<FtbPack> {
  return getJson<FtbPack>(f, `${FTB_API}/${encodeURIComponent(id)}`);
}

export async function searchFtb(q: string, f: Fetcher = fetch): Promise<PackHit[]> {
  const res = await getJson<{ packs?: number[] }>(f, `${FTB_API}/search/8?term=${encodeURIComponent(q)}`);
  const ids = (res.packs ?? []).slice(0, 8);
  const packs = await Promise.allSettled(ids.map((id) => ftbPack(String(id), f)));
  return packs.flatMap((p) => (p.status === 'fulfilled' && p.value?.name ? [ftbHit(p.value)] : []));
}

export async function ftbVersions(id: string, f: Fetcher = fetch): Promise<{ mod: PackHit; versions: PackVersion[] }> {
  const p = await ftbPack(id, f);
  return { mod: ftbHit(p), versions: ftbReleases(p).map(ftbVersion) };
}

// ------------------------------------------------------------ Suche

export interface SearchResult { hits: PackHit[]; errors: Partial<Record<PackSource, string>>; curseforge: 'ok' | 'no_key' }

export async function searchPacks(q: string, opts: { sources?: PackSource[]; cfKey: string | null; fetcher?: Fetcher }): Promise<SearchResult> {
  const f = opts.fetcher ?? fetch;
  const want = opts.sources?.length ? opts.sources : (['curseforge', 'modrinth', 'ftb'] as PackSource[]);
  const errors: SearchResult['errors'] = {};
  const jobs: Array<Promise<PackHit[]>> = [];
  const run = (src: PackSource, p: () => Promise<PackHit[]>) => jobs.push(p().catch((err: unknown) => {
    errors[src] = err instanceof Error ? err.message : String(err);
    log.warn({ err, src }, 'Modpack-Suche fehlgeschlagen');
    return [];
  }));
  if (want.includes('curseforge') && opts.cfKey) run('curseforge', () => searchCurseForge(q, opts.cfKey!, f));
  if (want.includes('modrinth')) run('modrinth', () => searchModrinth(q, f));
  if (want.includes('ftb') && q.trim().length >= 4) run('ftb', () => searchFtb(q, f));
  const lists = await Promise.all(jobs);
  return { hits: rank(q, lists.flat()), errors, curseforge: opts.cfKey ? 'ok' : 'no_key' };
}

/**
 * Reihenfolge: genaue Treffer und Abkuerzungen zuerst ("atm10" -> All the
 * Mods 10), dann nach Downloads. Die Quellen zaehlen Downloads verschieden,
 * deshalb nur als zweites Kriterium.
 */
export function rank(q: string, hits: PackHit[]): PackHit[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const nq = norm(q);
  const abbr = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => (/^\d+$/.test(w) ? w : w[0])).join('');
  const score = (h: PackHit) => {
    const n = norm(h.name);
    if (n === nq || norm(h.ref) === nq) return 0;
    if (abbr(h.name) === nq || norm(h.ref).startsWith(nq)) return 1;
    if (n.startsWith(nq)) return 2;
    if (n.includes(nq)) return 3;
    return 4;
  };
  return [...hits].sort((a, b) => score(a) - score(b) || b.downloads - a.downloads);
}

// ---------------------------------------------- Vorschlaege fuers Egg

export function compareMc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Welche Java-Version braucht diese Minecraft-Version? */
export function javaFor(mc: string | null | undefined): number {
  if (!mc) return 21;
  const [major = 1, minor = 0, patch = 0] = mc.split('.').map((x) => Number.parseInt(x, 10) || 0);
  if (major >= 26) return 25;
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

const BIG_PACKS = /all the mods|\batm\d|enigmatica|vault hunters|gregtech|create: above|stoneblock|direwolf/i;
export function ramFor(hit: Pick<PackHit, 'name' | 'loaders'>): number {
  if (BIG_PACKS.test(hit.name)) return 12288;
  if (hit.loaders.some((l) => l === 'forge' || l === 'neoforge')) return 8192;
  return 6144;
}

/** Variablen fuers Minecraft-Egg - mit festgesetzter Version. */
export function presetFor(hit: PackHit): PackPreset {
  const v = hit.latest?.id ?? '';
  const values: Record<string, string> =
    hit.source === 'curseforge' ? { TYPE: 'AUTO_CURSEFORGE', CF_SLUG: hit.ref, CF_FILE_ID: v }
    : hit.source === 'modrinth' ? { TYPE: 'MODRINTH', MODRINTH_MODPACK: hit.ref, MODRINTH_VERSION: v }
    : { TYPE: 'FTBA', FTB_MODPACK_ID: hit.ref, FTB_MODPACK_VERSION_ID: v };
  return { values, java: javaFor(hit.latest?.mcVersion ?? hit.mcVersions[0]), ramMb: ramFor(hit) };
}

/** Welches Pack laeuft auf einem Server, und welches Feld haelt die festgesetzte Version? */
export interface InstalledPack { source: PackSource; ref: string; versionVar: string; version: string | null }

export function packOf(vars: Record<string, string>): InstalledPack | null {
  const t = (vars.TYPE ?? '').toUpperCase();
  const val = (k: string) => (vars[k] ?? '').trim();
  if (t === 'AUTO_CURSEFORGE') {
    const ref = val('CF_SLUG') || (val('CF_PAGE_URL').match(/modpacks\/([^/?#]+)/)?.[1] ?? '');
    return ref ? { source: 'curseforge', ref, versionVar: 'CF_FILE_ID', version: val('CF_FILE_ID') || null } : null;
  }
  if (t === 'MODRINTH') {
    const raw = val('MODRINTH_MODPACK');
    // Eigene .mrpack-Datei: kein Update ueber eine Plattform moeglich
    if (!raw || raw.endsWith('.mrpack') || raw.startsWith('/')) return null;
    const ref = raw.match(/modrinth\.com\/modpack\/([^/?#]+)/)?.[1] ?? raw;
    return { source: 'modrinth', ref, versionVar: 'MODRINTH_VERSION', version: val('MODRINTH_VERSION') || null };
  }
  if (t === 'FTBA') {
    const ref = val('FTB_MODPACK_ID');
    return /^\d+$/.test(ref) ? { source: 'ftb', ref, versionVar: 'FTB_MODPACK_VERSION_ID', version: val('FTB_MODPACK_VERSION_ID') || null } : null;
  }
  return null;
}

export interface PackStatus {
  pack: PackHit | null;
  source: PackSource;
  ref: string;
  current: PackVersion | null;
  latest: PackVersion | null;
  /** Server haengt an keiner Version (folgt still der neuesten). */
  unpinned: boolean;
  updateAvailable: boolean;
  /** Pack wechselt die Minecraft-Version - Welt vorher sichern ist Pflicht, Mods koennen fehlen. */
  mcChange: boolean;
}

const statusCache = new Map<string, { at: number; data: { pack: PackHit | null; versions: PackVersion[] } }>();

export async function packStatus(p: InstalledPack, cfKey: string | null, f: Fetcher = fetch): Promise<PackStatus> {
  const key = `${p.source}:${p.ref}`;
  let data = statusCache.get(key);
  if (!data || Date.now() - data.at > 15 * 60_000) {
    let fresh: { pack: PackHit | null; versions: PackVersion[] };
    if (p.source === 'curseforge') {
      if (!cfKey) throw new Error('Kein CurseForge-API-Schluessel hinterlegt');
      const r = await curseForgeVersions(p.ref, cfKey, f);
      fresh = { pack: r.mod, versions: r.versions };
    } else if (p.source === 'modrinth') {
      const versions = await modrinthVersions(p.ref, f);
      const hit = (await searchModrinth(p.ref, f).catch(() => [])).find((h) => h.ref === p.ref) ?? null;
      fresh = { pack: hit, versions };
    } else {
      const r = await ftbVersions(p.ref, f);
      fresh = { pack: r.mod, versions: r.versions };
    }
    data = { at: Date.now(), data: fresh };
    statusCache.set(key, data);
  }
  const { pack, versions } = data.data;
  const latest = versions[0] ?? null;
  const current = p.version ? versions.find((v) => v.id === p.version) ?? { id: p.version, name: p.version, mcVersion: null, date: null } : null;
  const updateAvailable = !!latest && !!current && latest.id !== current.id
    && (!current.date || !latest.date || latest.date > current.date);
  return {
    pack, source: p.source, ref: p.ref, current, latest,
    unpinned: !p.version,
    updateAvailable,
    mcChange: !!(updateAvailable && current?.mcVersion && latest?.mcVersion && current.mcVersion !== latest.mcVersion),
  };
}

export function clearPackCache() { statusCache.clear(); }
