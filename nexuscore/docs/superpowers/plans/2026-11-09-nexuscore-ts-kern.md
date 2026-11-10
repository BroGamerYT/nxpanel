# NexusCore TypeScript-Kern — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nexuscore/` wird ein baubarer, lauffähiger und lokal auf Windows testbarer Host-Daemon: echter Windows-Prozess-Runner, persistente Registry, echter Log-Stream per WebSocket, Stats-Endpoint, gehärtete Auth, Vitest-Tests und ein Smoke-Test-Skript.

**Architecture:** Fastify 5 (ESM, NodeNext) mit zod-validierter Config, pino-Logging und einem zentralen Event-Bus, der Treiberereignisse an HTTP-Clients verteilt. Drei Treiber (Windows nativ, Docker via dockerode, Mock) hinter einem gemeinsamen `HostDriver`-Interface; die Registry persistiert Konfigurationen als JSON unter `nexuscore/data/`.

**Tech Stack:** Node 22+, TypeScript 5.7 (strict), Fastify 5, `@fastify/websocket` 11, zod, pino, dockerode, Vitest 5.

> **Hinweis zu den Code-Schritten:** Bei den Treibern (Tasks 6–8) und der HTTP-Schicht (Task 9)
> sind die exakten Signaturen, Zustände und Fehlerfälle in den jeweiligen
> `**Interfaces:**`-Blöcken festgelegt. Der vollstaendige Quelltext entsteht in den
> Implementierungsdateien und ist dort die massgebliche Fassung.

## Global Constraints

