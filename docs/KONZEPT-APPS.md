# Konzept: NexusPanel-Apps und Installer

Stand: 07.11.2026 · Status: Konzept, noch nichts davon gebaut · Aufgaben dazu: `docs/TODO.md`, Abschnitt „Apps und Installer“

**Gesamtbild mit allen Schnittstellen, Abläufen und Meilensteinen: `docs/ARCHITEKTUR.md`.**

Dieses Konzept beschreibt zwei getrennte Dinge:

1. **Apps zum Bedienen des Panels:** Windows, macOS, Linux und Android (APK), später optional iOS.
2. **Installer für das Panel selbst:** Linux, Windows 10/11, Windows Server mit Oberfläche und Windows Server Core ohne Oberfläche. Jeweils per Doppelklick auf eine `.exe` oder per Befehl.

Beides soll so weit wie möglich in **Rust** entstehen.

---

## 1. Technische Grundentscheidung: Tauri 2

| Möglichkeit | Plattformen | Oberfläche | Bewertung |
| --- | --- | --- | --- |
| **Tauri 2** (Rust-Kern + Web-Oberfläche) | Windows, macOS, Linux, Android, iOS | **Die vorhandene React-Oberfläche wird weiterverwendet** | **Empfohlen.** Eine Codebasis für alle Plattformen. Kleine Programme, weil Tauri die WebView des Systems nutzt statt einen eigenen Browser mitzuliefern. Kern in Rust. |
| Electron | nur Desktop | Web | Kein Android, sehr große Programme (über 100 MB). |
| Flutter | alle | Dart, komplett neu | Die ganze Oberfläche müsste neu geschrieben werden, kein Rust. |
| Reines Rust-GUI (egui, iced, Slint) | Desktop, Mobil teilweise | Rust, komplett neu | Wäre „100 % Rust“, aber jede Seite des Panels müsste neu entstehen. Für den **Installer** (wenige Seiten) gut geeignet, für die App nicht. |

**Entscheidung:**
- Die **App** wird mit **Tauri 2** gebaut. Rust kümmert sich um alles, was ans Betriebssystem geht: Schlüsselbund, Benachrichtigungen, Tray-Symbol, Autostart, Updates, Zertifikate. Die Oberfläche ist dieselbe wie im Browser.
- Der **Installer** wird ein eigenes Rust-Programm: eine `.exe`, die bei Doppelklick ein Fenster öffnet und mit Parametern ohne Oberfläche als Kommandozeilen-Werkzeug läuft.

Tauri 2 ist seit Oktober 2024 stabil und kann seitdem auch Android und iOS. Es baut von sich aus Installer für alle Plattformen:

| Plattform | Format |
| --- | --- |
| Windows | NSIS-Setup (`.exe`), MSI |
| macOS | `.app`, `.dmg` |
| Linux | AppImage, `.deb`, `.rpm` |
| Android | APK, AAB |

---

## 2. Die App (NexusPanel Client)

### 2.1 Was die App können soll

| Funktion | Desktop | Android | Umsetzung |
| --- | --- | --- | --- |
| Mehrere Panels („Verbindungen“) speichern und wechseln | ✓ | ✓ | Liste in Rust, Zugangsdaten im Schlüsselbund des Systems |
| Ganze Panel-Oberfläche (Server, Konsole, Dateien, Backups, Modpacks …) | ✓ | ✓ | Die vorhandene React-Oberfläche, mit einstellbarer API-Adresse |
| Anmelden mit 2FA, angemeldet bleiben | ✓ | ✓ | Geräte-Token (siehe 2.3), sicher abgelegt |
| Benachrichtigungen: Absturz, Server bereit, Update verfügbar, Backup fehlgeschlagen, Spieler beigetreten (einstellbar) | ✓ | ✓ | `tauri-plugin-notification`, Ereignisse per WebSocket |
| Tray-Symbol mit Ampel aller Server, Schnell-Start/-Stopp | ✓ | – | Tauri-Tray-API |
| Mit dem System starten (minimiert im Tray) | ✓ | – | `tauri-plugin-autostart` |
| Panel per QR-Code hinzufügen (im Panel anzeigen, mit dem Handy scannen) | – | ✓ | Kamera-Plugin. Der QR-Code enthält Adresse, Zertifikats-Fingerabdruck und einen Einmal-Kopplungscode. |
| Selbst signierte Zertifikate im LAN (`https://10.0.0.120`) | ✓ | ✓ | Fingerabdruck beim ersten Verbinden bestätigen (Trust on first use), danach festgehalten |
| Automatische Updates der App | ✓ | über Play Store oder Hinweis in der App | `tauri-plugin-updater` mit signierten Paketen |
| Links wie `nexuspanel://server/ff9dcda9` öffnen die App | ✓ | ✓ | Deep-Link-Plugin |
| Letzter Stand ohne Verbindung (nur lesen) | ✓ | ✓ | Kleiner Zwischenspeicher in Rust (SQLite) |

