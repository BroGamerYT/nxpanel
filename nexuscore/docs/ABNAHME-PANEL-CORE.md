# Abnahme: Panel-Backend gegen NexusCore

Stand: 12.11.2026. Ziel: Der Core ist das einzige Backend; das alte Panel-Backend (`src/`, Postgres/Redis) fällt weg, sobald hier alles Nötige steht.

## Wie das gemessen wurde (und was es nicht sagt)

* **Routen verglichen**, nicht Verhalten: Panel **183** Routen (aus dem Quelltext), Core **180** (aus der laufenden Routentabelle), die Oberfläche ruft **144** verschiedene Routen auf.
* **Ohne Gegenstück im Core: 35 Panel-Routen.** Davon ruft die Oberfläche **26** tatsächlich auf. Der Core hat zusätzlich **14** Routen, die das Panel nicht hat (Passkeys, Steam-Anmeldung, SFTP, Firewall, Plattform ...).
* Gleiche Route heißt **nicht** gleiches Verhalten. Das Verhalten ist nur dort geprüft, wo es Tests gibt (856 im Core); ein Vergleich Seite an Seite mit dem Panel (gleiche Anfrage, gleiche Antwort) fehlt noch.
* Die Oberfläche blendet Bereiche aus, die der Core nicht meldet (`features` in `/api/v1/about`). Fehlende Funktionen sind deshalb **unsichtbar, nicht kaputt**.

## Was fehlt, nach Bereichen

Entscheidung: **BAUEN** = nötig, damit der Core das Panel ersetzt · **SPÄTER** = nur für Sonderfälle · **BLOCK C** = hängt an Mehrrechner-Betrieb. Aufwand: S klein, M mittel, L groß.

| Bereich | Was das Panel kann | Fehlende Routen | In der Oberfläche benutzt | Entscheidung | Aufwand |
| --- | --- | ---: | ---: | --- | :-: |
| Mitnutzer (Subusers) | Weitere Benutzer je Server mit eigenen Rechten einladen | 0 | 0 | **ERLEDIGT** | – |
| Benutzer imitieren | Admin meldet sich als anderer Benutzer an, um dessen Sicht zu prüfen | 0 | 0 | **ERLEDIGT** | – |
| Spiele verwalten (Eggs) | Eggs importieren (Datei, URL, Katalog), löschen | 4 | 3 | **BAUEN** | M |
| Server aus Backup/Upload importieren | Bestehenden Server (Archiv, Backup) in einen neuen Server übernehmen | 7 | 5 | **BAUEN** | L |
| Spiel aktualisieren | Spieldateien (SteamCMD) auf den neuesten Stand bringen | 1 | 1 | **BAUEN** | M |
| Modpacks (Minecraft) | CurseForge/Modrinth suchen und installieren/aktualisieren | 5 | 5 | **BAUEN** | L |
| Speicherziele (Backups extern) | Backups auf externe Ziele (S3, SFTP ...) | 5 | 0 | **BAUEN** | L |
| Steam-Konten für Downloads | SteamCMD-Anmeldung mit Konto und Steam Guard | 4 | 4 | **SPÄTER** | L |
| Domain und DNS | Cloudflare-DNS-Einträge je Server, Domain am Server | 5 | 5 | **SPÄTER** | M |
| Hosts hinzufügen/ändern/löschen | Weitere Rechner (Cores) an das Panel koppeln | 3 | 2 | **BLOCK C** | L |
| Playit-Integration | Tunnel über playit.gg einrichten | 1 | 1 | **SPÄTER** | S |
| Docker aufräumen | Ungenutzte Images/Cache löschen (Dashboard) | 0 | 0 | **ERLEDIGT** | – |
| Hilfe/Dokumentation | Eingebaute Dokumentation anzeigen | 0 | 0 | **ERLEDIGT** | – |
| Gesundheit | healthz/readyz für Docker-Health-Checks und Überwachung | 0 | 0 | **ERLEDIGT** | – |
| Kleinigkeiten | presence, auth/permissions, eggs/branding, allocations (Lesen) | 0 | 0 | **ERLEDIGT** | – |

### Hinweise je Bereich

* **Mitnutzer (Subusers)** — Der Core kennt die Rechte je Server schon (`store/access.ts`, Admin-Route `PUT /admin/users/:id/servers/:server`); es fehlen die Routen und der Tab "Mitnutzer" der Oberfläche. Ohne die Routen blendet die Oberfläche den Tab aus.
* **Benutzer imitieren** — Sitzung mit "imitiert von" und Rückweg; Audit-Eintrag Pflicht. Im Core ist das Master-Token kein Benutzer — Imitation nur für Konten.
* **Spiele verwalten (Eggs)** — Der Core liest Eggs aus dem Ordner `eggs/`. Import-Prüfung (`normalizeForeignEgg`, Rechtefilter) muss mit; Eggs kommen aus dem Internet.
* **Server aus Backup/Upload importieren** — Entpacken ist eine Sicherheitsfrage (Archiv-Bomben, Pfade): der Core hat schon einen geprüften Entpacker (`files/archive.ts`).
* **Spiel aktualisieren** — Docker: Installer-Container erneut; Windows: SteamCMD `app_update`. Die Neuinstallation gibt es schon (`/reinstall`).
* **Modpacks (Minecraft)** — CurseForge braucht einen API-Schlüssel (Einstellung). Bei Docker/itzg übernimmt das Image die Installation; es fehlen Suche und Aktualisieren.
* **Speicherziele (Backups extern)** — Der Core sichert lokal. Externe Ziele brauchen Zugangsdaten-Speicher (verschlüsselt) und Test-Route.
* **Steam-Konten für Downloads** — Nur für Spiele, die Steam-Anmeldung zum Herunterladen verlangen. Der Core lädt anonym; die Stub-Route liefert eine leere Liste.
* **Domain und DNS** — Braucht Cloudflare-Zugang; nur sinnvoll mit öffentlichem Hostnamen.
* **Hosts hinzufügen/ändern/löschen** — Ein Core ist ein Rechner. Mehrere Rechner unter einer Oberfläche sind Tunnel/Cluster (Block C) und brauchen eine eigene Entscheidung.
* **Playit-Integration** — Eine Integration unter Admin → Integrationen (Discord gibt es schon im Core).
* **Docker aufräumen** — Nur für den Docker-Treiber; nur Images, die der Core nicht braucht.
* **Hilfe/Dokumentation** — Statische Dateien ausliefern; keine Rechtefrage.
* **Gesundheit** — Trivial; ohne Anmeldung, ohne interne Angaben.
* **Kleinigkeiten** — Der Core liefert einzelne Teile schon über andere Routen (z. B. `permissions` in `/auth/me`).

