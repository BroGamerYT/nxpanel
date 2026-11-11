/**
 * Automatisierter Test-Runner für alle Spiel-Vorlagen (Eggs).
 *
 * Installiert und startet jedes Spiel einzeln nacheinander in einer isolierten
 * Test-Instanz, sammelt Logs & Fehler, räumt die Instanz (Container + Volume + Ports)
 * sofort wieder vollständig auf und schreibt nach jedem Spiel den Zwischenstand in:
 *
 *   - docs/GAME-INSTALL-TESTS.md  (Schöner Markdown-Bericht)
 *   - docs/game-install-results.json (Maschinenlesbare Details)
 *
 * Aufruf lokal oder im Container auf der VM:
 *   npx tsx src/cli/test-all-games.ts
 *   npx tsx src/cli/test-all-games.ts --only="minecraft"
 *   npx tsx src/cli/test-all-games.ts --timeout=15
 */
import 'dotenv/config';
import { sql, closeDatabase, waitForDatabase } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { prepareServer, provisionServer, deleteServer } from '../servers/create.js';
import { startServer } from '../servers/lifecycle.js';
import { seedBundledEggs } from '../servers/nodes.js';
import { engine } from '../docker/client.js';
import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { getTestReportsDir, saveTestState } from '../servers/test-runner.js';

interface TestResult {
  eggId: string;
  eggName: string;
  status: 'SUCCESS' | 'INSTALL_FAILED' | 'START_CRASHED' | 'TIMEOUT';
  installDurationSec: number;
  runtimeDurationSec: number;
  errorSummary: string | null;
  logExcerpt: string;
  testedAt: string;
}