### 2.2 Aufbau

```
nexuspanel-app/                 (eigener Ordner im Repo: apps/client)
├── src-tauri/                  Rust
│   ├── src/connections.rs      Panels speichern, Schlüsselbund (crate keyring / Android Keystore)
│   ├── src/notify.rs           WebSocket zum Panel -> Systembenachrichtigungen
│   ├── src/tray.rs             Tray-Menü mit Serverstatus
│   ├── src/tls.rs              Zertifikat-Fingerabdruck pruefen und merken
│   └── tauri.conf.json         Bundles: nsis, msi, dmg, appimage, deb, rpm, android
└── (Frontend = web/ aus dem Panel, gebaut mit VITE_API_BASE)
```

- **Eine Oberfläche, zwei Wege.** `web/` bekommt eine einstellbare API-Adresse: Im Browser ist es die eigene Adresse, in der App die gewählte Verbindung. Alles andere bleibt gleich, so wandern neue Panel-Funktionen ohne Zusatzarbeit in die App.
- **Mobile Ansicht.** Die steht ohnehin in der TODO (Phase 7). Sie ist Voraussetzung für die Android-App:
  - Navigation unten statt Seitenleiste
  - Serverkacheln untereinander
  - Konsole mit Befehlszeile über der Tastatur

### 2.3 Was das Panel dafür braucht

1. **Geräte-Token.** Langlebige, je Gerät widerrufbare Anmeldungen. Unter „Mein Konto → Geräte“ siehst du „Pixel 8 – zuletzt aktiv vor 2 Min“ und kannst sie einzeln abmelden. Das passt zu den vorhandenen Sitzungen (Refresh-Token); neu sind Gerätename, Plattform und die Liste in der Oberfläche.
2. **Kopplung per QR-Code.** Ein kurzlebiger Einmal-Code, z. B. 5 Minuten gültig. Die App tauscht ihn gegen ein Geräte-Token. So muss man auf dem Handy kein Passwort eintippen.
3. **CORS und Herkunft für die App.** Tauri-Apps laden die Oberfläche von `tauri://localhost` (macOS/Linux) bzw. `http://tauri.localhost` (Windows/Android). Diese Herkünfte freigeben, für die App ein Bearer-Token statt Cookie verwenden.
4. **Ereignisstrom für Benachrichtigungen.** Ein WebSocket `/api/v1/events/stream` mit den vorhandenen Ereignissen (Absturz, Backup, Update, Spieler).
5. **Push aufs Handy, wenn die App geschlossen ist.** Drei Wege, Entscheidung offen:
   - **ntfy / UnifiedPush.** Selbst gehostet, ohne Google, passt zum Homelab. *Empfehlung.*
   - **Firebase Cloud Messaging.** Zuverlässigste Zustellung, braucht aber ein Google-Konto und einen Dienst-Schlüssel im Panel.
   - **Nur bei geöffneter App.** Am einfachsten, aber keine Meldungen im Hintergrund.
6. **Download-Seite im Panel** (`/apps`). Zeigt die neueste App-Version je Plattform mit Download-Knopf und einen QR-Code für die Android-APK. Die Dateien liegen bei den Releases (siehe 4).

### 2.4 Pakete und wo sie herkommen

| Plattform | Paket | Verteilung | Hinweise |
| --- | --- | --- | --- |
| Windows 10/11 | `NexusPanel-Setup.exe` (NSIS), `NexusPanel.msi` | Download-Seite, später `winget install NexusPanel` | Braucht WebView2: auf Windows 10/11 vorhanden, sonst lädt der Installer es nach. Ohne Code-Signatur zeigt SmartScreen eine Warnung (siehe 4.3). Ohne Rückfrage: `NexusPanel-Setup.exe /S` bzw. `msiexec /i NexusPanel.msi /qn` |
| Windows Server (mit Oberfläche) | wie oben | wie oben | Läuft, wenn WebView2 installiert ist. Auf Server Core gibt es keine App, dort gilt nur die Web-Oberfläche vom anderen PC. |
| macOS | `NexusPanel.dmg` (Universal: Apple Silicon + Intel) | Download-Seite, später Homebrew | Ohne Apple-Entwicklerkonto (99 $/Jahr) gibt es keine Notarisierung, und Gatekeeper warnt beim ersten Start. |
| Linux | `.AppImage`, `.deb`, `.rpm` | Download-Seite | AppImage läuft überall ohne Installation |
| Android | `NexusPanel.apk` (direkt), `.aab` (Play Store) | Download-Seite mit QR-Code, später Play Store | Eigener Signaturschlüssel. Diesen sicher aufbewahren, ohne ihn gibt es keine Updates mehr. |
| iOS | – | später, optional | Braucht einen Mac zum Bauen und das Apple-Konto, Verteilung über TestFlight oder App Store |

