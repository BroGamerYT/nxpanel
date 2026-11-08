# TODO

Was ansteht, was geplant ist, was erledigt ist. Das Panel zeigt diese Datei
unter „Was ist neu → Geplant“ an.

Format: `- [ ] Aufgabe` offen, `- [x] Aufgabe (0.5.0)` erledigt mit der
Version, in der es kam. Wann genau etwas gebaut wurde, steht im
Entwicklungslog, was eine Version enthält, im CHANGELOG.

## Bis 1.0

1.0 gibt es erst, wenn du das Panel für zufriedenstellend erklärst. Vorschlag, was dafür stehen sollte (anpassen, streichen, ergänzen):

- [ ] Alle AMP-Server umgezogen und laufen stabil, VM 101 gelöscht
- [x] Dateimanager und Backups (Phase 5) (0.12.0)
- [x] Speicher-Limit wird durchgesetzt (0.14.0)
- [x] Mitnutzer und Admin-Bereich in der Oberfläche (0.16.2)
- [ ] Panel von außen über HTTPS erreichbar (Caddy), 2FA für Admins Pflicht
- [x] 1-Klick-Update-Button für Panel und Gameserver (mit automatischem Backup vor dem Update) (0.18.0) (Gameserver- & Modpack-Updates umgesetzt)
- [x] Globale Panel-Suche (Strg+K) für Server, Einstellungen, Menüs und Direktaktionen (0.12.0)

## Als Nächstes

- [x] Online-Spieler je Server anzeigen – Minecraft (0.13.0)
- [x] Online-Spieler für weitere Spiele: ARK und Palworld mit Kicken/Bannen, Valheim/7DTD/SotF/CS2 anzeigen (0.15.0)
- [x] Spieler kicken, bannen (mit Begründung und Dauer) sowie Bann- und Whitelists im Panel verwalten – Minecraft (0.13.0)
- [ ] DDNS und eigene Subdomains je Server (Cloudflare, DuckDNS, Hetzner DNS) mit automatischen SRV-Records (ohne Portangabe beitreten)
- [x] 1-Klick Update-Button im Panel: Panel selbst aktualisieren & Server-Dateien auf Knopfdruck updaten (0.23.0)
- [x] Globale Suche / Befehlspalette (Strg+K): blitzschnell Server, Einstellungen, Menüs und Dateien finden (0.12.0)
- [x] Visuelle Konfigurations-Formulare für Spieleggs in Server-Einstellungen (0.12.0)
- [x] Spielvorlagen für alle Server (Palworld, Rust, Valheim, CS2, Satisfactory, 7 Days to Die, Sons of the Forest, TeamSpeak 3) (0.12.0)
- [x] MOTD-Editor für Minecraft: Farben, Formatierung, Vorschau, Server-Icon (0.13.0)
- [x] TPS und Ping für jeden Minecraft-Typ (Vanilla, Paper/Spark, Fabric, NeoForge) (0.13.0)
- [x] Netzwerk je Server als Verlauf (0.14.0)
- [x] Speicher-Limit durchsetzen: Server bei Überschreitung nicht mehr starten, Hinweis vorher (0.14.0)
- [x] Docker aufräumen per Knopf (ungenutzte Images, Build-Cache) (0.14.0)
- [ ] Bandbreiten-Limit je Server (Upload/Download), vom Admin einstellbar
- [ ] Umzug Minecraft Vanilla und Enshrouded aus AMP (Probelauf)
- [ ] Umzug ARK (Simon) aus AMP
- [ ] VM 101 sichern (Storage Box), löschen, alte Weiterleitungen 24000–26000 entfernen
- [ ] SRV-Eintrag ts.germanylangame.de auf Port 28000

## Panel und Community

- [x] Logo (0.11.0)
- [x] Hinweis im Panel, wenn auf GitHub eine neue Version erscheint (0.11.0)
- [x] Community-Seite (0.11.0)
- [x] Steam-Konten zentral hinterlegen, Steam-Guard-Code im Panel eingeben (0.11.0)

## Übersetzung

- [x] Spielvorlagen (Eggs) mehrsprachig: Feldnamen und Hinweise je Sprache (0.11.0)
- [x] Zeitachsen-Meldungen übersetzbar (Code + Werte statt fertigem Satz) (0.11.0)

## Phase 5 – Dateien und Backups (Abgeschlossen)

