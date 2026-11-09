/**
 * Nutzer auf der Kommandozeile verwalten - vor allem fuer den ersten Admin,
 * denn ohne Konto kommt niemand in die Oberflaeche.
 *
 *   npm run user -- create-admin <benutzername> <email>
 *   npm run user -- create <benutzername> <email> [--can-create]
 *   npm run user -- list
 *   npm run user -- reset-password <benutzername>
 *   npm run user -- set-role <benutzername> admin|moderator|user
 *   npm run user -- can-create <benutzername> on|off
 *   npm run user -- suspend <benutzername> on|off
 *   npm run user -- disable-2fa <benutzername>     (Handy weg, keine Codes mehr)
 *
 * Passwort: aus der Umgebungsvariable NXP_PASSWORD, sonst wird ein
 * sicheres erzeugt und EINMAL angezeigt.
 *
 * Auf dem Server im Container:
 *   docker exec -it nxp-panel node dist/cli/user.js create-admin dominik du@example.de
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { createUser, setPassword, findUserForLogin, UserInputError } from '../auth/users.js';
import { revokeAllUserSessions } from '../auth/sessions.js';
import { writeAudit } from '../audit.js';
import { disableTotp } from '../auth/twofactor.js';
import type { Role } from '../auth/permissions.js';

function generatePassword(): string {
  // 18 Bytes = 24 Zeichen base64url, gut abtippbar, ~144 Bit
  return randomBytes(18).toString('base64url');
}

function passwordFromEnv(): { password: string; generated: boolean } {
  const p = process.env.NXP_PASSWORD;
  return p ? { password: p, generated: false } : { password: generatePassword(), generated: true };
}

function showPassword(pw: { password: string; generated: boolean }) {
  if (!pw.generated) return;
  console.log('\n  Passwort (wird nur jetzt angezeigt):\n');
  console.log(`      ${pw.password}\n`);
  console.log('  Nach der ersten Anmeldung unter "Konto" aendern.\n');
}

async function requireUser(name: string | undefined) {
  if (!name) throw new UserInputError('Benutzername fehlt');
  const u = await findUserForLogin(name);
  if (!u) throw new UserInputError(`Nutzer "${name}" nicht gefunden`);
  return u;
}

function onOff(v: string | undefined): boolean {
  if (v === 'on') return true;
  if (v === 'off') return false;
  throw new UserInputError('Erwartet: on oder off');
}

async function main() {
  await waitForDatabase();
  await runMigrations();
  const [cmd, a, b, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'create-admin':
    case 'create': {
      if (!a) throw new UserInputError(`Aufruf: ${cmd} <benutzername> [email] [--can-create]`);
      const email = b && !b.startsWith('--') ? b : null;
      const pw = passwordFromEnv();
      const admin = cmd === 'create-admin';
      const u = await createUser({
        username: a,
        email,
        password: pw.password,
        role: admin ? 'admin' : 'user',
        canCreateServers: admin || rest.includes('--can-create') || b === '--can-create',
      });
      await writeAudit({ userId: u.id, actorName: 'cli', action: admin ? 'user.create_admin' : 'user.create', metadata: { via: 'cli' } });
      console.log(`Angelegt: ${u.username} <${u.email ?? 'keine E-Mail'}>  Rolle: ${u.role}  Server anlegen: ${u.can_create_servers ? 'ja' : 'nein'}`);
      showPassword(pw);
      break;
    }

    case 'list': {
      const rows = await sql<{ username: string; email: string | null; role: string; can_create_servers: boolean; suspended: boolean; last_login_at: Date | null; servers: number }[]>`
        SELECT u.username, u.email, u.role, u.can_create_servers, u.suspended, u.last_login_at,
               (SELECT count(*)::int FROM servers s WHERE s.owner_id = u.id) AS servers
        FROM users u ORDER BY u.created_at`;
      if (!rows.length) {
        console.log('Noch keine Nutzer. Ersten Admin anlegen:\n  npm run user -- create-admin <name> <email>');
        break;
      }
      console.log('Benutzer             Rolle      Anlegen  Gesperrt  Server  Letzte Anmeldung');
      for (const r of rows) {
        console.log(
          `${r.username.padEnd(20)} ${r.role.padEnd(10)} ${(r.can_create_servers ? 'ja' : '-').padEnd(8)} ${(r.suspended ? 'JA' : '-').padEnd(9)} ${String(r.servers).padEnd(7)} ${r.last_login_at ? r.last_login_at.toLocaleString('de-DE') : 'nie'}`,
        );
      }
      break;
    }

    case 'reset-password': {
      const u = await requireUser(a);
      const pw = passwordFromEnv();
      await setPassword(u.id, pw.password);
      const n = await revokeAllUserSessions(u.id, 'password_reset_cli');
      await writeAudit({ userId: u.id, actorName: 'cli', action: 'user.password_reset', metadata: { via: 'cli', sessionsRevoked: n } });
      console.log(`Passwort fuer ${u.username} neu gesetzt, ${n} Sitzung(en) beendet.`);
      showPassword(pw);
      break;
    }

    case 'set-role': {
      const u = await requireUser(a);
      if (b !== 'admin' && b !== 'moderator' && b !== 'user') throw new UserInputError('Rolle: admin, moderator oder user');
      await sql`UPDATE users SET role = ${b as Role} WHERE id = ${u.id}`;
      await writeAudit({ userId: u.id, actorName: 'cli', action: 'user.role_changed', metadata: { from: u.role, to: b } });
      console.log(`${u.username}: Rolle ${u.role} -> ${b}`);
      break;
    }

    case 'can-create': {
      const u = await requireUser(a);
      const v = onOff(b);
      await sql`UPDATE users SET can_create_servers = ${v} WHERE id = ${u.id}`;
      await writeAudit({ userId: u.id, actorName: 'cli', action: 'user.can_create_changed', metadata: { value: v } });
      console.log(`${u.username}: darf Server anlegen = ${v ? 'ja' : 'nein'}`);
      break;
    }

    case 'suspend': {
      const u = await requireUser(a);
      const v = onOff(b);
      await sql`UPDATE users SET suspended = ${v} WHERE id = ${u.id}`;
      if (v) await revokeAllUserSessions(u.id, 'suspended');
      await writeAudit({ userId: u.id, actorName: 'cli', action: v ? 'user.suspended' : 'user.unsuspended' });
      console.log(`${u.username}: gesperrt = ${v ? 'ja (alle Sitzungen beendet)' : 'nein'}`);
      break;
    }

    case 'disable-2fa': {
      const u = await requireUser(a);
      await disableTotp(u.id);
      const n = await revokeAllUserSessions(u.id, '2fa_reset_cli');
      await writeAudit({ userId: u.id, actorName: 'cli', action: 'user.reset_2fa', metadata: { via: 'cli' } });
      console.log(`${u.username}: Zwei-Faktor abgeschaltet, ${n} Sitzung(en) beendet. Anmeldung jetzt nur mit Passwort.`);
      break;
    }

    default:
      console.log(`Befehle:
  create-admin <name> <email>     ersten Administrator anlegen
  create <name> <email> [--can-create]
  list
  reset-password <name>
  set-role <name> admin|moderator|user
  can-create <name> on|off        Recht "server.create"
  suspend <name> on|off
  disable-2fa <name>              Zwei-Faktor abschalten (Notfall)

Passwort per NXP_PASSWORD=... vorgeben, sonst wird eins erzeugt.`);
  }
}

main()
  .catch((err) => {
    if (err instanceof UserInputError) console.error('Fehler: ' + err.message);
    else console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