---

## 3. Installer für das Panel selbst

### 3.1 Die Ausgangslage

Die Gameserver laufen als **Linux-Container**. Jedes Ziel braucht deshalb einen Linux-Kern mit Docker. Unter Linux ist das direkt da, unter Windows muss der Installer ihn bereitstellen. Dafür gibt es zwei Wege:

| Modus | Wie | Vorteile | Nachteile |
| --- | --- | --- | --- |
| **A: Hyper-V-VM** (empfohlen für Server) | Der Installer legt eine kleine Linux-VM an (Debian, 2 Kerne, 4 GB RAM als Vorgabe) mit eigenem virtuellen Switch. Die VM bekommt eine **eigene IP im LAN**. | Robust, eigene IP, kein NAT, **UDP funktioniert ohne Tricks**, sauber getrennt, läuft auch auf Server Core | Braucht Hyper-V (Windows Pro/Enterprise/Server). Fester RAM-Anteil. |
| **B: WSL2** (für Desktop-PCs) | Eigene WSL-Distribution „NexusPanel“ mit Docker Engine (**nicht** Docker Desktop) | Geht auch unter Windows Home, RAM wird geteilt | Netzwerk ist die Schwachstelle (siehe unten). Startet nur, wenn Windows hochfährt und WSL läuft. |

**Netzwerk bei WSL2:**
- Spiele brauchen meist **UDP**. Die klassische Weiterleitung `netsh interface portproxy` kann **nur TCP**.
- Darum nutzt der Installer den **Mirrored-Netzwerkmodus** von WSL (`networkingMode=mirrored` in `.wslconfig`, ab Windows 11 22H2). Dann lauschen Container direkt auf der Windows-IP.
- Unter **Windows 10** gibt es diesen Modus nicht. Dort schlägt der Installer Modus A vor.

**Docker Desktop wird bewusst nicht verwendet:**
- Es ist auf Windows Server nicht unterstützt.
- In größeren Firmen ist es lizenzpflichtig.
- Es braucht zusätzlichen Speicher.

Stattdessen installiert der Installer die freie **Docker Engine** direkt in der VM bzw. der WSL-Distribution.

### 3.2 Welcher Weg wo

| Ziel | Oberfläche | Empfohlener Modus | Installation |
| --- | --- | --- | --- |
| Linux (Debian/Ubuntu), Proxmox | – | direkt | `curl -fsSL https://<downloads>/install.sh \| sudo bash`. Baut auf `install/install-linux.sh`, `proxmox-vm.sh` und `proxmox-ct.sh` auf, die es schon gibt. |
| Windows 11 Pro/Home | ✓ | B (WSL2 mirrored); A, wenn Hyper-V vorhanden und gewünscht | **`NexusPanel-Server-Setup.exe`** per Doppelklick, Assistent |
| Windows 10 | ✓ | A (Hyper-V, nur Pro); bei Home nur eingeschränkt (B ohne UDP) | Assistent mit klarer Warnung |
| Windows Server 2022/2025 mit Desktop-Darstellung | ✓ | **A (Hyper-V)** | Assistent oder Befehl |
| Windows Server Core (ohne Oberfläche) | – | **A (Hyper-V)**. WSL wird auf Server Core nach aktuellem Stand nicht unterstützt (bei Microsoft vor dem Bau noch einmal prüfen). | **Nur per Befehl**, siehe 3.4 |
| Windows-VPS ohne verschachtelte Virtualisierung | – | **geht nicht** | Der Installer erkennt das und erklärt: Linux-Container brauchen Hyper-V oder WSL2. Empfehlung: Linux-VPS. |

### 3.3 Der grafische Installer (Doppelklick auf die `.exe`)

Eine einzige Datei: `NexusPanel-Server-Setup.exe`. Sie ist in Rust geschrieben (Oberfläche mit Slint oder Tauri) und digital signiert.

1. **Willkommen und Prüfung.** Der Assistent prüft:
   - Windows-Version und Edition
   - Virtualisierung im BIOS aktiv
   - Hyper-V bzw. WSL vorhanden oder nachinstallierbar
   - freier RAM (mindestens 4 GB frei) und Platte (mindestens 40 GB)
   - ob Port 8080 frei ist

   Jede Prüfung zeigt ✓ oder ✗ mit Erklärung und Lösung.
2. **Modus wählen.** Hyper-V-VM oder WSL2. Die passende Vorgabe ist schon ausgewählt (siehe 3.2), mit einem Satz zum Unterschied.
3. **Einstellungen:**
   - Installationsort und Datenlaufwerk (die Gameserver brauchen Platz)
   - RAM und Kerne für die VM
   - Panel-Port
   - Portbereich für Gameserver (Vorgabe 25500–25600)
   - Zeitzone
   - optional Domain für HTTPS (Caddy)