- Arbeitsverzeichnis ist `nexuscore/` innerhalb des Panel-Repos `Gameserver Interface`. Alle Pfade relativ dazu.
- `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, `target ES2023`, `module/moduleResolution NodeNext`, `outDir dist`, `rootDir src`.
- ESM-Projekt: `"type": "module"`, alle relativen Importe enden auf `.js`.
- Kein Token, keine PIN und kein Secret darf geloggt oder in einer Antwort im Klartext zurückgegeben werden.
- Der Port-Default bleibt `8443`, Host-Default wird `127.0.0.1` (nicht `0.0.0.0`).
- Alle neuen Fehlerantworten haben die Form `{ error: string; message?: string }`.
- `npm test` muss ohne Netzwerk und ohne Docker grün sein.
- Der Windows-Treiber läuft ohne `shell: true`; `stopServer` nutzt `taskkill /PID <pid> /T`, `killServer` zusätzlich `/F`.
- Kein Git-Commit ohne ausdrückliche Zustimmung des Nutzers.

---

## File Structure

| Datei | Verantwortung |
| --- | --- |
| `src/types.ts` | Protokoll-Typen: HostInfo, SystemMetrics, ServerInstanceConfig, ServerState, ServerStatus, CoreEvent, ServerStats |
| `src/config/index.ts` | zod-Config aus Umgebung; Startabbruch bei ungültiger Config |
| `src/logger.ts` | pino-Logger mit Redaction von Token/PIN |
| `src/protocol/security.ts` | Token-Prüfung (zeit-sicher), PIN-Ausstellung/Prüfung, Rate-Limit |
| `src/protocol/events.ts` | Event-Bus mit Ringpuffer je Server |
| `src/store/registry.ts` | JSON-Persistenz der Server-Konfigurationen |
| `src/system/monitor.ts` | Host-Metriken (CPU/RAM/Disk) |
| `src/drivers/interface.ts` | `HostDriver`-Interface |
| `src/drivers/mock-driver.ts` | simulierter Treiber |
| `src/drivers/windows-native.ts` | echter Windows-Prozess-Runner |
| `src/drivers/docker-driver.ts` | Container-Steuerung via dockerode |
| `src/http/server.ts` | Fastify-App, Auth-Hook, Routenregistrierung, WS-Stream |
| `src/http/routes/*.ts` | info, pair, servers, actions, stats, logs |
| `src/index.ts` | Bootstrap und geordneter Shutdown |
| `tests/*.test.ts` | Vitest-Tests |
| `scripts/smoke-test.ps1` | End-to-End-Prüfung unter Windows |
| `data/` | Laufzeitdaten (Registry, Logs) – nicht im Git |

---

### Task 1: Projekt-Setup und Toolchain

**Files:**
- Modify: `package.json`
- Modify: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `src/types.ts` (nur die Typen, die alle Tasks brauchen)

**Interfaces:**
- Produces: `ServerInstanceConfig`, `ServerState`, `ServerStatus`, `SystemMetrics`, `HostInfo`, `ServerStats`, `CoreEvent`, `LogLine` – exakt die Formen aus Task 2/3.

- [ ] **Step 1: `package.json` aktualisieren**

```json
{
  "name": "nexuscore",
  "version": "0.2.0",
  "description": "NexusCore - Dezentraler Host Daemon fuer Gameserver (Windows & Linux)",
  "type": "module",
  "main": "dist/index.js",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/cors": "^10.0.2",
    "@fastify/websocket": "^11.0.2",
    "dockerode": "^4.0.2",
    "dotenv": "^16.4.7",
    "fastify": "^5.2.1",
    "pino": "^9.5.0",
    "pino-pretty": "^13.0.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/dockerode": "^3.3.31",
    "@types/node": "^22.13.0",
    "@types/ws": "^8.5.14",
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^5.1.0"
  }
}
```

- [ ] **Step 2: `tsconfig.json` schreiben** – exakt diese Datei:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: `vitest.config.ts` schreiben**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
  },
});
```

- [ ] **Step 4: `.env.example` schreiben**

```dotenv
# Betriebsart: test | production
NEXUSCORE_MODE=test
# HTTP-Server (ohne TLS; TLS kommt mit mTLS in M2)
NEXUSCORE_HOST=127.0.0.1
NEXUSCORE_PORT=8443
# Treiber: windows-native | docker | mock
NEXUSCORE_RUNTIME=windows-native
# Ablage fuer Registry und Logs (Standard: <Projekt>/data)
NEXUSCORE_DATA_DIR=./data
# Bearer-Token fuer alle geschuetzten Routen (in production Pflicht)
NEXUSCORE_TOKEN=
# Kopplungs-PIN (leer = beim Start zufällig erzeugen und ausgeben)
NEXUSCORE_PAIRING_PIN=
# Erlaubte CORS-Herkuenfte, kommagetrennt (leer = CORS aus)
NEXUSCORE_CORS_ORIGINS=
NEXUSCORE_LOG_LEVEL=info
```

- [ ] **Step 5: `.gitignore` schreiben** (in `nexuscore/`)

```gitignore
node_modules/
dist/
data/
*.log
.env
```

- [ ] **Step 6: `src/types.ts` schreiben**

```ts
export type HostRuntime = 'windows-native' | 'docker' | 'mock';

export interface HostInfo {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  runtime: HostRuntime;
  version: string;
  uptimeSeconds: number;
}

export interface SystemMetrics {
  cpuUsagePercent: number;
  totalMemoryMb: number;
  usedMemoryMb: number;
  freeMemoryMb: number;
  diskTotalGb: number;
  diskFreeGb: number;
}

export interface ServerInstanceConfig {
  id: string;
  name: string;
  game: string;
  executable: string;
  args: string[];
  workingDir: string;
  maxMemoryMb?: number;
  maxCpuPercent?: number;
  ports: { name: string; hostPort: number; containerPort?: number; protocol: 'tcp' | 'udp' }[];
  env?: Record<string, string>;
}

export type ServerStatus = 'offline' | 'starting' | 'running' | 'stopping' | 'error';

export interface ServerState {
  id: string;
  status: ServerStatus;
  pid?: number;
  startedAt?: string;
  exitedAt?: string;
  exitCode?: number;
  memoryMb?: number;
  cpuPercent?: number;
}

export interface ServerStats {
  serverId: string;
  status: ServerStatus;
  pid?: number;
  cpuPercent: number;
  memoryMb: number;
  uptimeSeconds: number;
  startedAt?: string;
}

export interface LogLine {
  serverId: string;
  line: string;
  stream: 'stdout' | 'stderr';
  ts: string;
}

export type CoreEvent =
  | { type: 'console'; serverId: string; line: string; stream: 'stdout' | 'stderr'; ts: string }
  | { type: 'state'; serverId: string; state: ServerState; ts: string }
  | { type: 'metrics'; metrics: SystemMetrics; ts: string };
```

- [ ] **Step 7: Abhängigkeiten installieren und Build prüfen**

Run: `cd nexuscore && npm install && npm run build`
Expected: Build läuft durch (die alten `src/http/server.ts`-Fehler sind in diesem Task noch vorhanden und werden in Task 9 behoben – falls der Build vorher scheitert, mit `npm run typecheck` den Ist-Fehlerstand notieren und weiter).

Hinweis: `src/http/server.ts` und die alten Treiber werden in Task 9/6/7/8 ersetzt. Für den Zwischenstand `tsc` nur über die neuen Dateien laufen zu lassen, ist kein Ziel – der Gesamtbuild wird am Ende von Task 9 grün.

---

### Task 2: Config, Logger, Typen-Integration

**Files:**
- Create: `src/config/index.ts`
- Create: `src/logger.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: keine
- Produces: `config` (Typ `CoreConfig`), `isProduction: boolean`, `dataDir: string`, `logger`.

- [ ] **Step 1: Failing test `tests/config.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

describe('Konfiguration', () => {
  it('verwendet sichere Standardwerte', async () => {
    const mod = await import('../src/config/index.js');
    expect(mod.config.host).toBe('127.0.0.1');
    expect(mod.config.port).toBe(8443);
    expect(mod.config.mode).toBe('test');
  });
});
```

- [ ] **Step 2: Test laufen lassen – er muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/config.test.ts`
Expected: FAIL (Modul `../src/config/index.js` existiert nicht).

- [ ] **Step 3: `src/config/index.ts` schreiben**

```ts
import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const envBool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1' || v === 'yes');

const here = path.dirname(fileURLToPath(import.meta.url));

const schema = z
  .object({
    NEXUSCORE_MODE: z.enum(['test', 'production']).default('test'),
    NEXUSCORE_HOST: z.string().default('127.0.0.1'),
    NEXUSCORE_PORT: z.coerce.number().int().min(1).max(65535).default(8443),
    NEXUSCORE_RUNTIME: z.enum(['windows-native', 'docker', 'mock']).optional(),
    NEXUSCORE_DATA_DIR: z.string().default(path.resolve(here, '../../data')),
    NEXUSCORE_TOKEN: z.string().default(''),
    NEXUSCORE_PAIRING_PIN: z.string().default(''),
    NEXUSCORE_CORS_ORIGINS: z.string().default(''),
    NEXUSCORE_LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    NEXUSCORE_ALLOW_INSECURE_AUTH: envBool(false),
  })
  .superRefine((env, ctx) => {
    if (env.NEXUSCORE_MODE !== 'production') return;
    if (env.NEXUSCORE_TOKEN.length < 24) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NEXUSCORE_TOKEN'], message: 'NEXUSCORE_TOKEN muss im Production-Modus mindestens 24 Zeichen haben' });
    }
    if (env.NEXUSCORE_PAIRING_PIN.length < 6) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['NEXUSCORE_PAIRING_PIN'], message: 'NEXUSCORE_PAIRING_PIN muss mindestens 6 Zeichen haben' });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('NexusCore-Konfiguration unvollstaendig:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const isProduction = env.NEXUSCORE_MODE === 'production';

export const config = {
  mode: env.NEXUSCORE_MODE,
  host: env.NEXUSCORE_HOST,
  port: env.NEXUSCORE_PORT,
  runtime:
    env.NEXUSCORE_RUNTIME ??
    (process.platform === 'win32' ? ('windows-native' as const) : ('docker' as const)),
  dataDir: path.resolve(process.cwd(), env.NEXUSCORE_DATA_DIR),
  token: env.NEXUSCORE_TOKEN,
  pairingPin: env.NEXUSCORE_PAIRING_PIN,
  corsOrigins: env.NEXUSCORE_CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
  logLevel: env.NEXUSCORE_LOG_LEVEL,
  /** Nur fuer den lokalen Einstiegstest: ohne Token laeuft der Daemon im Testmodus offen. */
  allowInsecureAuth: env.NEXUSCORE_ALLOW_INSECURE_AUTH,
};