## Vorschlag für die Reihenfolge

1. **S-Pakete** zusammen: Gesundheit, Kleinigkeiten, Dokumentation, Docker aufräumen, Benutzer imitieren.
2. **Mitnutzer** (M) — wichtigste fehlende Funktion für gemeinsam genutzte Rechner.
3. **Spiel aktualisieren** (M) und **Eggs verwalten** (M).
4. **Server importieren** (L), **Modpacks** (L), **Speicherziele** (L).
5. SPÄTER/BLOCK C nur nach deiner Entscheidung.

## Danach: Panel-Backend abschalten

Erst wenn: (a) alle BAUEN-Bereiche stehen, (b) ein Seite-an-Seite-Test (gleiche Anfragen gegen Panel und Core) keine Abweichung zeigt, (c) die Daten des Panels (Postgres) in den Core übernommen werden können — **diese Datenübernahme gibt es noch nicht** und ist eine eigene Aufgabe (Benutzer, Server, Zeitpläne, Backups).

## Anhang: alle fehlenden Routen

| Methode | Pfad | Bereich | Von der Oberfläche benutzt |
| --- | --- | --- | :-: |
| GET | `/api/v1/admin/network/dns` | Domain und DNS | ja |
| PATCH | `/api/v1/admin/network/dns` | Domain und DNS | ja |
| POST | `/api/v1/admin/network/dns/sync` | Domain und DNS | ja |
| POST | `/api/v1/admin/network/dns/test` | Domain und DNS | ja |
| PATCH | `/api/v1/servers/:p/domain` | Domain und DNS | ja |
| POST | `/api/v1/admin/hosts` | Hosts hinzufügen/ändern/löschen | ja |
| DELETE | `/api/v1/admin/hosts/:p` | Hosts hinzufügen/ändern/löschen | ja |
| PATCH | `/api/v1/admin/hosts/:p` | Hosts hinzufügen/ändern/löschen | nein |
| DELETE | `/api/v1/admin/modpacks/curseforge` | Modpacks (Minecraft) | ja |
| PUT | `/api/v1/admin/modpacks/curseforge` | Modpacks (Minecraft) | ja |
| GET | `/api/v1/modpacks/curseforge` | Modpacks (Minecraft) | ja |
| GET | `/api/v1/modpacks/search` | Modpacks (Minecraft) | ja |
| POST | `/api/v1/servers/:p/modpack/update` | Modpacks (Minecraft) | ja |
| POST | `/api/v1/admin/integrations/playit` | Playit-Integration | ja |
| GET | `/api/v1/imports` | Server aus Backup/Upload importieren | ja |
| DELETE | `/api/v1/imports/:p` | Server aus Backup/Upload importieren | ja |
| POST | `/api/v1/imports/analyze` | Server aus Backup/Upload importieren | ja |
| POST | `/api/v1/imports/upload` | Server aus Backup/Upload importieren | nein |
| GET | `/api/v1/servers/:p/import` | Server aus Backup/Upload importieren | ja |
| POST | `/api/v1/servers/:p/import` | Server aus Backup/Upload importieren | ja |
| POST | `/api/v1/servers/:p/import/upload` | Server aus Backup/Upload importieren | nein |
| GET | `/api/v1/admin/storage-targets` | Speicherziele (Backups extern) | nein |
| GET | `/api/v1/servers/:p/storage-targets` | Speicherziele (Backups extern) | nein |
| POST | `/api/v1/servers/:p/storage-targets` | Speicherziele (Backups extern) | nein |
| DELETE | `/api/v1/servers/:p/storage-targets/:p` | Speicherziele (Backups extern) | nein |
| POST | `/api/v1/servers/:p/storage-targets/:p/test` | Speicherziele (Backups extern) | nein |
| POST | `/api/v1/servers/:p/update-game` | Spiel aktualisieren | ja |
| POST | `/api/v1/admin/eggs` | Spiele verwalten (Eggs) | ja |
| DELETE | `/api/v1/admin/eggs/:p` | Spiele verwalten (Eggs) | nein |
| GET | `/api/v1/admin/eggs/catalog` | Spiele verwalten (Eggs) | ja |
| POST | `/api/v1/admin/eggs/import-url` | Spiele verwalten (Eggs) | ja |
| POST | `/api/v1/steam/accounts` | Steam-Konten für Downloads | ja |
| DELETE | `/api/v1/steam/accounts/:p` | Steam-Konten für Downloads | ja |
| POST | `/api/v1/steam/accounts/:p/guard` | Steam-Konten für Downloads | ja |
| POST | `/api/v1/steam/accounts/:p/test` | Steam-Konten für Downloads | ja |
