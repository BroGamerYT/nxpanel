# ⚡ NexusCore Protokoll- & Architekturdokumentation (v1.1.0)

**Status:** Lauffähiger Prototyp / lokaler Testmodus
**Zielumgebung:** Windows Nativ, Linux (Docker/Podman) & NexusPanel OS
**Implementierung:** TypeScript (Fastify 5) unter `src/`. Ein Rust-Kern ist nicht mehr geplant (Entscheidung 11.11.2026, siehe `docs/ARCHITEKTUR.md`)

---

## 1. Übersicht & Zielsetzung

`NexusCore` ist das dezentrale Host-Daemon-Modul des Gameserver-Panels. Es ermöglicht das Steuern von Gameserver-Instanzen auf beliebigen Endgeräten (Windows PCs, Linux Root-Servern, Proxmox-VMs und dedizierten NexusPanel OS Systemen).

### Hauptmerkmale:
* **Multi-Plattform:** Nativer Betrieb unter Windows (ohne Docker/Proton) sowie unter Linux (Docker/Podman/NexusPanel OS).
* **Hohe Performance:** Extrem ressourcenschonend, schnelle Reaktionszeiten und geringer Footprint.
* **Sichere Kopplung (Token, später mTLS):** Das Panel authentifiziert sich per Token; die Kopplung erfolgt über eine einmalige PIN.
* **Modulare Treiber-Architektur:** Nahtloser Wechsel zwischen `WindowsNativeDriver`, `DockerDriver` und `MockDriver`.

---

## 2. Kommunikations-Protokoll (`/core/v1`)

Die Kommunikation zwischen **NexusPanel** und **NexusCore** erfolgt über HTTP(S) / REST und WebSockets (`/core/v1/stream`).

> Noch kein TLS: der Core hört aktuell auf reinem HTTP. mTLS und Zertifikatstausch folgen mit Meilenstein M2 (siehe `docs/ARCHITEKTUR.md`).

### Endpunkte (REST):

| Methode | Endpunkt | Auth | Beschreibung |
| --- | --- | --- | --- |
| `GET` | `/core/v1/info` | nein | Status des Core daemons, Betriebssystem, Laufzeit-Typ und Systemauslastung. |
| `POST` | `/core/v1/pair` | nein | Erstmalige Kopplung mit dem Panel über Kopplungs-PIN. |
| `GET` | `/core/v1/servers` | ja | Liste aller auf diesem Host registrierten Server. |
| `POST` | `/core/v1/servers` | ja | Registrieren / Anlegen eines neuen Gameservers. |
| `POST` | `/core/v1/servers/:id/start` | ja | Starten der Gameserver-Instanz. |
| `POST` | `/core/v1/servers/:id/stop` | ja | Beenden der Gameserver-Instanz. |
| `POST` | `/core/v1/servers/:id/kill` | ja | Abwürgen (Force Kill) der Instanz. |
| `GET` | `/core/v1/servers/:id/stats` | ja | Aktuelle Performance-Werte (CPU %, RAM MB, Laufzeit). |
| `GET` | `/core/v1/servers/:id/logs` | ja | Konsolenausgaben aus dem Ringpuffer (letzte 500 Zeilen). |

**Authentifizierung:** Alle geschützten Endpunkte erwarten `Authorization: Bearer <NEXUSCORE_TOKEN>`.
Ohne Token antworten sie mit `401`. Beim WebSocket kann der Token alternativ als
`?token=` übergeben werden, weil Browser dort keine Header setzen können.

**Fehlerformat:** `{ "error": "<kurz>", "message": "<detail>" }` mit Statuscode 400 (ungültige Eingabe), 401 (kein/ungültiger Token), 404 (unbekannte Instanz), 409 (ID existiert bereits), 429 (zu viele Kopplungsversuche).

### Beispiel: Instanz registrieren

```http
POST /core/v1/servers
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "minecraft-01",
  "name": "Mein Minecraft Server",
  "game": "minecraft",
  "executable": "C:\\Server\\java.exe",
  "args": ["-Xmx4G", "-jar", "server.jar", "nogui"],
  "workingDir": "C:\\Server",
  "ports": [{ "name": "game", "hostPort": 25565, "protocol": "tcp" }]
}
```

### Beispiel: Status abfragen

```json
{
  "stats": {
    "serverId": "minecraft-01",
    "status": "running",
    "pid": 12345,
    "cpuPercent": 4.2,
    "memoryMb": 3072,
    "uptimeSeconds": 5400,
    "startedAt": "2026-11-09T21:00:00.000Z"
  }
}
```

### WebSockets:
* **`/core/v1/stream`**: Echtzeit-Datenstrom für Konsolenausgaben, Prozessereignisse und Metriken aller aktiven Instanzen.
  * Optional `?serverId=<id>`: dann kommen nur die Ereignisse dieser Instanz (ohne Host-Metriken).
  * Beim Verbindungsaufbau werden die letzten 50 Konsolenzeilen nachgeliefert – ein neu verbindender Panel-Client verliert also nichts.

**Ereignistypen:**

```json
{ "type": "console", "serverId": "minecraft-01", "line": "[12:03:11] Done (3.2s)!", "stream": "stdout", "ts": "2026-11-09T21:03:11.000Z" }
{ "type": "state",   "serverId": "minecraft-01", "state": { "id": "minecraft-01", "status": "running", "pid": 12345 }, "ts": "..." }
{ "type": "metrics", "metrics": { "cpuUsagePercent": 12.4, "totalMemoryMb": 32768, "usedMemoryMb": 14320, "freeMemoryMb": 18448, "diskTotalGb": 931.5, "diskFreeGb": 402.1 }, "ts": "..." }
```

---