export const dataDir = config.dataDir;
```

- [ ] **Step 4: `src/logger.ts` schreiben**

```ts
import pino from 'pino';
import { config, isProduction } from './config/index.js';

export const logger = pino({
  level: config.logLevel,
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
  redact: {
    paths: ['*.token', '*.pin', 'req.headers.authorization', '*.secret', '*.password'],
    censor: '[entfernt]',
  },
});
```

- [ ] **Step 5: Test + Typecheck**

Run: `cd nexuscore && npx vitest run tests/config.test.ts && npm run typecheck`
Expected: PASS (Typecheck meldet nur die bekannten Altfehler in `src/http/server.ts`).

---

### Task 3: Event-Bus

**Files:**
- Create: `src/protocol/events.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Consumes: `CoreEvent`, `LogLine` aus `src/types.ts`
- Produces: `class EventBus` mit `emit(event: CoreEvent): void`, `on(handler: (e: CoreEvent) => void): () => void`, `logsFor(serverId: string, limit?: number): LogLine[]`, `recent(limit?: number): CoreEvent[]`

- [ ] **Step 1: Failing test `tests/events.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/protocol/events.js';

describe('EventBus', () => {
  it('liefert Konsolenzeilen je Server aus dem Ringpuffer', () => {
    const bus = new EventBus();
    bus.emit({ type: 'console', serverId: 'a', line: 'hallo', stream: 'stdout', ts: '2026-01-01T00:00:00.000Z' });
    bus.emit({ type: 'console', serverId: 'b', line: 'weg', stream: 'stdout', ts: '2026-01-01T00:00:01.000Z' });
    expect(bus.logsFor('a').map((l) => l.line)).toEqual(['hallo']);
  });

  it('liefert an Abonnenten und trennt sich beim Abmelden', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.on((e) => { if (e.type === 'console') seen.push(e.line); });
    bus.emit({ type: 'console', serverId: 'a', line: 'x', stream: 'stdout', ts: 't' });
    off();
    bus.emit({ type: 'console', serverId: 'a', line: 'y', stream: 'stdout', ts: 't' });
    expect(seen).toEqual(['x']);
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/events.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: `src/protocol/events.ts` schreiben**

```ts
import { EventEmitter } from 'node:events';
import type { CoreEvent, LogLine } from '../types.js';