4. **Admin-Konto.** Benutzername und E-Mail eingeben. Das Passwort wird erzeugt und **einmal** angezeigt, mit Knopf zum Kopieren und zum Speichern als Datei.
5. **Installation mit Fortschritt:**
   - Windows-Funktionen einschalten (Hyper-V bzw. WSL). Falls nötig: Neustart, danach macht der Installer selbst weiter.
   - Debian-Image laden und VM oder Distribution anlegen
   - Docker Engine installieren
   - Panel installieren
   - Firewall-Regeln anlegen (`New-NetFirewallRule` für Panel-Port und Portbereich, TCP und UDP)
   - Autostart einrichten: VM mit „automatisch starten“, bei WSL eine geplante Aufgabe beim Hochfahren
6. **Fertig.**
   - Knopf „Panel öffnen“ (Browser mit der richtigen Adresse)
   - Knopf „App herunterladen“
   - Hinweis, welche Ports im Router weitergeleitet werden müssen
   - Link zum Protokoll der Installation

Später, wenn man die `.exe` erneut startet:

| Aktion | Was passiert |
| --- | --- |
| **Status** | Läuft die VM bzw. WSL? Antwortet das Panel? Welche Version ist installiert? |
| **Aktualisieren** | Vorher ein Backup, dann neue Version einspielen |
| **Reparieren** | Firewall, Autostart und Weiterleitungen neu setzen |
| **Deinstallieren** | Mit Abfrage „Spieldaten und Backups behalten?“. Vorgabe: **behalten**. |

### 3.4 Ohne Oberfläche: per Befehl

Dieselbe `.exe` kann alles auch ohne Fenster. Das ist für Server Core, Fernwartung per SSH oder PowerShell-Remoting und Skripte gedacht.

```powershell
# Alles mit Vorgaben, ohne Rückfrage (Hyper-V-Modus auf Server)
.\NexusPanel-Server-Setup.exe install --unattended --mode hyperv `
    --vm-ram 8GB --vm-cpus 4 --data-drive D: `
    --port 8080 --range 25500-25600 --admin dominik --admin-email dominik@example.de

.\NexusPanel-Server-Setup.exe status          # Zustand, Version, Adresse
.\NexusPanel-Server-Setup.exe update          # Backup + Update
.\NexusPanel-Server-Setup.exe backup --to E:\Sicherung
.\NexusPanel-Server-Setup.exe uninstall --keep-data
```

Für Rechner ohne vorherigen Download gibt es einen Einzeiler wie unter Linux:

```powershell
# Lädt das signierte Setup, prüft die Prüfsumme, startet ohne Oberfläche
irm https://<downloads>/install.ps1 | iex
# mit Parametern:
& ([scriptblock]::Create((irm https://<downloads>/install.ps1))) -Mode hyperv -Port 8080
```

- `install.ps1` ist nur ein kleiner Lader: Er holt die `.exe`, prüft ihren SHA-256-Wert und ihre Signatur und startet sie mit den Parametern. Die eigentliche Logik steckt in der `.exe` (Rust), nicht in einem langen PowerShell-Skript. Das vorhandene `install/install-windows.ps1` geht darin auf.
- Für Firmen-Verteilung (GPO, Intune) gibt es zusätzlich ein **MSI**, das die `.exe` im Modus `--unattended` aufruft.
- Rückgabewerte: `0` heißt fertig, `3010` heißt „Neustart nötig, danach mit `install --resume` weiter“. Das kennt Windows von MSI und lässt sich gut skripten.

### 3.5 Aufbau des Installers in Rust

```
apps/server-setup/
├── src/main.rs        Doppelklick ohne Parameter -> Fenster, sonst CLI (clap)
├── src/checks.rs      Systemprüfung (Edition, Virtualisierung, RAM, Platte, Ports)
├── src/hyperv.rs      VM anlegen/starten (PowerShell Hyper-V-Cmdlets bzw. WMI)
├── src/wsl.rs         wsl --install / --import, .wslconfig (mirrored), Autostart
├── src/linux.rs       Docker Engine + Panel in VM/Distro (ruft install-linux.sh)
├── src/firewall.rs    Firewall-Regeln anlegen/entfernen
├── src/state.rs       Fortsetzen nach Neustart, Protokolldatei
└── src/ui/            Slint-Oberfläche (Assistent, Status, Update, Deinstallation)
```

Die Kommandozeile und die Oberfläche teilen sich denselben Rust-Kern. Was im Fenster geht, geht auch per Befehl, und umgekehrt.

---

## 4. Bauen, Signieren, Veröffentlichen

### 4.1 Automatisch bauen

