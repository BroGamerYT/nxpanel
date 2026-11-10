# NexusCore (TypeScript) – Design-Spezifikation

**Datum:** 09.11.2026
**Status:** Freigegeben
**Bereich:** `nexuscore/` im Panel-Repo „Gameserver Interface“ (NexusPanel 0.25.0)

---

## 1. Ziel

`nexuscore/` ist heute ein Prototyp: ein TypeScript/Fastify-Daemon mit drei Treibern und
einem winzigen, defekten Rust-Skelett. Der Kern soll zu einem **lauffähigen, lokal testbaren
Host-Daemon** werden, der auf einem Windows-Rechner ohne Docker-Desktop, VM oder Panel
einzeln betrieben und geprüft werden kann.

Nicht-Ziele dieses Durchgangs: mTLS, Zertifikats-PKI, Job Objects, Benutzer-Trennung,
Firewall-Regeln, Dateien/Backups. Diese Themen gehören zu M2–M5 in `docs/ARCHITEKTUR.md`.

Der Rust-Prototyp bleibt als Planung liegen (siehe Abschnitt 8).

## 2. Ausgangslage (geprüfte Befunde)

| # | Befund | Ort |
| --- | --- | --- |
| B1 | TypeScript-Build schlägt fehl (4 Fehler) | `src/http/server.ts` Z. 73, 110, 114, 121 |
| B2 | `connection.socket` existiert bei `@fastify/websocket` v11 nicht mehr | `src/http/server.ts` |
| B3 | `req.body` ist `unknown` und wird ungeprüft an den Treiber gegeben | `src/http/server.ts` Z. 73 |
| B4 | `GET /core/v1/servers/:id/stats` ist dokumentiert, aber nicht implementiert | `CORE_PROTOCOL.md` §2 |
| B5 | Docker-Treiber ist ein reiner Stub ohne Docker-Zugriff | `src/drivers/docker-driver.ts` |
| B6 | WebSocket-Stream liefert nur Demo-Metriken, keine echten Konsolenlogs | `src/http/server.ts` Z. 109-124 |
| B7 | Im Testmodus gilt jeder Request **ohne** Token als gültig | `src/protocol/security.ts` Z. 9 |
| B8 | CORS erlaubt alle Herkünfte (`origin: true`) | `src/http/server.ts` Z. 14 |
| B9 | Default-PIN `123456` und Default-Token im Klartext; `/pair` gibt den Secret-Token zurück | `src/config/index.ts`, `src/http/server.ts` Z. 59 |
| B10 | Registry existiert nur im Arbeitsspeicher, Neustart verliert alles | alle Treiber |
| B11 | `diskTotalGb`/`diskFreeGb` sind Platzhalter (100/50) | `src/system/monitor.ts` Z. 28-29 |
| B12 | `spawn` mit `shell: true` (Cmd-Injektion bei Argumenten) | `src/drivers/windows-native.ts` Z. 45 |
| B13 | `child.kill('SIGTERM')` bricht unter Windows den Prozess hart ab | `src/drivers/windows-native.ts` Z. 88 |
| B14 | `CORE_PROTOCOL.md` ist doppelt UTF-8-kodiert (Mojibake) | `CORE_PROTOCOL.md` Z. 1 ff. |
| B15 | Rust-Skelett: `ProcessConfig`/`ServerStatus` doppelt definiert, `crate::core` existiert im Bin-Crate nicht, `Cargo.toml.new` liegt herum, ohne MSVC-Build-Tools nicht baubar | `src/core/*.rs`, `Cargo.toml.new` |

## 3. Architektur

```
nexuscore/
├── src/
│   ├── index.ts                Bootstrap: Config → Treiber → HTTP → Shutdown
│   ├── types.ts                Protokoll-Typen (Host, Server, Events)
│   ├── logger.ts               pino-Logger mit Redaction
│   ├── config/index.ts         zod-Config (Startabbruch bei ungültiger Config)
│   ├── protocol/
│   │   ├── security.ts         Token/PIN, zeit-sicherer Vergleich, Rate-Limit
│   │   └── events.ts           Event-Bus (console | state | metrics)
│   ├── store/registry.ts       JSON-Persistenz der Server-Registry
│   ├── system/monitor.ts       echte CPU/RAM/Disk-Messung
│   ├── drivers/
│   │   ├── interface.ts        HostDriver-Trait
│   │   ├── windows-native.ts   echter Windows-Prozess-Runner
│   │   ├── docker-driver.ts    Container-Steuerung über dockerode
│   │   └── mock-driver.ts      risikofreier Testmodus
│   └── http/
│       ├── server.ts           Fastify-App, Hooks, Routenregistrierung
│       └── routes/             info · pair · servers · actions · stats
├── tests/                      Vitest
├── data/                       Registry + Logs (Laufzeitdaten, nicht im Git)
├── rust/                       Rust-Prototyp als Planung (siehe §8)
└── scripts/smoke-test.ps1      End-to-End-Prüfung auf Windows
```