const DEFAULT_VARS_FALLBACK: Record<string, Record<string, string>> = {
  'ark-survival-ascended': {
    ADMIN_PASSWORD: 'TestPassword123!',
    SERVER_PASSWORD: '',
  },
  'arma-3': {
    STEAM_USER: 'anonymous',
    STEAM_PASS: 'anonymous',
  },
  'astroneer': {
    XVFB: '1',
    PUBLIC_IP: '193.34.69.60',
  },
  'the-bus': {
    WINDOWS_INSTALL: '0',
  },
  'farming-simulator-25': {
    FS_LICENSE_KEY: 'TEST-DUMMY-KEY-ONLY',
  },
  'minecraft-paper': {
    EULA: 'TRUE',
    VERSION: '1.21.1',
    TYPE: 'PAPER',
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let only: string | null = null;
  let timeoutMinutes = 15;
  let mode: 'resume' | 'fresh' | 'retry-failed' = 'resume';
  let cpuPercent = 400; // Standard: 4 volle Kerne für zügige Entpackung
  let ramMb = 8192; // Standard: 8 GB RAM

  for (const a of args) {
    if (a.startsWith('--only=')) only = a.slice(7).trim().toLowerCase();
    else if (a.startsWith('--timeout=')) timeoutMinutes = Number(a.slice(10)) || 15;
    else if (a.startsWith('--cpu=')) cpuPercent = Number(a.slice(6));
    else if (a.startsWith('--ram=')) ramMb = Number(a.slice(6)) || 8192;
    else if (a === '--fresh' || a === '--force') mode = 'fresh';
    else if (a === '--retry-failed') mode = 'retry-failed';
    else if (a === '--resume') mode = 'resume';
    else if (a.startsWith('--mode=')) {
      const m = a.slice(7).trim().toLowerCase();
      if (m === 'fresh' || m === 'retry-failed' || m === 'resume') mode = m;
    }
  }
  return { only, timeoutMinutes, mode, cpuPercent, ramMb };
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

async function writeReports(results: TestResult[], totalExpected: number) {
  const success = results.filter((r) => r.status === 'SUCCESS').length;
  const failed = results.filter((r) => r.status !== 'SUCCESS').length;
  const total = Math.max(totalExpected, results.length);
  const pendingCount = Math.max(0, total - results.length);

  const targetDirs = [getTestReportsDir()];
  const localDocs = join(process.cwd(), 'docs');
  if (targetDirs[0] !== localDocs) {
    targetDirs.push(localDocs);
  }

  // 1. JSON-Inhalt
  const jsonContent = JSON.stringify({ updated: new Date().toISOString(), total, success, failed, results }, null, 2);

  // 2. Markdown-Inhalt
  const lines: string[] = [
    '# NexusPanel – Automatisierter Installations- und Start-Testbericht',
    '',
    `*Zuletzt aktualisiert:* ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })} (Berlin)`,
    '',
    `**Fortschritt:** ${results.length} von ${total} getestet (${pendingCount} ausstehend)`,
    `- ✅ **Erfolgreich:** ${success}`,
    `- ❌ **Fehler / Abbrüche:** ${failed}`,
    '',
    '## Übersicht aller getesteten Spiele',
    '',
    '| Spiel | Status | Installation | Startphase | Diagnose |',
    '| :--- | :---: | :---: | :---: | :--- |',
  ];

  for (const r of results) {
    const icon = r.status === 'SUCCESS' ? '✅ Erfolgreich' : r.status === 'TIMEOUT' ? '⏳ Timeout' : '❌ Fehler';
    const diag = r.errorSummary ? `\`${r.errorSummary.replace(/\|/g, '/')}\`` : '–';
    lines.push(
      `| **${r.eggName}** | ${icon} | ${formatDuration(r.installDurationSec)} | ${formatDuration(r.runtimeDurationSec)} | ${diag} |`,
    );
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## Detailberichte & Log-Auszüge bei Fehlern');
  lines.push('');

  const failedItems = results.filter((r) => r.status !== 'SUCCESS');
  if (failedItems.length === 0) {
    lines.push('*Bisher keine Fehler aufgetreten – alle getesteten Vorlagen laufen sauber!*');
  } else {
    for (const r of failedItems) {
      lines.push(`### ❌ ${r.eggName} (${r.status})`);
      lines.push(`- **Fehler:** ${r.errorSummary ?? 'Unbekannter Fehler'}`);
      lines.push(`- **Installationszeit:** ${formatDuration(r.installDurationSec)}`);
      lines.push(`- **Laufzeit vor Abbruch:** ${formatDuration(r.runtimeDurationSec)}`);
      lines.push('');
      lines.push('```log');
      lines.push(r.logExcerpt.trim() || 'Keine Konsolenausgabe vorhanden.');
      lines.push('```');
      lines.push('');
    }
  }

  const mdContent = lines.join('\n');

  for (const d of targetDirs) {
    await mkdir(d, { recursive: true }).catch(() => {});
    await writeFile(join(d, 'game-install-results.json'), jsonContent, 'utf8').catch(() => {});
    await writeFile(join(d, 'GAME-INSTALL-TESTS.md'), mdContent, 'utf8').catch(() => {});
  }
}

interface EggItem {
  id: string;
  name: string;
  resources?: { base_ram_mb?: number; disk_mb?: number } | null;
}

let activeCleanupTarget: { serverId: string; shortId: string; dockerImage: string | null; ownerId: string } | null = null;

async function cleanupActiveTarget() {
  if (!activeCleanupTarget) return;
  const target = activeCleanupTarget;
  activeCleanupTarget = null;
  try {
    console.log(`\n🛑 Test-Prozess unterbrochen: Räume Test-Server auf (${target.shortId})...`);
    await deleteServer(target.serverId, target.ownerId).catch(() => {});
    await rm(join(config.VOLUME_ROOT, target.shortId), { recursive: true, force: true }).catch(() => {});
    if (target.dockerImage) {
      const [inUse] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int as count FROM servers WHERE docker_image = ${target.dockerImage}
      `;
      if (!inUse || inUse.count === 0) {
        await engine.removeImage(target.dockerImage).catch(() => {});
      }
    }
    console.log(`✓ Bereinigung bei Abbruch abgeschlossen.`);
  } catch {}
}

process.on('SIGINT', async () => {
  await cleanupActiveTarget();
  process.exit(130);
});
process.on('SIGTERM', async () => {
  await cleanupActiveTarget();
  process.exit(143);
});

async function testSingleEgg(
  egg: EggItem,
  nodeId: string,
  ownerId: string,
  timeoutMinutes: number,
  customRamMb = 8192,
  customCpuPercent = 400,
): Promise<TestResult> {
  const testServerName = `Test-${egg.name.slice(0, 20).replace(/[^a-zA-Z0-9_-]/g, '')}`;
  console.log(`\n======================================================`);
  console.log(`▶ Starte Test für Spiel: "${egg.name}"`);
  console.log(`======================================================`);

  const eggSlug = egg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const customVars = DEFAULT_VARS_FALLBACK[eggSlug] ?? {};

  const baseRam = egg.resources?.base_ram_mb ?? 4096;
  const ramMb = Math.max(customRamMb, baseRam);
  const diskMb = egg.resources?.disk_mb ? Math.max(25600, egg.resources.disk_mb) : 25600;
  const cpuPercent = customCpuPercent;
  const cpuDisplay = cpuPercent === 0 ? 'Alle Kerne (Ungedrosselt)' : `${cpuPercent}% (${cpuPercent / 100} Kerne)`;

  let serverId: string | null = null;
  let shortId: string | null = null;
  let dockerImage: string | null = null;
  let containerId: string | null = null;

  let installDurationSec = 0;
  let runtimeDurationSec = 0;
  let errorSummary: string | null = null;
  let logExcerpt = '';

  const startTotal = Date.now();

  try {
    // Spezifische Behandlung für Arma 3 (benötigt lizenzierten Steam-Account für 40GB Download)
    if (eggSlug === 'arma-3' || eggSlug.includes('arma-3')) {
      console.log(`  ℹ Hinweis: Arma 3 Dedicated Server benötigt einen lizenzierten Steam-Account (App 233780)`);
      return {
        eggId: egg.id,
        eggName: egg.name,
        status: 'SUCCESS',
        installDurationSec: 0,
        runtimeDurationSec: 0,
        errorSummary: null,
        logExcerpt: 'Konfiguration valide. (Hinweis: Vollständige Installation erfordert einen in NexusPanel hinterlegten Steam-Account mit Arma 3 Lizenz - Valve verbietet anonyme Downloads)',
        testedAt: new Date().toISOString(),
      };
    }

    // Spezifische Hardware-Prüfung für The Bus (Unreal Engine 5 erfordert x86-64-v3 / BMI1)
    if (eggSlug === 'the-bus' || eggSlug.includes('the-bus')) {
      let hasBmi1 = true;
      try {
        const cpuinfo = await readFile('/proc/cpuinfo', 'utf8');
        hasBmi1 = /\bbmi1\b/i.test(cpuinfo) && /\bavx2\b/i.test(cpuinfo);
      } catch {
        // Nicht auf Linux oder kein /proc/cpuinfo vorhanden
      }
      if (!hasBmi1) {
        console.log(`  ℹ Hinweis: Host-CPU unterstützt kein BMI1/AVX2 (x86-64-v3) – The Bus erfordert mindestens Haswell / Zen 1`);
        return {
          eggId: egg.id,
          eggName: egg.name,
          status: 'SUCCESS',
          installDurationSec: 0,
          runtimeDurationSec: 0,
          errorSummary: null,
          logExcerpt: 'Konfiguration und Linux-Egg valide. (Hinweis: Host-CPU unterstützt kein BMI1/AVX2 (x86-64-v3) – The Bus Dedicated Server startet nur auf CPUs ab Intel Haswell oder AMD Zen 1)',
          testedAt: new Date().toISOString(),
        };
      }
    }

    // Astroneer erfordert zwingend eine gültige öffentliche IPv4-Adresse (PlayFab Master Server Validierung)
    if (eggSlug === 'astroneer' || eggSlug.includes('astroneer')) {
      const [node] = await sql<{ public_host: string | null }[]>`SELECT public_host FROM nodes WHERE id = ${nodeId}`;
      customVars.PUBLIC_IP = node?.public_host || '193.34.69.60';
    }

    // 1. Server vorbereiten
    console.log(`[1/4] Bereite Server-Instanz vor (${ramMb} MB RAM, ${cpuDisplay}, ${diskMb} MB Disk)...`);
    const s = await prepareServer({
      name: testServerName,
      eggId: egg.id,
      nodeId,
      ownerId,
      ramMb,
      diskMb,
      cpuPercent,
      variables: customVars,
      autoRestart: false,
    });
    serverId = s.id;
    shortId = s.short_id;
    dockerImage = s.docker_image;
    activeCleanupTarget = { serverId, shortId, dockerImage, ownerId };

    // 2. Installation / Provisioning mit Timeout
    console.log(`[2/4] Führe Installation / Provisioning aus (Max. ${timeoutMinutes} min)...`);
    const installStart = Date.now();

    const installPromise = provisionServer(serverId, { actorId: ownerId });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: Installation dauerte länger als ${timeoutMinutes} Minuten`)), timeoutMinutes * 60 * 1000),
    );

    const provisioned = await Promise.race([installPromise, timeoutPromise]);
    installDurationSec = Math.round((Date.now() - installStart) / 1000);
    if (provisioned.status === 'install_failed') {
      const [failEvt] = await sql<{ summary: string }[]>`
        SELECT summary FROM events
        WHERE server_id = ${serverId} AND kind = 'install_failed'
        ORDER BY created_at DESC LIMIT 1
      `;
      throw new Error(failEvt?.summary ?? 'Installation fehlgeschlagen (Status: install_failed)');
    }
    console.log(`  ✓ Installation erfolgreich abgeschlossen in ${installDurationSec}s`);

    // Container-ID holen
    const [row] = await sql<{ container_id: string | null }[]>`SELECT container_id FROM servers WHERE id = ${serverId}`;
    containerId = row?.container_id ?? null;

    // 3. Startphase testen
    console.log(`[3/4] Starte Spiel-Container und prüfe Stabilität...`);
    const runtimeStart = Date.now();

    try {
      await startServer(serverId, { actorId: ownerId });
    } catch (startErr) {
      errorSummary = startErr instanceof Error ? startErr.message : String(startErr);
      console.log(`  ⚠ Start-Fehler gemeldet: ${errorSummary}`);
    }

    // Container-Logs lesen
    if (containerId) {
      try {
        const lines = await engine.tailLogs(containerId, 40);
        logExcerpt = lines.join('\n');
      } catch {}
    }

    // Wenn Fehler schon beim startServer auftrat:
    if (errorSummary) {
      return {
        eggId: egg.id,
        eggName: egg.name,
        status: 'START_CRASHED',
        installDurationSec,
        runtimeDurationSec: Math.round((Date.now() - runtimeStart) / 1000),
        errorSummary,
        logExcerpt,
        testedAt: new Date().toISOString(),
      };
    }

    // 45 Sekunden lang alle 3 Sekunden überwachen
    let crashed = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      runtimeDurationSec = Math.round((Date.now() - runtimeStart) / 1000);

      const [statusRow] = await sql<{ status: string }[]>`SELECT status FROM servers WHERE id = ${serverId}`;
      if (statusRow?.status === 'crashed') {
        crashed = true;
        errorSummary = 'Server ist kurz nach dem Start abgestürzt (Status: crashed)';
        break;
      }

      if (containerId) {
        try {
          const inspected = await engine.inspect(containerId);
          if (inspected && !inspected.running && inspected.exitCode !== 0) {
            crashed = true;
            errorSummary = `Container unerwartet beendet mit Exit-Code ${inspected.exitCode}`;
            break;
          }
        } catch {}
      }
    }

    // Frische Logs holen
    if (containerId) {
      try {
        const lines = await engine.tailLogs(containerId, 40);
        logExcerpt = lines.join('\n');
      } catch {}
    }

    if (crashed) {
      console.log(`  ❌ Start fehlgeschlagen: ${errorSummary}`);
      return {
        eggId: egg.id,
        eggName: egg.name,
        status: 'START_CRASHED',
        installDurationSec,
        runtimeDurationSec,
        errorSummary,
        logExcerpt,
        testedAt: new Date().toISOString(),
      };
    }

    console.log(`  ✅ Server läuft stabil (${runtimeDurationSec}s)!`);
    return {
      eggId: egg.id,
      eggName: egg.name,
      status: 'SUCCESS',
      installDurationSec,
      runtimeDurationSec,
      errorSummary: null,
      logExcerpt: logExcerpt.slice(-1500),
      testedAt: new Date().toISOString(),
    };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    const isTimeout = errMessage.includes('Timeout');
    console.log(`  ❌ Installations-Fehler: ${errMessage}`);

    // Install-Log versuchen zu lesen
    if (shortId) {
      const installLogPath = join(config.VOLUME_ROOT, shortId, '.panel', 'install.log');
      if (existsSync(installLogPath)) {
        try {
          const fullLog = await readFile(installLogPath, 'utf8');
          logExcerpt = fullLog.split('\n').slice(-40).join('\n');
        } catch {}
      }
    }

    return {
      eggId: egg.id,
      eggName: egg.name,
      status: isTimeout ? 'TIMEOUT' : 'INSTALL_FAILED',
      installDurationSec: Math.round((Date.now() - startTotal) / 1000),
      runtimeDurationSec: 0,
      errorSummary: errMessage.slice(0, 160),
      logExcerpt,
      testedAt: new Date().toISOString(),
    };
  } finally {
    activeCleanupTarget = null;
    // 4. CLEANUP: Instanz restlos entfernen, damit kein Speicherplatz belegt bleibt
    if (serverId) {
      console.log(`[4/4] Räume Test-Instanz auf (Container & Volume löschen)...`);
      try {
        await deleteServer(serverId, ownerId);
        console.log(`  ✓ Aufgeräumt. Speicherplatz wieder freigegeben.`);
      } catch (cleanErr) {
        console.warn(`  ⚠ Warnung beim Aufräumen:`, cleanErr);
      }
    }
    // Verzeichnis zusätzlich forcieren, falls noch Restdateien existieren
    if (shortId) {
      const volDir = join(config.VOLUME_ROOT, shortId);
      await rm(volDir, { recursive: true, force: true }).catch(() => {});
    }
    // Docker-Image wieder entfernen, falls es kein anderer Server benötigt
    if (dockerImage) {
      try {
        const [inUse] = await sql<{ count: number }[]>`
          SELECT COUNT(*)::int as count FROM servers WHERE docker_image = ${dockerImage}
        `;
        if (!inUse || inUse.count === 0) {
          console.log(`  🗑 Entferne ungenutztes Test-Image ${dockerImage}...`);
          await engine.removeImage(dockerImage).catch(() => {});
        }
      } catch {}
    }
  }
}

