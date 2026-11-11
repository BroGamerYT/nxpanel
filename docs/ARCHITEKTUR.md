# NexusPanel – Gesamtarchitektur

Stand: 11.11.2026 · Status: **Zielbild**. Das Panel (Abschnitt 3) gibt es. NexusCore gibt es als lauffähigen Prototyp in TypeScript (`nexuscore/`). Apps, Installer und NexusPanel OS sind geplant.

> **Entscheidung 11.11.2026: NexusCore bleibt TypeScript.** Panel, Oberfläche und Core teilen sich Sprache, Werkzeuge und die Egg-Logik. Rust kommt nur dort zum Einsatz, wo Node nicht hinreicht: als kleines Hilfsprogramm für Windows (Job Objects, Dienst, Tray) und als Hülle der Tauri-Apps. Der frühere Rust-Prototyp unter `nexuscore/rust/` ist entfernt.
Ergänzt `docs/KONZEPT-APPS.md` (Entscheidungen und Begründungen). Die Aufgaben stehen in `docs/TODO.md`.

---

## 1. Überblick

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Bedienung                                                                    │
│  ┌────────────┐  ┌─────────────────────────┐  ┌──────────────────────────┐   │
│  │ Browser    │  │ Desktop-App (Tauri)     │  │ Android-App (Tauri)      │   │
│  │ (React-UI) │  │ Win / macOS / Linux     │  │ APK                      │   │
│  └─────┬──────┘  └───────────┬─────────────┘  └────────────┬─────────────┘   │
└────────┼─────────────────────┼─────────────────────────────┼─────────────────┘
         │ HTTPS + WebSocket (Bearer-/Geräte-Token)          │
┌────────┴──────────────────────────────────────────────────┴─────────────────┐
│  NexusPanel – Steuerzentrale (TypeScript, Fastify, PostgreSQL, Redis)         │
│  Nutzer · Rechte · Eggs · Modpacks · Audit · Zeitpläne · Benachrichtigungen    │
│  Host-Schicht:  "lokal" (heutiger Docker-Code)  |  "NexusCore" (neu)          │
└───────────────┬──────────────────────────────────────────────┬──────────────┘
                │ Token (Ziel: mTLS), JSON + WebSocket (/core/v1) │
     ┌──────────┴──────────┐   ┌───────────────────────┐   ┌───┴───────────────────┐
     │ NexusCore (TS)      │   │ NexusCore (TS)        │   │ NexusCore (TS)        │
     │ Linux-VM (Proxmox)  │   │ Windows-PC / Server   │   │ NexusPanel OS / VPS   │
     │ Laufzeit: Docker    │   │ Laufzeit: Windows     │   │ Laufzeit: Podman      │
     │                     │   │ nativ + Docker (WSL2) │   │                       │
     └──────────┬──────────┘   └──────────┬────────────┘   └──────────┬────────────┘
                │                          │                           │
          Gameserver                 Gameserver                  Gameserver
