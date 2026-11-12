import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { platformFor } from '../platform/index.js';

/**
 * Windows-Firewall: eine Freigabe je Spiel-Programm (eingehend, genau diese Datei).
 *
 * Der Core legt nur Regeln an, die er selbst benennt ("NexusCore <Server> <Programm>") und die er sich merkt -
 * andere Regeln fasst er nie an. Ohne Administratorrechte (oder ohne Dienst als SYSTEM) geht das nicht:
 * der Core versucht es nicht zu umgehen, sondern nennt den genauen Befehl, den ein Administrator ausfuehren kann.
 */

export interface RunResult {
  code: number;
  out: string;
}
export type Runner = (args: string[]) => Promise<RunResult>;

export interface RuleRecord {
  name: string;
  serverId: string;
  program: string;
  createdAt: string;
}

export class FirewallError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'needs_admin' | 'invalid_program' | 'failed',
    readonly command?: string,
  ) {
    super(message);
    this.name = 'FirewallError';
  }
}

const defaultRunner: Runner = (args) =>
  new Promise((resolve) => {
    execFile('netsh', args, { windowsHide: true, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const raw = (err as { code?: unknown } | null)?.code;
      const code = err ? (typeof raw === 'number' ? raw : 1) : 0;
      resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.trim() });
    });
  });

/** Name der Regel: stabil je Server und Programm, ohne Zeichen, die netsh oder die Anzeige stoeren. */
export function ruleName(serverId: string, program: string): string {
  const clean = (s: string): string => s.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 60);
  return `NexusCore ${clean(serverId)} ${clean(path.win32.basename(program.replace(/\//g, '\\')))}`;
}

/** Argumente fuer `netsh advfirewall firewall add rule ...` - ein Argument je Angabe, nie durch eine Shell. */
export function addRuleArgs(name: string, program: string): string[] {
  return ['advfirewall', 'firewall', 'add', 'rule', `name=${name}`, 'dir=in', 'action=allow', `program=${program}`, 'enable=yes', 'profile=any'];
}
export const deleteRuleArgs = (name: string): string[] => ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`];
export const showRuleArgs = (name: string): string[] => ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`];

/** Der Befehl in Textform - fuer die Meldung "als Administrator ausfuehren". */
export function commandText(args: string[]): string {
  return `netsh ${args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '')}"` : a)).join(' ')}`;
}

export class FirewallManager {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly run: Runner = defaultRunner,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  /** Gibt es Firewall-Freigaben je Programm auf diesem System? (nur Windows, siehe platform/index.ts) */
  get available(): boolean {
    return platformFor(this.platform).firewall.available;
  }

  /** Warum es sie hier nicht gibt (leer, wenn doch). */
  get reason(): string | undefined {
    return platformFor(this.platform).firewall.reason;
  }

  async records(): Promise<RuleRecord[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as { rules?: unknown };
      if (!Array.isArray(parsed.rules)) return [];
      return parsed.rules.filter(
        (r): r is RuleRecord =>
          Boolean(r) && typeof (r as RuleRecord).name === 'string' && typeof (r as RuleRecord).serverId === 'string' && typeof (r as RuleRecord).program === 'string',
      );
    } catch {
      return [];
    }
  }

  private save(rules: RuleRecord[]): Promise<void> {
    const next = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ version: 1, rules }, null, 2), 'utf8');
      await fs.rename(tmp, this.file);
    });
    this.writing = next.catch(() => {});
    return next;
  }

  /** Gibt es die Regel in der Windows-Firewall jetzt wirklich? (Sie koennte von Hand geloescht worden sein.) */
  async exists(name: string): Promise<boolean> {
    if (!this.available) return false;
    return (await this.run(showRuleArgs(name))).code === 0;
  }

  /** Programm freigeben. Eine vorhandene Regel gleichen Namens wird ersetzt, nicht verdoppelt. */
  async open(serverId: string, program: string): Promise<RuleRecord> {
    if (!this.available) throw new FirewallError('Die Windows-Firewall gibt es nur unter Windows.', 'unsupported');
    // eslint-disable-next-line no-control-regex
    if (!path.win32.isAbsolute(program) || /[\r\n\u0000"]/.test(program)) {
      throw new FirewallError('Das Programm braucht einen vollstaendigen Pfad.', 'invalid_program');
    }
    const name = ruleName(serverId, program);
    await this.run(deleteRuleArgs(name));
    const args = addRuleArgs(name, program);
    const res = await this.run(args);
    if (res.code !== 0) {
      // Ohne Administratorrechte meldet netsh "Zugriff verweigert" / "requires elevation" (je nach Sprache anders)
      if (/elevat|erh[oö]h|administrator|zugriff|denied/i.test(res.out)) {
        throw new FirewallError(
          'Dafuer braucht der Core Administratorrechte (als Dienst laeuft er mit ihnen). Ein Administrator kann den Befehl auch selbst ausfuehren.',
          'needs_admin',
          commandText(args),
        );
      }
      throw new FirewallError(`Die Firewall-Regel konnte nicht angelegt werden: ${res.out.slice(0, 300)}`, 'failed', commandText(args));
    }
    const record: RuleRecord = { name, serverId, program, createdAt: new Date().toISOString() };
    await this.save([...(await this.records()).filter((r) => r.name !== name), record]);
    return record;
  }

  /**
   * Alle Regeln dieses Servers wieder entfernen. Wer eine Regel nicht loeschen konnte, behaelt den Eintrag in
   * der Merkliste - so geht sie nicht stillschweigend verloren.
   */
  async closeServer(serverId: string): Promise<{ removed: string[]; failed: Array<{ name: string; message: string }> }> {
    const removed: string[] = [];
    const failed: Array<{ name: string; message: string }> = [];
    const all = await this.records();
    for (const rec of all.filter((r) => r.serverId === serverId)) {
      if (!this.available) {
        failed.push({ name: rec.name, message: 'nur unter Windows' });
        continue;
      }
      // Von Hand schon geloescht: nichts zu tun, der Eintrag kann weg
      const res = (await this.exists(rec.name)) ? await this.run(deleteRuleArgs(rec.name)) : { code: 0, out: '' };
      if (res.code === 0) removed.push(rec.name);
      else failed.push({ name: rec.name, message: res.out.slice(0, 200) || `Fehler ${res.code}` });
    }
    if (removed.length) await this.save(all.filter((r) => !removed.includes(r.name)));
    return { removed, failed };
  }
}
