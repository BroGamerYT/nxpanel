# ⚡ NexusCore Protokoll- & Architekturdokumentation (v1.0.0)

**Status:** Experimentell / Lokaler Testmodus  
**Zielumgebung:** Windows Nativ, Linux (Docker/Podman) & NexusPanel OS  

---

## 1. Übersicht & Zielsetzung

`NexusCore` ist das dezentrale Host-Daemon-Modul des Gameserver-Panels. Es ermöglicht das Steuern von Gameserver-Instanzen auf beliebigen Endgeräten (Windows PCs, Linux Root-Servern, Proxmox-VMs und dedizierten NexusPanel OS Systemen).

### Hauptmerkmale:
* **Multi-Plattform:** Nativer Betrieb unter Windows (ohne Docker/Proton) sowie unter Linux (Docker/Podman/NexusPanel OS).
* **Hohe Performance:** Extrem ressourcenschonend, schnelle Reaktionszeiten und geringer Footprint.
* **Sichere Kopplung (mTLS / Token):** Das Panel authentifiziert sich per Gegen-Zertifikat oder Einmal-Kopplungspin.
* **Modulare Treiber-Architektur:** Nahtloser Wechsel zwischen `WindowsNativeDriver`, `DockerDriver` und `MockDriver`.

---

## 2. Kommunikations-Protokoll (`/core/v1`)

Die Kommunikation zwischen **NexusPanel** und **NexusCore** erfolgt über HTTPS / REST und WebSockets (`/core/v1/stream`).

### Endpunkte (REST):

| Methode | Endpunkt | Beschreibung |
| --- | --- | --- |
| `GET` | `/core/v1/info` | Status des Core daemons, Betriebssystem, Laufzeit-Typ und Systemauslastung. |
| `POST` | `/core/v1/pair` | Erstmalige Kopplung mit dem Panel über Kopplungs-PIN. |
| `GET` | `/core/v1/servers` | Liste aller auf diesem Host registrierten Server. |
| `POST` | `/core/v1/servers` | Registrieren / Anlegen eines neuen Gameservers. |
| `POST` | `/core/v1/servers/:id/start` | Starten der Gameserver-Instanz. |
| `POST` | `/core/v1/servers/:id/stop` | Beenden der Gameserver-Instanz. |
| `POST` | `/core/v1/servers/:id/kill` | Abwürgen (Force Kill) der Instanz. |
| `GET` | `/core/v1/servers/:id/stats` | Aktuelle Performance-Werte (CPU %, RAM MB, Disk, Net). |

### WebSockets:
* **`/core/v1/stream`**: Echtzeit-Datenstrom für Konsolenausgaben, Prozessereignisse und Metriken aller aktiven Instanzen.

---

## 3. Treiber-Architektur (`src/drivers/`)

### 🌐 1. Windows Native Driver (`windows-native.ts`)
* **Prozess-Isolierung:** Nutzung von Windows Job Objects zur strikten Deckelung von RAM und CPU.
* **Benutzer-Trennung:** Startet Server unter eingeschränkten Windows-Benutzerkonten (`NX_Server_<ID>`).
* **Firewall:** Automatische Einrichtung von Inbound/Outbound-Regeln über PowerShell/Windows-Firewall-API.

### 🐳 2. Docker Driver (`docker-driver.ts`)
* Nutzt den lokalen Docker-Daemon (auf Linux / Proxmox oder Windows Docker Desktop).
* Kompatibel mit allen Pterodactyl- & Pelican-Images.

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

Der Core startet standardmäßig im **Lokalen Testmodus** auf Port `8443` (oder konfigurierbar über `.env`).

---

## 5. Meilenstein-Planung

1. **M1 (Aktuell):** Aufbau des NexusCore-Skeletts mit Modultreibern, REST/WS-Schnittstellen und Windows-Test-Runner.
2. **M2:** Zertifikatsbasierte mTLS-Authentifizierung und automatischer Zertifikatstausch mit NexusPanel.
3. **M3:** Ausbau der Windows Job Objects und automatische Windows Firewall Freigabe.
4. **M4:** Vorbereitung für NexusPanel OS (Podman/Container-Integration für Bare-Metal-ISO).
