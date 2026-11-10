# 🌐 NexusCore Ökosystem & Plattform-Masterkonzept

**Status:** Architektur- & Implementierungskonzept  
**Version:** 1.1.0  
**Datum:** 10.11.2026  
**Ziel:** 100 % plattformübergreifende Kompatibilität zwischen Master-Panel, Windows (.exe/.msi), macOS (.dmg/Homebrew), Linux (systemd) und NexusPanel OS – inkl. Standalone-Modus und Zero-Config Reverse-Tunneling.

---

## 1. Vision & Leitidee

Das Gameserver Interface (**NexusPanel**) trennt Kontrollebene und Ausführungsebene, bietet aber maximale Flexibilität durch zwei Betriebsarten:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    NexusPanel Master-Zentrale (Cloud / VPS)                  │
│    Web-UI (React 19) · Benutzer · Rechte · Abrechnung · Modpacks · Backups   │
│    + Zero-Config Reverse Tunnel Hub (WSS / WireGuard / TCP-UDP Ingress)      │
└──────────────────────────────────────┬───────────────────────────────────────┘
                                       │ Ausgehender sicherer Tunnel (Outbound WSS/TLS)
                                       │ KEINE Portweiterleitung im Router nötig!
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│ NexusCore: Windows      │  │ NexusCore: macOS        │  │ NexusCore: Linux & OS   │
│ (.exe / .msi Installer) │  │ (.dmg / Homebrew)       │  │ (systemd / ISO Appliance│
│ ─────────────────────── │  │ ─────────────────────── │  │ ─────────────────────── │
│ • Dual-Mode: Panel/Node │  │ • Dual-Mode: Panel/Node │  │ • Dual-Mode: Panel/Node │
│ • Windows-Dienst        │  │ • Apple Silicon (M1-M4) │  │ • Docker Engine / Podman│
│ • Job Objects (RAM/CPU) │  │ • launchd Hintergrund   │  │ • A/B-Systemupdates     │
│ • Windows-Spiele nativ  │  │ • Nativ / Colima Docker │  │ • Proxmox / Bare-Metal  │
│ • Outbound-Tunnel aktiv │  │ • Outbound-Tunnel aktiv │  │ • Outbound-Tunnel aktiv │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

---

## 2. Die zwei Betriebsarten (Dual-Mode: 2-in-1)

Jede NexusCore-Installation (Windows, Mac, Linux) kann per Klick in der Weboberfläche in zwei Modi betrieben werden:

### Modus A: „Eigenständiges Server-Panel“ (Standalone All-in-One)
* **Zielgruppe:** Gamer, die einfach auf ihrem eigenen PC (Windows oder Mac) einen Gameserver für sich und Freunde hosten wollen, ohne externe Server oder Cloud-Dienste mieten zu müssen.
* **Funktionsumfang:**
  * Eingebettete React-Weboberfläche direkt unter `http://127.0.0.1:8443`.
  * Lokale SQLite-Datenbank (`core.db`) für Server, Einstellungen und Audit-Logs.
  * 1-Klick-Installation von Gameservern (Minecraft, Palworld, Enshrouded, Terraria etc.).
  * Live-Konsole mit Autovervollständigung, Dateimanager und automatische Backups.
  * Kann bei Bedarf selbst als Master agieren und weitere Knoten im LAN anbinden.

### Modus B: „Knoten-Modus“ (Remote Worker / Node)
* **Zielgruppe:** Leistungsstarke Gaming-PCs, Home-Server, Proxmox-VMs oder Mac Studios, die als Rechenknechte für ein zentrales NexusPanel dienen.
* **Funktionsumfang:**
  * Reiner Daemon ohne Benutzerverwaltung.
  * Startet, stoppt und überwacht Instanzen im Auftrag des Masters.
  * Sendet Live-Metriken (CPU, RAM, SSD) und Log-Streams zurück.
  * Verbindet sich über den **Zero-Config Reverse-Tunnel** mit dem Master.

---

## 3. NexusCluster: Der Freundeskreis-Verbund (Power Pooling)

Das revolutionäre Szenario: **„3 Freunde, 3 PCs zuhause – zusammengeschlossen zu einem einzigen, mächtigen System mit zentraler Verwaltung.“**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 NexusCluster: Zentrale Gruppen-Verwaltung                   │
│                                                                             │
│  Kombinierter Ressourcen-Pool aller Freunde:                                │
│  • Gesamt-RAM: 80 GB RAM (32 GB + 32 GB + 16 GB)                            │
│  • Gesamt-CPU: 24 physische Kerne / 48 Threads                              │
│  • Gameserver im Verbund: 5 aktiv (ARK auf PC 1, Palworld auf PC 2...)      │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
┌─────────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐
│ Freund 1 (Dominik)      │  │ Freund 2 (Max)          │  │ Freund 3 (Alex)         │
│ • Gaming-PC (Windows)   │  │ • Gaming-PC (Windows)   │  │ • Home-Server (Linux)   │
│ • 32 GB RAM / Ryzen 7   │  │ • 32 GB RAM / Intel i7  │  │ • 16 GB RAM / Mac Mini  │
│ • Hostet: ARK Ascended  │  │ • Hostet: Palworld      │  │ • Hostet: Minecraft     │
│ • [Gaming-Modus: Aus]   │  │ • [Gaming-Modus: Aus]   │  │ • [Dauerbetrieb 24/7]   │
└─────────────────────────┘  └─────────────────────────┘  └─────────────────────────┘
```

### 3.1 Wie Freunde beitreten (1-Klick Cluster-Invite)
1. **Einladungs-Code generieren:** Im Master-Panel klickt der Admin auf *„Freund zum Cluster einladen“* -> erhält einen Code wie `CLUSTER-DOM-772`.
2. **Beitritt am Heim-PC:** Der Kumpel startet seine `nexuscore.exe` (oder Mac `.dmg` / Linux), klickt auf *„Einem Freundes-Cluster beitreten“*, tippt den Code ein – fertig!
3. **Automatischer Reverse-Tunnel:** Der PC des Kumpels verbindet sich sofort über den Outbound-Tunnel mit dem Master. **Weder du noch dein Kumpel müssen Ports im Router öffnen.**

### 3.2 Intelligente Lastverteilung (Smart Placement)
Wenn im Panel ein neuer Gameserver erstellt wird:
* **Manuelle Wahl:** Dropdown *„Auf welchem PC soll der Server laufen? [Dominiks PC (18 GB frei)] | [Max PC (22 GB frei)] | [Alex Mac Mini (10 GB frei)]“*.
* **Automatisches Placement:** Das Panel wählt vollautomatisch den PC mit der aktuell geringsten CPU-Last und dem meisten freien Arbeitsspeicher.

### 3.3 Hardware-Schutz & Privatsphäre für den Freund
Damit Freunde gerne mitmachen, behält jeder die volle Kontrolle über seinen eigenen PC:
* **Ressourcen-Budget:** Kumpel Max kann einstellen: *„Ich gebe maximal 16 GB meiner 32 GB RAM für den Cluster frei“*.
* **„Gaming-Modus“ (Schongang):** Wenn Max abends selbst zockt, drückt er im Systray-Icon auf *„Gaming-Modus aktivieren“*. Der Core drosselt Hintergrund-Prozesse oder pausiert Server mit Vorwarnung.
* **Kein Dateizugriff auf Privates:** Das Panel kann ausschließlich im zugewiesenen Server-Ordner (`D:\NexusCore\servers\`) agieren. Private Fotos, Dokumente oder Spiele des Kumpels sind strikt isoliert.

### 3.4 Gemeinsame Verwaltung (Rollen & Co-Admins)
* Alle Freunde bekommen eigene Logins im Panel.
* Jeder sieht die gemeinsamen Server, kann in die Live-Konsole schauen, Spieler kicken/whitelisten oder Neustarts durchführen.
* Keine WhatsApp-Nachrichten mehr wie: *„Hey Dominik, kannst du mal den Palworld-Server neustarten?“* – jeder Kumpel kann es selbst über die gemeinsame Web-App oder Handy-App tun.

---

## 4. Zero-Config Reverse-Tunneling (NAT- & Firewall-Bypass)

### 3.1 Das Kernproblem bei Heim-PCs
Bisherige Gameserver-Systeme scheitern im Heimnetz an drei Hürden:
1. **Keine Portfreigaben:** Router (Fritz!Box, Speedport) blockieren alle eingehenden Verbindungen.
2. **DS-Lite / CGNAT:** Bei Glasfaser-, Kabel- und Mobilfunkanschlüssen besitzen Nutzer keine eigene öffentliche IPv4-Adresse. Portfreigaben sind technisch wirkungslos.
3. **Privatsphäre & Sicherheit:** Die private Heim-IP darf nicht öffentlich im Internet stehen, um DDoS-Angriffen und Portscans vorzubeugen.

### 3.2 Die Lösung: Ausgehender Tunnel zum Master

```
┌──────────────────────────────────────┐
│        Privater PC zuhause           │
│     (Windows, macOS oder Linux)      │
│  • Keine IP-Freigabe im Router       │
│  • Funktioniert hinter DS-Lite/CGNAT │
│  • Gameserver nutzt CPU & 32 GB RAM  │
└──────────────────┬───────────────────┘
                   │
                   │ Ausgehende Verbindung (Outbound WSS/TLS an Port 443)
                   │ Router lässt ausgehenden Datenverkehr IMMER zu!
                   ▼
┌──────────────────────────────────────┐
│      NexusPanel Master-Server        │ ◄────── Spieler verbinden sich hier!
│        (VPS mit fester IP)           │         (z. B. "play.dein-server.de:25565")
│  • Öffentliche Ingress-Ports         │
│  • Web-UI & Authentifizierung        │
│  • Multiplex-Proxy (TCP/UDP Stream)  │
└──────────────────────────────────────┘
```

### 3.3 Die zwei getrennten Tunnelkanäle
1. **Control Plane (Steuerungskanal):**
   - Ein permanenter, verschlüsselter WebSocket-Tunnel (`wss://panel.example.com/core/v1/tunnel`).
   - Über diesen Kanal schickt der Master Start-/Stopp-Befehle, Konfigurationsänderungen und fragt Logs/Stats ab.
   - Verbindungsabbruch (z. B. Zwangstrennung des Routers) wird in < 2 Sekunden erkannt; automatischer Reconnect mit exponentiellem Backoff.

2. **Game Traffic Ingress (Spieler-Proxy für TCP & UDP):**
   - Der Master-Server öffnet den öffentlichen Spiel-Port (z. B. `25565` TCP für Minecraft oder `7777` UDP für Palworld/ARK).
   - Freunde verbinden sich mit der Domain des Masters (`play.meinedomain.de:25565`).
   - Der Master leitet die Pakete transparent durch den Tunnel an den Heim-PC weiter.
   - **Ergebnis:** Freunde spielen auf der Hardware deines Heim-PCs, ohne dass deine private IP jemals bekannt wird oder du Ports öffnen musst.

---

## 5. Intelligentes Failover & Live-Sync (High-Availability bei PC-/Stromausfall)

Das ultimative Sicherheitsfeature: **Fällt ein Rechner aus (Stromausfall, Windows-Update, Bluescreen oder Netztrennung), übernimmt automatisch ein anderer PC der Gruppe den Server.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. PC 1 (Dominik) hat STROMAUSFALL (Knoten offline, Heartbeat bricht ab)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼ Master erkennt Ausfall nach 30s
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. NexusPanel Master aktiviert Notfall-Failover                             │
│    • Holt letzten Spielstand (aus Live-Sync / Delta-Snapshot)               │
│    • Wählt automatisch verfügbaren Fallback-Knoten: PC 2 (Max)              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. PC 2 (Max) startet die Instanz nahtlos mit aktuellem Spielstand           │
│ 4. Master leitet Spieler-Ports (play.meinedomain.de) sofort auf PC 2 um     │
│ 5. Freunde können nach 30-60 Sekunden weiterspielen!                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Wie der Spielstand aktuell gehalten wird (Savegame Live-Sync)
* **Deltas statt Riesenbackups:** Spiel-Binärdateien (z. B. 20 GB Spiel) sind statisch. Nur die eigentliche Welt und Spielstände (`Saved/`, `world/`) ändern sich – und die sind meist nur wenige Megabyte groß.
* **Periodischer Sync:** Alle 5 Minuten (oder bei jedem Autosave des Spiels via RCON) sendet der aktive Knoten ein verschlüsseltes, Zstandard-komprimiertes Delta-Snapshot an den Master-Server.
* **Pre-Caching auf Fallback-Knoten:** Häufig genutzte Gameserver-Dateien können im Standby bereits auf den PCs der Freunde liegen, sodass im Notfall nur die Weltdatei kopiert werden muss.

### 5.2 Automatischer Failover-Ablauf
1. **Heartbeat-Überwachung:** Jeder Knoten sendet alle 5 Sekunden ein Lebenszeichen an den Master.
2. **Ausfall-Erkennung:** Bleibt der Heartbeat für 30 Sekunden aus, markiert der Master den Knoten als `OFFLINE / UNREACHABLE`.
3. **Automatischer Spawn auf Fallback-Host:** Der Master befiehlt dem nächsten berechtigten Freundes-PC (z. B. Max’ PC), den Gameserver mit dem aktuellsten Snapshot zu starten.
4. **Proxy-Umschaltung:** Der Master-Proxy biegt die Spielports transparent auf den neuen Host um. Spieler müssen keine neue IP eingeben, sondern verbinden sich einfach wieder auf dieselbe Domain.

### 5.3 Split-Brain-Schutz (Verhinderung von Daten-Konflikten)
Wenn PC 1 nach dem Stromausfall wieder hochfährt:
* Er darf den Server **nicht** eigenmächtig starten oder alte Spielstände überschreiben.
* Vor jedem Start fragt der Core beim Master an: *„Bin ich der autorisierte Host für diesen Server?“*
* Der Master antwortet: *„Nein, der Server läuft bereits auf PC 2 mit Spielstand Revision 189.“*
* PC 1 schaltet sich in den Standby-Modus und lädt den neuen Spielstand von PC 2 herunter, sobald PC 2 wieder entlastet werden soll.

---

## 6. Plattform-Architektur: Windows (`.exe` / `.msi`)

* **Bereitstellung:**
  * `nexuscore.exe` (Single Executable Application via Node SEA / Rust).
  * `NexusCore-Setup.msi` (WiX v5 Windows Installer Paket).
* **Ausführung:**
  * Interaktiver Start per Doppelklick (inkl. Web-Dashboard auf `http://127.0.0.1:8443`).
  * Installierbar als echter Windows-Dienst (`nexuscored.exe` via Windows Service Control Manager).
  * Systray-Icon (`nxctl-tray.exe`) mit Statusanzeige und 1-Klick-PIN.
* **Laufzeit:**
  * **Windows Nativ:** Gameserver laufen ohne Virtualisierung/Docker direkt als Windows-Prozesse.
  * **Job Objects:** Harte RAM-Limits (`JOB_OBJECT_LIMIT_PROCESS_MEMORY`), CPU-Rate-Limits und automatischer Kill verwaister Kindprozesse.
  * **Isolierung:** Dedizierter Windows-Dienstnutzer `nxp-<id>`, NTFS-Rechtebeschränkung.
  * **Firewall:** Automatische Freigabe über Windows Advanced Firewall API.

---

## 7. Plattform-Architektur: macOS (Apple Silicon & Intel)

* **Bereitstellung:**
  * `.dmg` Drag-and-Drop Installer mit App-Bundle (`NexusCore.app`).
  * Homebrew Formula: `brew install nexuscore`.
  * Universal Binary für `arm64` (Apple Silicon M1, M2, M3, M4) und `x86_64` (Intel).
* **Ausführung:**
  * Menüleisten-App (macOS Menu Bar Item) mit Statusampel und PIN-Kopierfunktion.
  * Hintergrunddienst über macOS `launchd` (`~/Library/LaunchAgents/io.nexuspanel.core.plist`).
* **Laufzeiten unter macOS:**
  * **Nativ:** Hervorragend für Java-Spiele (Minecraft Paper/Fabric), Node.js, Python und native Mac-Server (Factorio, Terraria).
  * **Container:** Integrierte Anbindung an Colima oder Docker Desktop für Spiele, die ausschließlich als Linux-Binärdatei vorliegen.
* **Outbound-Tunnel:** Vollständig unterstützt – auch ein Mac Mini oder MacBook zuhause kann ohne Router-Konfiguration als Node dienen.

---

## 8. Plattform-Architektur: Linux (Debian, Ubuntu, Rocky, VPS)

* **Bereitstellung:**
  * Einzeiler-Skript: `curl -fsSL https://get.nexuspanel.io/core | sudo bash`
  * Native Paketformate: `.deb` (Debian/Ubuntu) und `.rpm` (RHEL/Rocky/Fedora).
* **Ausführung:**
  * Robuster `systemd`-Service (`nexuscored.service`) mit automatischem Neustart bei Systemboot.
* **Laufzeiten:**
  * **Docker Engine** (Standard).
  * **Podman Rootless:** Maximale Sicherheit; der Prozess läuft unter einem normalen Linux-Benutzer ohne Root-Rechte auf dem Host. Netzwerk über `pasta`.

---

## 9. Plattform-Architektur: NexusPanel OS (Appliance)

* **Bereitstellung:**
  * Schlüsselfertiges `.iso` (für USB-Stick / Bare-Metal) und VM-Images (`.qcow2` für Proxmox, `.vhdx` für Hyper-V).
* **Ausführung:**
  * Minimalistisches, unzerstörbares Linux-System mit Long Term Support Kernel.
  * **A/B-Systemupdates:** Atomare Systemaktualisierungen aus dem Web-Panel. Schlägt der Boot fehl, schaltet das System automatisch auf die alte Partition zurück.
* **Zero-Touch Setup:**
  * PC von USB booten -> Monitor zeigt DHCP-IP und PIN -> im Browser öffnen oder an Master koppeln -> fertig.

---

## 10. Protokoll-Spezifikation (`/core/v1`) & Kompatibilität

Alle Plattformen teilen denselben API-Standard:

| Methode | Endpunkt | Auth | Funktion |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | nein | Web-Dashboard (HTML) oder Kurzinformation (JSON) |
| `GET` | `/favicon.ico` | nein | SVG-Status-Icon |
| `GET` | `/core/v1/info` | nein | Host-Status, CPU, RAM, Festplatte, Version |
| `POST` | `/core/v1/pair` | nein | Kopplung via Einmal-PIN (erzeugt Token) |
| `GET` | `/core/v1/servers` | ja | Liste aller registrierten Gameserver |
| `POST` | `/core/v1/servers` | ja | Neuen Gameserver registrieren / anlegen |
| `POST` | `/core/v1/servers/:id/start` | ja | Serverinstanz starten |
| `POST` | `/core/v1/servers/:id/stop` | ja | Serverinstanz ordentlich herunterfahren |
| `POST` | `/core/v1/servers/:id/kill` | ja | Notfall-Abwürgen (Force Kill) |
| `GET` | `/core/v1/servers/:id/stats` | ja | Live-Performancewerte (CPU %, RAM MB, Uptime) |
| `GET` | `/core/v1/servers/:id/logs` | ja | Konsolenausgaben aus dem Ringpuffer |
| `WS` | `/core/v1/stream` | Token | Live-Stream für Konsole, Metriken und Statuswechsel |
| `WS` | `/core/v1/tunnel` | Token | **Reverse-Tunnel-Endpunkt** für Outbound-Knoten ohne Portfreigabe |

---

## 11. Phasen-Roadmap (Globale Bereitstellung)

```
┌─────────────────────────────────┐
│ Phase 1: Prototyp & Windows     │ ◄── [ABGESCHLOSSEN / LIVE]
│ • TS-Core mit Windows-Runner    │     nexuscore.exe & MSI laufen auf dem PC
│ • Live-Dashboard auf /          │     HTML-Startseite & Metriken aktiv
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Phase 2: Standalone Panel-UI    │ ◄── [JETZT IM FOKUS: Für jeden Nutzer weltweit]
│ • Vollwertige Server-Verwaltung │     Doppelklick auf .exe -> sofort Panel im Browser
│ • Gameserver erstellen & lenken │     Minecraft, Palworld, SteamCMD per 1-Klick
│ • Live-Konsole & Dateimanager   │     100 % lokal, portabel, ohne Cloud-Zwang
│ • Lokale SQLite / Registry      │     Läuft überall auf der Welt ohne feste IP
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Phase 3: Reverse-Tunneling      │ ◄── [DANACH: Vernetzung & Freunde-Verbund]
│ • Outbound WebSocket-Client     │     Cluster-Beitritt per Invite-Code
│ • Control-Channel Multiplexing  │     Keine Portfreigaben / DS-Lite Bypass
│ • TCP/UDP Game Traffic Proxy    │     Gemeinsamer Ressourcen-Pool
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│ Phase 4: macOS & Linux Pakete   │
│ • macOS .dmg + Universal Binary │     Apple Silicon & Intel Support
│ • Linux .deb/.rpm + systemd     │     1-Zeiler curl-Install
│ • NexusPanel OS (Boot-ISO)      │     Proxmox / Bare-Metal Appliance
└─────────────────────────────────┘
```