Ein **GitHub-Actions-Workflow** mit einem Durchlauf je Plattform:

| Durchlauf | Baut |
| --- | --- |
| windows-latest | App (NSIS, MSI) und Server-Setup (`.exe`, MSI) |
| macos-latest | App (`.dmg`, Universal) |
| ubuntu-latest | App (AppImage, `.deb`, `.rpm`) und Android (APK, AAB) |

- Ausgelöst durch ein Versions-Tag. Die Versionsnummer kommt wie beim Panel aus `package.json`.
- Ergebnis ist ein Release mit allen Dateien, SHA-256-Prüfsummen und der Update-Beschreibung für den Tauri-Updater.

### 4.2 Versionen

App und Server-Setup bekommen **dieselbe Versionsnummer wie das Panel**. Die App zeigt einen Hinweis, wenn Panel und App zu weit auseinanderliegen. Grundlage dafür ist eine neue API-Versionsangabe in `/api/v1/about`.

### 4.3 Signaturen (Kosten und Entscheidung)

| Was | Ohne Signatur | Mit Signatur |
| --- | --- | --- |
| Windows `.exe`/MSI | SmartScreen: „Der Computer wurde durch Windows geschützt“, man muss „Trotzdem ausführen“ klicken | Code-Signatur-Zertifikat (OV/EV) oder Microsoft „Trusted Signing“ (Abo) |
| macOS | Gatekeeper-Warnung, Öffnen per Rechtsklick | Apple-Entwicklerkonto, Notarisierung |
| Android APK | geht immer, braucht nur den eigenen Schlüssel | Play Store: einmalige Gebühr |
| Tauri-Updater | **Pflicht:** eigener Signaturschlüssel (kostenlos), sonst keine automatischen Updates | – |

Für den Anfang reicht es, ohne bezahlte Signaturen zu starten. Dann gibt es Warnungen und auf der Download-Seite eine Erklärung dazu. Die Updater-Signatur ist kostenlos und von Anfang an dabei.

---

## 5. Sicherheit

- **Zugangsdaten nur im Schlüsselbund des Systems:**
  - Windows: Anmeldeinformationsverwaltung
  - macOS: Schlüsselbund
  - Linux: Secret Service
  - Android: Keystore

  Nie im Klartext in Dateien.
- **Geräte-Token einzeln widerrufbar.** Ein verlorenes Handy wird im Panel abgemeldet, die anderen Geräte bleiben angemeldet.
- **Selbst signierte Zertifikate** nur nach bestätigtem Fingerabdruck. Ändert er sich, warnt die App deutlich und verbindet nicht stillschweigend.
- **Installer:**
  - lädt nur über HTTPS mit Prüfsumme
  - erzeugt Geheimnisse (JWT, Verschlüsselungsschlüssel, Admin-Passwort) **lokal**
  - bindet das Panel standardmäßig nur ans LAN
  - schlägt HTTPS mit Caddy vor, wenn eine Domain angegeben wird
- **Root und Admin.** Der Installer braucht Administratorrechte nur für die Installation. Das Panel selbst läuft danach ohne Administratorrechte auf dem Windows-Host. Unter Proxmox gilt weiterhin: kein root auf dem Host.

---

## 6. Umsetzung in Schritten

Die Aufwände sind grobe Schätzungen in Arbeitstagen für eine Person.

| Phase | Inhalt | Ergebnis | Aufwand |
| --- | --- | --- | --- |
| **A: Vorbereitung im Panel** | Geräte-Token und Geräteliste, Kopplung per QR-Code, CORS für die App, Ereignis-WebSocket, einstellbare API-Adresse in `web/`, Download-Seite | Panel ist bereit für Apps | 4–6 |
| **B: Mobile Ansicht** | Responsive Oberfläche (steht schon in Phase 7) | Panel auf dem Handy gut bedienbar, Voraussetzung für C | 4–7 |
| **C: Desktop-App** | Tauri-Projekt, Verbindungen, Schlüsselbund, Tray, Benachrichtigungen, Autostart, Updater, Builds für Windows/Linux/macOS | `NexusPanel-Setup.exe`, `.dmg`, AppImage/`.deb`/`.rpm` | 6–10 |
| **D: Android-App** | Android-Build, QR-Kopplung, Push (ntfy) | `NexusPanel.apk` | 4–6 |
| **E: Server-Setup Windows** | Rust-Installer: Prüfungen, Hyper-V-Modus, CLI, dann WSL2-Modus, Firewall, Autostart, Update, Deinstallation | `NexusPanel-Server-Setup.exe` + `install.ps1` | 8–14 |
| **F: Linux-Einzeiler** | `install.sh` über die Download-Adresse, Parameter für `--unattended` | `curl … \| sudo bash` | 1–2 |
| **G: Veröffentlichen** | GitHub Actions, Releases, Prüfsummen, optional Signaturen, winget/Homebrew, Play Store | Downloads für alle | 3–5 |
| H (optional) | iOS | App Store / TestFlight | 3–5 |