### 3.1 Abhängigkeiten

Neu in `nexuscore/package.json`: `zod`, `pino`, `pino-pretty`, `dockerode`.
Dev: `vitest`, `@types/dockerode`, `eslint`, `typescript-eslint`.
Der Panel nutzt dieselben Pakete, gleiche Versionen – Austauschbarkeit bleibt erhalten.

### 3.2 Konfiguration (`zod`)

Muster aus `src/config.ts` des Panels: ungültige Config ⇒ Startabbruch mit lesbarer Meldung.
Neu bzw. geändert:

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `NEXUSCORE_MODE` | `test` | `test` \| `production` |
| `NEXUSCORE_PORT` | `8443` | HTTP-Port |
| `NEXUSCORE_HOST` | `127.0.0.1` | standardmäßig nur lokal erreichbar |
| `NEXUSCORE_RUNTIME` | plattformabhängig | `windows-native` \| `docker` \| `mock` |
| `NEXUSCORE_DATA_DIR` | `<Projekt>/data` | Registry, Logs, später Zertifikate |
| `NEXUSCORE_TOKEN` | leer ⇒ Token muss gesetzt sein | Bearer-Token für alle geschützten Routen |
| `NEXUSCORE_PAIRING_PIN` | leer ⇒ PIN wird beim Start zufällig erzeugt und ausgegeben | Kopplung |
| `NEXUSCORE_CORS_ORIGINS` | leer ⇒ CORS aus | erlaubte Herkünfte, kommagetrennt |
| `NEXUSCORE_LOG_LEVEL` | `info` | Log-Level |

Der Token wird **nicht** mehr über `/pair` im Klartext ausgegeben, sondern nur der
Fingerabdruck (SHA-256, gekürzt) – der Panel-Seite bleibt so der Weg über den
Admin-Kanal. In `production` sind Token und PIN Pflicht, sonst startet der Daemon nicht.

### 3.3 Event-Bus (`src/protocol/events.ts`)

Einzige Wahrheit für alle Ereignisse. Typen:

```ts
type CoreEvent =
  | { type: 'console'; serverId: string; line: string; stream: 'stdout'|'stderr'; ts: string }
  | { type: 'state';    serverId: string; state: ServerState; ts: string }
  | { type: 'metrics';  host: SystemMetrics; ts: string };
```

Der Bus ist ein `EventEmitter` mit Ringpuffer (letzte 500 Ereignisse je Server),
damit ein spät verbindender WS-Client die letzten Zeilen bekommt.

### 3.4 Treiber

**Interface** (`src/drivers/interface.ts`) wird um `getServerStats(id)` und
`readLog(serverId, since)` erweitert; `onLog` wird durch den Event-Bus ersetzt
(Treiber emittieren, das HTTP-Layer verteilt).

**WindowsNativeDriver** – echter Runner:
- `spawn` **ohne** `shell: true`; Kommandozeilen-Argumente werden korrekt escaped.
- stdout/stderr werden zeilenweise gepuffert und als `console`-Event emittiert.
- Zustandsautomat `offline → starting → running → stopping → offline`;
  `close`/`error` setzen den Zustand zurück und melden den Exit-Code.
- `stopServer` nutzt `taskkill /PID <pid> /T` (Prozessbaum), `killServer` zusätzlich `/F`.
  Hinweis: Windows kennt kein SIGTERM – ein „sanfter“ Stopp ist derzeit nicht möglich,
  das wird im Protokoll-Dokument ausdrücklich vermerkt.
- Der Server läuft ohne Job Object; RAM-/CPU-Limits werden als Konfiguration
  angenommen, aber erst in M3 technisch erzwungen (dokumentiert, nicht vorgetäuscht).