const MAX_LOGS_PER_SERVER = 500;

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly logs = new Map<string, LogLine[]>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(event: CoreEvent): void {
    if (event.type === 'console') {
      const list = this.logs.get(event.serverId) ?? [];
      list.push({ serverId: event.serverId, line: event.line, stream: event.stream, ts: event.ts });
      while (list.length > MAX_LOGS_PER_SERVER) list.shift();
      this.logs.set(event.serverId, list);
    }
    this.emitter.emit('event', event);
  }

  on(handler: (event: CoreEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  logsFor(serverId: string, limit = MAX_LOGS_PER_SERVER): LogLine[] {
    const list = this.logs.get(serverId) ?? [];
    return list.slice(-limit);
  }

  recent(limit = 100): CoreEvent[] {
    const all: CoreEvent[] = [];
    for (const list of this.logs.values()) {
      for (const entry of list) {
        all.push({ type: 'console', serverId: entry.serverId, line: entry.line, stream: entry.stream, ts: entry.ts });
      }
    }
    return all.slice(-limit);
  }
}

export const events = new EventBus();
```

- [ ] **Step 4: Test laufen lassen**

Run: `cd nexuscore && npx vitest run tests/events.test.ts`
Expected: PASS.

---

### Task 4: Security (Token, PIN, Rate-Limit)

**Files:**
- Create: `src/protocol/security.ts`
- Test: `tests/security.test.ts`

**Interfaces:**
- Consumes: `config` aus `src/config/index.js`
- Produces: `validateRequestToken(header?: string): { valid: boolean; reason?: string }`, `createPairingPin(): string`, `validatePairingPin(pin: string): boolean`, `pairingAttemptsRemaining(): number`, `tokenFingerprint(): string`

- [ ] **Step 1: Failing test `tests/security.test.ts`**

```ts
import { describe, expect, it } from 'vitest';

process.env.NEXUSCORE_TOKEN = 'test-token-0123456789abcdefghij';
process.env.NEXUSCORE_MODE = 'test';

const { validateRequestToken, createPairingPin, validatePairingPin } = await import('../src/protocol/security.js');

describe('Security', () => {
  it('lehnt fehlende und falsche Tokens ab', () => {
    expect(validateRequestToken(undefined).valid).toBe(false);
    expect(validateRequestToken('Bearer falsch').valid).toBe(false);
  });

  it('akzeptiert das konfigurierte Token mit und ohne Bearer-Praefix', () => {
    expect(validateRequestToken('Bearer test-token-0123456789abcdefghij').valid).toBe(true);
    expect(validateRequestToken('test-token-0123456789abcdefghij').valid).toBe(true);
  });

  it('erzeugt eine PIN, die gueltig ist', () => {
    const pin = createPairingPin();
    expect(pin).toMatch(/^[A-Z0-9-]{6,12}$/);
    expect(validatePairingPin(pin)).toBe(true);
    expect(validatePairingPin('falsch-falsch')).toBe(false);
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/security.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: `src/protocol/security.ts` schreiben**

```ts
import crypto from 'node:crypto';
import { config } from '../config/index.js';

const PIN_TTL_MS = 10 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

export interface AuthValidationResult {
  valid: boolean;
  reason?: string;
}

let activePin = config.pairingPin.toUpperCase();
let pinCreatedAt = Date.now();
const attempts: number[] = [];

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Laengenvergleich nicht verraten: trotzdem vergleichen, damit die Zeit konstant bleibt.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function tokenFingerprint(): string {
  if (!config.token) return 'nicht gesetzt';
  return crypto.createHash('sha256').update(config.token).digest('hex').slice(0, 12);
}

export function validateRequestToken(headerToken?: string): AuthValidationResult {
  if (!config.token) {
    if (config.allowInsecureAuth) return { valid: true };
    return { valid: false, reason: 'Server hat kein Token gesetzt (NEXUSCORE_TOKEN).' };
  }
  if (!headerToken) {
    return { valid: false, reason: 'Fehlender Authentifizierungs-Token.' };
  }
  const token = headerToken.replace(/^Bearer\s+/i, '').trim();
  if (timingSafeEqualString(token, config.token)) {
    return { valid: true };
  }
  return { valid: false, reason: 'Ungültiger Authentifizierungs-Token.' };
}

export function createPairingPin(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let pin = '';
  for (const byte of bytes) pin += alphabet[byte % alphabet.length];
  activePin = `${pin.slice(0, 3)}-${pin.slice(3)}`;
  pinCreatedAt = Date.now();
  return activePin;
}

export function currentPairingPin(): string {
  if (!activePin || Date.now() - pinCreatedAt > PIN_TTL_MS) {
    return createPairingPin();
  }
  return activePin;
}

export function validatePairingPin(pin: string): boolean {
  const now = Date.now();
  while (attempts.length > 0 && now - attempts[0]! > ATTEMPT_WINDOW_MS) attempts.shift();
  if (attempts.length >= MAX_PAIR_ATTEMPTS) return false;
  attempts.push(now);
  const normalized = (pin ?? '').trim().toUpperCase();
  if (!normalized) return false;
  const ok = timingSafeEqualString(normalized, currentPairingPin());
  if (ok) {
    attempts.length = 0;
    // PIN wird verbraucht und neu erzeugt.
    createPairingPin();
  }
  return ok;
}

export function pairingAttemptsRemaining(): number {
  return Math.max(0, MAX_PAIR_ATTEMPTS - attempts.length);
}
```

- [ ] **Step 4: Test laufen lassen**

Run: `cd nexuscore && npx vitest run tests/security.test.ts`
Expected: PASS.

---

### Task 5: Registry (Persistenz)

**Files:**
- Create: `src/store/registry.ts`
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `ServerInstanceConfig` aus `src/types.js`
- Produces: `class ServerRegistry` mit `static async open(dir: string): Promise<ServerRegistry>`, `list(): ServerInstanceConfig[]`, `get(id: string): ServerInstanceConfig | undefined`, `async add(config: ServerInstanceConfig): Promise<void>` (wirft bei Duplikat), `async remove(id: string): Promise<boolean>`, `async save(): Promise<void>`, `file: string`

- [ ] **Step 1: Failing test `tests/registry.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ServerRegistry } from '../src/store/registry.js';

const sample = {
  id: 'srv-1',
  name: 'Test',
  game: 'minecraft',
  executable: 'cmd.exe',
  args: ['/c', 'echo hi'],
  workingDir: '.',
  ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' as const }],
};

describe('Registry', () => {
  it('legt an, persistiert und laedt wieder', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-reg-'));
    const reg = await ServerRegistry.open(dir);
    await reg.add(sample);
    const again = await ServerRegistry.open(dir);
    expect(again.get('srv-1')?.name).toBe('Test');
  });

  it('lehnt doppelte IDs ab', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-reg-'));
    const reg = await ServerRegistry.open(dir);
    await reg.add(sample);
    await expect(reg.add(sample)).rejects.toThrow(/existiert/);
  });

  it('verträgt eine beschaedigte Datei', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nx-reg-'));
    await fs.writeFile(path.join(dir, 'servers.json'), 'kein json');
    const reg = await ServerRegistry.open(dir);
    expect(reg.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/registry.test.ts`
Expected: FAIL (Modul fehlt).

- [ ] **Step 3: `src/store/registry.ts` schreiben**

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerInstanceConfig } from '../types.js';

interface RegistryFile {
  version: number;
  servers: ServerInstanceConfig[];
}

const FILE_VERSION = 1;

export class ServerRegistry {
  private servers = new Map<string, ServerInstanceConfig>();

  private constructor(readonly dir: string, readonly file: string) {}

  static async open(dir: string): Promise<ServerRegistry> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'servers.json');
    const registry = new ServerRegistry(dir, file);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed && Array.isArray(parsed.servers)) {
        for (const server of parsed.servers) {
          if (server && typeof server.id === 'string') this_add(registry, server);
        }
      }
    } catch {
      // Keine oder beschaedigte Datei: mit leerer Registry weiterarbeiten.
    }
    return registry;
  }

  list(): ServerInstanceConfig[] {
    return Array.from(this.servers.values());
  }

  get(id: string): ServerInstanceConfig | undefined {
    return this.servers.get(id);
  }

  async add(config: ServerInstanceConfig): Promise<void> {
    if (this.servers.has(config.id)) {
      throw new Error(`Server "${config.id}" existiert bereits.`);
    }
    this.servers.set(config.id, config);
    await this.save();
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.servers.delete(id);
    if (removed) await this.save();
    return removed;
  }

  async save(): Promise<void> {
    const payload: RegistryFile = { version: FILE_VERSION, servers: this.list() };
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmp, this.file);
  }
}

