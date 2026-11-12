import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Die Plattform-Schicht: alles, was je Betriebssystem anders ist, steht hier - nirgends sonst.
 *
 * Der Core, die API und die Oberflaeche sind auf Windows, Linux und macOS derselbe Code. Darunter gilt:
 *  - Docker ist der gemeinsame Weg fuer alle Systeme (Linux: Docker Engine, Windows und macOS: Docker Desktop).
 *  - Spiele direkt als Prozess (ohne Docker) gibt es nur unter Windows (`windows-native`).
 *  - Dienst, Firewall und Werkzeuge haengen vom System ab.
 *
 * Neue Systemabhaengigkeit? Hier eintragen und ueber `platformFor()` benutzen, nicht `process.platform` im Code verstreuen.
 */

export type PlatformId = 'windows' | 'linux' | 'darwin';
export type RuntimeId = 'windows-native' | 'docker' | 'mock';

export interface PlatformInfo {
  id: PlatformId;
  /** Anzeigename, z. B. "Windows". */
  label: string;
  /** Welche Treiber hier laufen (mock geht immer: er startet nichts). */
  runtimes: readonly RuntimeId[];
  defaultRuntime: RuntimeId;
  /** Freigaben je Programm in der Betriebssystem-Firewall. */
  firewall: { available: boolean; reason?: string };
  /** Wie der Core als Dienst laeuft. */
  service: { kind: 'windows-service' | 'systemd' | 'launchd'; install: string };
  /** Name der Platzhalter-Startdatei fuer Server ohne echte Installation. */
  scriptName: string;
}

const WINDOWS: PlatformInfo = {
  id: 'windows',
  label: 'Windows',
  runtimes: ['windows-native', 'docker', 'mock'],
  defaultRuntime: 'windows-native',
  firewall: { available: true },
  service: { kind: 'windows-service', install: 'scripts/install-service.ps1' },
  scriptName: 'start.bat',
};

const LINUX: PlatformInfo = {
  id: 'linux',
  label: 'Linux',
  runtimes: ['docker', 'mock'],
  defaultRuntime: 'docker',
  firewall: {
    available: false,
    reason: 'Docker veröffentlicht Spielports an der Firewall des Rechners vorbei. Ports und Zugriff über die Firewall (ufw, firewalld) oder DOCKER-USER-Regeln des Rechners verwalten.',
  },
  service: { kind: 'systemd', install: 'deploy/linux/install-core.sh' },
  scriptName: 'start.sh',
};

const DARWIN: PlatformInfo = {
  id: 'darwin',
  label: 'macOS',
  runtimes: ['docker', 'mock'],
  defaultRuntime: 'docker',
  firewall: { available: false, reason: 'Unter macOS laufen Spiele in Docker Desktop; die Firewall von macOS regelt sie nicht je Programm.' },
  service: { kind: 'launchd', install: 'deploy/macos/install-core.sh' },
  scriptName: 'start.sh',
};

export function platformFor(nodePlatform: NodeJS.Platform = process.platform): PlatformInfo {
  if (nodePlatform === 'win32') return WINDOWS;
  if (nodePlatform === 'darwin') return DARWIN;
  return LINUX; // alle anderen Unix-Systeme: wie Linux (nur Docker)
}

export class RuntimeNotSupportedError extends Error {
  constructor(runtime: string, platform: PlatformInfo) {
    super(
      `Der Treiber "${runtime}" läuft unter ${platform.label} nicht. Möglich: ${platform.runtimes.join(', ')}. ` +
        `(NEXUSCORE_RUNTIME=${platform.defaultRuntime} ist hier der Standard.)`,
    );
    this.name = 'RuntimeNotSupportedError';
  }
}

/** Bricht mit klarer Meldung ab, wenn der gewaehlte Treiber auf diesem System nicht geht. */
export function assertRuntimeSupported(runtime: string, platform: PlatformInfo = platformFor()): void {
  if (!(platform.runtimes as readonly string[]).includes(runtime)) throw new RuntimeNotSupportedError(runtime, platform);
}

/** Platzhalter-Startdatei fuer Server ohne echte Installation (nur Tests und Mock). */
export function placeholderScript(platform: PlatformInfo, name: string, eggId: string, port: number): string {
  if (platform.id === 'windows') {
    return `@echo off\necho [NexusPanel] Starte Server '${name}' (Egg: ${eggId})...\necho [NexusPanel] Server bereit auf Port ${port}!\n:loop\nping -n 5 127.0.0.1 >nul\ngoto loop\n`;
  }
  return `#!/bin/sh\necho "[NexusPanel] Starte Server '${name}' (Egg: ${eggId})..."\necho "[NexusPanel] Server bereit auf Port ${port}!"\nwhile true; do sleep 5; done\n`;
}

/** Das tar des Systems; unter Windows das mitgelieferte, damit nicht ein fremdes aus dem PATH greift. */
export function tarBinary(platform: PlatformInfo = platformFor(), env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string {
  if (platform.id === 'windows') {
    const system = path.win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (exists(system)) return system;
  }
  return 'tar';
}

/** Was die Oberflaeche und Skripte ueber dieses System wissen duerfen. */
export function describePlatform(runtime: string, platform: PlatformInfo = platformFor()) {
  return {
    id: platform.id,
    label: platform.label,
    runtime,
    runtimes: [...platform.runtimes],
    firewall: platform.firewall,
    service: platform.service,
  };
}