Sinnvolle Reihenfolge: **A → B → C → E → D → F → G**. Desktop-App und Windows-Installer bringen dir am meisten, weil das Panel bei dir auf einem Windows-PC entwickelt und betrieben wird.

---

## 7. Offene Entscheidungen

1. **Push aufs Handy:** ntfy/UnifiedPush (selbst gehostet, Empfehlung), Firebase oder nur bei geöffneter App?
2. **Signaturen:** Erst ohne (mit Warnungen) oder gleich Code-Signatur für Windows bzw. Apple-Konto?
3. **Download-Adresse:** z. B. `downloads.brogameryt.de` oder GitHub-Releases-Seite?
4. **iOS:** überhaupt gewünscht? Es braucht einen Mac.
5. **Installer-Oberfläche:** Slint (klein, reines Rust) oder Tauri (gleicher Look wie die App, etwas größer)?
6. **Name und Symbol:** „NexusPanel“ mit den Symbolen aus `web/public/branding`, je Theme eine Farbe?

---

## 8. Ergänzung (07.11.2026, 20:35): Laufzeiten – Docker, Podman, Windows nativ, eigenes System

### 8.1 Mehrere Laufzeiten statt einer

Das Panel bekommt eine **Laufzeit-Schicht**. Jeder Server läuft auf einer davon, wählbar je Server und je Host:

| Laufzeit | Wo | Trennung | Wofür |
| --- | --- | --- | --- |
| **Docker** (wie jetzt, Standard) | Linux, WSL2, Hyper-V-VM | stark | alle Linux-Server |
| **Podman** (neu, optional) | Linux | stark, zusätzlich **rootless**: root im Container ist nicht root auf dem Host | sicherheitsbewusste Hosts. Podman hat eine Docker-kompatible Schnittstelle, deshalb lässt sich der vorhandene Code (dockerode) großteils weiterverwenden. |
| **Windows nativ** (neu) | Windows 10/11, Windows Server, **ohne VM** | mittel | Windows-only-Spiele (ARK Ascended, Enshrouded, Farming Simulator) ohne Proton/Wine, wie bei AMP |

#### Podman

**Vorteile:** kein Hintergrunddienst mit root-Rechten, Container laufen unter einem normalen Benutzer.

**Zu prüfen:**
- Ports unter 1024 sind rootless nicht erlaubt. Für Gameserver egal, die nutzen höhere Ports.
- UDP-Leistung des rootless-Netzes (pasta/slirp4netns) bei vielen Spielern
- Ob RAM- und CPU-Limits greifen (cgroup v2 muss für den Benutzer freigegeben sein)
- Images, die zwingend als root starten wollen

**Umsetzung:**
- Laufzeit-Schnittstelle im Panel (`src/docker/client.ts` → `src/runtime/{docker,podman}.ts`)
- Podman-Socket statt Docker-Socket
- Testlauf aller Eggs (die Test-Funktion im Panel existiert schon)

#### Windows nativ (`nxagent`, Rust)

Ein kleiner **Windows-Dienst in Rust**. Er nimmt Befehle vom Panel entgegen: installieren, starten, stoppen, Konsole, Statistiken. Pro Server:
- eigener eingeschränkter Windows-Benutzer, Ordnerrechte nur auf den eigenen Server-Ordner
- **Job Object** mit harten Grenzen für RAM, CPU-Anteil und Prozessanzahl. Endet der Job, enden auch alle Kindprozesse – kein Server bleibt als Waise übrig.
- Firewall-Regel nur für die eigene `.exe` und die zugeteilten Ports
- Installation und Updates über SteamCMD für Windows. Fehlende VC++-Runtimes und DirectX installiert der Dienst nach.
- Konsole über die Ein- und Ausgabe-Kanäle des Prozesses (stdin/stdout), sonst RCON. Logs und Statistiken liefert der Dienst wie Docker.

**Eggs:** Jedes Spiel bekommt eine optionale Windows-Variante im Egg (`"windows": { "steam_app": …, "executable": …, "args": …, "config_files": … }`). Ohne diese Variante bietet das Panel für das Spiel auf einem Windows-Host nur die Docker-Laufzeit an.

**Nebeneffekt:** `nxagent` ist zugleich der Baustein für **mehrere Hosts**. Ein zweiter PC oder Server meldet sich mit seinem Agenten am Panel an.

**Grenzen:**
- Die Server sind weniger stark getrennt als in Containern. Für eigene Server und Freunde ist das vertretbar, für fremde zahlende Nutzer nicht die erste Wahl.
- Jede Windows-Variante eines Eggs muss einmal getestet werden.