```

**Grundsätze:**

1. **Das Panel entscheidet, der Kern führt aus.** Das Panel prüft Rechte, Grenzen und Budgets. Der Kern prüft nur noch, ob der Auftrag echt vom gekoppelten Panel kommt.
2. **Ein Kern, mehrere Laufzeiten.** Docker, Podman und Windows nativ sitzen hinter derselben Schnittstelle. Für das Panel sieht jeder Server gleich aus.
3. **Kein Stillstand beim Umbau.** Neue Teile kommen neben die alten. Der heutige Weg bleibt Rückfall, bis der neue erprobt ist.
4. **Sicher ohne Aufwand für den Nutzer.** Zertifikate, Geheimnisse und Updates regelt das System. Der Nutzer gibt einmal einen Kopplungscode ein.

---

## 2. Bausteine und Sprachen

| Baustein | Sprache | Läuft auf | Repo-Ordner | Status |
| --- | --- | --- | --- | --- |
| NexusPanel (Server) | TypeScript (Node 22, Fastify 5) | Linux-Container | `src/` | vorhanden |
| Weboberfläche | TypeScript (React 19, Vite, Tailwind) | Browser, App | `web/` | vorhanden |
| NexusCore | TypeScript (Node 22, Fastify 5) | Windows, Linux, macOS | `nexuscore/` | Prototyp vorhanden |
| Windows-Hilfsprogramm (Job Objects, Dienst, Tray) | Rust | Windows | `nexuscore/helper/` | geplant |
| `nxctl` (Kommandozeile) | TypeScript | wie NexusCore | `nexuscore/src/cli/` | geplant |
| Desktop-/Android-App | Rust (Tauri 2) + `web/` | Win/macOS/Linux/Android | `apps/client/` | neu |
| Server-Setup | Tauri (Rust-Hülle + `web/`) | Windows | `apps/server-setup/` | neu |
| Linux-Installer | Bash | Debian/Ubuntu/Proxmox | `install/` | vorhanden, wird ausgebaut |
| NexusPanel OS | mkosi/live-build-Rezept | x86_64 | `os/` | neu |
| Eggs | JSON | – | `eggs/` | vorhanden, wird erweitert |

```
Gameserver Interface/
├── src/                 Panel (TypeScript)
├── web/                 Oberfläche (React)
├── eggs/                Spielvorlagen
├── migrations/          Datenbank
├── nexuscore/           NexusCore (TypeScript)
│   ├── src/drivers/     Laufzeiten: windows-native, docker, mock (Schnittstelle HostDriver)
│   ├── src/http/        Routen /core/v1 (Panel) und /api/v1 (Standalone-Oberfläche)
│   ├── src/protocol/    Ereignisse, Kopplung, gemeinsame Typen
│   ├── src/store/       Registry der Instanzen
│   ├── src/system/      Auslastung des Hosts
│   ├── tests/           Vitest
│   └── helper/          ── geplant: kleines Rust-Programm für Job Objects, Dienst, Tray ──
├── apps/
│   ├── client/          Tauri-App (nutzt web/ als Oberfläche)
│   └── server-setup/    Windows-Installer (bettet nexuscore ein)
├── os/                  NexusPanel-OS-Rezept
├── install/             Linux-/Proxmox-Skripte
└── docs/                Konzept, Architektur, TODO, Log
```

---

## 3. NexusPanel – die Steuerzentrale (heute)

**Was das Panel kann:**
- Anmeldung mit 2FA, Rollen (admin, moderator, user), feine Rechte je Server (Mitnutzer), Budgets je Nutzer
- Eggs mit Variablen, Konfigurationsdateien, Import aus Backups, Titelbildern
- Modpacks (CurseForge, Modrinth, FTB) mit Update und Backup
- Konsole, Dateimanager, Backups (lokal + NAS), Zeitpläne, Revisionen
- Spieler-Ansicht, Bans, MOTD, TPS
- Audit-Log, Zeitachse, Benachrichtigungen, Hilfe-Seiten, Testlauf für Eggs

**Was neu dazukommt:**
1. **Host-Schicht** (`src/hosts/`): Jeder Server gehört zu einem Host. Ein Host hat einen Typ:
   - `local`: der heutige Code im Panel-Container, spricht direkt mit Docker
   - `core`: ein gekoppelter NexusCore
2. **Tabelle `hosts`** mit Name, Typ, Adresse, Zertifikats-Fingerabdruck, Laufzeiten, Ressourcen und Status. Dazu `servers.host_id` und `servers.runtime`.
3. **Kopplung und Zertifikate:** Das Panel ist die Zertifizierungsstelle (CA) für seine Kerne (siehe 6).
4. **Auftragswarteschlange** (Redis) für lange Aufgaben: Installation, Backup, Update. Mit Fortschritt, Abbruch und Wiederaufnahme nach einem Neustart.

```ts
// src/hosts/host.ts – was jeder Host-Typ können muss
export interface Host {
  create(spec: ServerSpec): Promise<void>;
  remove(serverId: string, opts: { keepData: boolean }): Promise<void>;
  install(serverId: string, onLog: (l: string) => void): Promise<InstallResult>;
  power(serverId: string, action: 'start' | 'stop' | 'restart' | 'kill'): Promise<void>;
  console(serverId: string): AsyncIterable<ConsoleLine>;
  send(serverId: string, line: string): Promise<void>;
  stats(serverId: string): AsyncIterable<Stats>;
  files: FileApi;      // list, read, write, upload, download, archive
  backups: BackupApi;  // create, list, restore, delete, verify
  query(serverId: string): Promise<GameStatus>;
}
```

---

## 4. NexusCore im Detail

### 4.1 Aufbau als Prozess

Zielbild der Module. Mit `(vorhanden)` markierte Teile gibt es heute unter `nexuscore/src/`.

```
nexuscored (Node 22, als einzelne .exe über Node SEA)
├── http       Fastify-Server, Routen /core/v1/... (vorhanden), Ziel: nur mTLS
├── drivers    Schnittstelle HostDriver + windows-native | docker | mock (vorhanden), podman (geplant)
├── protocol   Ereignisstrom, Kopplung per PIN und Token (vorhanden)
├── store      SQLite core.db: Instanzen, Einstellungen, Audit, Aufgaben (vorhanden)
├── system     CPU, RAM und Platte des Hosts (vorhanden)
├── install    Installation als Aufgabe mit Fortschritt: Paper + Java (vorhanden), SteamCMD (geplant)
├── steam      SteamCMD verwalten (laden, aktualisieren, Login-Sitzungen)
├── fs         sichere Dateizugriffe (Wurzel je Server, keine Ausbrüche über ".." oder Links)
├── backup     tar + zstd, SHA-256, Ziele: lokal, SMB/NAS, S3, SFTP
├── query      Minecraft-Ping, A2S (Valve), RCON (Source/Minecraft), Palworld-REST
├── ports      Vergabe-Prüfung, Firewall-Regeln (Windows Firewall / nftables)
├── update     Selbst-Update, signiert, mit Rückfall auf die alte Version
└── audit      lokales, nur anhängendes Protokoll jeder ausgeführten Aktion
```

**Bibliotheken (Auswahl):**

| Zweck | Paket |
| --- | --- |
| HTTP-Schnittstelle und WebSocket | fastify, @fastify/websocket |
| Docker/Podman | dockerode |
| Eingabeprüfung | zod |
| Protokollierung | pino |
| lokale Datenbank | `node:sqlite` (in Node eingebaut, ab 22.13) |
| Backup-Archive | tar und zstd des Systems, wie im Panel |
| Prüfsummen, Signaturen | `node:crypto` (SHA-256, Ed25519) |
| Egg-Logik | gemeinsam mit dem Panel (`src/eggs/`) |
| Windows-Schnittstellen (Job Objects, Dienst, Tray) | kleines Rust-Hilfsprogramm, vom Core als Prozess aufgerufen |

### 4.2 Die Laufzeit-Schnittstelle

Heute (`nexuscore/src/drivers/interface.ts`):

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
  sendCommand?(serverId: string, command: string): Promise<void>;
  setLogSink(sink: LogSink): void;
  shutdown(): Promise<void>;
}
```