## 3. Treiber-Architektur (`src/drivers/`)

Alle Treiber implementieren dieselbe Schnittstelle (`HostDriver`) und sind hinter
einem Event-Bus austauschbar. Der HTTP-Layer kennt keinen Treiber.

### 🌐 1. Windows Native Driver (`windows-native.ts`)
* **Echter Prozessstart** über `spawn` **ohne** `shell: true` – Kommandozeilen-Argumente werden dadurch nicht zerlegt (keine Injektion über Leerzeichen oder Anführungszeichen).
* **Prozessbaum-Abbau** über `taskkill /PID <pid> /T` (Stoppen) bzw. `taskkill /PID <pid> /T /F` (Abbrechen). Es wird immer der ganze Baum beendet, damit keine Waisen zurückbleiben.
* **Konsolenausgaben** werden aus stdout/stderr zeilenweise in den Event-Bus geschrieben und stehen zusätzlich im Ringpuffer (letzte 500 Zeilen je Server).
* **Statistiken** kommen aus Windows selbst: Working Set und kumulierte Prozesszeit via `Get-Process` (PowerShell). Die CPU-Last wird aus der Differenz zweier Messungen berechnet.
* **Noch offen (M3):** Job Objects für harte RAM-/CPU-Grenzen, eigener Windows-Benutzer pro Server (`NX_Server_<ID>`), automatische Firewall-Freigabe je `.exe` und Port.

### 🐳 2. Docker Driver (`docker-driver.ts`)
* Nutzt den lokalen Docker-Daemon (auf Linux / Proxmox oder Windows Docker Desktop) über `dockerode` – dieselbe Bibliothek, die auch das Panel nutzt.
* Kompatibel mit allen Pterodactyl- & Pelican-Images.
* Läuft der Core ohne erreichbaren Docker-Daemon, startet er trotzdem; Instanzen lassen sich dann nur nicht starten.

### 🧪 3. Mock Driver (`mock-driver.ts`)
* Dient zum risikofreien lokalen Testen auf Entwickler-Rechnern ohne echte Systemänderungen.

---

## 4. Lokaler Testbetrieb

Zum Testen unter Windows wird das mitgelieferte Startscript verwendet:

```powershell
.\start-nexuscore.ps1
```
oder
```cmd
start-nexuscore.bat
```

Der Core startet standardmäßig im **Lokalen Testmodus** auf Port `8443` (oder konfigurierbar über `.env`) und lauscht nur auf `127.0.0.1`.

### Vollständiger Selbsttest auf Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1
```

Das Skript startet einen eigenen Daemon, prüft alle Endpunkte (inklusive Kopplung, Auth, Registrierung, Start, Statistik, Logs, WebSocket und Stoppen) und meldet je Schritt PASS oder FAIL.

Gegen einen bereits laufenden Daemon:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1 -BaseUrl http://127.0.0.1:8443 -Token <token>
```

### Konfiguration (`.env`)

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `NEXUSCORE_MODE` | `test` | `test` oder `production`. In `production` sind Token und PIN Pflicht, sonst startet der Core nicht. |
| `NEXUSCORE_HOST` | `127.0.0.1` | Bindeadresse. |
| `NEXUSCORE_PORT` | `8443` | HTTP-Port. |
| `NEXUSCORE_RUNTIME` | plattformabhängig | `windows-native`, `docker` oder `mock`. |
| `NEXUSCORE_DATA_DIR` | `<Projekt>/data` | Registry und Laufzeitdaten. |
| `NEXUSCORE_TOKEN` | leer | Bearer-Token für alle geschützten Routen. |
| `NEXUSCORE_PAIRING_PIN` | leer | Kopplungs-PIN; leer bedeutet: beim Start zufällig erzeugen und ausgeben. |
| `NEXUSCORE_CORS_ORIGINS` | leer | erlaubte Herkünfte, kommagetrennt. Leer heißt: CORS aus. |
| `NEXUSCORE_LOG_LEVEL` | `info` | Log-Level. |

> **Keine Geheimnisse im Repository.** `.env` ist von Git ausgenommen; es gibt nur `.env.example` mit leeren Werten. Ein Token wird nie im Klartext über eine Antwort ausgegeben – `/info` und `/pair` liefern nur den Fingerabdruck (SHA-256, gekürzt).

---

## 5. Meilenstein-Planung

1. **M1 (abgeschlossen):** Lauffähiger NexusCore-Prototyp in TypeScript – Modultreiber, REST/WS-Schnittstelle, Persistenz, Auth, Windows-Test-Runner und Selbsttest-Skript.
2. **M2:** Zertifikatsbasierte mTLS-Authentifizierung und automatischer Zertifikatstausch mit NexusPanel.
3. **M3:** Ausbau der Windows Job Objects, eigener Benutzer je Server und automatische Windows-Firewall-Freigabe.
4. **M4:** Vorbereitung für NexusPanel OS (Podman/Container-Integration für Bare-Metal-ISO).
5. **M5:** Host-Schicht im Panel, damit mehrere Cores nebeneinander verwaltet werden können (siehe `docs/ARCHITEKTUR.md`).

### Bekannte Grenzen des aktuellen Stands

* **Stoppen unter Windows ist nicht „sanft“:** Windows kennt kein `SIGTERM`. `taskkill /T` versucht zuerst zu schließen, bei Spielservern führt das praktisch zum sofortigen Abbruch. Ein echter Graceful-Stop über die Spielkonsole ist noch nicht umgesetzt.
* **Keine Ressourcenbegrenzung** auf dem Windows-Treiber: `maxMemoryMb` und `maxCpuPercent` werden angenommen, aber erst mit M3 technisch erzwungen.
* **Keine TLS-/mTLS-Schicht** – sie folgt mit M2.
