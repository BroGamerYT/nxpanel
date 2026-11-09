import { config } from './config/index.js';
import { MockDriver } from './drivers/mock-driver.js';
import { WindowsNativeDriver } from './drivers/windows-native.js';
import { DockerDriver } from './drivers/docker-driver.js';
import { HostDriver } from './drivers/interface.js';
import { createCoreServer } from './http/server.js';

async function main() {
  console.log(`
  ╔═══════════════════════════════════════════════════════════╗
  ║              ⚡ NEXUSCORE HOST DAEMON (v0.1.0)           ║
  ║  Plattform: ${process.platform.padEnd(12)} Mode: ${config.mode.padEnd(14)} ║
  ╚═══════════════════════════════════════════════════════════╝
  `);

  let driver: HostDriver;

  if (config.runtime === 'windows-native') {
    driver = new WindowsNativeDriver();
  } else if (config.runtime === 'docker') {
    driver = new DockerDriver();
  } else {
    driver = new MockDriver();
  }

  console.log(`[NexusCore] Aktiver Treiber: "${driver.name}"`);
  await driver.initialize();

  // Beispiel-Testserver im Test-Modus registrieren
  if (config.mode === 'test') {
    await driver.registerServer({
      id: 'test-minecraft-01',
      name: 'Test Minecraft Server (Local)',
      game: 'minecraft',
      executable: 'cmd.exe',
      args: ['/c', 'echo Starte Test-Gameserver... && timeout /t 10'],
      workingDir: process.cwd(),
      ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' }],
    });
  }

  const server = await createCoreServer(driver);

  try {
    const address = await server.listen({ port: config.port, host: config.host });
    console.log(`[NexusCore] Daemon lauscht erfolgreich auf: ${address}`);
    console.log(`[NexusCore] HTTP API: ${address}/core/v1/info`);
    console.log(`[NexusCore] Kopplungs-PIN: ${config.pairingPin}`);
  } catch (err) {
    console.error('[NexusCore] Fehler beim Starten des Daemons:', err);
    process.exit(1);
  }
}

main();