Noch offen gegenüber dem Zielbild: Entfernen mit `keepData`, Stoppen mit Befehl und Frist aus dem Egg (`StopSpec`), harte Grenzen für RAM, CPU und I/O (`setLimits`) sowie das Bereit-Muster (`ReadyCheck`).
### 4.3 Laufzeit „Docker“ und „Podman“

- Übernimmt, was heute `src/docker/client.ts` macht:
  - Image ziehen, Container anlegen (Limits, Ports, `tmp`-Regel, Labels)
  - Spielnetz, Konsole über attach, Statistiken über den Stats-Stream
- **Podman:** derselbe Code mit anderem Socket (`/run/user/<uid>/podman/podman.sock`, rootless) plus Unterschiede:
  - Netz über pasta
  - Limits nur bei freigegebenen cgroup-v2-Controllern; der Kern prüft das beim Start und meldet fehlende Freigaben
- Interne Ports (RCON) bekommen keine Host-Freigabe. Der Kern spricht sie über das Container-Netz an.

### 4.4 Laufzeit „Windows nativ“

Pro Server legt der Kern beim Anlegen an:

| Schutz | Umsetzung |
| --- | --- |
| Eigener Benutzer | lokales Konto `nxp-<id>` ohne Anmelderecht (Richtlinie „Lokal anmelden verweigern“), zufälliges Passwort im geschützten Speicher des Kerns |
| Ordnerrechte | `D:\NexusCore\servers\<id>\`: Vollzugriff nur für `nxp-<id>` und den Kern, Vererbung von oben aus |
| Job Object | `JOB_OBJECT_LIMIT_PROCESS_MEMORY` bzw. `JOB_MEMORY` (RAM), `CPU_RATE_CONTROL` (harter CPU-Anteil), `ACTIVE_PROCESS` (Anzahl), `KILL_ON_JOB_CLOSE` (keine Waisen) |
| Start | `CreateProcessAsUser` mit dem Token des Server-Benutzers, Prozess sofort in den Job, stdin/stdout/stderr über Pipes |
| Netzwerk | Windows-Firewall: eingehende Regel nur für die `.exe` des Servers und genau seine Ports (TCP/UDP), ausgehend erlaubt |
| Priorität | normale Prozesspriorität, I/O-Priorität niedrig für Hintergrund-Updates |

**Konsole:**
- Zeilen von stdout/stderr gehen als Strom ans Panel.
- Befehle gehen über stdin.
- Spiele ohne stdin-Konsole (ARK, Palworld) werden über RCON bzw. REST bedient, so wie heute.

**Stoppen:**
1. Stopp-Befehl aus dem Egg (z. B. `stop`, `exit`, `SaveWorld` + `DoExit` über RCON)
2. Nach Ablauf der Frist `CTRL_BREAK`
3. Danach den Job beenden

**Abhängigkeiten:** Der Kern prüft vor dem ersten Start, was das Egg verlangt (`windows.requires`: `vcredist2015-2022`, `directx-june2010`, `dotnet8`), und installiert fehlende Pakete einmalig mit Protokoll.

### 4.5 Spiele installieren

| Weg | Wann | Ablauf |
| --- | --- | --- |
| SteamCMD | die meisten Spiele | `steamcmd +force_install_dir <dir> +login anonymous +app_update <id> validate +quit`, für Spiele mit Login über die Steam-Konten im Panel (vorhanden) |
| Image | Docker/Podman mit fertigem Image (itzg, lloesche …) | Image ziehen, das Image installiert beim Start selbst |
| Installationsskript | Eggs mit `install_script` | Linux: Hilfscontainer wie heute. Windows: PowerShell-Skript als Server-Benutzer mit Zeitlimit. |
| Download | z. B. Minecraft-JAR, Velocity | HTTPS mit Prüfsumme aus dem Egg |

Fortschritt („Lade 42 %“, „Prüfe Dateien“) geht als Job-Ereignis ans Panel. Abbruch ist jederzeit möglich, ein halber Download wird beim nächsten Versuch fortgesetzt.

### 4.6 Dateien, Backups, Statistiken, Abfragen

- **Dateien:**
  - Jede Anfrage wird gegen die Server-Wurzel aufgelöst (`canonicalize`). Symlinks, die hinausführen, werden abgelehnt.
  - Uploads werden gestreamt, mit Größenlimit.
  - Revisionen (wie heute im Panel) übernimmt der Kern.
- **Backups:**
  - tar + zstd (Stufe 3, mehrere Threads), SHA-256 über die fertige Datei, Manifest mit Dateiliste und Spielversion
  - Prüfung: Archiv lesbar, Pflichtdateien des Spiels vorhanden
  - Ziele: lokal, SMB (dein UGREEN-NAS), S3, SFTP (Hetzner Storage Box)
  - Laufende Server: optional „Speichern und kurz anhalten“ über den Befehl aus dem Egg (`save-off`/`save-all` bzw. `SaveWorld`)
- **Statistiken:** alle 10 s CPU, RAM, Netz rx/tx und Plattenbelegung (alle 5 min). Das Panel zeigt sie wie heute, die Quelle ist der Kern.
- **Abfragen:** Minecraft-Ping und RCON, A2S, Palworld-REST, ARK-RCON. Ergebnisse werden 15 s zwischengespeichert, damit 20 offene Browser-Tabs nicht 20 Abfragen auslösen.

### 4.7 Lokale Daten des Kerns

```
Windows:  C:\ProgramData\NexusCore\   (Konfiguration, core.db, Zertifikate, Logs)
          D:\NexusCore\servers\<id>\   (Spieldaten, Laufwerk wählbar)
          D:\NexusCore\backups\