function this_add(registry: ServerRegistry, config: ServerInstanceConfig): void {
  registry.servers.set(config.id, config);
}
```

Hinweis für die Umsetzung: `this_add` ist im echten Code nicht erlaubt (private member). In der Umsetzung wird stattdessen direkt `registry.servers.set(...)` verwendet – die Klasse bekommt dafür einen statischen工厂-freien Weg: der Konstruktor bleibt privat, `open` nutzt die interne Map über eine private statische Hilfsmethode `hydrate`. Korrekte Fassung:

```ts
  static async open(dir: string): Promise<ServerRegistry> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'servers.json');
    const registry = new ServerRegistry(dir, file);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw) as RegistryFile;
      if (parsed && Array.isArray(parsed.servers)) {
        for (const server of parsed.servers) {
          if (server && typeof server.id === 'string') registry.servers.set(server.id, server);
        }
      }
    } catch {
      // Keine oder beschaedigte Datei: mit leerer Registry weiterarbeiten.
    }
    return registry;
  }
```

- [ ] **Step 4: Test laufen lassen**

Run: `cd nexuscore && npx vitest run tests/registry.test.ts`
Expected: PASS.

---

### Task 6: Treiber-Interface und Mock-Treiber

**Files:**
- Modify: `src/drivers/interface.ts`
- Modify: `src/drivers/mock-driver.ts`
- Test: `tests/mock-driver.test.ts`

**Interfaces:**
- Consumes: `ServerInstanceConfig`, `ServerState`, `ServerStats` aus `src/types.js`
- Produces:

```ts
export interface HostDriver {
  readonly name: string;
  initialize(): Promise<void>;
  registerServer(config: ServerInstanceConfig): Promise<ServerState>;
  startServer(serverId: string): Promise<ServerState>;
  stopServer(serverId: string): Promise<ServerState>;
  killServer(serverId: string): Promise<ServerState>;
  getServerState(serverId: string): Promise<ServerState>;
  getServerStats(serverId: string): Promise<ServerStats>;
  listServers(): Promise<ServerState[]>;
  /** Wird vom HTTP-Layer gesetzt: Treiber meldet hier Konsolenzeilen. */
  setLogSink(sink: (line: LogLine) => void): void;
  shutdown(): Promise<void>;
}
```

- [ ] **Step 1: Failing test `tests/mock-driver.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { MockDriver } from '../src/drivers/mock-driver.js';

const cfg = {
  id: 'm-1', name: 'Mock', game: 'test', executable: 'x.exe', args: [],
  workingDir: '.', ports: [{ name: 'game', hostPort: 25565, protocol: 'tcp' as const }],
};

