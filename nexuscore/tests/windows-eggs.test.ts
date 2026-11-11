import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { resolveArgs, conditionHolds, steamValues, listPrograms, renderConfig } = await import('../src/install/steam-game.js');
const { installPlanFor } = await import('../src/install/manager.js');
const { initialValue } = await import('../src/eggs/rules.js');
const { isDownloadSource } = await import('../src/install/sources.js');

const EGG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../eggs');

interface Egg {
  name?: string;
  variables?: Array<{ env_variable: string; default_value?: string }>;
  ports?: { primary?: { ref?: string }; secondary?: Array<{ ref?: string }> };
  windows?: {
    steam_app_id?: number;
    download?: { source: string; stripTop?: boolean; keep?: string[]; mkdirs?: string[] };
    executable: string;
    args?: Array<string | { when: string; args: string[] }>;
    stop?: { timeout_seconds?: number };
    files?: Array<{ path: string; format: string; content?: string; set?: Record<string, string | { $number?: string; $boolean?: string }> }>;
  };
}

const eggs: Array<[string, Egg]> = fs
  .readdirSync(EGG_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(EGG_DIR, f), 'utf8')) as Egg] as [string, Egg])
  .filter(([, e]) => e.windows);

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;
const names = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!.toUpperCase());
const upper = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/** Alle Platzhalter, die der Core beim Start fuer dieses Spiel kennt. */
function known(egg: Egg): Set<string> {
  const set = new Set(['SERVER_PORT', 'MAX_MEMORY_MB', 'SERVER_NAME', 'SERVER_DIR']);
  for (const v of egg.variables ?? []) set.add(v.env_variable.toUpperCase());
  const ports = [egg.ports?.primary, ...(egg.ports?.secondary ?? [])].filter(Boolean);
  ports.forEach((p, i) => {
    const n = upper(p?.ref ?? (i === 0 ? 'game' : `port${i}`));
    set.add(`PORT_${n}`);
    set.add(`${n}_PORT`);
  });
  if (ports.length === 0) set.add('PORT_GAME');
  return set;
}