Linux:    /etc/nexuscore/  /var/lib/nexuscore/  /var/log/nexuscore/
```

`core.db` (SQLite) enthält:
- Server mit Spezifikation und Zustand
- Jobs mit Fortschritt
- Zertifikate und den Fingerabdruck des Panels
- das lokale Audit-Log

Geht die Verbindung zum Panel verloren, laufen die Server weiter. Zeitpläne, die das Panel vorab übertragen hat (Neustart, Backup), führt der Kern auch offline aus.

---

## 5. Schnittstelle Panel ↔ NexusCore

### 5.1 Grundregeln

- **Heute:** HTTP auf Port **8443** mit Bearer-Token, Kopplung über eine einmalige PIN (siehe `nexuscore/CORE_PROTOCOL.md`). Der Core bindet standardmäßig nur an `127.0.0.1`.
- **Ziel:** nur HTTPS mit **gegenseitigen Zertifikaten** (mTLS) auf demselben Port. Ohne gültiges Client-Zertifikat antwortet der Kern nicht. Bis dahin gehört ein Core nicht ungeschützt ins Internet.
- Alle Routen unter `/core/v1`. Felder kommen nur dazu, werden nie umgedeutet. Bei inkompatiblen Änderungen kommt `/core/v2`, und der Kern spricht eine Zeit lang beide.
- Beim Verbinden tauschen beide ihre Version. Das Panel zeigt „Kern veraltet – aktualisieren“ und kann das Update auslösen.
- Jede verändernde Anfrage trägt eine `request_id`. Doppelt gesendete Aufträge, z. B. nach einem Netzwackler, werden nur einmal ausgeführt.

### 5.2 Routen (Auszug)

| Methode | Route | Zweck |
| --- | --- | --- |
| GET | `/core/v1/info` | Version, Betriebssystem, Laufzeiten, CPU/RAM/Platte, freie Ports |
| PUT | `/core/v1/servers/{id}` | Server anlegen oder Spezifikation ändern (idempotent) |
| DELETE | `/core/v1/servers/{id}?keep_data=1` | entfernen |
| POST | `/core/v1/servers/{id}/install` | Installation als Job → `{ job_id }` |
| POST | `/core/v1/servers/{id}/power` | `{ "action": "start" \| "stop" \| "restart" \| "kill" }` |
| GET | `/core/v1/servers/{id}/state` | Zustand, Startzeit, Exit-Code |
| WS | `/core/v1/servers/{id}/console` | Konsole lesen + Befehle senden |
| WS | `/core/v1/stream` | alle Ereignisse des Hosts: Statistiken, Zustände, Jobs, Abstürze |
| GET/PUT/POST | `/core/v1/servers/{id}/files/...` | Liste, lesen, schreiben, hochladen, packen |
| POST | `/core/v1/servers/{id}/backups` | Backup als Job |
| POST | `/core/v1/servers/{id}/backups/{b}/restore` | zurückspielen als Job |
| GET | `/core/v1/servers/{id}/query` | Spielstatus (Spieler, TPS, Ping) |
| GET | `/core/v1/jobs/{job}` | Fortschritt, Protokoll, Ergebnis |
| POST | `/core/v1/update` | Selbst-Update auf eine signierte Version |

### 5.3 Ereignisse auf dem Strom (Beispiele)

```json
{ "type": "stats", "server": "ff9dcda9", "ts": 1794100000, "cpu": 37.5, "mem_mb": 2950,
  "rx_bps": 21000, "tx_bps": 914000 }
{ "type": "state", "server": "ff9dcda9", "state": "crashed", "exit_code": -1073741819,
  "reason": "Zugriffsverletzung (0xC0000005)" }
{ "type": "job", "job": "j_83fa", "server": "ff9dcda9", "kind": "install",
  "progress": 0.42, "message": "SteamCMD: Lade 3,1 von 7,4 GB" }
{ "type": "console", "server": "ff9dcda9", "stream": "stdout",
  "line": "[03:16:22 INFO]: BroGamerYT joined the game" }