**Aufwand:** grob 10–15 Arbeitstage für den Dienst und die ersten 3–4 Spiele.

### 8.2 Eigener Kernel? Nein – aber ein eigenes System auf Linux-Basis

**Ein eigener Kernel ist nicht machbar.** Ein Kernel braucht Treiber für jede Netzwerkkarte, jeden Festplatten-Controller und jede CPU, dazu Dateisysteme, Netzwerkstack und Speicherverwaltung. Die Gameserver selbst sind Linux- bzw. Windows-Programme. Ein eigener Kernel müsste sich nach außen exakt wie Linux verhalten, damit sie überhaupt laufen. Das ist die Arbeit von Jahrzehnten und tausenden Entwicklern, und am Ende hätte man ein schlechteres Linux.

**Machbar ist dagegen „NexusPanel OS“: eine eigene, schlanke Distribution auf dem Linux-Kernel.** Ein fertiges Abbild, das nur Panel und Container-Laufzeit enthält:

| Merkmal | Umsetzung |
| --- | --- |
| Verteilung | ISO zum Booten auf echter Hardware, fertiges Proxmox- und Hyper-V-Abbild (qcow2/vhdx), USB-Stick |
| Inhalt | Minimales Debian (oder eine Basis wie Flatcar/Fedora CoreOS), Docker oder Podman, Panel, Caddy. Nichts sonst. |
| Erster Start | Einrichtungs-Assistent im Browser: Netzwerk, Admin-Konto, Portbereich, Datenplatte. Keine Kommandozeile nötig. |
| Updates | Ganzes System als Abbild mit A/B-Partitionen. Schlägt ein Update fehl, startet automatisch die alte Version. Über den Update-Knopf im Panel. |
| Sicherheit | Nur lesbares Grundsystem, nur Panel-Port und Spielports offen, SSH optional |
| Werkzeuge zum Bauen | mkosi oder Debian live-build in GitHub Actions, gleiche Versionsnummer wie das Panel |

Damit hat man das Gefühl von „alles läuft auf unserem System“, ohne einen Kernel schreiben zu müssen. Windows-only-Spiele laufen dort weiterhin über Proton/Wine. Für sie bleibt „Windows nativ“ der bessere Weg.

**Aufwand:** grob 6–10 Arbeitstage für ein erstes bootfähiges Abbild mit Assistent, A/B-Updates zusätzlich 4–6.

### 8.3 Empfohlene Reihenfolge

1. Laufzeit-Schicht im Panel (Voraussetzung für alles andere)
2. **Windows nativ** (`nxagent`): größter Nutzen für dich, weil ARK und Enshrouded dann ohne Proton laufen
3. Podman als Option
4. NexusPanel OS als Abbild für Proxmox und Bare Metal

---

## 9. NexusCore – ein gemeinsamer Programmkern in Rust (07.11.2026, 20:40)

### 9.1 Idee

Statt vieler Einzelteile gibt es **einen Kern**, der überall gleich ist: unter Windows, Linux, macOS und in NexusPanel OS. Er erledigt alles, was direkt mit den Gameservern zu tun hat. Das Panel (Node.js) wird zur **Steuerzentrale**: Nutzer, Rechte, Oberfläche, Abrechnung der Ressourcen. Die eigentliche Arbeit macht NexusCore auf jedem Rechner.

Dieses Muster ist bewährt:
- **Pterodactyl:** Panel + „Wings“ (Go)
- **AMP:** ADS + Instanzen

Neu ist hier: ein Kern, der zugleich Docker, Podman und Windows nativ kann.

```
                 ┌──────────────────────────────┐
  Browser / App ─┤  NexusPanel (Steuerzentrale)  │  Nutzer, Rechte, Oberfläche, Eggs, Audit
                 └──────────────┬───────────────┘
                                │  gesicherte Verbindung (mTLS), JSON/WebSocket
          ┌─────────────────────┼─────────────────────┐
   ┌──────┴──────┐       ┌──────┴──────┐       ┌──────┴──────┐
   │ NexusCore   │       │ NexusCore   │       │ NexusCore   │
   │ Proxmox-VM  │       │ Windows-PC  │       │ Miet-Server │
   │ Docker      │       │ nativ       │       │ Podman      │
   └─────────────┘       └─────────────┘       └─────────────┘
```

### 9.2 Bausteine (Rust-Workspace `core/`)

| Teil | Aufgabe |
| --- | --- |
| `nexuscore` (Bibliothek) | Die gesamte Logik, von allen anderen Teilen genutzt |
| `nexuscored` (Dienst) | Läuft als Windows-Dienst, systemd-Dienst oder launchd. Spricht mit dem Panel. |
| `nxctl` (Kommandozeile) | Lokale Bedienung und Fehlersuche: `nxctl status`, `nxctl logs ark`, `nxctl backup ark` |
| eingebettet | Im **Server-Installer** (richtet den Kern ein) und optional in der **Desktop-App**: „Server auf diesem PC hosten“ |

