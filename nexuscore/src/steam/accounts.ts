import crypto from 'node:crypto';
import type { ServerRegistry } from '../store/registry.js';
import type { SecretStore } from '../store/secrets.js';

/**
 * Steam-Konten: manche Spiele laden nur mit einem Steam-Konto, das sie besitzt. Der Core merkt sich Kontoname und Passwort
 * (das Passwort im verschluesselten Speicher, nie in einer Antwort), prueft die Anmeldung mit SteamCMD und fuehrt durch
 * Steam Guard. Ein Konto gehoert einem Benutzer und kann fuer alle freigegeben werden.
 */

export type GuardStatus = 'none' | 'needed' | 'ok' | 'failed';
export type GuardType = 'none' | 'email' | 'app';

export class SteamAccountError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'steam_error') {
    super(message);
    this.name = 'SteamAccountError';
  }
}

/** Wer fragt: Administratoren (und das Master-Token) sehen und aendern alles. */
export interface SteamActor {
  id: string | null;
  username: string;
  admin: boolean;
}

interface Rec {
  id: string;
  ownerId: string | null;
  ownerName: string;
  label: string;
  accountName: string;
  steamId: string | null;
  isShared: boolean;
  guardStatus: GuardStatus;
  guardType: GuardType;
  guardPrompt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SteamAccountView {
  id: string;
  ownerId: string | null;
  ownerName: string;
  isOwner: boolean;
  isShared: boolean;
  label: string;
  accountName: string;
  steamId: string | null;
  hasPassword: boolean;
  guardStatus: GuardStatus;
  guardType: GuardType;
  guardPrompt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface TestResult {
  status: 'ok' | 'needed' | 'failed';
  guardType?: GuardType;
  message: string;
  account: SteamAccountView;
}

/** Startet SteamCMD mit der Anmeldung und liefert die gesamte Ausgabe. Ersetzbar fuer Tests. */
export type SteamLoginRunner = (input: { accountId: string; accountName: string; password: string; code?: string }) => Promise<string>;

const SETTING = 'steam.accounts';
const secretName = (id: string): string => `steam.${id}.password`;
const NAME_PATTERN = /^[A-Za-z0-9_.@-]{2,100}$/;

export interface Verdict {
  status: 'ok' | 'needed' | 'failed';
  guardStatus: GuardStatus;
  guardType?: GuardType;
  prompt: string | null;
  message: string;
}

/** Wertet die Ausgabe von SteamCMD aus. */
export function classifySteamOutput(output: string, hasCode: boolean, knownType: GuardType): Verdict {
  const out = output.toLowerCase();
  const has = (...needles: Array<string | RegExp>): boolean => needles.some((n) => (typeof n === 'string' ? out.includes(n) : n.test(out)));

  if (has('to steam public...ok', 'logged in using cached credentials', 'waiting for user info...ok', 'waiting for license info...ok', 'logged in ok', 'waiting for confirmation...ok')) {
    return {
      status: 'ok',
      guardStatus: 'ok',
      prompt: null,
      message: hasCode
        ? 'Steam Guard erfolgreich verifiziert und bestätigt!'
        : out.includes('waiting for confirmation...ok')
          ? 'Steam-Verbindung erfolgreich über Handy-Bestätigung verifiziert!'
          : 'Steam-Verbindung erfolgreich hergestellt und verifiziert!',
    };
  }
  if (has(/rate\s*limit\s*exceeded/)) {
    return { status: 'failed', guardStatus: 'failed', prompt: 'Zu viele Fehlversuche - bitte kurz warten', message: 'Steam meldet zu viele Fehlversuche (Rate Limit Exceeded). Bitte kurz warten.' };
  }
  if (has('waiting for confirmation', 'please confirm the login in the steam mobile app')) {
    return {
      status: 'needed',
      guardStatus: 'needed',
      guardType: 'app',
      prompt: 'Bitte öffne die Steam-App auf deinem Smartphone und tippe auf Bestätigen',
      message: 'Steam hat eine Bestätigung an dein Smartphone gesendet! Bitte dort auf Bestätigen tippen.',
    };
  }
  if (hasCode && has(/two-?factor\s*code\s*mismatch/, 'invalid code', 'code mismatch', /account\s*logon\s*denied/)) {
    return {
      status: 'needed',
      guardStatus: 'needed',
      guardType: knownType === 'none' ? 'app' : knownType,
      prompt: 'Der eingegebene Steam-Guard-Code war ungültig oder abgelaufen',
      message: 'Der Steam-Guard-Code war ungültig oder abgelaufen. Bitte generiere oder prüfe einen neuen Code.',
    };
  }
  if (has('invalid password')) {
    if (!hasCode) {
      return {
        status: 'needed',
        guardStatus: 'needed',
        guardType: 'app',
        prompt: 'Steam verlangt deinen Steam-Guard-Code aus der Steam-App (oder das Passwort ist falsch)',
        message: 'Steam Guard ist aktiv oder das Passwort ist falsch. Bitte gib den Code aus deiner Steam-App ein.',
      };
    }
    return { status: 'failed', guardStatus: 'failed', prompt: 'Passwort oder Steam-Guard-Code ungültig', message: 'Steam-Anmeldung fehlgeschlagen: Passwort oder eingegebener Guard-Code ist falsch.' };
  }
  if (has(/two-?factor\s*code\s*mismatch/, /account\s*logon\s*denied/, 'steam guard', 'two-factor code', 'mobile authenticator')) {
    const app = has('mobile', 'twofactor', 'two-factor', 'authenticator');
    return {
      status: 'needed',
      guardStatus: 'needed',
      guardType: app ? 'app' : 'email',
      prompt: app ? 'Steam Guard Mobile Authenticator Code erforderlich' : 'Steam Guard Bestätigungscode per E-Mail gesendet',
      message: app ? 'Steam Guard ist aktiv! Bitte gib den Code aus deiner Steam-App ein.' : 'Steam Guard ist aktiv! Ein Bestätigungscode wurde per E-Mail gesendet.',
    };
  }
  return { status: 'failed', guardStatus: 'failed', prompt: null, message: `Unerwartete Steam-Antwort: ${output.replace(/\s+/g, ' ').trim().slice(0, 150)}` };
}

export class SteamAccounts {
  constructor(
    private readonly registry: ServerRegistry,
    private readonly secrets: SecretStore,
    private readonly runner: () => SteamLoginRunner | null,
  ) {}

  private all(): Rec[] {
    return this.registry.getSetting<Rec[]>(SETTING) ?? [];
  }
  private put(list: Rec[]): void {
    this.registry.setSetting(SETTING, list);
  }

  private view(r: Rec, actor: SteamActor): SteamAccountView {
    return {
      id: r.id,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      isOwner: actor.admin || (actor.id !== null && r.ownerId === actor.id),
      isShared: r.isShared,
      label: r.label,
      accountName: r.accountName,
      steamId: r.steamId,
      hasPassword: this.secrets.status(secretName(r.id)) !== 'missing',
      guardStatus: r.guardStatus,
      guardType: r.guardType,
      guardPrompt: r.guardPrompt,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
    };
  }

  private visible(r: Rec, actor: SteamActor): boolean {
    return actor.admin || r.isShared || (actor.id !== null && r.ownerId === actor.id);
  }
  private owned(r: Rec, actor: SteamActor): boolean {
    return actor.admin || (actor.id !== null && r.ownerId === actor.id);
  }

  list(actor: SteamActor): SteamAccountView[] {
    return this.all()
      .filter((r) => this.visible(r, actor))
      .sort((a, b) => Number(a.isShared) - Number(b.isShared) || b.createdAt.localeCompare(a.createdAt))
      .map((r) => this.view(r, actor));
  }

  save(actor: SteamActor, input: { id?: string | undefined; label?: string | undefined; accountName: string; password?: string | undefined; steamId?: string | undefined; isShared?: boolean | undefined }): { account: SteamAccountView; created: boolean } {
    const accountName = input.accountName.trim();
    if (!NAME_PATTERN.test(accountName)) throw new SteamAccountError('Der Kontoname enthält ungültige Zeichen.', 400, 'invalid_input');
    const steamId = input.steamId?.trim() || null;
    if (steamId && !/^\d{5,25}$/.test(steamId)) throw new SteamAccountError('Die Steam-ID besteht nur aus Ziffern.', 400, 'invalid_input');
    const list = this.all();
    const clash = list.find((r) => r.accountName.toLowerCase() === accountName.toLowerCase() && r.id !== input.id);
    if (clash) throw new SteamAccountError('Dieses Steam-Konto ist schon eingetragen.', 409, 'account_exists');
    const now = new Date().toISOString();
    const label = input.label?.trim() || accountName;

    if (input.id) {
      const existing = list.find((r) => r.id === input.id);
      if (!existing || !this.visible(existing, actor)) throw new SteamAccountError('Steam-Konto nicht gefunden', 404, 'not_found');
      if (!this.owned(existing, actor)) throw new SteamAccountError('Keine Berechtigung, dieses Steam-Konto zu bearbeiten', 403, 'forbidden');
      const changedName = existing.accountName.toLowerCase() !== accountName.toLowerCase();
      const next: Rec = {
        ...existing,
        label,
        accountName,
        steamId: steamId ?? existing.steamId,
        isShared: input.isShared ?? existing.isShared,
        // Anderer Kontoname oder neues Passwort: die alte Pruefung gilt nicht mehr
        ...(changedName || input.password ? { guardStatus: 'none' as const, guardType: 'none' as const, guardPrompt: null } : {}),
        updatedAt: now,
      };
      if (input.password) this.secrets.set(secretName(existing.id), input.password);
      this.put(list.map((r) => (r.id === existing.id ? next : r)));
      return { account: this.view(next, actor), created: false };
    }

    const rec: Rec = {
      id: crypto.randomUUID(),
      ownerId: actor.id,
      ownerName: actor.username,
      label,
      accountName,
      steamId,
      isShared: Boolean(input.isShared),
      guardStatus: 'none',
      guardType: 'none',
      guardPrompt: null,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    if (input.password) this.secrets.set(secretName(rec.id), input.password);
    this.put([...list, rec]);
    return { account: this.view(rec, actor), created: true };
  }

  /** Anmeldung pruefen; mit `code` zusaetzlich den Steam-Guard-Code eingeben. */
  async test(actor: SteamActor, id: string, code?: string): Promise<TestResult> {
    const rec = this.all().find((r) => r.id === id);
    if (!rec || !this.visible(rec, actor)) throw new SteamAccountError('Steam-Konto nicht gefunden', 404, 'not_found');
    if (this.secrets.status(secretName(id)) !== 'ok') throw new SteamAccountError('Kein (lesbares) Passwort für dieses Steam-Konto hinterlegt', 400, 'no_password');
    const run = this.runner();
    if (!run) throw new SteamAccountError('Dieser Core kann SteamCMD hier nicht starten (weder Docker noch Windows-Direktbetrieb).', 400, 'unsupported');
    const password = this.secrets.get(secretName(id));
    if (!password) throw new SteamAccountError('Kein (lesbares) Passwort für dieses Steam-Konto hinterlegt', 400, 'no_password');
    const cleanCode = code?.trim().toUpperCase();

    let output: string;
    try {
      output = await run({ accountId: id, accountName: rec.accountName, password, ...(cleanCode ? { code: cleanCode } : {}) });
    } catch (err) {
      return { status: 'failed', message: `Testlauf fehlgeschlagen: ${err instanceof Error ? err.message : 'Verbindungsfehler zu Steam'}`, account: this.view(rec, actor) };
    }
    // Das Passwort darf nie in einer Antwort landen, auch nicht, wenn SteamCMD es zurueckmeldet
    const verdict = classifySteamOutput(output.split(password).join('***'), Boolean(cleanCode), rec.guardType);
    const next: Rec = {
      ...rec,
      guardStatus: verdict.guardStatus,
      guardType: verdict.guardType ?? rec.guardType,
      guardPrompt: verdict.prompt,
      ...(verdict.status === 'ok' ? { lastUsedAt: new Date().toISOString() } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.put(this.all().map((r) => (r.id === id ? next : r)));
    return { status: verdict.status, ...(verdict.guardType ? { guardType: verdict.guardType } : {}), message: verdict.message, account: this.view(next, actor) };
  }

  delete(actor: SteamActor, id: string): void {
    const list = this.all();
    const rec = list.find((r) => r.id === id);
    if (!rec || !this.visible(rec, actor)) throw new SteamAccountError('Konto nicht gefunden', 404, 'not_found');
    if (!this.owned(rec, actor)) throw new SteamAccountError('Keine Berechtigung zum Löschen dieses Steam-Kontos', 403, 'delete_forbidden');
    this.secrets.delete(secretName(id));
    this.put(list.filter((r) => r.id !== id));
  }

  /** Fuer Installationen: Name und Passwort eines Kontos, das der Benutzer nutzen darf. */
  credentials(actor: SteamActor, id: string): { username: string; password: string } | null {
    const rec = this.all().find((r) => r.id === id);
    if (!rec || !this.visible(rec, actor)) return null;
    const password = this.secrets.status(secretName(id)) === 'ok' ? this.secrets.get(secretName(id)) : null;
    return password ? { username: rec.accountName, password } : null;
  }
}