- [x] Dateimanager (Baum, Upload mit Fortschritt, Verschieben, Editor) (0.12.0)
- [x] Packen und Entpacken im Hintergrund (0.12.0)
- [x] Backups als tar.zst, Wiederherstellen und Namensschema (0.12.0)
- [x] Auto-Backup mit Aufbewahrung (Retention) (0.12.0)
- [x] Backup-Integritätsprüfung und Funktionalitäts-Check (SHA-256, TAR/Zstd-Stream, Spieldateien) (0.12.0)
- [x] Cloud- und Netzwerk-Backups: Ziel AWS S3 / Cloudflare R2 / MinIO (0.15.0)
- [x] Netzwerk-Backups: Hetzner Storage Box (SFTP, SMB, NFS, WebDAV) & Speicherziele (0.15.0)
- [x] Netzwerk-Backups: UGREEN NAS / TrueNAS / Synology über SMB/CIFS & Tailscale mit lesbaren Pfaden (0.14.0 / 0.15.0)
- [x] Zeitpläne (Neustart, Backup, Befehl) mit Cron/Intervallen und Sofortausführung (0.15.0)
- [x] Dateiversionierung & Revisions-Historie mit Diff-Vorschau und Rollback (0.15.0)
- [x] Log-Reiter mit Suche und Download (0.10.0)
- [x] Konfigurationsdateien als Formular (server.properties, INI, JSON usw.) im Dateimanager (0.12.0)
- [x] 8 neue Spiel-Vorlagen (Eggs) hinzugefügt: Palworld, Rust, Valheim, CS2, Satisfactory, 7 Days to Die, Sons of the Forest, TeamSpeak 3 (0.12.0)
- [x] Formularfelder bestehender Eggs massiv um Gameplay- und Welteinstellungen erweitert (0.12.0)
- [x] Titelbilder je Spiel (Steam / Panel-Motiv / eigenes Bild), Spielauswahl als Kacheln oder Liste (0.16.0)
- [x] 4 neue Eggs: Minecraft Bedrock, Factorio, V Rising, Core Keeper (0.16.0, auf der VM noch zu testen)
- [x] Modpacks: Suche (CurseForge, Modrinth, FTB), eigene Pack-Datei, Update-Anzeige und 1-Klick-Update mit Backup (0.18.0)
- [x] Terraria, Project Zomboid, Mumble (0.18.1, auf der VM noch zu testen)
- [x] Weitere Eggs: Garry's Mod, Velocity-Proxy (mit TOML-Konfiguration), Don't Starve Together (0.20.0 / 0.23.0)

## Spieler und Moderation

- [x] Live-Anzeige aller verbundenen Spieler (Name, Avatar/Skin, Ping, Spielzeit) (0.13.0 / 0.15.0)
- [x] Moderation: Spieler kicken und bannen mit Grund, Whitelist/OP-Rechte per Mausklick (0.13.0 / 0.15.0)
- [x] Listen-Verwaltung: Bannliste, Whitelist, VIP/OP-Listen direkt im Panel durchsuchen und bearbeiten (0.13.0)

## Netzwerk und Domains

- [ ] DDNS-Unterstützung für dynamische Host-IPs (Cloudflare API, Hetzner DNS, DuckDNS, Custom Webhook)
- [ ] Eigene Subadressen je Gameserver (z. B. mc.meinedomain.de) unabhängig von der IP des Host-Servers
- [ ] Automatische SRV-Records für Minecraft und TeamSpeak (Spieler treten ohne Portangabe bei)

## Phase 6 – Mehrbenutzer und Rechtesystem (Abgeschlossen)

- [x] Mitnutzer-Verwaltung in der Oberfläche mit Presets und Checkbox-Matrix (0.16.2)
- [x] Feingranulare Power-Rechte: Start/Stop getrennt von Neustart/Kill (0.16.2)
- [x] Admin-Bereich in der Oberfläche: Nutzerverwaltung mit Rollen, Limits & 2FA-Reset (0.16.2)
- [x] Erlaubte Spielvorlagen (Egg-Whitelisting je Benutzer) (0.16.2)
- [x] Globales Audit-Log in der Oberfläche mit Live-Filtern (0.16.2)
- [ ] Einladung per E-Mail
- [x] Aktivitätsansicht je Server in der Oberfläche (0.23.0)

## Phase 7 – Komfort

- [ ] RCON für Spiele ohne Konsole
- [x] Benachrichtigungen (Panel, Discord-Webhook bei Absturz) (0.23.0)
- [x] Befehlspalette Strg+K, Favoriten, Tags (0.23.0)
- [ ] SFTP mit Panel-Login
- [x] Modpacks und Plugins (Modrinth, CurseForge, Workshop) (0.18.0)
- [ ] Versions-Updater mit Backup und Rücksprung
- [x] Mobile Ansicht (0.23.0)
- [ ] Mehrere Hosts (Nodes)
- [ ] Prometheus/Grafana

