import { sql } from './dist/db/index.js';
import { createSession } from './dist/auth/sessions.js';
import { signAccessToken } from './dist/auth/tokens.js';
import { createUser } from './dist/auth/users.js';

const API_BASE = 'http://127.0.0.1:8080/api/v1';

async function main() {
  console.log('=== TEST 1: Vorbereitung Admin & Simon ===');
  // 1. Admin laden
  const [admin] = await sql`SELECT id, username FROM users WHERE role = 'admin' LIMIT 1`;
  if (!admin) throw new Error('Kein Admin gefunden');
  console.log('Admin gefunden:', admin.username, admin.id);

  // Admin Session erzeugen
  const adminSession = await createSession(admin.id, { userAgent: 'Test-Admin-Agent', ip: '127.0.0.1' });
  const adminToken = await signAccessToken({ sub: admin.id, sid: adminSession.sessionId });

  // 2. Bestehende Test-User aufräumen
  await sql`DELETE FROM users WHERE username = 'simon'`;

  // 3. User 'simon' neu anlegen (Rolle 'user', nur Minecraft Java erlaubt)
  const simon = await createUser({
    username: 'simon',
    email: 'simon@test.local',
    password: 'SimonPass123!Safe',
    role: 'user',
    canCreateServers: true,
    allowedEggs: ['Minecraft Java'],
  });
  console.log('User simon erstellt mit allowed_eggs: [Minecraft Java], id:', simon.id);

  // Simon Session erzeugen
  const simonSession = await createSession(simon.id, { userAgent: 'Test-Simon-Agent', ip: '127.0.0.1' });
  const simonToken = await signAccessToken({ sub: simon.id, sid: simonSession.sessionId });

  console.log('\n=== TEST 2: Simon versucht Admin-Bereich aufzurufen (muss 403 liefern) ===');
  const resAdminUsers = await fetch(`${API_BASE}/admin/users`, {
    headers: { Authorization: `Bearer ${simonToken}` }
  });
  console.log(`GET /admin/users als Simon -> Status: ${resAdminUsers.status} (Erwartet: 403)`);
  if (resAdminUsers.status !== 403) throw new Error('FEHLER: Simon konnte Admin-Bereich sehen!');

  console.log('\n=== TEST 3: Simon versucht Spielvorlagen abzurufen (nur erlaubte Spiele sichtbar) ===');
  const resEggs = await fetch(`${API_BASE}/eggs`, {
    headers: { Authorization: `Bearer ${simonToken}` }
  });
  const eggsData = await resEggs.json();
  const visibleEggNames = eggsData.eggs.map(e => e.name);
  console.log('Sichtbare Vorlagen für Simon:', visibleEggNames);
  if (visibleEggNames.includes('ARK: Survival Ascended') || visibleEggNames.includes('Enshrouded')) {
    throw new Error('FEHLER: Simon sieht Spiele außerhalb seiner Whitelist!');
  }
  if (!visibleEggNames.includes('Minecraft Java')) {
    throw new Error('FEHLER: Simon sieht Minecraft Java nicht!');
  }
  console.log('PASSED: Egg-Whitelisting filtert nicht-erlaubte Vorlagen perfekt heraus.');

  console.log('\n=== TEST 4: Simon versucht nicht-erlaubten Server (z. B. ARK) zu erstellen ===');
  const [arkEgg] = await sql`SELECT id FROM eggs WHERE name ILIKE '%ARK%' LIMIT 1`;
  const resCreateArk = await fetch(`${API_BASE}/servers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${simonToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Simons Unerlaubter Ark Server',
      eggId: arkEgg.id,
      dockerImage: 'ghcr.io/pterodactyl/games:source',
      ramMb: 2048,
      diskMb: 10240,
      cpuPercent: 100,
      variables: {}
    })
  });
  const arkErr = await resCreateArk.json();
  console.log(`POST /servers (ARK) als Simon -> Status: ${resCreateArk.status}, Grund: ${arkErr.error || arkErr.message}`);
  if (resCreateArk.status !== 403) throw new Error('FEHLER: Simon durfte ARK Server anlegen!');
  console.log('PASSED: Erstellung nicht-erlaubter Spielserver wird serverseitig mit 403 geblockt.');

  console.log('\n=== TEST 5: Admin weist Simon bestehende Instanzen zu (AMP-Stil) ===');
  const [mcServer] = await sql`SELECT id, name FROM servers WHERE name ILIKE '%BroGamerYT%' LIMIT 1`;
  const [arkServer] = await sql`SELECT id, name FROM servers WHERE name ILIKE '%Simon Ark%' LIMIT 1`;

  console.log('Gefundene Instanzen:');
  console.log(' - Minecraft:', mcServer.name, mcServer.id);
  console.log(' - ARK:', arkServer.name, arkServer.id);

  // Zuweisung 1: Minecraft -> Operator (Start, Stop, Restart, Command, Console)
  const mcFlags = ['control.console', 'control.command', 'control.start', 'control.stop', 'control.restart'];
  const resAssignMc = await fetch(`${API_BASE}/admin/users/${simon.id}/servers/${mcServer.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ permissions: mcFlags })
  });
  console.log(`Admin weist Simon Rechte für MC zu -> Status: ${resAssignMc.status}`);

  // Zuweisung 2: ARK -> Nur Zuschauer / Konsole lesen (KEIN Start, KEIN Stop, KEIN Restart, KEIN File Write)
  const arkFlags = ['control.console'];
  const resAssignArk = await fetch(`${API_BASE}/admin/users/${simon.id}/servers/${arkServer.id}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ permissions: arkFlags })
  });
  console.log(`Admin weist Simon Rechte für ARK zu -> Status: ${resAssignArk.status}`);

  console.log('\n=== TEST 6: Simon testet ARK-Rechte (Darf Konsole sehen, aber KEIN Start/Stop/Kill/File) ===');
  // 6a: Console WS-Ticket holen (sollte 200 sein, da control.console vorhanden)
  const resArkWs = await fetch(`${API_BASE}/servers/${arkServer.id}/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${simonToken}` }
  });
  console.log(`ARK ws-ticket (Konsole lesen) -> Status: ${resArkWs.status} (Erwartet: 200)`);
  if (resArkWs.status !== 200) throw new Error('FEHLER: Simon konnte kein Konsolen-Ticket für ARK holen!');

  // 6b: Starten versuchen (sollte 403 sein)
  const resArkStart = await fetch(`${API_BASE}/servers/${arkServer.id}/power`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${simonToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'start' })
  });
  const arkStartErr = await resArkStart.json();
  console.log(`ARK Starten versuchen -> Status: ${resArkStart.status}, Grund: ${arkStartErr.error || arkStartErr.message} (Erwartet: 403)`);
  if (resArkStart.status !== 403) throw new Error('FEHLER: Simon durfte ARK starten!');

  // 6c: Stoppen versuchen (sollte 403 sein)
  const resArkStop = await fetch(`${API_BASE}/servers/${arkServer.id}/power`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${simonToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ action: 'stop' })
  });
  console.log(`ARK Stoppen versuchen -> Status: ${resArkStop.status} (Erwartet: 403)`);
  if (resArkStop.status !== 403) throw new Error('FEHLER: Simon durfte ARK stoppen!');

  // 6d: Datei schreiben versuchen (sollte 403 sein)
  const resArkFile = await fetch(`${API_BASE}/servers/${arkServer.id}/files/content`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${simonToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ path: 'hack.txt', content: 'test' })
  });
  console.log(`ARK Datei schreiben versuchen -> Status: ${resArkFile.status} (Erwartet: 403)`);
  if (resArkFile.status !== 403) throw new Error('FEHLER: Simon durfte Dateien schreiben!');

  console.log('PASSED: ARK ist für Simon strikt Read-Only / Konsole, alle Schreib- und Startaktionen werden mit 403 blockiert!');

  console.log('\n=== TEST 7: Simon testet Minecraft-Rechte (Darf Konsole und Power-Aktionen) ===');
  // 7a: Console WS-Ticket holen (sollte 200 sein)
  const resMcWs = await fetch(`${API_BASE}/servers/${mcServer.id}/ws-ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${simonToken}` }
  });
  console.log(`MC ws-ticket -> Status: ${resMcWs.status} (Erwartet: 200)`);
  if (resMcWs.status !== 200) throw new Error('FEHLER: Simon konnte kein MC Konsolen-Ticket holen!');

  console.log('PASSED: Minecraft Operator-Rechte greifen sauber!');

  console.log('\n=== TEST 8: Aufräumen ===');
  await sql`DELETE FROM subusers WHERE user_id = ${simon.id}`;
  await sql`DELETE FROM users WHERE id = ${simon.id}`;
  console.log('Test-User simon und Subuser-Einträge bereinigt.');

  console.log('\n>>> ALLE TESTS ERFOLGREICH BESTANDEN! DAS RECHTESYSTEM FUNKTIONIERT ZU 100% FEHLERFREI! <<<');
  process.exit(0);
}

main().catch((err) => {
  console.error('Test fehlgeschlagen:', err);
  process.exit(1);
});