describe('MockDriver', () => {
  it('durchlaeuft den Zustandsautomaten', async () => {
    const d = new MockDriver();
    await d.initialize();
    await d.registerServer(cfg);
    expect((await d.getServerState('m-1')).status).toBe('offline');
    expect((await d.startServer('m-1')).status).toBe('starting');
    await new Promise((r) => setTimeout(r, 1100));
    expect((await d.getServerState('m-1')).status).toBe('running');
    expect((await d.stopServer('m-1')).status).toBe('stopping');
  });

  it('liefert Statistiken', async () => {
    const d = new MockDriver();
    await d.initialize();
    await d.registerServer(cfg);
    await d.startServer('m-1');
    const stats = await d.getServerStats('m-1');
    expect(stats.serverId).toBe('m-1');
    expect(stats.memoryMb).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/mock-driver.test.ts`
Expected: FAIL (Interface/Verhalten fehlt).

- [ ] **Step 3: `src/drivers/interface.ts` schreiben** (Inhalt wie oben angegeben).

- [ ] **Step 4: `src/drivers/mock-driver.ts` neu schreiben** – Zustandsautomat, `setLogSink`, `getServerStats`, `shutdown`. Der Treiber darf keine `setTimeout`-Kette ohne Aufräumen hinterlassen; `shutdown()` löscht alle Timer.

- [ ] **Step 5: Test laufen lassen**

Run: `cd nexuscore && npx vitest run tests/mock-driver.test.ts`
Expected: PASS.

---

### Task 7: WindowsNativeDriver (echter Prozess)

**Files:**
- Modify: `src/drivers/windows-native.ts`
- Test: `tests/windows-driver.test.ts`

**Interfaces:**
- Consumes: `HostDriver` aus `./interface.js`, `LogLine` aus `../types.js`
- Produces: `class WindowsNativeDriver implements HostDriver`

- [ ] **Step 1: Failing test `tests/windows-driver.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { WindowsNativeDriver } from '../src/drivers/windows-native.js';

describe('WindowsNativeDriver', () => {
  it('startet einen echten Prozess und liefert Logs', async () => {
    const d = new WindowsNativeDriver();
    await d.initialize();
    const lines: string[] = [];
    d.setLogSink((l) => lines.push(l.line));
    await d.registerServer({
      id: 'w-1', name: 'Win', game: 'test',
      executable: process.execPath,
      args: ['-e', 'console.log("nexuscore-test"); setTimeout(()=>{},50)'],
      workingDir: process.cwd(),
      ports: [{ name: 'game', hostPort: 25570, protocol: 'tcp' }],
    });
    await d.startServer('w-1');
    await new Promise((r) => setTimeout(r, 800));
    expect(lines.join('\n')).toContain('nexuscore-test');
    await d.killServer('w-1');
    expect((await d.getServerState('w-1')).status).toBe('offline');
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/windows-driver.test.ts`
Expected: FAIL.

- [ ] **Step 3: `src/drivers/windows-native.ts` neu schreiben**

Pflichtpunkte der Umsetzung:
- `spawn(executable, args, { cwd, env, shell: false, windowsHide: true })`.
- stdout/stderr über einen Zeilen-Puffer (`StringDecoder` oder Split auf `\n`) zeilenweise an `logSink`.
- Zustandsautomat offline → starting → running → stopping → offline; `error` → status `error`.
- `stopServer`: `taskkill /PID <pid> /T` (kein `/F`); `killServer`: `taskkill /PID <pid> /T /F`.
- Unter Nicht-Windows-Systemen wird der Treiber nicht verwendet – `initialize()` warnt und der Treiber wirft bei `startServer` einen klaren Fehler.
- `getServerStats`: RAM über Working Set, CPU über Differenz der kumulierten Prozesszeit; unter Windows via `powershell -NoProfile -Command "Get-Process -Id <pid> | Select-Object WS,CPU | ConvertTo-Json"`, Fehler werden abgefangen und auf 0 gesetzt.
- `shutdown()` beendet alle laufenden Prozesse.

- [ ] **Step 4: Test laufen lassen**

Run: `cd nexuscore && npx vitest run tests/windows-driver.test.ts`
Expected: PASS.

---

### Task 8: DockerDriver (dockerode)

**Files:**
- Modify: `src/drivers/docker-driver.ts`
- Test: `tests/docker-driver.test.ts` (nur Logik ohne Docker-Daemon)

**Interfaces:**
- Produces: `class DockerDriver implements HostDriver`, statische Hilfsfunktion `buildCreateOptions(config: ServerInstanceConfig)` (exportiert, damit sie ohne Docker testbar ist).

- [ ] **Step 1: Failing test `tests/docker-driver.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { buildCreateOptions } from '../src/drivers/docker-driver.js';

describe('DockerDriver', () => {
  it('baut Ports und Env fuer docker run auf', () => {
    const opts = buildCreateOptions({
      id: 'd-1', name: 'Docker', game: 'test', executable: 'nginx', args: [],
      workingDir: '.', ports: [{ name: 'game', hostPort: 25580, containerPort: 80, protocol: 'tcp' }],
      env: { E: '1' },
    });
    expect(opts).toContain('25580:80/tcp');
    expect(opts).toContain('E=1');
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/docker-driver.test.ts`
Expected: FAIL.

- [ ] **Step 3: `src/drivers/docker-driver.ts` neu schreiben**

- `buildCreateOptions(config)` liefert ein Array von CLI-Argumenten für `docker run -d --name <id> ...`.
- `initialize()` prüft die Docker-Erreichbarkeit (`docker.listContainers()`), loggt die Verfügbarkeit und wirft **nicht** – der Daemon startet auch ohne Docker.
- `startServer` legt den Container an und startet ihn; `stopServer`/`killServer` nutzen `container.stop()`/`container.kill()`.
- Logs über `container.logs({ follow: true, stdout: true, stderr: true })`, Zeilenweise an `logSink`.
- `getServerStats` über `container.stats({ stream: false })`.
- `getServerState` liest `container.inspect()`.

- [ ] **Step 4: Test laufen lassen**

Run: `cd nexuscore && npx vitest run tests/docker-driver.test.ts`
Expected: PASS.

---

### Task 9: System-Monitor und HTTP-Schicht

**Files:**
- Modify: `src/system/monitor.ts`
- Modify: `src/http/server.ts`
- Create: `src/http/routes/info.ts`, `pair.ts`, `servers.ts`, `actions.ts`, `stats.ts`, `logs.ts`
- Test: `tests/routes.test.ts`

**Interfaces:**
- Consumes: `HostDriver`, `EventBus`, `config`, `validateRequestToken`, `validatePairingPin`, `tokenFingerprint`
- Produces: `createCoreServer(driver: HostDriver, bus: EventBus): Promise<FastifyInstance>`, `getSystemMetrics(): SystemMetrics`

- [ ] **Step 1: Failing test `tests/routes.test.ts`**

```ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MockDriver } from '../src/drivers/mock-driver.js';
import { EventBus } from '../src/protocol/events.js';
import { createCoreServer } from '../src/http/server.js';

let server: Awaited<ReturnType<typeof createCoreServer>>;

beforeAll(async () => {
  const driver = new MockDriver();
  await driver.initialize();
  server = await createCoreServer(driver, new EventBus());
  await server.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await server.close();
});

describe('HTTP-Routen', () => {
  it('/core/v1/info ist oeffentlich', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/info' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('geschuetzte Routen verlangen einen Token', async () => {
    const res = await server.inject({ method: 'GET', url: '/core/v1/servers' });
    expect(res.statusCode).toBe(401);
  });

  it('registriert, startet und liefert Stats', async () => {
    const token = process.env.NEXUSCORE_TOKEN ?? '';
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const reg = await server.inject({
      method: 'POST', url: '/core/v1/servers', headers,
      payload: { id: 'r-1', name: 'R', game: 'g', executable: 'x', args: [], workingDir: '.', ports: [] },
    });
    expect(reg.statusCode).toBe(201);
    const stats = await server.inject({ method: 'GET', url: '/core/v1/servers/r-1/stats', headers });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().serverId).toBe('r-1');
  });
});
```

- [ ] **Step 2: Test laufen lassen – muss fehlschlagen**

Run: `cd nexuscore && npx vitest run tests/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: `src/system/monitor.ts` neu schreiben** – RAM bevorzugt aus `/proc/meminfo` (`MemAvailable`), CPU als Differenz zweier Abtastungen (250 ms beim ersten Mal), Disk über `fs.statfs` auf dem Datenverzeichnis; Platzhalter 100/50 entfallen.

- [ ] **Step 4: `src/http/server.ts` neu schreiben**

Kernpunkte:
- `Fastify({ logger: false })`; Logger wird über `pino` aus `src/logger.ts` angebunden (`loggerInstance`).
- CORS nur registrieren, wenn `config.corsOrigins.length > 0`.
- `onRequest`-Hook: `GET /core/v1/info` und `POST /core/v1/pair` sind öffentlich, alles andere braucht `validateRequestToken`.
- WebSocket-Route `/core/v1/stream`: Token kommt aus `Authorization`-Header oder `?token=`; `?serverId=` filtert auf einen Server.
- Routen aus `src/http/routes/*.ts` registrieren.

- [ ] **Step 5: Routen-Dateien schreiben**

- `info.ts`: `{ status: 'ok', host, metrics, core: { version, runtime, tokenFingerprint } }` – **kein** Secret.
- `pair.ts`: prüft PIN, antwortet bei Erfolg mit `{ status: 'paired', host, tokenFingerprint, message }`; bei falscher PIN 400, bei erschöpften Versuchen 429.
- `servers.ts`: `GET` Liste, `POST` Registrierung (409 bei Duplikat, 400 bei ungültigem Body).
- `actions.ts`: `start`, `stop`, `kill` – 404 bei unbekannter ID.
- `stats.ts`: `GET /core/v1/servers/:id/stats` → `ServerStats`.
- `logs.ts`: `GET /core/v1/servers/:id/logs?limit=100` → `{ serverId, lines: LogLine[] }`.

- [ ] **Step 6: Test + Build**

Run: `cd nexuscore && npx vitest run tests/routes.test.ts && npm run build`
Expected: PASS und Build ohne Fehler.

---

### Task 10: Bootstrap und Shutdown

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `config`, `logger`, `createCoreServer`, `EventBus`, `ServerRegistry`, Treiber
- Produces: lauffähiger Daemon.

- [ ] **Step 1: `src/index.ts` neu schreiben**

Pflichtpunkte:
- Registry öffnen, gespeicherte Instanzen in den Treiber laden.
- `driver.setLogSink(...)` → EventBus (`console`-Event).
- Treiber-Aktionen emittieren `state`-Events.
- Beim Testmodus wird ein Testserver registriert (`test-minecraft-01`), damit `/core/v1/servers` nie leer ist.
- Metrik-Timer (5 s) emittiert `metrics`-Events; `unref()` damit der Prozess nicht am Timer hängt.
- `SIGINT`/`SIGTERM`: Timer löschen, `driver.shutdown()`, HTTP-Server schließen, Registry speichern, `process.exit(0)`.

- [ ] **Step 2: Build und manueller Start**

Run: `cd nexuscore && npm run build && node dist/index.js`
Expected: Banner, „Daemon lauscht erfolgreich auf: http://127.0.0.1:8443“, Kopplungs-PIN. Danach `Ctrl+C` → geordneter Shutdown.

---

### Task 11: Tests vervollständigen

**Files:**
- Create: `tests/security.test.ts` (Task 4), `tests/registry.test.ts` (Task 5), `tests/mock-driver.test.ts` (Task 6), `tests/windows-driver.test.ts` (Task 7), `tests/docker-driver.test.ts` (Task 8), `tests/routes.test.ts` (Task 9)
- Create: `tests/events.test.ts` (Task 3)

- [ ] **Step 1: Gesamten Testlauf**

Run: `cd nexuscore && npm test`
Expected: alle Tests grün.

- [ ] **Step 2: Typecheck**

Run: `cd nexuscore && npm run typecheck`
Expected: keine Fehler.

---

### Task 12: Windows-Skripte

**Files:**
- Modify: `start-nexuscore.bat`, `start-nexuscore.ps1`, `start-nexuscore.sh`
- Create: `scripts/smoke-test.ps1`

- [ ] **Step 1: `start-nexuscore.bat` neu schreiben**

```bat
@echo off
chcp 65001 > NUL
title NexusCore Host Daemon (Windows)
cd /d "%~dp0"

echo ========================================================
echo   NEXUSCORE HOST DAEMON - lokaler Windows-Testbetrieb
echo ========================================================
echo.

if not exist "node_modules" (
  echo Installiere Abhaengigkeiten...
  call npm install
)

echo Baue NexusCore...
call npm run build
if errorlevel 1 (
  echo BUILD FEHLGESCHLAGEN.
  pause
  exit /b 1
)

echo.
echo Starte Daemon (Beenden mit Strg+C)...
call npm start
```

- [ ] **Step 2: `start-nexuscore.ps1` analog schreiben** (Fehlerprüfung über `$LASTEXITCODE`).

- [ ] **Step 3: `start-nexuscore.sh` analog schreiben** (ohne `.bat`-Spezifika).

- [ ] **Step 4: `scripts/smoke-test.ps1` schreiben**

Das Skript: Daemon mit `node dist/index.js` starten (eigenes Fenster unterdrücken, Ausgabe in Logdatei), auf Port warten, dann mit `Invoke-RestMethod` und `Invoke-WebRequest` prüfen:
1. `GET /core/v1/info` → 200
2. `POST /core/v1/pair` mit falscher PIN → 400
3. `POST /core/v1/pair` mit richtiger PIN → 200
4. `GET /core/v1/servers` ohne Token → 401
5. `GET /core/v1/servers` mit Token → 200
6. `POST /core/v1/servers` → 201
7. `POST /core/v1/servers/:id/start` → 200
8. `GET /core/v1/servers/:id/stats` → 200
9. `GET /core/v1/servers/:id/logs` → 200 mit mindestens einer Zeile
10. `POST /core/v1/servers/:id/stop` → 200
11. WebSocket `/core/v1/stream?serverId=…` →/events empfangen (Node-Hilfsskript `scripts/ws-check.mjs`)

Ausgabe: je Schritt `PASS`/`FAIL` mit Beschreibung, am Ende eine Zusammenfassung und Exit-Code 0/1. Der Token wird aus `NEXUSCORE_TOKEN` gelesen; ist er leer, startet das Skript den Daemon selbst mit einem selbst gewählten Token.

- [ ] **Step 5: `scripts/ws-check.mjs` schreiben** – verbindet sich per `ws` auf den Stream, sammelt 10 s lang Nachrichten und beendet sich mit 0, wenn mindestens eine Konsole-Nachricht eintrifft.

- [ ] **Step 6: Smoke-Test ausführen**

Run: `powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1`
Expected: alle Schritte PASS, Exit-Code 0.

---

### Task 13: Rust-Teil und Dokumentation

**Files:**
- Move: `src/core/main.rs`, `src/core/mod.rs`, `src/core/server.rs` → `rust/src/`
- Move: `Cargo.toml` → `rust/Cargo.toml`; Delete: `Cargo.toml.new`
- Create: `rust/README.md`
- Create: `nexuscore/README.md`
- Modify: `CORE_PROTOCOL.md` (Encoding + Ist-Stand)
- Modify (Panel): `docs/ENTWICKLUNGSLOG.md`

- [ ] **Step 1: Rust-Dateien verschieben**

Run: `mkdir rust/src && move src/core/main.rs rust/src/main.rs && move src/core/mod.rs rust/src/lib.rs && move src/core/server.rs rust/src/server.rs && move Cargo.toml rust/Cargo.toml && del Cargo.toml.new`
Expected: Dateien liegen unter `rust/`, `src/core/` ist leer und wird entfernt.

- [ ] **Step 2: `rust/README.md` schreiben**

Inhalt: Zweck (Planungsstand für M2–M5 aus `docs/ARCHITEKTUR.md`), bekannte offene Punkte (doppelte Typdefinitionen, `crate::core`-Pfad im Bin-Crate, fehlender MSVC-Linker auf diesem Rechner), dass der Code bewusst nicht gebaut wird, und der Verweis auf die Architektur-Dokumentation.

- [ ] **Step 3: `CORE_PROTOCOL.md` reparieren und aktualisieren**

- Datei als **UTF-8 ohne BOM** neu schreiben (aktuell: Mojibake durch doppelte Kodierung).
- Endpunkte um `GET /core/v1/servers/:id/logs` ergänzen, `stats` mit Antwortformat beschreiben.
- Sektion „Windows-Stopp-Semantik“: kein SIGTERM unter Windows, `taskkill /T` bzw. `/T /F`.
- Meilensteine auf den Ist-Stand aktualisieren (M1 = lauffähiger Prototyp abgeschlossen).

- [ ] **Step 4: `nexuscore/README.md` schreiben**

Kurz: Zweck, Voraussetzungen (Node 22+), Schnellstart (`npm install && npm run build && npm start`), Test (`npm test`), Windows-Test (`scripts/smoke-test.ps1`), Umgebungsvariablen, Protokollübersicht, Hinweis auf den Rust-Planungsteil.

- [ ] **Step 5: `docs/ENTWICKLUNGSLOG.md` ergänzen**

Eintrag im bestehenden Format: `| HH:MM | 0.26.0: NexusCore-Prototyp ... | Dateiliste |`.

- [ ] **Step 6: Panel-Build nicht beeinträchtigen**

Run: `cd "Gameserver Interface" && npm run typecheck`
Expected: keine neuen Fehler (die Panel-Dateien wurden nicht verändert).

---

### Task 14: Verifikation

- [ ] **Step 1: Build**

Run: `cd nexuscore && npm run build`
Expected: Erfolg.

- [ ] **Step 2: Tests**

Run: `cd nexuscore && npm test`
Expected: alle grün.

- [ ] **Step 3: Live-Durchlauf**

Run: `cd nexuscore && powershell -ExecutionPolicy Bypass -File scripts/smoke-test.ps1`
Expected: alle Schritte PASS, Exit-Code 0.

- [ ] **Step 4: Persistenz-Check**

Daemon starten, einen Server registrieren, Daemon beenden, neu starten, `GET /core/v1/servers` muss den Server noch zeigen.

- [ ] **Step 5: Git-Status prüfen**

Run: `cd "Gameserver Interface" && git status --short`
Expected: nur die beabsichtigten Änderungen; **kein Commit** ohne Freigabe des Nutzers.
