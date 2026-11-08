import { Fragment, useEffect, useState, type ReactNode } from 'react';

/**
 * Sprachen als Module.
 *
 * Jede Datei in src/locales/ ist eine Sprache: de.json, en.json, fr.json …
 * Eine neue Sprache = eine neue Datei, sonst nichts. Sie taucht automatisch
 * in der Sprachauswahl auf (Name aus "_meta.name").
 *
 * Deutsch ist die Grundsprache: fehlt ein Text in einer anderen Datei, steht
 * dort der deutsche - die Oberflaeche bricht nie, eine Uebersetzung kann
 * also Stueck fuer Stueck wachsen.
 *
 * Schluessel sind verschachtelt ("server.power.start"), Platzhalter stehen in
 * geschweiften Klammern ("{name}"). Fuer Ein-/Mehrzahl gibt es die Endungen
 * _one und _other, gewaehlt ueber den Platzhalter "count".
 */
type Tree = { [k: string]: string | Tree };
export const BASE = 'en';

function flatten(tree: Tree, prefix = '', out: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v, key, out);
  }
  return out;
}

const loaders = import.meta.glob<{ default: Tree }>('../locales/*.json');
const loaderByCode: Record<string, () => Promise<{ default: Tree }>> = {};
for (const [path, loader] of Object.entries(loaders)) {
  const code = /([^/]+)\.json$/.exec(path)![1]!;
  loaderByCode[code] = loader;
}

const KNOWN_LANGUAGE_NAMES: Record<string, string> = {
  de: 'Deutsch',
  en: 'English',
  fr: 'Français',
  es: 'Español',
  it: 'Italiano',
  nl: 'Nederlands',
  pl: 'Polski',
  pt: 'Português',
  ru: 'Русский',
  tr: 'Türkçe',
};

const catalogs: Record<string, Record<string, string>> = {};
const inflight: Record<string, Promise<void>> = {};

/** Alle vorhandenen Sprachen, Grundsprache zuerst. */
export const LANGUAGES = Object.keys(loaderByCode)
  .sort((a, b) => (a === BASE ? -1 : b === BASE ? 1 : a.localeCompare(b)))
  .map((code) => ({
    code,
    get name() {
      return catalogs[code]?.['_meta.name'] ?? KNOWN_LANGUAGE_NAMES[code] ?? code;
    },
  }));

let current = BASE;
let revision = 0;
const listeners = new Set<(state: string) => void>();

function notify() {
  revision++;
  const state = `${current}:${revision}`;
  for (const f of listeners) f(state);
}

/** Laedt eine Sprachdatei bei Bedarf nach (nur fuer die gewaehlte Sprache). */
export async function ensureLocaleLoaded(code: string): Promise<void> {
  const target = resolveLocale(code);
  if (catalogs[target]) return;
  if (!inflight[target]) {
    const loader = loaderByCode[target];
    inflight[target] = (loader ? loader() : Promise.resolve({ default: {} as Tree }))
      .then((mod) => {
        catalogs[target] = flatten(mod.default);
      })
      .finally(() => {
        delete inflight[target];
      });
  }
  await inflight[target];
  // Deutsch und Englisch sind zu 100 % vollstaendig (geprueft per Test).
  // Nur bei weiteren, evtl. unvollstaendigen Sprachen wird BASE als Fallback mitgeladen.
  if (target !== BASE && target !== 'de' && !catalogs[BASE] && loaderByCode[BASE]) {
    await ensureLocaleLoaded(BASE);
  }
}

/** Bester Treffer: genau ("pt-BR"), sonst die Hauptsprache ("pt"), sonst BASE. */
export function resolveLocale(wanted: string | null | undefined): string {
  if (!wanted) return BASE;
  if (loaderByCode[wanted]) return wanted;
  const main = wanted.split('-')[0]!;
  return loaderByCode[main] ? main : BASE;
}

export function getLocale() { return current; }

/** Fuer Datum und Zahlen: "de" -> "de-DE"-artige Formatierung uebernimmt der Browser. */
export function intlLocale() { return catalogs[current]?.['_meta.intl'] ?? current; }

const STORE = 'nxp.locale';
export function storedLocale(): string | null {
  try { return localStorage.getItem(STORE); } catch { return null; }
}

/**
 * Vor der Anmeldung gewaehlt? Dann wird diese Wahl nach dem Login ans Konto
 * uebernommen, statt von einer aelteren Kontoeinstellung ueberschrieben.
 */
let chosenBeforeLogin: string | null = null;
export function chooseBeforeLogin(code: string) { chosenBeforeLogin = resolveLocale(code); setLocale(code); }
export function takeChoiceBeforeLogin() { const c = chosenBeforeLogin; chosenBeforeLogin = null; return c; }

export function setLocale(code: string) {
  const l = resolveLocale(code);
  current = l;
  try { localStorage.setItem(STORE, l); } catch { /* egal */ }
  document.documentElement.lang = l;
  if (catalogs[l]) {
    notify();
  } else {
    void ensureLocaleLoaded(l).then(() => notify());
  }
}

/** Startsprache vor der Anmeldung: zuletzt gewaehlt, sonst Browser, sonst Deutsch. */
export function initialLocale() {
  return resolveLocale(storedLocale() ?? navigator.language);
}

type Vars = Record<string, string | number>;

export function t(key: string, vars?: Vars): string {
  let k = key;
  if (vars && typeof vars.count === 'number') {
    const form = vars.count === 1 ? `${key}_one` : `${key}_other`;
    if (catalogs[current]?.[form] ?? catalogs[BASE]?.[form]) k = form;
  }
  let s = catalogs[current]?.[k] ?? catalogs[BASE]?.[k];
  if (s === undefined) {
    if (import.meta.env.DEV) console.warn(`[i18n] fehlt: ${k}`);
    return key;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
  return s;
}

/** Gibt es einen Text fuer diesen Schluessel? (z. B. fuer Fehlercodes der API) */
export function has(key: string) {
  return (catalogs[current]?.[key] ?? catalogs[BASE]?.[key]) !== undefined;
}

/**
 * Baut die Oberflaeche beim Sprachwechsel neu auf. Komponenten rufen t()
 * direkt auf und muessen dafuer keinen Hook benutzen.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, set] = useState(() => `${current}:${revision}`);
  useEffect(() => {
    listeners.add(set);
    return () => { listeners.delete(set); };
  }, []);
  return <div key={state} className="contents">{children}</div>;
}

// Beim Laden sofort setzen und gewaehlte Sprachdatei vorladen.
export const i18nReady = ensureLocaleLoaded(initialLocale()).then(() => {
  setLocale(initialLocale());
});

/** Datum/Zeit in der aktuellen Sprache. */
export function fmtDateTime(d: string | number | Date, opts: Intl.DateTimeFormatOptions) {
  return new Date(d).toLocaleString(intlLocale(), opts);
}

/**
 * Wie t(), aber Platzhalter duerfen Elemente sein - fuer Saetze mit Code,
 * Links oder Hervorhebung mittendrin: tn('x', { file: <code>a.txt</code> }).
 * So bleibt der ganze Satz in der Sprachdatei, auch wenn die Wortstellung
 * in einer anderen Sprache anders ist.
 */
export function tn(key: string, vars: Record<string, ReactNode>): ReactNode {
  const raw = t(key, Object.fromEntries(Object.entries(vars).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, v as number])));
  const parts = raw.split(/(\{\w+\})/);
  return parts.map((p, i) => {
    const m = /^\{(\w+)\}$/.exec(p);
    return m && m[1]! in vars ? <Fragment key={i}>{vars[m[1]!]}</Fragment> : p;
  });
}