## Optimierung und Sicherheit

- [x] Geheime Werte nur an Nutzer mit Änderungsrecht (0.18.1)
- [x] Minecraft-RCON nicht mehr am Host freigegeben (0.18.1)
- [x] RCON von ARK und Palworld ebenfalls nur intern (0.19.0)
- [x] Oberfläche lädt Seiten erst beim Öffnen: Start-JavaScript von 1,1 MB auf rund 0,45 MB, Konsole (xterm) nur auf der Serverseite (0.19.0)
- [ ] Ergebnisse des Spiele-Testlaufs auswerten und fehlerhafte Eggs reparieren
- [x] Sprachdateien nur für die gewählte Sprache laden (0.23.0)
- [x] Absprache zwischen den Sessions: vor jeder Version CHANGELOG und package.json prüfen (doppelte Versionsnummern vermeiden) (0.23.0)

## Apps und Installer (Konzept: docs/KONZEPT-APPS.md, Gesamtbild: docs/ARCHITEKTUR.md)

- [ ] Entscheidungen: Push (ntfy/Firebase/keins), Signaturen, Download-Adresse, iOS ja/nein, Installer-Oberfläche (Slint/Tauri)
- [ ] Panel: Geräte-Token mit Geräteliste und einzeln abmelden
- [ ] Panel: Kopplung per QR-Code (Einmal-Code gegen Geräte-Token)
- [ ] Panel: CORS/Herkunft für Tauri-Apps, Ereignis-WebSocket für Benachrichtigungen
- [ ] Panel: einstellbare API-Adresse in der Oberfläche, Download-Seite /apps mit QR für die APK
- [x] Mobile Ansicht (Voraussetzung für die Android-App) (0.23.0)
- [ ] Desktop-App (Tauri 2, Rust): Verbindungen, Schlüsselbund, Tray mit Serverstatus, Benachrichtigungen, Autostart, Updater
- [ ] App-Pakete: Windows (NSIS-.exe, MSI), macOS (.dmg Universal), Linux (AppImage, .deb, .rpm)
- [ ] Android-App (APK/AAB) mit QR-Kopplung und Push
- [ ] Server-Setup für Windows in Rust: eine .exe mit Assistent (Doppelklick) und Befehlszeile (--unattended)
- [ ] Server-Setup: Hyper-V-Modus (eigene VM mit LAN-IP, auch Windows Server Core)
- [ ] Server-Setup: WSL2-Modus mit Mirrored-Netzwerk (Windows 11), Hinweis bei Windows 10
- [ ] Server-Setup: Prüfungen, Firewall-Regeln, Autostart, Status, Update mit Backup, Reparieren, Deinstallieren (Daten behalten)
- [ ] Einzeiler: `irm …/install.ps1 | iex` (Windows) und `curl …/install.sh | sudo bash` (Linux)
- [ ] MSI für Verteilung per GPO/Intune
- [ ] GitHub Actions: Builds für alle Plattformen, Releases mit Prüfsummen, Updater-Signatur
- [ ] Optional: Code-Signatur Windows, Apple-Notarisierung, winget, Homebrew, Play Store, iOS
- [ ] Laufzeit-Schicht im Panel: Docker, Podman und Windows nativ austauschbar (Konzept Abschnitt 8)
- [ ] Windows nativ ohne VM: Rust-Dienst `nxagent` mit Job Objects, eigenem Benutzer je Server, SteamCMD, Firewall je .exe
- [ ] Windows-Varianten in den Eggs (zuerst ARK Ascended, Enshrouded, Farming Simulator, Palworld)
- [ ] Podman (rootless) als optionale Laufzeit unter Linux, Testlauf aller Eggs
- [ ] NexusPanel OS: schlankes Linux-Abbild (ISO, Proxmox/Hyper-V), Einrichtung im Browser, A/B-Updates
- [ ] NexusCore (Rust): gemeinsamer Kern für alle Hosts – Dienst `nexuscored`, Kommandozeile `nxctl`, Kopplung mit mTLS (Konzept Abschnitt 9)
- [ ] Host-Schicht im Panel: alle Server-Aktionen über „lokal“ oder „NexusCore“
- [ ] NexusCore übernimmt Docker/Podman, danach Dateien und Backups; mehrere Hosts im Panel
- [ ] Umsetzung nach den Meilensteinen M1–M8 in docs/ARCHITEKTUR.md (Start: M1 Host-Schicht, M2 Kern-Grundgerüst, M3 Windows nativ)