### 9.3 Was der Kern kann

- **Laufzeiten hinter einer Schnittstelle** (Rust-Trait `Runtime`: anlegen, starten, stoppen, abwürgen, Konsole, Logs, Statistiken):
  - Docker (über die Bibliothek bollard)
  - Podman (Docker-kompatible Schnittstelle, rootless)
  - **Windows nativ** (Job Objects, eigener Benutzer je Server, siehe 8.1)
  - später optional Linux nativ (cgroups v2 über systemd-Scopes, ohne Container)
- **Spiele installieren:**
  - SteamCMD (Windows und Linux), Installationsskripte aus den Eggs
  - Proton nur dort, wo nötig
- **Dateien:** Dateimanager-Funktionen mit sicheren Pfaden (nichts außerhalb des Server-Ordners), Upload und Download, Revisionen
- **Backups:** tar + zstd, Prüfsummen, Rotation, Ziele lokal, NAS und S3
- **Live-Daten:** CPU, RAM, Netz und Platte je Server. Spielabfragen: Minecraft-Ping, A2S, RCON.
- **Ports:** Vergabe, Freigabe und Firewall-Regeln (unter Windows je `.exe`)
- **Selbst-Update** des Kerns, signiert, auf Wunsch vom Panel ausgelöst

### 9.4 Verbindung Panel ↔ Kern

- **Kopplung:**
  1. Im Panel auf „Host hinzufügen“ klicken.
  2. Einmal-Code eingeben bzw. im Installer einfügen.
  3. Kern und Panel tauschen Zertifikate aus.

  Danach sprechen sie nur noch über **mTLS** miteinander, beide Seiten weisen sich mit Zertifikat aus.
- **Schnittstelle:** HTTP/JSON für Befehle, WebSocket für Konsole, Logs und Statistiken. Versioniert (`/v1`), damit Panel und Kern nicht exakt gleich alt sein müssen.
- **Rechte:** Der Kern führt nur aus, was das Panel signiert anfordert. Benutzerrechte prüft weiterhin das Panel.

### 9.5 Warum Rust

- Eine einzige Datei je Betriebssystem, keine Laufzeit nötig (kein Node.js, kein Java)
- Sehr wenig RAM im Leerlauf
- Speichersicher: wichtig für einen Dienst mit hohen Rechten
- Gute Anbindung an Windows-Schnittstellen (`windows`-Crate: Job Objects, Dienste, Firewall) und an Docker (bollard)
- Dieselbe Sprache wie App (Tauri) und Installer: geteilter Code, z. B. Kopplung, Zertifikate, Update-Prüfung

### 9.6 Umstieg ohne Stillstand

Das Panel steuert Docker heute direkt (`src/docker/client.ts` und Umgebung). Der Umstieg erfolgt schrittweise:

1. **Schnittstelle im Panel:** Alle Server-Aktionen laufen über eine Schicht „Host“. Zunächst gibt es eine Umsetzung „lokal“ (der heutige Code) und eine „NexusCore“.
2. **NexusCore v0.1 mit Windows nativ.** Neue Fähigkeit, nichts Bestehendes wird angefasst. ARK und Enshrouded können auf einem Windows-PC laufen.
3. **NexusCore übernimmt Docker** auf der VM. Der lokale Docker-Code im Panel wird zum Rückfall-Weg und fällt später weg.
4. **Mehrere Hosts** sind damit automatisch möglich: Ein neuer Rechner bekommt den Kern über den Installer und wird im Panel gekoppelt.

### 9.7 Aufwand und Risiken

| Schritt | Aufwand (grob, Arbeitstage) |
| --- | --- |
| Host-Schicht im Panel | 3–5 |
| NexusCore-Grundgerüst: Dienst, Kopplung/mTLS, API, Statistiken, Konsole | 8–12 |
| Windows nativ (Job Objects, Benutzer, SteamCMD, Firewall) + 3–4 Eggs | 10–15 |
| Docker- und Podman-Laufzeit im Kern, Umzug der VM | 6–10 |
| Backups und Dateien im Kern | 5–8 |

**Risiken:**
- **Zwei Sprachen** im Projekt: TypeScript für Panel und Oberfläche, Rust für Kern, App und Installer. Mehr Pflegeaufwand, dafür klare Trennung.
- **Versionsabgleich** zwischen Panel und Kern: gelöst über die versionierte Schnittstelle und eine Kompatibilitätsprüfung beim Verbinden.
- **Sicherheit:** Der Kern läuft mit hohen Rechten (Windows-Dienst bzw. Zugriff auf Docker). Darum gelten mTLS, signierte Updates, kein offener Port ohne Zertifikat und ein Audit-Log im Kern.