describe('windows-Blöcke der Spielvorlagen', () => {
  it('es gibt mehr als die ersten zwei', () => {
    expect(eggs.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(eggs)('%s', (_id, egg) => {
    const w = egg.windows!;

    it('hat App-ID und ein Programm im Server-Ordner', () => {
      // Entweder aus Steam (App-ID) oder aus einem Archiv einer Quelle, die der Core kennt - nie beides, nie keines
      if (w.download) {
        expect(w.steam_app_id).toBeUndefined();
        expect(isDownloadSource(w.download.source), w.download.source).toBe(true);
        for (const d of [...(w.download.mkdirs ?? []), ...(w.download.keep ?? [])]) {
          expect(path.isAbsolute(d)).toBe(false);
          expect(d.split(/[\\/]/)).not.toContain('..');
        }
      } else {
        expect(Number.isInteger(w.steam_app_id) && w.steam_app_id! > 0).toBe(true);
      }
      expect(w.executable).toMatch(/\.exe$/i);
      expect(path.isAbsolute(w.executable)).toBe(false);
      expect(w.executable.split(/[\\/]/)).not.toContain('..');
      expect(w.stop?.timeout_seconds ?? 30).toBeGreaterThan(0);
    });

    it('benutzt nur Platzhalter, die es für dieses Spiel gibt', () => {
      const ok = known(egg);
      const used: string[] = [];
      const take = (a: string | { when: string; args: string[] }) => {
        if (typeof a === 'string') used.push(...names(a));
        else {
          used.push(a.when.match(/^\s*([A-Za-z0-9_]+)/)![1]!.toUpperCase());
          for (const x of a.args) used.push(...names(x));
        }
      };
      (w.args ?? []).forEach(take);
      for (const f of w.files ?? []) {
        used.push(...names(f.content ?? ''));
        for (const v of Object.values(f.set ?? {})) used.push(...names(typeof v === 'string' ? v : (v.$number ?? v.$boolean ?? '')));
      }
      const unknown = [...new Set(used)].filter((n) => !ok.has(n));
      expect(unknown, `unbekannte Platzhalter in ${_id}`).toEqual([]);
    });

    it('baut aus den Vorgaben des Spiels Argumente ohne leere Werte', () => {
      const variables = Object.fromEntries((egg.variables ?? []).map((v) => [v.env_variable, initialValue(v)]));
      const ports = [egg.ports?.primary, ...(egg.ports?.secondary ?? [])].filter(Boolean).map((p, i) => ({
        name: (p?.ref ?? (i === 0 ? 'game' : `port${i}`)).toLowerCase(),
        hostPort: 30000 + i,
        protocol: 'udp' as const,
      }));
      const values = steamValues({ ports: ports.length ? ports : [{ name: 'game', hostPort: 30000, protocol: 'udp' }], maxMemoryMb: 4096, name: 'Test', workingDir: 'C:\\Spiele\\test' }, variables);
      const args = resolveArgs(w.args ?? [], values);
      if ((w.args ?? []).length > 0) expect(args.length).toBeGreaterThan(0);
      expect(args.every((a) => a.trim() !== '')).toBe(true);
      // Ein Argument, das ohne Wert halb leer bliebe ("-Port="), gehoert in eine when-Gruppe
      expect(args.filter((a) => /[=]$/.test(a)), `halb leere Argumente in ${_id}`).toEqual([]);
      // Kein Platzhalter bleibt stehen
      expect(args.filter((a) => /\{\{/.test(a))).toEqual([]);
    });

    it('erzeugt seine Konfigurationsdateien aus den Vorgaben ohne Fehler', () => {
      const variables = Object.fromEntries((egg.variables ?? []).map((v) => [v.env_variable, initialValue(v)]));
      const ports = [egg.ports?.primary, ...(egg.ports?.secondary ?? [])].filter(Boolean).map((p, i) => ({
        name: (p?.ref ?? (i === 0 ? 'game' : `port${i}`)).toLowerCase(),
        hostPort: 30000 + i,
        protocol: 'udp' as const,
      }));
      const values = steamValues({ ports: ports.length ? ports : [{ name: 'game', hostPort: 30000, protocol: 'udp' }], maxMemoryMb: 4096, name: 'Test Server', workingDir: 'C:\\Spiele\\test' }, variables);
      for (const f of w.files ?? []) {
        const text = renderConfig(f as never, null, values);
        expect(text.length, f.path).toBeGreaterThan(0);
        if (f.format === 'json') expect(() => JSON.parse(text), f.path).not.toThrow();
        // Ein zweiter Durchlauf ueber das Ergebnis aendert nichts mehr (stabil bei jedem Start)
        expect(renderConfig(f as never, text, values), f.path).toBe(text);
      }
    });

    it('wird vom Core als Steam- oder Download-Spiel erkannt', () => {
      const plan = installPlanFor(_id, egg as never, {});
      if (w.download) {
        expect(plan?.kind).toBe('download');
        expect(plan?.steam?.download?.source).toBe(w.download.source);
      } else {
        expect(plan?.kind).toBe('steamcmd');
        expect(plan?.steam?.appId).toBe(w.steam_app_id);
      }
    });

    it('JSON-Dateien: Zahlen aus Ports oder Variablen mit Wert', () => {
      for (const f of w.files ?? []) {
        for (const [key, v] of Object.entries(f.set ?? {})) {
          if (typeof v === 'string' || v.$number === undefined) continue;
          for (const n of names(v.$number)) {
            const def = (egg.variables ?? []).find((x) => x.env_variable.toUpperCase() === n);
            // Ports sind immer gesetzt; Variablen brauchen einen Standardwert, sonst waere es keine Zahl
            if (def) expect(def.default_value, `${f.path}: ${key} <- ${n}`).not.toBe('');
          }
        }
      }
    });
  });
});

describe('Zufallspasswörter', () => {
  it('{{GENERATE_PASSWORD}} wird zu einem echten, jedes Mal anderen Passwort', () => {
    const a = initialValue({ default_value: '{{GENERATE_PASSWORD}}' });
    const b = initialValue({ default_value: ' {{GENERATE_PASSWORD}} ' });
    expect(a).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(b).not.toBe(a);
    expect(initialValue({ default_value: 'fest' })).toBe('fest');
    expect(initialValue({})).toBe('');
  });

  it('keine Vorlage mit Windows-Block lässt den Platzhalter im Klartext stehen', () => {
    for (const [id, egg] of eggs) {
      for (const v of egg.variables ?? []) {
        const value = initialValue(v);
        expect(value, `${id}.${v.env_variable}`).not.toContain('{{GENERATE_PASSWORD}}');
      }
    }
  });
});

describe('bedingte Startargumente', () => {
  const values = { A: 'x', EMPTY: '', FLAG: 'TRUE' };

  it('prüft gesetzt, gleich und ungleich - ohne Rücksicht auf Groß-/Kleinschreibung', () => {
    expect(conditionHolds('A', values)).toBe(true);
    expect(conditionHolds('EMPTY', values)).toBe(false);
    expect(conditionHolds('nichtda', values)).toBe(false);
    expect(conditionHolds('flag=true', values)).toBe(true);
    expect(conditionHolds('FLAG!=false', values)).toBe(true);
    expect(conditionHolds('FLAG!=true', values)).toBe(false);
    expect(conditionHolds('EMPTY=', values)).toBe(true);
    expect(conditionHolds('A=', values)).toBe(false);
    expect(conditionHolds('', values)).toBe(false);
  });

  it('lässt ein Paar ganz weg, wenn der Wert fehlt', () => {
    const args = resolveArgs(['-x', { when: 'A', args: ['-a', '{{A}}'] }, { when: 'EMPTY', args: ['-e', '{{EMPTY}}'] }, '{{EMPTY}}'], values);
    expect(args).toEqual(['-x', '-a', 'x']);
  });
});

describe('Hilfe bei falschem Programmnamen', () => {
  it('nennt die gefundenen Programme, ohne Installer-Reste', async () => {
    const os = await import('node:os');
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nx-exe-'));
    try {
      await fs.promises.mkdir(path.join(dir, 'Game', 'Binaries', 'Win64'), { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'Game', 'Binaries', 'Win64', 'Server-Shipping.exe'), '');
      await fs.promises.writeFile(path.join(dir, 'start.exe'), '');
      await fs.promises.writeFile(path.join(dir, 'vcredist_x64.exe'), '');
      await fs.promises.writeFile(path.join(dir, 'readme.txt'), '');
      const found = await listPrograms(dir);
      expect(found.sort()).toEqual(['Game/Binaries/Win64/Server-Shipping.exe', 'start.exe']);
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });
});
