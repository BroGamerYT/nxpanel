import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { config } from '../config.js';
import { safePath } from '../servers/files.js';
import { sql } from '../db/index.js';

/**
 * Ordner, die der Admin-Dateimanager zeigt.
 *
 * Das Panel laeuft im Container und sieht vom Host nur, was eingebunden ist
 * (docker-compose.yml): /var/lib/panel (Spieldaten, Backups, Testberichte)
 * und die NAS. Weitere Ordner lassen sich ueber ADMIN_FILE_ROOTS ergaenzen,
 * z. B. "Panel-Installation=/opt/nxpanel" - der Ordner muss dann auch im
 * Compose-File eingebunden sein. Bewusst kein Zugriff auf "/" des Hosts.
 */
export interface AdminFileRoot {
  id: string;
  label: string;
  path: string;
  available: boolean;
  readOnly?: boolean;
}

function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ordner';
}

export function adminFileRoots(env: { VOLUME_ROOT: string; BACKUP_ROOT: string; NAS_BACKUP_ROOT: string; ADMIN_FILE_ROOTS: string } = config): AdminFileRoot[] {
  const list: { label: string; path: string; readOnly?: boolean }[] = [];
  const vol = resolve(env.VOLUME_ROOT);
  const backup = resolve(env.BACKUP_ROOT);
  const parent = dirname(vol);
  // Liegen Spieldaten und Backups im selben Elternordner (Standard:
  // /var/lib/panel), zeigen wir den ganzen Panel-Ordner.
  if (parent !== sep && (backup === parent || backup.startsWith(parent + sep))) {
    list.push({ label: 'Panel-Daten', path: parent });
  } else {
    list.push({ label: 'Spieldaten', path: vol }, { label: 'Backups', path: backup });
  }
  if (env.NAS_BACKUP_ROOT) list.push({ label: 'NAS-Backups', path: resolve(env.NAS_BACKUP_ROOT) });
  for (const part of env.ADMIN_FILE_ROOTS.split(/[;\n]/)) {
    const m = part.trim().match(/^([^=]+)=(\/.+?)(:ro)?$/i);
    if (m && m[2] !== '/') {
      list.push({
        label: m[1]!.trim(),
        path: resolve(m[2]!.trim()),
        ...(m[3] ? { readOnly: true } : {}),
      });
    }
  }
  const seen = new Set<string>();
  const out: AdminFileRoot[] = [];
  for (const r of list) {
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    let id = slug(r.label);
    while (out.some((o) => o.id === id)) id += '-2';
    out.push({
      id,
      label: r.label,
      path: r.path,
      available: existsSync(r.path),
      ...(r.readOnly ? { readOnly: true } : {}),
    });
  }
  return out;
}

export function findAdminRoot(id: string): AdminFileRoot | undefined {
  return adminFileRoots().find((r) => r.id === id);
}

/**
 * Groesse der Unterordner und Dateien eines Ordners (wie "du -d 1"),
 * groesste zuerst. Hilft, volle Platten aufzuraeumen. Bricht nach
 * timeoutMs ab, damit riesige Baeume das Panel nicht blockieren.
 */
export async function folderUsage(root: string, relPath: string, timeoutMs = 60_000): Promise<{ path: string; entries: { name: string; path: string; bytes: number }[]; partial: boolean }> {
  const { fullPath, relPath: rel } = await safePath({ root }, relPath);
  const res = process.platform === 'win32'
    ? await usageNode(fullPath, timeoutMs)
    : await usageDu(fullPath, timeoutMs).catch(() => usageNode(fullPath, timeoutMs));
  const entries = res.sizes.map(([name, bytes]) => ({ name, path: rel ? `${rel}/${name}` : name, bytes }));
  entries.sort((a, b) => b.bytes - a.bytes);
  return { path: rel, entries, partial: res.partial };
}

type Sizes = { sizes: [string, number][]; partial: boolean };

/** Schnell ueber "du" (Linux, auch BusyBox). Wirft, wenn es "du" nicht gibt. */
function usageDu(fullPath: string, timeoutMs: number): Promise<Sizes> {
  return new Promise((resolvePromise, reject) => {
    // -x: auf demselben Dateisystem bleiben; -k: KiB; -d 1: eine Ebene (GNU und BusyBox)
    const p = spawn('du', ['-x', '-k', '-d', '1', fullPath], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    let partial = false;
    const timer = setTimeout(() => { partial = true; p.kill('SIGTERM'); }, timeoutMs);
    p.stdout.on('data', (c: Buffer) => { out += c.toString(); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', () => {
      clearTimeout(timer);
      const sizes: [string, number][] = [];
      for (const line of out.split('\n')) {
        const m = line.match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const abs = m[2]!;
        if (abs === fullPath) continue;
        const name = abs.slice(fullPath.length).replace(/^[\\/]+/, '');
        if (!name || name.includes('/')) continue;
        sizes.push([name, Number(m[1]) * 1024]);
      }
      resolvePromise({ sizes, partial });
    });
  });
}

/** Ohne "du" (Windows, NexusCore): selbst zaehlen, Symlinks nicht folgen. */
async function usageNode(fullPath: string, timeoutMs: number): Promise<Sizes> {
  const deadline = Date.now() + timeoutMs;
  let partial = false;
  const sizeOf = async (p: string): Promise<number> => {
    if (Date.now() > deadline) { partial = true; return 0; }
    const st = await lstat(p).catch(() => null);
    if (!st || st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    let sum = 0;
    for (const e of await readdir(p).catch(() => [] as string[])) sum += await sizeOf(`${p}/${e}`);
    return sum;
  };
  const sizes: [string, number][] = [];
  for (const e of await readdir(fullPath, { withFileTypes: true })) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    sizes.push([e.name, await sizeOf(`${fullPath}/${e.name}`)]);
  }
  return { sizes, partial };
}

/**
 * Im Spieldaten-Ordner heissen die Unterordner nach der Kurz-ID des Servers.
 * Liefert dafuer lesbare Namen ("Survival · Minecraft Java"), sonst {}.
 */
export async function volumeLabels(root: string, relPath: string, volumeRoot = config.VOLUME_ROOT): Promise<Record<string, string>> {
  const here = resolve(root, relPath.replace(/^\/+/, ''));
  if (here !== resolve(volumeRoot)) return {};
  const rows = await sql<{ short_id: string; name: string; egg: string | null }[]>`
    SELECT s.short_id, s.name, e.name AS egg FROM servers s LEFT JOIN eggs e ON e.id = s.egg_id`;
  const out: Record<string, string> = { '.egg-covers': 'Titelbilder (Zwischenspeicher)' };
  for (const r of rows) out[r.short_id] = r.egg ? `${r.name} · ${r.egg}` : r.name;
  return out;
}

export const ORPHAN_LABEL = 'kein Server mehr – Rest eines gelöschten Servers';

/** Beschriftet Eintraege; Kurz-ID-Ordner ohne Server gelten als verwaist. */
export function applyVolumeLabels<T extends { name: string }>(entries: T[], labels: Record<string, string>): (T & { label?: string; orphan?: boolean })[] {
  if (Object.keys(labels).length === 0) return entries;
  return entries.map((e) => {
    if (labels[e.name]) return { ...e, label: labels[e.name] };
    if (/^[0-9a-f]{8}$/.test(e.name)) return { ...e, label: ORPHAN_LABEL, orphan: true };
    return e;
  });
}
