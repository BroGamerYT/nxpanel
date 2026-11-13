import { applyPendingRestore, CoreBackups } from './backups/core-backup.js';
import { config } from './config/index.js';

/**
 * Reparatur-Modus von der Kommandozeile - funktioniert auch, wenn der Core wegen einer kaputten Datenbank nicht mehr startet:
 *
 *   nexuscore.exe backups                 zeigt die Sicherungen
 *   nexuscore.exe restore <Kennung|latest>  spielt eine Sicherung ein (den Dienst vorher beenden)
 *
 * Der jetzige Stand wird vorher selbst als Sicherung abgelegt ("vor-wiederherstellung").
 */
export async function runRepairCli(command: string, arg: string | undefined): Promise<number> {
  const backups = new CoreBackups({
    dir: config.dataDir,
    snapshot: () => {
      throw new Error('Im Reparatur-Modus wird nichts neu gesichert.');
    },
  });
  const list = await backups.list();

  if (command === 'backups') {
    if (list.length === 0) console.log('Es gibt keine Sicherungen in ' + config.dataDir);
    for (const b of list) console.log(`${b.id}   ${b.createdAt.slice(0, 16).replace('T', ' ')} UTC   Version ${b.version}   ${b.reason}   ${Math.round(b.sizeBytes / 1024)} KB`);
    return 0;
  }

  const id = !arg || arg === 'latest' ? list.find((b) => b.reason !== 'vor Wiederherstellung')?.id : arg;
  if (!id || !list.some((b) => b.id === id)) {
    console.error('Welche Sicherung? Mit "backups" ansehen, dann "restore <Kennung>" oder "restore latest".');
    return 2;
  }
  try {
    await backups.stageRestore(id);
    const done = await applyPendingRestore(config.dataDir);
    console.log(`Sicherung ${done?.id ?? id} eingespielt. Der vorherige Stand liegt als ${done?.safety ?? '?'} in ${config.dataDir}. Jetzt den Dienst/Core wieder starten.`);
    return 0;
  } catch (err) {
    console.error(`Wiederherstellung fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
