# Änderungen

<p align="center">
  <b>🇩🇪 Deutsch</b> &nbsp;•&nbsp; <a href="CHANGELOG.en.md"><b>🇬🇧 English</b></a>
</p>

Alle Versionen von NexusPanel, neueste oben. Das Panel zeigt diese Datei
unter „Was ist neu“ an (Klick auf die Versionsnummer unten links).

Nummerierung nach [Semantic Versioning](https://semver.org/lang/de/):
`0.MINOR.PATCH` – MINOR für neue Funktionen, PATCH für Fehlerbehebungen.
Solange die Version mit 0 beginnt, kann sich noch alles ändern. **1.0 gibt es erst, wenn Dominik das Panel für zufriedenstellend erklärt** – bis dahin zählt es weiter 0.10, 0.11, 0.12 … (nach 0.9 kommt also 0.10, nicht 1.0).

Format einer Version (so liest sie das Panel):

    ## [1.2.3] – JJJJ-MM-TT – Kurzer Titel
    ### Neu | Geändert | Behoben | Sicherheit
    - Punkt

Bis 0.4.x wurden Nachträge ohne eigene Nummer ausgespielt; sie sind hier
nachträglich anhand des Entwicklungslogs eingeordnet. Ab 0.5.0 bekommt
jede Auslieferung eine eigene Nummer.

## [0.23.0] - 2026-11-08 – Online-Egg-Suche, Auto-Start-Limit, Mod-Konfigurator & TODO-Paket

### Hinzugefügt
- **Online-Egg-Katalog & intelligente Suche (350+ Spiele)**: Unter „Neuer Server → Spiel importieren (JSON)“ und in der Spielsuche durchsucht das Panel jetzt den gesamten Pelican- und Pterodactyl-Katalog (`pelican-eggs/*`, `pterodactyl/game-eggs`) sowie bei Bedarf öffentliche GitHub-Repos. Unterstützt deutsche Namen, Abkürzungen (`ls25`, `cs2`, `gta`, `mc`, `7d2d`, `asa`, `ets2` …) und fehlertolerante Tippfehler-Suche (Fuzzy-Search). Gefundene Vorlagen werden per 1-Klick importiert und automatisch auf NexusPanel umgestellt.
- **Egg-Vorlage & CLI-Werkzeuge**: Kommentierte Vorlage `eggs/_egg-vorlage.json.example`, Handbuch `docs/EGG-VORLAGE.md` und neue Befehle `npm run egg -- search`, `convert` und `check`.
- **Auto-Start mit 5-Versuche-Limit & „Nicht startbar“-Anzeige**: Auto-Start lässt sich direkt auf jeder Server-Kachel, im Serverkopf und in den Einstellungen per Klick aktivieren oder deaktivieren. Stürzt ein Server 5-mal hintereinander ab, bleibt er ausgeschaltet und zeigt direkt am Panel das rote Badge **„Nicht startbar (5/5 Abstürze)“** samt Warnhinweis an.
- **Mod- & Plugin-Konfigurator**: Der visuelle Konfigurations-Editor unter „Einstellungen → Konfigurationsdateien“ durchsucht jetzt automatisch Mod- und Plugin-Ordner (`config/`, `defaultconfigs/`, `world/serverconfig/`, `BepInEx/config/`, `oxide/config/`, `plugins/`) und stellt `.toml`-, `.cfg`-, `.ini`-, `.yml`- und `.json`-Dateien inkl. der `#`-Kommentare der Mod-Entwickler als interaktive Formulare mit Gruppenfilter und Suche dar.
- **Aktivitätsansicht je Server**: Im Reiter „Zeitachse“ können Berechtigte (`activity.read`) zwischen den Server-Ereignissen und dem Benutzer-Aktivitätsprotokoll (Audit-Log des Servers inkl. Aktion, Nutzer, Details und IP) umschalten.
- **Docker-Container-Schicht je Server & Read-Only-Ordner im Admin-Dateimanager**: Auf der Serverseite wird neben dem Speicherplatz auch die Größe der schreibbaren Container-Schicht (`SizeRw`) angezeigt (mit Warnhinweis, falls ein Spiel Daten außerhalb von `/home/container` ablegt). `ADMIN_FILE_ROOTS` unterstützt `:ro` (z. B. `Panel-Installation=/opt/nxpanel:ro`).
- **Favoriten & Tags für Server**: Server lassen sich per Stern-Klick als Favorit oben in der Serverliste anheften und mit frei wählbaren `#Tags` versehen (inkl. Tag-Filter in der Serverliste und Suche in der Befehlspalette `Strg+K`).
- **1-Klick-Update für alle Spiele mit Vorab-Backup**: Neben Modpacks können nun alle Spielserver über den „Aktualisieren“-Dialog mit einem Klick aktualisiert werden (optionales Sicherheits-Backup vorab, Ziehen des neuesten Docker-Images, Container-Rebuild und automatischer Neustart).
- **Panel-Benachrichtigungsglocke & Mobile Ansicht**: Neue Benachrichtigungsglocke in der Kopfleiste mit Zähler für ungelesene Warnungen/Abstürze/Updates und Direktsprung zum Server sowie ausklappbares Burger-Menü und horizontal scrollbare Reiter für Smartphones.

### Geändert
- **Sprachdateien nach Bedarf laden**: Die Oberfläche lädt nur noch die Sprachdatei der gewählten Sprache (`de.json` oder `en.json`) statt alle Sprachen ins Start-Bundle zu packen.
- **Rechnerische Zusatzports & Startmuster**: Der Egg-Importer erkennt `SERVER_PORT + N`-Ausdrücke sowie Spiele wie Unturned und Barotrauma automatisch als `offset`-Port und vergibt für Vorlagen ohne eigenes `done`-Muster ein allgemeines Bereitschafts-Muster.
- **Deutlich schnelleres Deploy (`deploy.bat`)**: Lokaler Vorab-Build von Backend und Oberfläche, stabiles Docker-Layer-Caching (`mtime=0` im Manifest), asynchrones Egg-Seeding beim Start und 1,5 s Shutdown-Timeout beim Container-Neustart.

## [0.22.1] - 2026-11-07

### Geändert
- **Dateien (VM): Server-Ordner mit Namen.** Unter `volumes` steht neben jedem Ordner (Kurz-ID) der Servername und das Spiel, z. B. „Simon Ark · ARK: Survival Ascended“, auch in der Speicherbelegung. Die Ordner selbst behalten ihre Kurz-ID, weil Docker und das Panel sie darüber ansprechen.
- Ordner ohne zugehörigen Server werden als „kein Server mehr – Rest eines gelöschten Servers“ markiert. Die kann man löschen, um Platz zu schaffen.

## [0.22.0] - 2026-11-07

### Hinzugefügt
- **Dateimanager für die VM (nur Admins)**: neuer Menüpunkt „Dateien (VM)“ (`/admin/dateien`). Zeigt alle Ordner des Panels auf der VM – Spieldaten aller Server, Backups, Testberichte (`/var/lib/panel`) und die NAS-Backups – wie der Instanz-Ordner bei AMP. Gleicher Funktionsumfang wie der Server-Dateimanager: Ordner durchsuchen, Dateien bearbeiten, hoch- und herunterladen, umbenennen, löschen, packen, entpacken.
- **Speicherbelegung**: „Speicherbelegung anzeigen“ misst die Größe der Unterordner (größte zuerst, per Klick tiefer). Hilft beim Aufräumen voller Platten.
- Weitere Ordner lassen sich mit `ADMIN_FILE_ROOTS` ergänzen (z. B. `Panel-Installation=/opt/nxpanel`), sie müssen im Panel-Container eingebunden sein. Zugriff auf `/` des Hosts ist bewusst ausgeschlossen.
- Jede ändernde Aktion steht im Audit-Log (`admin.file.*`). Gleiche Pfadprüfung wie beim Server-Dateimanager (kein `..`, keine Symlinks nach außen).
- API `/api/v1/admin/files/...` dokumentiert, Test `admin-files.test.ts`.

## [0.21.2] - 2026-11-07

### Behoben (aus dem automatischen Spieletest)
- **Project Zomboid** ließ sich nicht anlegen („Ungültige Werte: ADMINPASSWORD“). Pflicht-Passwörter ohne Vorgabe bekommen jetzt automatisch ein Zufallspasswort: neue Vorgabe `{{GENERATE_PASSWORD}}` in Eggs. Leer lassen → das Panel erzeugt ein sicheres Passwort, das danach in den Einstellungen sichtbar ist. Genauso umgestellt: ARK (Admin-Passwort), Abiotic Factor, Assetto Corsa, CS2 (RCON-Passwort statt festem „CS2AdminPass!“).
- **Counter-Strike 2:** doppelte Variable `CS2_RCON_PASSWORD` entfernt. Der Fehler „state is 0x202“ bedeutet: zu wenig freier Speicher. Speicherbedarf auf 64 GB angehoben, Hinweis in der Konsole.
- **Velocity:** leeres Pflichtfeld `USER_AGENT` hatte keine Vorgabe.
- **V Rising:** Hinweis bei „Missing configuration“ (vorübergehender SteamCMD-Fehler; erneut starten).
- **7 Days to Die:** Hinweise für volle Platte und zu wenig RAM, Speicherbedarf 30 GB.

### Hinzugefügt
- Warnung im Installationsprotokoll, wenn auf dem Datenträger weniger frei ist als dem Server zugeteilt.
- Hinweis „Festplatte voll“ (auch bei SteamCMD-Code 0x202) bei CS2, 7 Days to Die, V Rising und Project Zomboid.
- Test `bundled-eggs.test.ts` prüft alle mitgelieferten Eggs: keine doppelten Variablen, Pflichtfelder mit Vorgabe (außer Konten, Lizenzen, Tokens), gültige Hinweis-Muster. Läuft auch beim Deploy ohne Datenbank.

## [0.21.1] - 2026-11-07

### Geändert
- **Schnelleres Einspielen:** Das Docker-Image installiert die npm-Pakete nicht mehr bei jedem Update neu. Bisher hat die neue Versionsnummer in `package.json` alle drei `npm ci`-Schritte jedes Mal ungültig gemacht. Jetzt arbeiten die Installationsschritte mit einer Kopie ohne Versionsnummer und kommen aus dem Cache, solange sich keine Abhängigkeiten ändern. npm-Downloads liegen zusätzlich in einem BuildKit-Cache.
- `remote-update.sh` zeigt bei jedem Schritt die Sekunden seit Start und prüft die Bereitschaft alle 0,5 s statt alle 2 s.
- `deploy.bat` zeigt am Ende die Gesamtdauer.
- `.dockerignore` schließt Tests, Deploy-Dateien und Archive aus.

## [0.21.0] - 2026-11-07 - Dokumentations-Bibliothek & universeller Markdown-Viewer

### Neu
- **Dokumentations-Bibliothek (`/docs`, `/hilfe`)**: Neuer Reiter „Dokumentation (.md)“ in Hilfe & Doku zum Durchsuchen und Betrachten aller 12 Markdown-Dokumente des Projekts (`ARCHITEKTUR.md`, `EGG-KATALOG.md`, `KONZEPT-APPS.md`, `Game-Server-Panel – Konzept & Roadmap.md`, `GAME-INSTALL-TESTS.md`, `TODO.md`, `ENTWICKLUNGSLOG.md`, `CHANGELOG.md`, `README.md`, `VM-INFOS.md`, `SECURITY.md`, `CONTRIBUTING.md`).
- **Universeller .md-Switcher**: Schneller Wechsel zwischen Dokumenten über Kategorien (Architektur, Spiele & Eggs, Konzepte & Planung, Verlauf, Allgemein), Live-Suche, Kachel-Übersicht sowie „Vorheriges / Nächstes Dokument“.
- **Strukturierter Markdown-Viewer (`MarkdownViewer`)**: Sicheres GitHub-Flavored-Markdown (GFM) Styling mit Syntax-Badges, formatierten Tabellen, Checkboxen, Callouts, Anker-Überschriften und Umschalter zwischen formatierter Ansicht und Markdown-Quelltext.
- **Inhaltsverzeichnis & Aktionen**: Automatisches Inhaltsverzeichnis (TOC) mit Sprungmarken für jedes Dokument, 1-Klick-Kopieren und .md-Download.
- **Dateimanager-Vorschau**: Im Editor des Dateimanagers können `.md`-Dateien nun per Knopfdruck zwischen Editor und formatierter Vorschau umgeschaltet werden.
- **Testbericht-Modal**: `GAME-INSTALL-TESTS.md` im Admin-Testbericht wird jetzt formatiert mit GFM-Tabellen gerendert.
- **Globale Suche (Strg+K)**: Alle Markdown-Dokumente sind direkt aus der Befehlszeile auffindbar und anspringbar.

## [0.20.2] - 2026-11-07

### Behoben
- `deploy.bat` brach ohne lokales Postgres mit „Testdatenbank panel_test nicht erreichbar“ ab. Die Test-Einrichtung warnt jetzt nur, die Unit-Tests ohne Datenbank laufen weiter.

### Geändert
- `deploy.ps1` führt ohne Datenbank zusätzlich `steam-tuning.test.ts` und `test-db.test.ts` aus.
- Der Shell-Test für `steam_dev.cfg` wird unter Windows übersprungen (braucht Linux-`find`), auf Linux läuft er weiter.
- Weboberfläche baute nicht: `MarkdownViewer` nutzte für Tabellen noch die alte marked-Schnittstelle (`header, body`). Jetzt passend zu marked 18 (Token mit Zellen), Tabellen werden wieder korrekt dargestellt.

## [0.20.1] - 2026-11-07

### Geändert
- **Schnellere Spiel-Downloads über SteamCMD:** Das Panel hängt an jeden SteamCMD-Aufruf im Installationsskript `+@nClientDownloadEnableHTTP2PlatformLinux 0 +@fDownloadRateImprovementToAddAnotherConnection 1.0 +@cMaxInitialDownloadSources 15` an und legt eine `steam_dev.cfg` neben `steamcmd.sh`, damit auch das Update beim Serverstart davon profitiert. Abschaltbar mit `STEAMCMD_FAST_DOWNLOAD=false`.
- **Tests laufen immer gegen eine eigene Datenbank** (`<name>_test` bzw. `TEST_DATABASE_URL`, wird automatisch angelegt) und Redis-DB 15. Ohne "test" im Namen bricht der Lauf ab. Ein laufendes Panel stört die Tests nicht mehr.

### Hinzugefügt
- Tests `steam-tuning.test.ts` und `test-db.test.ts`; `tests/README.md` überarbeitet.

## [0.20.0] - 2026-11-07

### Hinzugefügt
- **Egg-Katalog** `docs/EGG-KATALOG.md`: alle 263 Pelican/Pterodactyl-Eggs nach Kategorie, mit Steam-ID, Laufzeit, Zusatzports, Bewertung (direkt / prüfen / Steam-Konto) und Download-Link.
- **25 neue mitgelieferte Spiele** (konvertiert aus pelican-eggs, MIT): Garry's Mod, Left 4 Dead 2, Counter-Strike: Source, Sven Co-op, Insurgency: Sandstorm, Squad, Mordhau, Unturned, Barotrauma, Don't Starve Together, The Forest, Abiotic Factor, Soulmask, Necesse, Hurtworld, Astroneer, Vintage Story, Space Engineers, Empyrion, Eco, Arma Reforger, Euro Truck Simulator 2, American Truck Simulator, Assetto Corsa, Velocity (Proxy). Alle ungetestet auf der VM.
- **Admin: „Spiel importieren (JSON)“** direkt in der Spielauswahl beim Server-Erstellen.

### Geändert
- Import passt fremde Eggs automatisch an: `*_PORT`-Variablen werden zu vergebenen Zusatzports (RCON intern), `done` wird zum Bereitschafts-Check, Konfigurationsangaben als Text werden gelesen, `yml`/`file`-Parser, `startup_commands`, `run_as 1000:1000` bei Pelican-Images.
- Installer: Shell aus dem Egg (bash/ash/sh) und chown auf `run_as` nach der Installation.

### Behoben
- Variablen, die auf andere Variablen/Ports verweisen (z. B. `{{SERVER_PORT}}`), werden jetzt aufgelöst (Enshrouded STEAM_PORT, Factorio RCON_PORT).
- Backup-Test wählt zuverlässig ein Minecraft-Egg.

## [0.19.0] – 2026-11-07 – Schnellere Oberfläche, RCON intern, Konzept für Apps und Installer

### Geändert
- **Panel startet schneller**: Seiten werden erst beim Öffnen geladen. Das JavaScript beim Start schrumpft von 1,1 MB auf rund 0,45 MB; die Konsole (xterm, 360 KB) lädt nur noch auf der Serverseite. Bibliotheken liegen in eigenen Dateien und bleiben nach Panel-Updates im Browser-Cache. Die Seitenleiste bleibt beim Seitenwechsel stehen.

### Sicherheit
- RCON von **ARK** und **Palworld** wird wie bei Minecraft nicht mehr am Host freigegeben – das Panel erreicht ihn intern. Wer RCON mit eigenen Programmen von außen nutzen will, entfernt im Egg `"internal": true`. Wirkt nach dem nächsten Container-Neubau.

### Neu
- **Konzept `docs/KONZEPT-APPS.md`**: Apps für Windows, macOS, Linux und Android (Tauri 2, Rust) und ein Server-Installer für Windows in Rust – Doppelklick-Assistent oder Befehlszeile, für Windows 10/11, Windows Server mit Oberfläche und Server Core (Hyper-V- oder WSL2-Modus). Aufgaben in der TODO unter „Apps und Installer“.

## [0.18.1] – 2026-11-07 – Prüfung: Sicherheit, RCON intern, 3 neue Spiele

### Sicherheit
- **Geheime Werte nur für Berechtigte**: Die Spiel-Einstellungen schickten Passwörter (RCON, Admin, Server) an jeden mit Leserecht – ein Mitnutzer mit der Vorlage „Zuschauer“ sah z. B. das ARK-Admin-Passwort. Jetzt bekommen den Wert (fürs Auge-Symbol) nur die, die ihn auch ändern dürfen; alle anderen sehen nur „gesetzt“.
- **Minecraft-RCON nicht mehr im Internet**: Der RCON-Port wird nicht mehr am Host freigegeben. Das Panel erreicht ihn intern über das Spielnetz; von außen war er sonst über den weitergeleiteten Portbereich erreichbar (RCON ist unverschlüsselt). Neue Egg-Option `"internal": true` für Nebenports. Wirkt bei bestehenden Servern nach dem nächsten Container-Neubau (z. B. Einstellung speichern).

### Neu
- Neue Spiele (ungetestet): **Terraria** (Vanilla und tModLoader), **Project Zomboid**, **Mumble** (Sprachserver).

### Behoben
- Drei veraltete Tests (RCON jetzt Pflichtport, Geheimnisse, undokumentierte Route `POST /admin/test-games/stop`) – alle 292 Tests grün.

## [0.18.0] – 2026-11-07 – Modpacks: Suche beim Erstellen, Update mit einem Klick, Versionen in allen Ansichten, Hilfeseite & Hover-Erklärungen

### Neu
- **Umfassende Hilfeseite & Dokumentationsbereich (`/hilfe`)**:
  - Neuer Menüpunkt **Hilfe & Doku** in der Haupt-Seitenleiste sowie direkte Verlinkung über die Versionsanzeige im Footer.
  - 5 interaktive Reiter:
    - **Hilfe & FAQ**: Kompakter Leitfaden zu Serversteuerung (Starten, Stoppen, Notfall-Kill), Statusfarben-Legende, Ressourcen-Verständnis (z. B. 400% CPU = 4 Kerne), Backups & UGREEN-NAS-Sicherung, Revisions-Historie im Dateimanager, Mitnutzer-Rechte und Tastaturkürzel.
    - **Changelog**: Ausführliche Versionsübersicht mit Hervorhebung der aktuellen Version.
    - **Entwickler-Log**: Vollständiges Entwicklerprotokoll aus `docs/ENTWICKLUNGSLOG.md`, chronologisch sortiert und mit interaktivem Live-Suchfilter nach Datum, Funktion oder Dateien.
    - **Roadmap & Geplant**: Offene und erledigte Punkte aus `docs/TODO.md`.
    - **System & Architektur**: Übersicht der Panel-Architektur (Node.js, PostgreSQL, Redis, Docker) mit Direktlink zur interaktiven Scalar OpenAPI-Dokumentation (`/docs`).
- **Interaktives Tooltip- & Hover-Erklärungs-System (`Tooltip.tsx`)**:
  - Universelle Portal-Tooltips bei Hover über Status-Badges (Online, Startet, Offline, Crash), Buttons (Starten, Stoppen, Neu starten, Notfall-Abwürgen mit Sicherheits-Warnung) und Kennzahlen.
  - Dezente `InfoTip`-Symbole `(?)` mit Hover-Erklärung bei CPU, RAM, Speicherplatz und Host-Metriken im Dashboard und auf der Serverseite.
- **Reiter „Modpack“ beim Server-Erstellen**: Name oder Kürzel eintippen (z. B. „atm10“) und Vorschläge aus **CurseForge, Modrinth und Feed the Beast** bekommen – mit Bild, Minecraft-Version, Loader, Downloads und Link zur Seite. „Auswählen“ trägt Servertyp, Pack, Version, passendes Java und einen RAM-Vorschlag ein.
- **Anleitung mit Links** direkt im Reiter: CurseForge-API-Schlüssel holen (console.curseforge.com), Modrinth, FTB, und wie man ein eigenes Pack aus **Prism Launcher, Modrinth App, CurseForge App** exportiert.
- **CurseForge-Schlüssel** trägt der Admin einmal im Reiter ein; er wird geprüft, verschlüsselt gespeichert und automatisch an CurseForge-Server gegeben. Ohne Schlüssel werden Modrinth und FTB durchsucht.
- **Eigene Pack-Datei** (.mrpack oder CurseForge-.zip) hochladen – landet nach dem Anlegen im Server-Ordner.
- **Pack-Version wird festgesetzt**, damit der Server nicht bei jedem Neustart still auf eine neue Version springt.
- **Game- und Modpack-Version in allen Ansichten**:
  - In der Serverliste (sowohl in der Tabellen- als auch in der Kachelansicht) wird für alle Spieleserver die Game-Version (z. B. `1.21.1`) und bei Modpacks zusätzlich der Paketname mit Version (`📦 Pack v...`) angezeigt.
  - Im Server-Header wird die Version prominent direkt neben dem Servertyp und Status-Badge visualisiert (`📦 All the Mods 10 (vATM10AERO-0.8.0)` · `MC 1.21.1`).
- **Update-Button in der Aktionsleiste**:
  - Direkt oben in der Aktionsleiste des Servers (neben „Starten“, „Neu starten“ und „Stoppen“) gibt es nun den Button **„Aktualisieren“** (mit pulsierender Hervorhebung und Update-Badge, wenn ein Modpack-Update verfügbar ist).
  - Öffnet ein Update-Modal mit direktem Vergleich (Installierte Version vs. Neueste Version), Hinweis auf automatisches Backup und Warnung bei Minecraft-Versionswechseln.
- **1-Klick-Update mit Backup**: Server stoppen → Backup (muss fertig sein, sonst passiert nichts) → neue Version → Neustart. Fortschritt live sichtbar (`pack.step.*`). Braucht die Rechte „Einstellungen ändern“ und „Backup anlegen“.
- **Neues Login-Design mit Banner & Interaktion**:
  - Immersives Glasmorphismus-Design mit Cyber-Grid-Hintergrund und warmem Bernstein-/Cyan-Ambient-Glow.
  - Header-Banner (`banner.png`) mit weichem Farbverlauf und `v0.18.0`-Versionsbadge.
  - Klickbares 3D-NexusPanel-Logo mit 360°-Drehanimation und spielerischem Easter-Egg-Zähler ("⚡ Turbo-Host Engine").
  - Passwort-Sichtbarkeits-Umschalter (Auge-Icon) zum bequemen Prüfen des eingegebenen Passworts.
  - Feststelltasten-Erkennung (Caps-Lock-Warnung: `Feststelltaste ist aktiviert (⇪)`).
  - Live-Statusanzeige (`● Systeme betriebsbereit`) und Sicherheits-Badge (`Sichere Sitzung · Ende-zu-Ende verschlüsselt`).
- **Automatisierter Spiele-Test-Runner (`deploy.bat test-games`)**:
  - Testet alle 17 Spiel-Vorlagen nacheinander im Hintergrund (jeweils mit Installation, Start-Prüfung und Log-Diagnose).
  - Räumt jede Instanz sofort wieder restlos auf (Container, Volume und Ports gelöscht), sodass Festplatte und RAM nicht überlaufen.
  - Schreibt nach jedem Spiel den Zwischenstand live in einen Diagnosebericht (`docs/GAME-INSTALL-TESTS.md`).
- Neuer Servertyp FTBA (Feed the Beast) im Minecraft-Java-Egg.

### Behoben
- **CurseForge-Modpack-Download**: Leere Modpack-Variablen (`CF_MODPACK_ZIP`, etc.) werden nicht mehr an den Container übergeben. Zuvor interpretierte `mc-image-helper` ein leeres `CF_MODPACK_ZIP=""` als Verzeichnispfad (`/data`) und brach mit `Zip file seems to be a directory:` ab.
- **CurseForge-Schlüssel**: Hilfreiche Fehlermeldung bei versehentlicher Eingabe eines Profil-Tokens (`cfc_pat_...`) mit Hinweis auf den Core-Schlüssel unter „API keys“ (`$2a$10$...`).
- **Icons**: NexusPanel Amber-Logo (`logo.svg` und `favicon.svg`) hinzugefügt, sodass kein defektes Bild-Symbol mehr im Header oder Reiter angezeigt wird. Automatische UID/GID-Korrektur (1000:1000) für hochgeladene Server-Icons.

## [0.17.0] – 2026-11-07 – „Minecraft Paper“ heißt jetzt „Minecraft Java“, mehr Servertypen und Modpacks

### Geändert
- Das Minecraft-Egg konnte schon immer alle Java-Servertypen, hieß aber „Minecraft Paper“. Es heißt jetzt **Minecraft Java**. Bestehende Server bleiben, wie sie sind (Umbenennung per Migration 0017, auch in den erlaubten Spielen der Nutzer).

### Neu
- Weitere Servertypen: **Folia, Quilt, Mohist, Arclight** (Mohist/Arclight = Mods und Plugins zusammen) zusätzlich zu Paper, Purpur, Spigot, Vanilla, Fabric, Forge und NeoForge.
- **Modpacks mit einem Klick**: Servertyp MODRINTH (Feld „Modrinth-Modpack“) oder AUTO_CURSEFORGE (Felder „CurseForge-Modpack“ und API-Schlüssel). Die Felder erscheinen nur beim passenden Typ.
- TPS-Abfrage für Mohist/Arclight.

## [0.16.3] – 2026-11-07 – Sicherheit bei Zeitplänen & AMP-Stil Instanzenverwaltung

### Neu
- **AMP-Stil Instanzen- & Rechteverwaltung (`/admin/users`)**:
  - Im Admin-Bereich (nur für Admins zugänglich) gibt es bei jedem Benutzer den neuen Knopf **„Server-Rechte“**.
  - Ein Klick öffnet eine Übersicht aller vorhandenen Server auf dem Host.
  - Pro Server kann der Admin mit einem Klick den Zugriffsstatus festlegen:
    - *Kein Zugriff* (Server bleibt unsichtbar)
    - *Zuschauer (Nur Lesen)* (z. B. auf ARK nur Konsole mitlesen, keine Start/Stop-Knöpfe)
    - *Operator* (z. B. auf Minecraft voller Start/Stop/Konsole-Zugriff)
    - *Verwalter*, *Co-Admin* oder *Hauptbesitzer*
    - *Individuell* mit aufklappbaren Checkboxen für einzelne Aktionen.
  - Änderungen werden sofort pro Server gespeichert.

### Sicherheit
- **Zeitpläne konnten fehlende Rechte ersetzen.** Wer nur „Zeitpläne pflegen“ hatte, konnte einen Zeitplan mit der Aktion „Befehl“ anlegen oder auslösen und so Konsolenbefehle schicken (z. B. `op Name`) – ohne das Recht dazu. Genauso Neustart und Backup. Jetzt braucht anlegen, ändern und auslösen zusätzlich das Recht der Aktion: Befehl → `control.command`, Neustart → `control.restart`, Backup → `backup.create`.
- **Fremde Zeitpläne auslösbar.** „Sofort ausführen“ prüfte nicht, ob der Zeitplan zum Server gehört – mit der ID ließ sich ein Zeitplan eines anderen Servers starten. Jetzt 404.

### Behoben
- Versionsnummer in package.json stand nach 0.16.2 noch auf 0.16.1.

## [0.16.2] – 2026-11-07 – Phase 6: Mehrbenutzer, Mitnutzer & Rechtesystem (RBAC)

### Neu
- **Mitnutzer-Verwaltung auf Servern (Reiter „Mitnutzer“)**:
  - Jeder Server-Besitzer kann andere Nutzer zur Instanz einladen und ihre Rechte feingranular bestimmen.
  - Vordefinierte Rollen-Presets: *Zuschauer*, *Operator*, *Verwalter*, *Co-Admin* sowie *Individuell*.
  - Feingranulare Checkbox-Matrix nach Kategorien:
    - **Steuerung**: Konsole mitlesen, Befehle senden, Starten, Stoppen, Neustarten, Abwürgen (Start & Stop können separat von Neustart/Kill vergeben werden).
    - **Dateien**: Ansehen, Bearbeiten/Hochladen, Löschen, Packen/Entpacken, SFTP.
    - **Backups**: Sehen, Erstellen, Zurückspielen, Löschen, Herunterladen.
    - **Zeitpläne**: Sehen, Bearbeiten, Sofort ausführen.
    - **Spieler & Moderation**: Online-Spieler sehen, Kicken, Bannen, Whitelist verwalten.
    - **Einstellungen**: Umbenennen, Neu installieren, Mitnutzer verwalten.
- **Admin-Bereich: Benutzerverwaltung (`/admin/users`)**:
  - Accounts anlegen, bearbeiten, globale Rollen (`admin`, `moderator`, `user`) zuweisen.
  - **Erlaubte Spielvorlagen (Egg-Whitelisting)**: Admins können für jeden Nutzer festlegen, welche Spiele er erstellen darf (z. B. nur Minecraft und Sons of the Forest). Alle anderen Vorlagen werden ausgeblendet und beim Server-Erstellen serverseitig abgewiesen.
  - Ressourcen-Limits (Server-Anzahl, RAM-Budget in MB, Disk-Budget in MB).
  - 1-Klick-Sperre (`suspended`) und 2FA-Reset bei verlorenem Authenticator.
- **Admin-Bereich: Audit-Log (`/admin/audit`)**:
  - Chronologische Übersicht aller Aktionen und Sicherheitsereignisse mit Schnellfiltern nach Server, Mitnutzer und Benutzer.
- **UI-Gates**: Knöpfe (z. B. Start, Neustart) und Reiter auf der Serverseite passen sich dynamisch an die Rechte des angemeldeten Benutzers an.

## [0.16.1] – 2026-11-07 – RCON-Passwort fehlte (TPS und Spielerverwaltung stumm)

### Behoben
- Minecraft: Stand das RCON-Passwort leer in den Einstellungen, bekam der Container `RCON_PASSWORD=""`. Das Image erzeugt dann kein eigenes Passwort und schaltet RCON ab („No rcon password set … rcon disabled“) – TPS blieb „–“, Kick/Ban/OP gingen nicht. Das Panel legt jetzt bei leerem Passwort selbst eines an, speichert es und baut den Container beim nächsten Start einmal neu. Gilt für alle Spiele mit RCON-Abfrage.

## [0.16.0] – 2026-11-07 – Titelbilder, Kacheln beim Erstellen, 4 neue Spiele

### Neu
- **Titelbilder für jedes Spiel**: Kacheln beim Server-Erstellen und in der Serverliste zeigen ein Bild. Bekannte Spiele bekommen ihr Steam-Titelbild (holt das Panel einmal und speichert es; der Browser fragt nie selbst bei Steam an). Spiele ohne Bild bekommen ein Panel-Motiv aus `web/public/branding` – Banner oder Symbol, je Spiel fest ausgewürfelt.
- **Titelbild wählen (Admin)**: Bild-Knopf an jeder Spielkachel – Automatisch, Steam-Bild, zufälliges Panel-Motiv, eines der 14 Motive gezielt, oder eigenes Bild hochladen (PNG/JPEG/WebP, max. 2 MB; quadratische Logos werden nicht angeschnitten).
- **Spielauswahl als Kacheln oder Liste** umschaltbar (wird gemerkt). Die Serverliste zeigt das Bild auch in der Listenansicht als Vorschau.
- **Neue Spiele (ungetestet)**: Minecraft Bedrock (itzg), Factorio (factoriotools), V Rising (trueosiris, Wine), Core Keeper (escaping, Direktverbindung).

### Behoben
- Minecraft-Servericon in der MOTD-Vorschau wurde nie angezeigt: das Bild braucht die Anmeldung, ein normales `<img>` schickt sie nicht mit. Wird jetzt mit Anmeldung geladen.

## [0.15.0] – 2026-11-07 – Phase 5 Abschluss (Zeitpläne, Dateiversionierung, Storage Targets, UGREEN NAS) & Spieler-Erweiterung

### Neu
- **Phase 5 – Zeitpläne (Schedules)**: Vollwertiger Scheduler für automatisierte Server-Aktionen (Neustart, Backup, Konsolenbefehl wie z. B. `say Neustart in 5min` oder `save-all`). Schnellvorlagen, flexible Intervalle oder feste Uhrzeiten (z. B. `04:00`), manuelle Sofortausführung und Live-Statusanzeige im neuen Reiter „Zeitpläne“.
- **Phase 5 – Dateiversionierung & Revisions-Historie**: Bei jeder Änderung einer Datei über den integrierten Dateimanager wird automatisch ein Revisions-Snapshot gesichert (bis zu 25 Versionen pro Datei). Integrierte Differenz- und Vorschauansicht mit 1-Klick-Rollback auf frühere Stände.
- **Phase 5 – Storage Targets (S3, Hetzner Storage Box SFTP & lokaler Pfad)**: Zentrale Konfiguration für externe Sicherungsziele.
- **Phase 5 – Lesbare NAS-Namen**: Backups auf dem UGREEN NAS werden jetzt im Format `<Servername>/<Backup-Dateiname>.tar.zst` gespeichert. Vollständige automatische Rückwärtskompatibilität für alte UUID-Pfade.
- ARK: Survival Ascended: Reiter „Spieler“ mit allen Spielern online (über RCON, mit EOS-ID), Kicken, Bannen (auch auf Zeit – das Panel hebt den Bann danach auf), Entbannen, Whitelist. Spielerzahl und Antwortzeit im Serverkopf.
- Palworld: dasselbe über RCON mit Steam-ID (Kicken, Bannen, Entbannen).
- Valheim, 7 Days to Die, Sons of the Forest, Counter-Strike 2: Spieler online, Maximum, Version/Karte und Antwortzeit über die Valve-Serverabfrage (A2S).
- Für Spiele ohne lesbare Bannliste zeigt das Panel die Banns, die über das Panel verhängt wurden.

### Behoben
- Backup-Tabelle passt ohne Querscrollen: lange Namen werden gekürzt (voller Name beim Drüberfahren), Datum steht unter dem Namen, Aktions-Knöpfe überlappen nicht mehr.

## [0.14.0] – 2026-11-07 – Speicher-Limit, Docker aufräumen, Netzwerk-Verlauf & UGREEN NAS Backups

### Neu
- UGREEN NAS Anbindung über Tailscale: Automatisches und manuelles Synchronisieren aller Backups auf ein Backup-NAS (SMB/CIFS-Share). Backups erhalten ein `[ NAS ]`-Badge und können per Klick gesichert werden. Fällt eine lokale Datei weg, wird sie beim Restore automatisch vom NAS bezogen.
- Backup-Integritätsprüfung & Auto-Scheduler: Validierung von Backups per SHA-256 Prüfsumme, Tar/Zstandard-Streaming-Dekodierung ohne Entpacken und Erkennung kritischer Spieldateien. Automatischer Hintergrund-Scheduler für periodische Backups mit anpassbarer Retention-Policy (ältere ungesperrte Backups werden automatisch rotiert).
- Speicher-Limit wird durchgesetzt: Belegt ein Server mehr als zugeteilt, startet er nicht mehr (klare Meldung mit Zahlen). Vorher gibt es einen Hinweis in der Zeitachse – einmal bei 90 %, einmal bei 100 %.
- „Docker aufräumen“ in der Host-Karte (nur Admins): löscht ungenutzte Images und den Build-Cache, mit Rückfrage. Spielserver, auch gestoppte, und ihre Daten bleiben unberührt. Zeigt, wie viel Platz frei wurde.
- Netzwerk-Verlauf je Server: Download und Upload der letzten Stunde als Linien im Serverkopf, mit aktueller Rate. Der Verlauf bleibt nach dem Stoppen sichtbar – hilfreich nach Abstürzen.

## [0.13.0] – 2026-11-07 – Minecraft live: Spieler, TPS, MOTD

### Neu
- Serverkopf zeigt bei Minecraft live: Spieler online/maximal, TPS (grün/gelb/rot) mit ms pro Tick, Antwortzeit und Version. Funktioniert für jeden Servertyp: Spieler, Version und Antwortzeit über den Server List Ping (wie die Serverliste im Spiel), TPS über RCON mit dem passenden Befehl – `tps` (Paper/Purpur/Spigot), `spark tps`, `neoforge tps`/`forge tps` oder `tick query` (Vanilla ab 1.20.3). Der funktionierende Befehl wird gemerkt.
- Neuer Reiter „Spieler“: wer online ist, Kicken und Bannen mit Begründung, Bann auf Zeit (1 Stunde bis 30 Tage – das Panel hebt ihn danach selbst auf), OP geben/entziehen, Whitelist. Bann-, Whitelist- und OP-Liste aus den Dateien des Servers, auch wenn er aus ist.
- MOTD-Editor in den Einstellungen: zwei Zeilen, alle 16 Farben und Formatierungen per Klick, Vorschau wie in der Minecraft-Serverliste, Zähler für sichtbare Zeichen. Servericon hochladen – jedes Bild wird automatisch auf 64×64 gebracht.
- Servertyp NeoForge auswählbar.

### Sicherheit
- Spielernamen und Begründungen werden streng geprüft, bevor sie in einen RCON-Befehl gehen (keine Zeilenumbrüche, nur gültige Minecraft-Namen).

## [0.12.1] – 2026-11-07 – Logdateien live

### Neu
- Logdateien: Schalter „Live“ (an als Vorgabe). Die neueste Logdatei wird alle 3 Sekunden nachgeladen, die Ansicht bleibt unten. Beginnt das Spiel eine neue Datei (z. B. nach einem Neustart), springt die Ansicht von selbst zur neuesten. Hochscrollen hält das Mitlaufen an, bis man wieder unten ist.

## [0.12.0] – 2026-11-07 – Dateimanager, Backups, Konfigurations-Formulare und Globale Suche

### Neu
- Backup-Integritätsprüfung und Funktionalitäts-Check:
  - Backups lassen sich direkt im Panel auf Knopfdruck oder automatisch nach Erstellung validieren.
  - Prüft SHA-256 Prüfsummen gegen nachträgliche Manipulation oder Beschädigung.
  - Testet die Zstandard- und TAR-Archivdekodierung ohne Entpacken auf Festplatte.
  - Erkennt spielspezifische Pflichtdateien (z. B. `level.dat`, `server.properties`, `GameUserSettings.ini`, `SavedArks`, `PalWorldSettings.ini`).
  - Interaktives Prüfbericht-Modal und Status-Plaketten („Geprüft“ bzw. „Beschädigt“) in der Backup-Tabelle.
- Automatische Backups & Aufbewahrung (Retention):
  - Hintergrund-Scheduler (`backup-scheduler.ts`) sichert Server vollautomatisch im gewünschten Intervall (z. B. alle 6, 12, 24 oder 48 Stunden).
  - Konfigurierbares Aufbewahrungs-Limit (Retention): Ältere ungesperrte Backups werden automatisch rotiert und gelöscht.
  - Gesperrte Backups (`locked`) bleiben dauerhaft vor automatischer Löschung geschützt.
- Globale Schnellsuche / Spotlight (`Strg+K`):
  - Jederzeit per Tastenkombination `Strg+K` oder über den Such-Button in der Seitenleiste aufrufbar.
  - Findet blitzschnell Server, Direktaktionen (Konsole, Dateien, Backups, Einstellungen), globale Panel-Einstellungen, 2FA, Steam-Accounts, Netzwerk und Spiele.
- Visueller Formular-Editor für Konfigurationsdateien:
  - Unter „Einstellungen → Konfigurationsdateien“ lassen sich Server-Konfigurationen (`.ini`, `.properties`, `.cfg`, `.json`) bequem visuell mit Schaltern, Schiebereglern und Abschnitten bearbeiten, ohne Syntaxfehler zu riskieren.
  - Der normale Dateimanager („Dateien“) bleibt als schneller, sauberer Quellcode-Editor mit Syntax-Tabs und Zeilennummern erhalten.
- 8 neue mitgelieferte Spiele-Vorlagen (Eggs) für das System:
  - Palworld, Rust, Valheim, Counter-Strike 2, Satisfactory, 7 Days to Die, Sons of the Forest und TeamSpeak 3.
  - Ausführliche Konfigurationsvariablen und Mapping für Minecraft Paper, ARK: Survival Ascended und Enshrouded hinzugefügt.
- Neuer Dateimanager im Panel (Reiter „Dateien“ je Server):
  - Ordnerhierarchie mit Breadcrumb-Pfadnavigation und Sofortsuche.
  - Vollständiger Quellcode-Editor mit Zeilennummerierung, Tastenkürzeln (z. B. `Strg+S` zum Speichern, `Tab` zur Einrückung) und Statusanzeigen.
  - Multi-Datei-Upload mit Drag-and-Drop direkt in den aktuellen Ordner.
  - Ordner erstellen, Dateien/Verzeichnisse umbenennen, löschen und direkt herunterladen.
  - Archiv-Verwaltung: ZIP- und TAR-Archive auf Knopfdruck entpacken sowie Verzeichnisse/Dateien als ZIP packen.
  - Pfadtraversierungs- und Symlink-Schutz (`safePath`) gegen Ausbruch aus dem Server-Datenverzeichnis.
- Vollwertiges Backup-System (Reiter „Backups“ je Server):
  - Erstellung hochkomprimierter `tar.zst`-Archive (Zstandard) mit SHA-256 Prüfsummen-Validierung und exakter Byte-Größenermittlung.
  - Automatische Namensgenerierung nach dem Schema `<ServerName>_<Game>_(<Version>)_<YYYY-MM-DD_HH-mm-ss>.tar.zst`.
  - Wiederherstellung (Restore) direkt aus dem Panel mit Sicherheitsabfrage und Serverstatus-Prüfung.
  - Backup-Sperre („Gesperrt“), die geschützte Sicherungen vor manuellem Löschen oder automatischer Rotation bewahrt.
  - Direkter Download von Backups über den Browser und Berechtigungssystem (`backup.read`, `backup.create`, `backup.restore`, `backup.delete`, `backup.download`).
- Cyber-Emerald Marken- und Theme-Paket:
  - Isometrisches Cyber-Emerald Server-Logo als SVG und hochauflösende Rastergrafiken.
  - Animiertes pulsierendes GIF-Emblem für Lade- und Statusanzeigen.
  - Banner mit Randabstand gegen Schnittkanten-Überlauf.
  - 6 Farbthemen (Cyber Emerald, Amber Classic, Arctic Cyan, Crimson Forge, Plasma Violet, Stealth Titanium) im Projekt hinterlegt.

## [0.11.0] – 2026-11-06 – Panel, Community und Übersetzung

### Neu
- Neues NexusPanel-Logo (Vektor-SVG) im Panel, Login, der Navigation und der Info-Seite.
- Automatischer GitHub-Update-Hinweis: Das Panel prüft Releases im Hintergrund und zeigt verfügbare Aktualisierungen in der Seitenleiste sowie unter „Was ist neu“ an.
- Neue Seite „Community & Ressourcen“ (`/community`): Offizielle Links zu GitHub, Discord, Pelican/Pterodactyl Egg-Repository und Germany LanGame Community-Showcase.
- Zentrale Steam-Konten-Verwaltung: Steam-Konten sicher hinterlegen (Passwörter AES-256-GCM verschlüsselt in der Datenbank) und Steam-Guard-Codes (App/E-Mail) direkt über das Panel eingeben.
- Mehrsprachige Spielvorlagen (Eggs): Feldnamen (`name_locales`) und Beschreibungen (`description_locales`) in Deutsch und Englisch in den Eggs hinterlegt; Formularfelder passen sich automatisch an die Nutzersprache an.
- Mehrsprachige Konsolen-Hinweise (`text_locales`): Erklärungen für Fehlermuster in der Konsole werden in der Nutzersprache angezeigt.
- Übersetzbare Zeitachsen-Meldungen: Server-Ereignisse nutzen strukturierte Event-Codes und Parameter mit vollständiger Lokalisierung (`de` und `en`).

## [0.10.0] – 2026-11-06 – Spiel-Logs und EOS-Hilfe für ARK

### Neu
- Reiter „Logdateien“ je Server: alle Logdateien des Spiels, neueste zuerst und vorausgewählt; Suche, „nur Fehler und Warnungen“, Herunterladen. Auch gepackte Minecraft-Logs (.log.gz) lassen sich lesen.
- Konsole liest bei ARK zusätzlich das eigentliche Spiel-Log (`ShooterGame.log`) mit – dort stehen alle Meldungen von Epic Online Services, die vorher unsichtbar waren.
- Hinweise in der Fehlerliste: Eggs können Muster mit Erklärung mitbringen. ARK erklärt EOS-Fehler (Zertifikat, DNS, Uhrzeit, Sitzung) und meldet grün, sobald der Server bei Epic angemeldet ist. Minecraft erklärt u. a. Speichermangel, „Can't keep up“, belegten Port, falsche Java-Version.
- Harmlose Proton-Meldungen (ProtonFixes, ILocalize …) werden nicht mehr als Warnung gezählt.
- Netzwerk → Verbindungstest: prüft von der VM aus DNS und HTTPS zu Epic, mit welcher Adresse die VM draußen ankommt (Abgleich mit der eingetragenen öffentlichen Adresse) und ob die Uhr stimmt.
- ARK: neue Einstellung „Plattformen“ (PC oder Crossplay mit Konsolen).

### Geändert
- ARK gilt erst als „Läuft“, wenn der Server bei Epic angemeldet ist („advertising for join“ im Spiel-Log) – vorher sprang der Status schon beim Start des Skripts um.

## [0.9.0] – 2026-11-06 – Konsole mit Fehlerliste, Suche und Farben

### Neu
- Rechts neben der Konsole: Liste aller erkannten Fehler und Warnungen mit Uhrzeit. Ein Klick springt zur Stelle in der Konsole und markiert sie.
- Konsole farbig: Fehler rot, Warnungen gelb, eigene Befehle bernsteinfarben. Was das Spiel selbst einfärbt, bleibt wie es ist.
- Suche und Filter in der Konsole: Suchbegriff zeigt nur passende Zeilen (Treffer hervorgehoben), dazu „Alles“, „Warnungen“, „Fehler“.
- Erkannt werden die üblichen Muster aller Spiele: Minecraft (`/ERROR`, `/WARN`, Exceptions), Linux-Meldungen (z. B. „No space left on device“), Proton/Wine. Java-Stacktrace-Zeilen zählen nicht einzeln.

### Behoben
- ARK, Enshrouded und Farming Simulator konnten Proton nicht laden („No space left on device“): `/tmp` im Container war eine 256-MB-RAM-Disk. Eggs können jetzt `"tmp": "disk"` angeben; diese drei Spiele tun das.
- Passt ein bestehender Container nicht mehr zu seinem Egg, legt das Panel ihn beim nächsten Start selbst neu an – Spielstände bleiben dabei erhalten.

## [0.8.0] – 2026-11-06 – Speicher im Blick

### Neu
- Belegter Speicher je Server: in Kacheln, Liste (Spalte „Speicherplatz“) und auf der Serverseite, jeweils „belegt von zugeteilt“, mit Warnung, wenn mehr belegt als zugeteilt ist.
- Gesamtlast um „Speicher gesamt“ erweitert.
- Host-Karte (Admins): was den Speicher füllt – Spieldaten aller Server und Docker selbst (Images, Container, Build-Cache) – mit Zeitpunkt der letzten Messung.
- Gemessen wird alle 5 Minuten im Hintergrund, nach Installation und Import sofort.

## [0.7.0] – 2026-11-06 – Dashboard

### Neu
- Serverliste wahlweise als Liste oder Kacheln (Umschalter oben rechts, wird gemerkt). Kacheln zeigen CPU, RAM und Netzwerk je Server live.
- Gesamtlast über allen Servern: laufende Server, CPU, RAM (verbraucht von zugeteilt), Download- und Upload-Rate.
- Für Admins: Grundleistung der Maschine – CPU-Last, Kerne, Load, RAM und Speicherplatz (belegt/gesamt) und wie viel davon Servern zugeteilt ist, mit Warnung, wenn mehr RAM zugeteilt ist, als die Maschine hat.
- In der Listenansicht zeigt die Spalte „Last“ CPU und RAM laufender Server.
- Das Panel sammelt die Auslastung aller laufenden Server zentral im Hintergrund (Grundlage auch für die geplante Bandbreiten-Anzeige).

## [0.6.0] – 2026-11-06 – Sprachen als Module

### Neu
- Oberfläche in mehreren Sprachen: Deutsch und Englisch. Jede Sprache ist eine Datei in `web/src/locales/` – eine neue Sprache braucht nur eine neue Datei, sie erscheint automatisch in der Auswahl.
- Englisch ist die Vorlage zum Übersetzen (`en.json` kopieren, Anleitung in `web/src/locales/README.md`). Fehlende Texte erscheinen auf Englisch, eine Übersetzung kann also Stück für Stück wachsen.
- Sprachauswahl unten links und auf der Anmeldeseite. Die Wahl wird am Konto gespeichert und gilt auf jedem Gerät; ohne Wahl gilt die Sprache des Browsers.
- Datum und Uhrzeit im Format der gewählten Sprache.
- Fehlermeldungen der API werden in anderen Sprachen über ihren Code übersetzt.
- Test prüft jede Sprachdatei: keine unbekannten Schlüssel, gleiche Platzhalter, Deutsch vollständig.

### Noch nicht übersetzt
- Texte aus den Spielvorlagen (Feldnamen, Hinweise), Meldungen in der Zeitachse, CHANGELOG und Planung.

## [0.5.0] – 2026-11-06 – Server aus Backup, Versionsanzeige

### Neu
- Neuer Server direkt aus einem Backup: Reiter „Aus Backup übernehmen“ beim Anlegen. Das Panel erkennt Spiel, Version und Einstellungen und füllt das Formular vor; bei Unsicherheit fragt es per Auswahlliste nach.
- Erkennung für Minecraft (Version aus level.dat oder Jar-Name, Servertyp, MOTD, Spielerzahl, Schwierigkeit), ARK: Survival Ascended (Karte, Servername, Admin-Passwort, Spielerzahl), Enshrouded (Name, Plätze) und TeamSpeak 6.
- Nach der Installation übernimmt das Panel die Daten selbst; währenddessen lässt sich der Server nicht starten.
- Versionsnummer und Build unten links, Klick öffnet „Was ist neu“ und die Planung.
- Jede Auslieferung bekommt eine fortlaufende Build-Nummer.

### Behoben
- Minecraft-Begrüßung (MOTD) war auf 59 Zeichen begrenzt – Farbcodes wie §6 zählen mit, echte MOTDs aus AMP passten nicht. Jetzt 256.

### Sicherheit
- Hochgeladene Backups sieht nur, wer sie hochgeladen hat; Dateien im Import-Ordner nur Admins.

## [0.4.3] – 2026-11-06 – AMP-Umzug

### Neu
- Neue Spiele: ARK: Survival Ascended, Enshrouded, TeamSpeak 6.
- Backup übernehmen (Einstellungen): AMP-Backup hochladen oder aus dem Import-Ordner wählen. Jedes Spiel sagt selbst, was es braucht; der Rest bleibt liegen, Vorhandenes wird gesichert.
- Spiele können als eigener Benutzer laufen; Eggs können Werte in SQLite-Datenbanken setzen.
- Eigenes Docker-Netz `nxp-games` für alle Spielcontainer.

### Behoben
- Stoppen schickte nie den Stopp-Befehl des Spiels und beendete jeden Server nach 15 s hart.
- TeamSpeak nutzte nach dem Import den alten Port aus der Datenbank.
- Server mit Porttest (TeamSpeak, FS25) blieben auf „Startet“ hängen.
- Import scheiterte unter Windows an der Pfadprüfung.
- CPU/RAM-Anzeige blieb nach dem Stoppen stehen.

## [0.4.2] – 2026-11-06 – Server-Einstellungen

### Neu
- Spiel-Einstellungen nachträglich ändern, Java-Version wechseln, RAM/CPU/Speicher anpassen (RAM und CPU auch im laufenden Betrieb).
- Ports neu vergeben und zusätzliche Ports hinzufügen.

### Behoben
- Minecraft bekam immer nur 1 GB Heap; jetzt 85 % des zugeteilten RAM.
- UDP-Ports wurden bei „tcp+udp“ nicht freigegeben.

## [0.4.1] – 2026-11-06 – Port-Bereich und Netzwerk

### Neu
- Port-Bereich je Host (28000–28999), öffentliche Adresse, Netzwerk-Seite mit allen belegten Ports.

### Behoben
- Adresse kopieren funktionierte über http nicht.
- Öffentliche Adresse wurde auch für Ports außerhalb des weitergeleiteten Bereichs angezeigt.
- Docker-Build der Oberfläche scheiterte auf der VM.
- Portvergabe lief bei belegtem Host-Port in eine Endlosschleife.

## [0.4.0] – 2026-11-06 – Weboberfläche

### Neu
- Weboberfläche (React): Anmeldung, Serverliste, Live-Konsole, Power-Knöpfe, CPU-/RAM-Graphen, Erstellungsdialog.

## [0.3.0] – 2026-11-06 – Zwei-Faktor und API

### Neu
- Zwei-Faktor-Anmeldung (TOTP) mit Wiederherstellungscodes.
- Server, Eggs, Nutzer und Mitnutzer über die REST-API, OpenAPI-Dokumentation unter /api/docs.
- Live-Konsole per WebSocket.

## [0.2.0] – 2026-11-06 – Anmeldung und Rechte

### Neu
- Anmeldung mit Argon2id, rotierende Sitzungen, Rechte je Server, Ratelimits, Audit-Log.

## [0.1.0] – 2026-11-05 – Grundgerüst und Container-Kern

### Neu
- Grundgerüst (TypeScript, Fastify, Postgres, Redis), Container-Kern mit Statusmaschine und Absturzerkennung.
- Egg-Parser, Installation, Bereitschaftsprüfung, Konfigurationsdateien, Portvergabe.
- Updater (deploy.bat) mit Fassungsverwaltung und Rücksprung.