```

---

## 6. Sicherheit

### 6.1 Kopplung (einmalig je Host)

Der Ablauf unten ist das **Ziel** mit Zertifikaten. Heute koppelt das Panel über Adresse, Token und optional eine PIN: Der Core nennt den Fingerabdruck seines Tokens, das Panel vergleicht ihn mit dem eingegebenen (`src/hosts/registry.ts`).

```
Panel                                                  NexusCore (frisch installiert)
  │ Admin klickt "Host hinzufügen"                          │
  │ → erzeugt Kopplungscode (8 Zeichen, 10 min gültig)       │
  │   + zeigt: nxctl pair https://panel:8080 K7Q2-MX9P      │
  │                                                          │  Code im Installer eingeben
  │◄──────────── POST /api/v1/hosts/pair { code, csr } ─────┤  (CSR = Zertifikatsantrag,
  │  prüft Code, signiert CSR mit der Panel-CA               │   privater Schlüssel bleibt
  │──────────── { cert, ca_cert, host_id } ────────────────►│   auf dem Host)
  │                                                          │  speichert Zertifikat + CA
  │  Panel ruft /core/v1/info per mTLS auf → Host "online"   │
```

- Der private Schlüssel des Kerns verlässt den Host nie.
- Die Panel-CA liegt verschlüsselt in der Datenbank (wie die anderen Geheimnisse, AES-256-GCM).
- Ein Host lässt sich im Panel **widerrufen**. Sein Zertifikat kommt auf die Sperrliste, und der Kern lehnt das Panel-Zertifikat ab, sobald er die Liste geladen hat.

### 6.2 Grundsätze

| Bereich | Regel |
| --- | --- |
| Rechte | Nur das Panel prüft Nutzerrechte. Der Kern nimmt nur Aufträge mit gültigem Panel-Zertifikat an und schreibt jeden ins lokale Audit-Log. |
| Geheimnisse | Passwörter der Server (RCON, Admin) kommen als Umgebung und landen nie in Logs. Windows-Benutzerpasswörter liegen per DPAPI geschützt im Kern. |
| Trennung | Container: rootless (Podman) oder eigenes Netz + Limits (Docker). Windows nativ: eigener Benutzer, Job Object, Ordnerrechte, Firewall je `.exe`. |
| Netz | Kern-Port 8443 nur fürs Panel (Firewall-Regel auf die Panel-Adresse, wenn bekannt). RCON und Abfrage-Ports intern. |
| Updates | Kern, App und Installer nur mit Ed25519-Signatur des Projekts. Bei Fehlstart nach Update automatisch zurück zur vorigen Version. |
| Dateien | Pfade werden aufgelöst und gegen die Server-Wurzel geprüft. Archive werden beim Entpacken gegen „Zip-Slip“ geprüft. |
| Protokolle | Panel-Audit (Wer hat was ausgelöst?) + Kern-Audit (Was wurde ausgeführt?), über die `request_id` verknüpft. |

---

## 7. Eggs: Erweiterung für mehrere Laufzeiten

Bestehende Eggs bleiben gültig, sie gelten dann für Docker/Podman. Neu ist ein optionaler Block für Windows nativ:

```json
{
  "name": "ARK: Survival Ascended",
  "docker_images": { "Proton": "…" },
  "windows": {
    "steam_app": 2430930,
    "executable": "ShooterGame/Binaries/Win64/ArkAscendedServer.exe",
    "args": "{{MAP}}?listen?SessionName={{SESSION_NAME}}?Port={{SERVER_PORT}}?RCONPort={{RCON_PORT}}?RCONEnabled=True -WinLiveMaxPlayers={{MAX_PLAYERS}}",
    "requires": ["vcredist2015-2022", "directx-june2010"],
    "stop": { "rcon": ["SaveWorld", "DoExit"], "timeout_seconds": 120 },
    "config_files": { "ShooterGame/Saved/Config/WindowsServer/GameUserSettings.ini": { "parser": "ini", "find": { "…": "…" } } },
    "log_file": "ShooterGame/Saved/Logs/ShooterGame.log"
  },
  "runtimes": ["windows", "docker"]
}
```

- `runtimes` sagt, wo das Spiel laufen kann, in der Reihenfolge der Empfehlung. Das Panel bietet beim Anlegen nur passende Hosts und Laufzeiten an.
- Variablen, Ports, Abfragen, Hinweise und Import-Regeln teilen sich alle Laufzeiten. Nur Start, Pfade und Konfigurationsdateien sind je Laufzeit verschieden.
- Der vorhandene **Egg-Testlauf** wird je Laufzeit ausgeführt. Ein Egg gilt erst als „geprüft“, wenn es auf seiner Laufzeit startet und bereit meldet.

---

## 8. Abläufe (Beispiele)

### 8.1 Neuer Server auf einem Windows-Host (nativ)

1. Nutzer wählt im Panel „ARK“. Das Panel schlägt den Windows-Host vor, weil `runtimes[0] = windows` ist und dort ein Kern online ist.
2. Das Panel prüft Rechte, Budget und Ports und legt den Server in der Datenbank an.
3. `PUT /core/v1/servers/{id}`: Der Kern legt Benutzer, Ordner und Firewall-Regel an.
4. `POST …/install`: Der Kern prüft VC++/DirectX, installiert über SteamCMD und meldet Fortschritt auf dem Strom. Das Panel zeigt ihn live.
5. Der Kern schreibt die Konfigurationsdateien aus dem Egg.
6. `power start`: Prozess im Job Object starten. Wenn das Bereit-Muster im Log steht, meldet der Kern „running“, das Panel zeigt ihn grün.

### 8.2 Absturz

1. Prozess endet unerwartet (Exit-Code `0xC0000005`). Der Kern meldet `state=crashed` mit lesbarem Grund.
2. Das Panel schreibt ein Ereignis, benachrichtigt (App/Discord) und startet neu, wenn „Auto-Neustart“ an ist (höchstens 3× in 10 min).
3. Die letzten 200 Zeilen der Konsole hängen am Ereignis. Bekannte Fehler erkennt das Panel über die `hints` des Eggs.

### 8.3 Panel nicht erreichbar

Die Server laufen weiter, und geplante Neustarts und Backups führt der Kern aus. Ereignisse speichert er zwischen und liefert sie nach, sobald das Panel wieder da ist. Im Panel steht der Host so lange als „getrennt seit …“, die Server mit dem zuletzt bekannten Zustand.

### 8.4 Update des Kerns

1. Panel: „Kern 0.3.1 verfügbar“, ein Klick auf Aktualisieren.
2. Der Kern lädt die Datei und prüft die Signatur.
3. Er ersetzt sich über den Dienst-Manager und startet neu.
4. Gameserver laufen weiter:
   - Docker/Podman unabhängig vom Kern
   - Windows nativ: Die Job Objects bleiben bestehen, der Kern hängt sich nach dem Neustart über gespeicherte Prozess-IDs wieder an.
5. Startet die neue Version nicht innerhalb von 60 s, kommt automatisch die alte zurück.

---

## 9. Installation je Ziel

| Ziel | Was installiert wird | Wie |
| --- | --- | --- |
| Linux/Proxmox (heute) | Panel + Docker (+ künftig NexusCore als Host „lokal“) | `install-linux.sh`, Proxmox-Skripte |
| Windows-PC, nur Gameserver | **nur NexusCore** (Windows nativ), Panel läuft woanders | `NexusPanel-Server-Setup.exe` → „Diesen PC als Host hinzufügen“ → Kopplungscode |
| Windows-PC, alles | Panel in WSL2/Hyper-V + NexusCore nativ auf Windows | Setup-Assistent, Modus „Komplett“ |
| Windows Server Core | NexusCore nativ und/oder Panel in Hyper-V-VM | `NexusPanel-Server-Setup.exe install --unattended …` bzw. `irm …/install.ps1 \| iex` |
| NexusPanel OS | Panel + NexusCore + Podman/Docker vorinstalliert | ISO oder fertiges VM-Abbild, Einrichtung im Browser |

Der Windows-Installer liefert den Core als einzelne `.exe` (Node SEA) mit. Prüfungen, Kopplung und Dienst-Einrichtung ruft er über den Core auf, statt sie ein zweites Mal zu bauen.

---

## 10. Apps

- **Desktop/Android (Tauri 2):**
  - Oberfläche aus `web/`, Rust-Hülle für Schlüsselbund, Tray, Benachrichtigungen, Updater und Kopplung per QR-Code
  - Einzelheiten in `docs/KONZEPT-APPS.md`, Abschnitt 2
- **„Server auf diesem PC hosten“ (Desktop):** Die App kann einen eingebetteten NexusCore starten. Der PC wird zum Host, solange die App läuft, oder dauerhaft als Dienst. Für LAN-Partys ideal: App installieren, Code scannen, Server läuft.
- **Gemeinsame Typen** (`nexuscore/src/protocol/`): Die Typen der Schnittstelle nutzen Panel, Core und die Oberfläche der Apps gemeinsam. Die Rust-Hülle der Apps bleibt dünn und enthält keine Fachlogik.

---

## 11. Bauen, Testen, Veröffentlichen

| Teil | Tests | Build |
| --- | --- | --- |
| Panel | Vitest (heute rund 290 Tests), API-Tests mit Fake-Host | Docker-Image wie heute (`deploy.ps1`) |
| NexusCore | Vitest (heute 50 Tests), in CI auf `ubuntu-latest` und `windows-latest`. Geplant: Laufzeit-Tests gegen echtes Docker/Podman (Linux) sowie Job Object, Benutzer und Firewall im Testmodus (Windows) | `tsc`, danach Paket als einzelne `.exe` (Node SEA) für Windows sowie Pakete für Linux x86_64 und arm64 |
| Schnittstelle | **Vertragstests:** Panel und Kern prüfen gegen dieselben Beispiele (`nexuscore/src/protocol/fixtures/*.json`) | – |
| Eggs | Egg-Testlauf je Laufzeit auf echten Hosts, Bericht im Panel (vorhanden) | – |
| Apps/Installer | Rauchtests (startet, koppelt, zeigt Server) | Tauri-Bundles, signiert |

Alle Teile tragen **dieselbe Versionsnummer**. Ein Git-Tag `v0.x.y` baut alles und erzeugt ein Release mit Prüfsummen.

---

## 12. Umstieg in Meilensteinen

| Meilenstein | Version (Ziel) | Inhalt | Danach möglich |
| --- | --- | --- | --- |
| M1 | 0.20 | Host-Schicht im Panel, Typ `local` = heutiger Code, Tabelle `hosts` | nichts sichtbar, Grundlage |
| M2 | 0.21 | NexusCore-Grundgerüst: Dienst, Kopplung (heute Token + PIN, Ziel mTLS), `/info`, Ereignisstrom, `nxctl` | Host im Panel hinzufügen und Werte sehen |
| M3 | 0.22–0.23 | **Windows nativ:** Benutzer, Job Object, Firewall, SteamCMD, Konsole; Eggs ARK, Enshrouded, Palworld, FS25 mit Windows-Block | ARK/Enshrouded ohne Proton auf einem Windows-PC |
| M4 | 0.24 | Windows-Server-Setup (`.exe`, GUI + CLI) mit Modus „nur Host“ | Windows-Host in 5 Minuten einrichten |
| M5 | 0.25–0.26 | Docker- und Podman-Laufzeit im Kern, Umzug deiner VM von `local` auf `core` | ein Weg für alle Hosts, mehrere Linux-Hosts |
| M6 | 0.27 | Dateien, Backups, Revisionen im Kern, Panel-Code dafür wird Rückfall | Backups direkt am Host, schnellere Dateiübertragung |
| M7 | 0.28+ | Desktop-App, später Android, „Server auf diesem PC hosten“ | Bedienung ohne Browser |
| M8 | 0.30+ | NexusPanel OS (ISO, VM-Abbild, A/B-Updates) | Komplettsystem zum Booten |

Jeder Meilenstein ist für sich nützlich und lässt sich ausliefern. Fällt ein späterer weg, bleibt das Bisherige vollständig lauffähig.

---

## 13. Offene Entscheidungen

1. **Kern-Port:** 8443 als Vorgabe? Gibt es ihn bei dir schon (Proxmox nutzt 8006)?
2. **Laufwerk für Spieldaten unter Windows:** Abfrage im Installer, Vorgabe das größte freie Laufwerk?
3. **Windows nativ für Mitnutzer:** Erlauben für alle, oder nur für Admin-eigene Server (wegen der schwächeren Trennung)?
4. **Push, Signaturen, Download-Adresse, iOS:** siehe `docs/KONZEPT-APPS.md`, Abschnitt 7.
5. **Reihenfolge:** M3 (Windows nativ) vor M5 (Docker im Kern)? Empfohlen ja, weil es dir sofort ARK ohne Proton bringt.