**DockerDriver** – echte Steuerung über `dockerode` (dieselbe Bibliothek wie im Panel):
`docker run -d` mit Ports, Env, Volume-Pfade; `docker stop` / `docker kill`;
Logs über `docker logs -f`; Stats über `docker stats --no-stream`.
Der Treiber meldet sich selbst als nicht verfügbar, wenn kein Docker-Daemon erreichbar ist.

**MockDriver** – bleibt, aber mit echtem Zustandsautomat und simulierten
CPU-/RAM-Werten; wird für Tests und `--runtime mock` genutzt.

### 3.5 Persistenz (`src/store/registry.ts`)

- Ablage: `<data-dir>/servers.json` (Standard `nexuscore/data/`).
- Schema: `{ version: 1, servers: ServerInstanceConfig[] }`.
- Schreibzugriffe atomar (Temp-Datei + Rename), damit ein Absturz keine halbe Datei hinterlässt.
- Beim Start wird die Registry geladen; die Treiber registrieren die Instanzen neu.
- Duplikat-IDs werden beim Registrieren abgelehnt (HTTP 409).

### 3.6 HTTP-Schicht

Öffentlich (ohne Token): `GET /core/v1/info`, `POST /core/v1/pair`.
Alles andere: `Authorization: Bearer <token>`; Vergleich zeit-sicher über
`crypto.timingSafeEqual`. `/pair` ist auf 5 Versuche pro 10 Minuten begrenzt
(PIN wird nach erfolgreicher Kopplung verbraucht und neu erzeugt).

Routen (unverändert zum Protokoll, `stats` neu implementiert):

| Methode | Endpunkt | Auth |
| --- | --- | --- |
| GET | `/core/v1/info` | nein |
| POST | `/core/v1/pair` | nein (Rate-Limit) |
| GET | `/core/v1/servers` | ja |
| POST | `/core/v1/servers` | ja |
| POST | `/core/v1/servers/:id/start` | ja |
| POST | `/core/v1/servers/:id/stop` | ja |
| POST | `/core/v1/servers/:id/kill` | ja |
| GET | `/core/v1/servers/:id/stats` | ja |
| GET | `/core/v1/servers/:id/logs` | ja (neu: Log-Ringpuffer) |
| WS | `/core/v1/stream?serverId=<id>` | ja (Token per Query oder Header) |

Der WebSocket-Stream sendet `console`-, `state`- und `metrics`-Events.
Bei `?serverId=` werden nur die Ereignisse dieses Servers gesendet, sonst alle.

### 3.7 System-Monitor

- RAM: `os.totalmem()`/`os.freemem()`, unter Linux bevorzugt `MemAvailable` aus `/proc/meminfo`
  (Muster aus `src/host.ts` des Panels).
- CPU: Differenz zweier `os.cpus()`-Abtastungen; erster Aufruf misst 250 ms selbst.
- Disk: `fs.statfs` auf dem Datenverzeichnis (Platzhalter 100/50 entfällt).
- Pro Instanz (`getServerStats`): RAM aus Working Set, CPU aus Differenz der kumulierten
  Prozesszeit – via PowerShell `Get-Process`, mit Mock-Fallback.

### 3.8 Fehlerbehandlung

- Alle Routen validieren ihre Eingaben; Fehler kommen als
  `{ error: <kurz>, message: <detail> }` mit passendem Statuscode (400/401/404/409/429/500).
- Unerwartete Fehler werden geloggt (ohne Token/PIN) und als 500 beantwortet.
- Der Prozess beendet sich bei `SIGINT`/`SIGTERM` geordnet: laufende Instanzen stoppen,
  Registry schreiben, HTTP-Server schließen.

## 4. Windows-Testbarkeit

1. `start-nexuscore.bat` / `.ps1`: installiert bei Bedarf, baut (`npm run build`), startet den Daemon.
   Der alte `.bat` wird ersetzt (ruft bisher nur `npm run dev` auf).
2. `scripts/smoke-test.ps1`: startet den Daemon (oder nutzt einen laufenden), ruft
   `/info`, `/pair`, `/servers`, Registrierung, Start, Stats, Logs, Stop und den
   WebSocket-Stream auf und meldet je Schritt PASS/FAIL. Am Ende wird eine Zusammenfassung
   ausgegeben; Exit-Code ≠ 0 bei Fehlern.