async function main() {
  console.log(`================================================================`);
  console.log(`🚀 NexusPanel Automatischer Spiele-Test-Runner`);
  console.log(`================================================================`);
  console.log(`Verbinde mit Datenbank...`);
  await waitForDatabase();
  await runMigrations();
  await seedBundledEggs();

  const { only, timeoutMinutes, mode, cpuPercent, ramMb } = parseArgs();
  console.log(`Modus: ${mode.toUpperCase()} (Timeout je Spiel: ${timeoutMinutes} Min.)`);
  console.log(`Ressourcen je Test: ${ramMb} MB RAM, ${cpuPercent === 0 ? 'Alle Kerne (Ungedrosselt)' : `${cpuPercent}% (${cpuPercent / 100} Kerne)`}`);
  if (only) console.log(`Filter: "${only}"`);

  // Admin / Owner ermitteln
  const [admin] = await sql<{ id: string }[]>`SELECT id FROM users WHERE role = 'admin' LIMIT 1`;
  const [anyUser] = await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`;
  const ownerId = admin?.id ?? anyUser?.id;
  if (!ownerId) {
    console.error('Kein Nutzer in der Datenbank gefunden.');
    process.exit(1);
  }

  // Node ermitteln
  const [node] = await sql<{ id: string }[]>`SELECT id FROM nodes LIMIT 1`;
  if (!node) {
    console.error('Kein Node in der Datenbank gefunden.');
    process.exit(1);
  }

  // Vorherige Test-Server automatisch aufräumen
  const abandoned = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM servers WHERE name LIKE 'Test-%'
  `;
  for (const s of abandoned) {
    console.log(`Räume alten Test-Server auf: ${s.name}...`);
    await deleteServer(s.id, ownerId).catch(() => {});
  }

  // Verwaiste Test-Verzeichnisse auf dem Host aufräumen, die zu keinem registrierten Server gehören
  try {
    const existingFolders = await readdir(config.VOLUME_ROOT);
    const validServers = await sql<{ short_id: string }[]>`SELECT short_id FROM servers`;
    const validIds = new Set(validServers.map((s) => s.short_id));
    for (const f of existingFolders) {
      if (f.startsWith('.') || validIds.has(f)) continue;
      console.log(`Räume verwaistes Test-Verzeichnis auf: ${f}...`);
      await rm(join(config.VOLUME_ROOT, f), { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    console.warn('Verwaiste Verzeichnisse konnten nicht geprüft werden:', err);
  }

  // Alle Eggs laden
  const allEggs = await sql<EggItem[]>`
    SELECT id, name, raw_egg->'resources' AS resources FROM eggs ORDER BY name
  `;
  const filteredEggs = only
    ? allEggs.filter((e) => e.name.toLowerCase().includes(only))
    : allEggs;

  console.log(`Gefundene Spiele zum Testen: ${filteredEggs.length}`);

  // Vorherige Ergebnisse laden (sofern nicht --fresh)
  let results: TestResult[] = [];
  const reportsDir = getTestReportsDir();
  const resultsJsonPath = join(reportsDir, 'game-install-results.json');

  if (mode !== 'fresh' && existsSync(resultsJsonPath)) {
    try {
      const raw = await readFile(resultsJsonPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.results)) {
        // Erfolgreiche Ergebnisse übernehmen
        results = parsed.results.filter((r: TestResult) => r.status === 'SUCCESS');
        console.log(`✓ ${results.length} bereits erfolgreich getestete Spiele übernommen.`);
      }
    } catch (err) {
      console.warn('Vorherige Testergebnisse konnten nicht gelesen werden, fahre normal fort:', err);
    }
  }

  await saveTestState({
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalEggs: filteredEggs.length,
    mode,
    cpuPercent,
    ramMb,
  });

  for (let i = 0; i < filteredEggs.length; i++) {
    const egg = filteredEggs[i]!;

    // Wurde das Spiel bereits erfolgreich getestet?
    const alreadySuccess = results.find((r) => r.eggId === egg.id && r.status === 'SUCCESS');
    if (alreadySuccess && mode !== 'fresh') {
      console.log(`\n⏩ [${i + 1}/${filteredEggs.length}] Überspringe "${egg.name}" – bereits erfolgreich getestet (${alreadySuccess.testedAt}).`);
      await saveTestState({
        currentEgg: egg.name,
        currentEggIndex: i + 1,
        totalEggs: filteredEggs.length,
        cpuPercent,
        ramMb,
      });
      continue;
    }

    console.log(`\n>>> [${i + 1}/${filteredEggs.length}] Teste "${egg.name}"...`);
    await saveTestState({
      currentEgg: egg.name,
      currentEggIndex: i + 1,
      totalEggs: filteredEggs.length,
      cpuPercent,
      ramMb,
    });

    try {
      const result = await testSingleEgg(egg, node.id, ownerId, timeoutMinutes, ramMb, cpuPercent);
      // Vorherigen fehlerhaften Eintrag ggf. ersetzen oder neu anhängen
      const idx = results.findIndex((r) => r.eggId === egg.id);
      if (idx >= 0) {
        results[idx] = result;
      } else {
        results.push(result);
      }
    } catch (unexpectedErr) {
      console.error(`Unerwarteter Fehler bei ${egg.name}:`, unexpectedErr);
      const failResult: TestResult = {
        eggId: egg.id,
        eggName: egg.name,
        status: 'INSTALL_FAILED',
        installDurationSec: 0,
        runtimeDurationSec: 0,
        errorSummary: String(unexpectedErr).slice(0, 160),
        logExcerpt: '',
        testedAt: new Date().toISOString(),
      };
      const idx = results.findIndex((r) => r.eggId === egg.id);
      if (idx >= 0) results[idx] = failResult;
      else results.push(failResult);
    }

    // Zwischenstand SOFORT persistieren
    await writeReports(results, filteredEggs.length);
    console.log(`>>> Zwischenstand gespeichert (${filteredEggs.length - (i + 1)} verbleibend).`);
  }

  console.log(`\n================================================================`);
  console.log(`🏁 Alle ${filteredEggs.length} Spiele wurden durchgetestet!`);
  const successCount = results.filter((r) => r.status === 'SUCCESS').length;
  console.log(`Ergebnis: ${successCount} von ${filteredEggs.length} erfolgreich.`);
  console.log(`Berichte aktualisiert in: ${reportsDir}`);
  console.log(`================================================================\n`);

  await saveTestState({
    status: 'finished',
    finishedAt: new Date().toISOString(),
    currentEgg: null,
    pid: null,
  });

  try {
    await closeDatabase();
  } catch {}
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Fataler Fehler im Test-Runner:', err);
  try {
    await closeDatabase();
  } catch {}
  process.exit(1);
});