## Erledigt

- [x] Logdateien je Server (neueste zuerst), ARK-Spiel-Log in der Konsole, EOS-Hinweise und Verbindungstest (0.10.0)
- [x] Konsole: Fehlerliste rechts, Farben, Suche und Filter (0.9.0)
- [x] Speicherbelegung je Server, gesamt und von Docker (0.8.0)
- [x] Liste oder Kacheln, Gesamtlast, Grundleistung des Hosts, Netzwerk-Rate live (0.7.0)
- [x] Sprachen als Module: Deutsch und Englisch, je Sprache eine Datei, Wahl am Konto (0.6.0)
- [x] Versionsnummer, Build-Nummer und „Was ist neu“ im Panel (0.5.0)
- [x] Server aus Backup anlegen mit Erkennung von Spiel und Einstellungen (0.5.0)
- [x] Umzug TeamSpeak 6 (Germany LanGame) aus AMP (0.4.3)
- [x] Backup übernehmen, Spiele ARK SA, Enshrouded, TeamSpeak 6 (0.4.3)
- [x] Server-Einstellungen: Variablen, Ressourcen, Java-Version, Ports (0.4.2)
- [x] Port-Bereich 28000–28999 und Netzwerk-Seite (0.4.1)
- [x] Weboberfläche (0.4.0)
- [x] Zwei-Faktor, REST-API, OpenAPI (0.3.0)
- [x] Anmeldung, Rechte, Audit-Log (0.2.0)
- [x] Grundgerüst, Container-Kern, Eggs, Ports, Updater (0.1.0)

## Eggs (0.20.0)
- [x] Egg-Katalog aller Pelican-Eggs mit Bewertung (`docs/EGG-KATALOG.md`)
- [x] 25 Spiele direkt als Panel-Eggs eingebaut
- [x] Admin-Import-Button für Egg-JSON
- [x] Online-Egg-Katalog-Suche (350+ Spiele, Aliase, Tippfehler-Toleranz & 1-Klick-Import) (0.23.0)
- [ ] Neue Eggs auf VM 120 testen (Start, Ports, Abfrage)
- [x] Rechnerische Zusatzports (Spielport + 1) als `offset` ergänzen, z. B. Unturned (0.23.0)
- [x] Startmuster für Eggs ohne `done`-Text nachtragen (0.23.0)

## Downloads und Tests (0.20.1)
- [x] SteamCMD schneller (HTTP/2 aus, mehr Content-Server)
- [x] Tests gegen eigene Testdatenbank
- [ ] Download-Geschwindigkeit auf VM 120 nachmessen (vorher ca. 20 Mbit/s)
- [ ] Falls weiter langsam: Netzwerkkarte der VM (virtio?) und MTU prüfen
- [ ] Testabdeckung messen (`@vitest/coverage-v8`), Docker-Tests auf der VM automatisieren

## Spieletest 07.11. (0.21.2)
- [x] Project Zomboid: Admin-Passwort automatisch erzeugen
- [x] CS2: doppelte Variable, Hinweis Platte voll
- [ ] Freien Speicher der VM prüfen (`df -h`) – CS2 (0x202) und vermutlich 7 Days to Die sind an voller Platte gescheitert
- [ ] Spieletest für CS2, 7 Days to Die, V Rising, Project Zomboid wiederholen
- [ ] V Rising: falls „Missing configuration“ bleibt, auf Pelican-Egg (Installer + Wine-Yolk) umstellen

## Admin-Dateimanager (0.22.0)
- [x] Dateimanager für die Panel-Ordner auf der VM, nur Admins
- [x] Speicherbelegung je Ordner
- [x] Optional: Panel-Installation (/opt/nxpanel) read-only einbinden und per `ADMIN_FILE_ROOTS` zeigen (0.23.0)
- [x] Docker-Belegung (Images, Container-Schichten) je Server anzeigen – große Container-Schichten = Spieldaten außerhalb des Datenordners (0.23.0)

## Server-Betrieb & Konfigurator (0.23.0)
- [x] Auto-Start an-/abschaltbar je Server mit 5-Versuche-Limit und direkter „Nicht startbar“-Anzeige am Panel (0.23.0)
- [x] Mod- & Plugin-Konfigurator (`config/`, `defaultconfigs/`, `world/serverconfig/`, `BepInEx/config/` etc.) inkl. `.toml`- und `.yml`-Formular-Editor (0.23.0)
- [x] Deploy (`deploy.bat`) durch lokalen Vorab-Build und stabiles Docker-Layer-Caching beschleunigt (0.23.0)