3. `npm run dev` bleibt für die Entwicklung erhalten, `npm start` startet den Build.

## 5. Tests (Vitest)

| Datei | Inhalt |
| --- | --- |
| `tests/config.test.ts` | Config-Validierung, Defaults, Abbruch bei ungültiger Config |
| `tests/security.test.ts` | Token-Pflicht, zeit-sicherer Vergleich, PIN-Rate-Limit, `/pair`-Verhalten |
| `tests/routes.test.ts` | alle Routen mit MockDriver: Statuscodes, Fehlerfälle, 401 ohne Token |
| `tests/registry.test.ts` | Persistenz: anlegen, laden, doppelte ID, beschädigte Datei |
| `tests/events.test.ts` | Event-Bus: Ringpuffer, Filter, Reihenfolge |
| `tests/windows-driver.test.ts` | Zustandsautomat des WindowsNativeDriver (echter `cmd.exe`-Prozess, lauffähig auf Windows) |

Ziel: `npm test` läuft grün ohne Netzwerk und ohne Docker.

## 6. Dokumentation

- `CORE_PROTOCOL.md`: Mojibake reparieren (B14), Endpunkte um `logs` erweitern,
  Windows-Stopp-Semantik und Stats-Format beschreiben, Meilensteine aktualisieren.
- `nexuscore/README.md`: kurze Anleitung für lokalen Start und Test auf Windows.
- `docs/ENTWICKLUNGSLOG.md` (Panel): Eintrag im bestehenden Format
  (Zeit | Version | Beschreibung | Dateien).
- `nexuscore/rust/README.md`: Hinweis, dass der Rust-Teil die Planung aus
  `docs/ARCHITEKTUR.md` (M2–M5) vorbereitet und noch nicht baubar ist
  (fehlende MSVC Build Tools).

## 7. Reihenfolge der Umsetzung

1. Projekt-Setup (Dependencies, `tsconfig` strict, `.env.example`, `vitest.config.ts`).
2. Grundbausteine: `types.ts`, `config`, `logger`, `security`, `events`.
3. `store/registry.ts`.
4. Treiber (`interface`, `mock`, `windows-native`, `docker`).
5. `system/monitor.ts`.
6. HTTP-Schicht (`server.ts` + Routen).
7. `index.ts` (Bootstrap inkl. Shutdown).
8. Tests.
9. Windows-Skripte und Doku.
10. Verifikation: `npm run build`, `npm test`, Daemon starten, `smoke-test.ps1`.

## 8. Rust-Teil

`src/core/*.rs` wird nach `nexuscore/rust/` verschoben, `Cargo.toml`/`Cargo.toml.new`
werden dort abgelegt bzw. entfernt. Die Dateien bleiben **unverändert inhaltlich**
(Planungsstand), bekommen aber eine Kopfzeile, die auf `docs/ARCHITEKTUR.md` und die
fehlende Build-Toolchain hinweist. `Cargo.toml.new` wird gelöscht.

Bekannte, bewusst nicht behobene Fehler des Rust-Prototyps (B15):
doppelte Typdefinitionen, `crate::core`-Pfad im Bin-Crate, fehlender Linker.
Sie werden in `rust/README.md` benannt, nicht kaschiert.

## 9. Abnahmekriterien

- [ ] `npm run build` in `nexuscore/` läuft fehlerfrei (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- [ ] `npm test` in `nexuscore/` ist vollständig grün.
- [ ] `start-nexuscore.bat` startet den Daemon auf Windows ohne weitere Handgriffe.
- [ ] `scripts/smoke-test.ps1` meldet für jeden Endpunkt PASS und endet mit Exit-Code 0.
- [ ] Ohne Token liefern alle geschützten Routen 401.
- [ ] Registrierte Instanzen überleben einen Daemon-Neustart.
- [ ] Der WebSocket-Stream liefert echte Konsolenausgaben des gestarteten Testprozesses.
- [ ] `CORE_PROTOCOL.md` ist UTF-8-korrekt und beschreibt den Ist-Stand.
- [ ] Rust-Teil liegt unter `nexuscore/rust/` mit Planungs-Hinweis; `Cargo.toml.new` entfernt.
