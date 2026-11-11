# NexusCore – Aufgabenliste für die Weiterentwicklung

**Für:** die KI, die am Core weiterarbeitet
**Stand:** 10.11.2026, 23:40 – Core 0.2.0, Panel 0.26.1 (Build 106)
**Grundlage:** `docs/KONZEPT-NEXUSCORE-ECOSYSTEM.md` (v1.1.0), `nexuscore/CORE_PROTOCOL.md`, `docs/TODO.md`

---

## 0. Bevor du anfängst

**Was der Core ist.** Die Ausführungsebene. Er kennt Instanzen, Prozesse, Ports und Dateien –
**keine** Nutzer, keine Rechte, keine Abrechnung. Alles, was nach Benutzerverwaltung riecht,
gehört ins Panel (`src/`), nicht in den Core. Einzige Ausnahme: der Standalone-Modus braucht
eine eigene, bewusst einfache lokale Anmeldung (Aufgabe 1.1).

**Arbeitsregeln**

1. Jede Aufgabe einzeln abschließen: Code + Tests + Eintrag in `docs/ENTWICKLUNGSLOG.md`
   (Datum, Uhrzeit Europe/Berlin, was, welche Dateien) und bei sichtbaren Änderungen in
   `CHANGELOG.md`. Dominik verfolgt den Fortschritt über diese beiden Dateien.
2. `npm run typecheck` **und** `npm test` müssen im Ordner `nexuscore/` grün sein, bevor eine
   Aufgabe als fertig gilt. Zusätzlich im Wurzelverzeichnis `npx tsc --noEmit` und in `web/`,
   wenn du dort etwas angefasst hast. Aktuell sind alle drei sauber – halte das so.
3. Antworten, Logtexte, Fehlermeldungen und Kommentare auf Deutsch. Oberfläche immer über
   `web/src/locales/de.json` und `en.json`, niemals fest verdrahtete Texte.
4. Keine neuen Abhängigkeiten ohne Notwendigkeit. Wenn doch: im Logeintrag begründen.
5. Finger weg von `src/` (Panel), außer die Aufgabe nennt es ausdrücklich.
6. Debug- und Wegwerfskripte nach `scratch/`, nicht ins Wurzelverzeichnis.
7. Wenn eine Entscheidung offen ist (Abschnitt 5), **nicht raten** – Dominik fragen.

**Erst committen.** Der Arbeitsbaum hat rund 80 geänderte Dateien und mehrere komplett
unversionierte Ordner (`nexuscore/rust`, `nexuscore/tests`, `nexuscore/src/http/routes`,
`nexuscore/src/store`, `migrations/0029_host_layer.sql`, `0030_sftp_passwords.sql`).
Lauffähigen Stand committen, bevor du neue Änderungen draufsetzt – sonst ist nichts mehr
trennbar, wenn etwas kippt.

---

## 1. Block A – Sicherheit (zuerst, blockiert alles andere)

Der Core startet in Phase 2 auf fremden Rechnern. Jeder Fehler hier ist Codeausführung auf dem
PC eines Nutzers. Dieser Block kommt **vor** jedem neuen Feature.

### A1 – Auth-Hook greift nur für `/core/` (kritisch)

In `src/http/server.ts` steigt der `onRequest`-Hook sofort aus:

```ts
if (!path.startsWith('/core/')) {
  return;   // ← /api/v1/* und /api/panel/* sind damit völlig offen
}
```

Dadurch sind ohne jeden Token erreichbar:

* `POST /api/panel/servers` – nimmt `executable` frei aus dem Body (`src/http/routes/standalone.ts`,
  `newServerSchema` prüft nur die Länge) → beliebiges Programm registrieren
* `POST /api/panel/servers/:id/start` → es läuft. Das ist Codeausführung auf dem Host.
* `POST /api/v1/servers/:id/command` → beliebige Zeilen in stdin jeder Instanz
* `GET /api/v1/auth/me` → gibt bedingungslos `role: admin` mit allen Rechten zurück

Die Bindung auf `127.0.0.1` reicht als Schutz nicht: der Sammel-Content-Type-Parser nimmt jeden
Typ an, also genügt ein `fetch` mit `text/plain` von einer beliebigen Webseite im Browser des
Nutzers – das ist eine „simple request“ ohne Preflight, CORS verhindert nur das Lesen der
Antwort, nicht das Schreiben. Ein offener Tab reicht. Mit `NEXUSCORE_HOST=0.0.0.0` (naheliegend
im Knoten-Modus) ist der Rechner offen im Netz.

**Zu tun**

* Hook umdrehen: standardmäßig **alles** geschützt, Ausnahmen über eine Allowlist
  (`GET /`, `GET /favicon.ico`, statische Assets unter `/assets/`, `GET /core/v1/info`,
  `POST /core/v1/pair`, und im Standalone-Modus der Anmeldeendpunkt aus A4).
* `/api/v1` und `/api/panel` in den Tokenschutz ziehen.
* Prüfen, dass die Allowlist auf dem **normalisierten** Pfad arbeitet (`..`, doppelte Schrägstriche,
  Groß-/Kleinschreibung, URL-Kodierung) – sonst ist sie mit `/core/v1/../api/panel/servers` umgehbar.
* Test je offener Route: ohne Token `401`, mit Token `2xx`.

### A2 – Browser-Zugriff absichern (CSRF) – erledigt 11.11.2026

> **Umgesetzt** in `src/http/server.ts` und `src/protocol/security.ts`, Tests in
> `tests/browser-protection.test.ts`. Eine bewusste Abweichung von der Vorgabe unten:
> Eine **fehlende** Herkunft wird nicht pauschal abgelehnt, sonst kämen Panel, PowerShell und
> das Selbsttest-Skript nicht mehr durch (sie schicken keinen `Origin`-Header). Abgelehnt wird
> eine fehlende Herkunft nur, wenn die Anmeldung aus dem Cookie stammt – das Cookie schickt nur
> ein Browser, und der nennt bei schreibenden Anfragen immer eine Herkunft. Beim Hostnamen sind
> IP-Adressen, `localhost` und die Namen aus `NEXUSCORE_ALLOWED_HOSTS` (neu) erlaubt.

* Sammel-Content-Type-Parser einengen: nur `application/json` (und was die Oberfläche wirklich
  braucht) parsen, alles andere mit `415` ablehnen. Das Problem mit PowerShell-POSTs ohne Body
  (`application/x-www-form-urlencoded`) löst stattdessen ein Parser, der genau diesen Typ nur
  bei leerem Body als „kein Body“ akzeptiert.
* `Origin`-Prüfung für alle schreibenden Anfragen: nur `http://127.0.0.1:<port>`,
  `http://localhost:<port>` und die Einträge aus `NEXUSCORE_CORS_ORIGINS`. Fremde oder fehlende
  Herkunft bei POST/PATCH/DELETE → `403`.
* Sicherheits-Header setzen (`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  restriktive CSP für die ausgelieferte Oberfläche).
* Schutz gegen DNS-Rebinding: `Host`-Header auf `127.0.0.1`, `localhost` oder die konfigurierte
  Adresse prüfen, alles andere ablehnen.

### A3 – `executable` einschränken – erledigt 11.11.2026

> **Umgesetzt** in `src/protocol/paths.ts`, eingebaut in `POST /core/v1/servers`,
> `POST /api/panel/servers` und `POST /api/v1/servers`. Relative Angaben werden aufgelöst:
> `workingDir` gegen das Server-Verzeichnis, `executable` gegen `workingDir`. Beim
> Docker-Treiber entfällt die Prüfung, dort sind beide Angaben Image und Pfad im Container.
> **Folge für B2:** Java oder SteamCMD müssen unter dem Server-Verzeichnis liegen oder vom Core
> selbst gestartet werden, ein Pfad wie `C:\Program Files\Java\…` wird über die Schnittstelle
> abgelehnt.

Freie Pfade aus dem Netz sind nicht haltbar, auch nicht mit Token.

* Basisverzeichnis einführen (`NEXUSCORE_SERVER_ROOT`, Standard `<dataDir>/servers`).
* `executable` und `workingDir` müssen nach `path.resolve` **innerhalb** dieses Verzeichnisses
  liegen – Prüfung mit `path.relative`, nicht mit `startsWith` auf Zeichenketten.
* Symlinks auflösen (`fs.realpath`) und danach erneut prüfen, sonst zeigt ein Link nach draußen.
* Konzeptbezug: Abschnitt 3.3 verspricht ausdrücklich, dass private Dateien des Freundes
  unerreichbar bleiben. Das ist die Umsetzung dieses Versprechens.
* Tests: Pfad außerhalb → `400`; `..`-Pfad → `400`; Symlink nach draußen → `400`.

### A4 – Rechte im Standalone-Modus ehrlich machen – erledigt 11.11.2026

> **Umgesetzt** in `src/store/account.ts` und `src/http/routes/api-v1.ts`. Ein lokales Konto
> (`NEXUSCORE_ADMIN_USER`, Standard `admin`), Passwort als scrypt-Hash in `account.json`.
> Ohne `NEXUSCORE_ADMIN_PASSWORD` erzeugt der Core beim ersten Start ein Passwort, zeigt es
> einmal im Fenster und schreibt es nach `ERSTES-PASSWORT.txt` im Datenverzeichnis; die Datei
> wird nach der ersten Anmeldung gelöscht. `/api/v1/auth/refresh` gibt ohne gültige Sitzung
> `401`. Fünf Fehlversuche sperren die jeweilige Herkunft für zehn Minuten. Sitzungen gelten
> sieben Tage und liegen nur im Speicher, nach einem Neustart ist eine neue Anmeldung nötig.
> `POST /api/v1/auth/password` ändert das Passwort; die Oberfläche hat dafür noch kein Formular.

`GET /api/v1/auth/me` in `src/http/routes/api-v1.ts` gibt jedem alle Adminrechte. Im lokalen
Einzelplatzbetrieb ist das vertretbar, als Dauerzustand nicht.

* Betriebsart explizit machen: `NEXUSCORE_ROLE=standalone|node` (Konzept Abschnitt 2, Modus A/B).
* Im Knoten-Modus liefern `/api/v1/*` und `/api/panel/*` `403` – dort steuert ausschließlich das
  Panel über `/core/v1`.
* Im Standalone-Modus eine echte lokale Anmeldung: ein Konto, Passwort beim ersten Start gesetzt
  oder in der Konsole ausgegeben, Hash mit Argon2id oder scrypt, Sitzungscookie
  `HttpOnly; SameSite=Strict; Path=/`. Kein festes `nexus-standalone-token` mehr.
* `/api/v1/auth/login` und `/logout` tatsächlich implementieren statt Platzhalter zurückzugeben.

### A5 – Kleinere Fehler, gleich mitnehmen – erledigt 11.11.2026

> **Umgesetzt:** Portvergabe über `src/protocol/ports.ts` (Bereich `NEXUSCORE_PORT_RANGE`, echter
> Bindungstest), `findServer` nur exakt, unbekannte Instanzen geben `404` (auch im WebSocket),
> `kill` beendet hart statt nur zu stoppen, beschädigte `servers.json` wird weggesichert und der
> Start bricht ab, eindeutige Temp-Datei mit `fsync`, Testinstanz nur noch einmal aufgebaut.

* **Portvergabe** (`api-v1.ts`): `25565 + registry.list().length` vergibt nach einer Löschung einen
  schon belegten Port. Freien Port im konfigurierten Bereich suchen und mit echtem Bindungstest
  prüfen – das Panel macht das in `src/servers/allocations.ts` bereits richtig, Vorgehen übernehmen.
* **`findServer`** (`api-v1.ts`): `s.id.startsWith(idOrShortId)` trifft fremde Server („mc“ findet
  „mc-test“). Nur exakte ID oder exakte Kurz-ID der ersten 8 Zeichen; bei mehreren Treffern `409`.
* **Fallback auf `req.params.id`** in Power- und Command-Route: unbekannte Instanz muss `404`
  ergeben, nicht an den Treiber durchgereicht werden.
* **Registry** (`src/store/registry.ts`): eine beschädigte `servers.json` wird still durch eine leere
  Registry ersetzt – alle Instanzen wären weg, ohne Hinweis. Stattdessen Datei als
  `servers.json.korrupt-<zeitstempel>` wegsichern, laut im Log melden und den Start abbrechen.
  Außerdem beim atomaren Schreiben einen eindeutigen Temp-Namen je Vorgang verwenden (aktuell
  teilen sich alle Schreibvorgänge `${file}.tmp`) und vor dem `rename` `fsync` aufrufen.
* **Testinstanz**: `index.ts` legt im Testmodus `test-minecraft-01` an und registriert sie doppelt
  (Treiber und Registry mit demselben Objekt getrennt aufgebaut). Zusammenführen und sicherstellen,
  dass das im Produktionsmodus nie passiert.

**Fertig, wenn:** jede Route ohne Token `401`/`403` liefert, ein Test die Pfadbeschränkung von
`executable` beweist, ein Test eine Anfrage mit fremdem `Origin` abgewiesen sieht, und
`npm test` grün ist.

---

## 2. Block B – Phase 2: Standalone-Panel (Konzept Abschnitt 2 Modus A, Roadmap Phase 2)

Ziel laut Konzept: Doppelklick auf die `.exe`, Browser auf, Gameserver anlegen und spielen –
ohne Cloud, ohne feste IP. Heute ist davon die Oberfläche da, aber die Server sind Attrappen:
`POST /api/v1/servers` schreibt ein `start.bat`, das nur eine Zeile ausgibt und dann `ping` in einer
Endlosschleife läuft. Nichts wird installiert.

### B1 – Lokale Datenbank statt `servers.json` – erledigt 11.11.2026

> **Umgesetzt** in `src/store/database.ts` und `src/store/registry.ts` mit `node:sqlite`
> (Entscheidung 2 in Abschnitt 5). Migrationen stehen im Code, weil die gepackte `.exe` keine
> Dateien nachladen kann. Die Registry hat jetzt auch Einstellungen (`getSetting`/`setSetting`),
> Audit (`audit`/`recentAudit`) und Aufgaben (`createTask`/`updateTask`/`listTasks`).
> Anlegen, Start, Stopp, Kill und Anmeldungen werden ins Audit geschrieben. **Noch offen:** das
> Konto liegt weiter in `account.json`, und `GET /api/v1/tasks/active` liefert noch eine leere
> Liste – die Aufgaben füllt erst B2 (Installation).

* SQLite (`core.db`) im `dataDir`, Tabellen für Instanzen, Einstellungen, Audit und Aufgaben.
* Eigener kleiner Migrations-Runner, Vorbild `src/db/` im Panel.
* Umzug aus einer vorhandenen `servers.json` beim ersten Start, Altdatei als `.migriert` behalten.
* Entscheidung zur Bibliothek steht noch offen → Abschnitt 5.

### B2 – Echte Spielinstallation – Teil 1 (Minecraft Paper) erledigt 11.11.2026

> **Umgesetzt** unter `src/install/`: Download mit Pflicht-Prüfsumme und Host-Liste
> (`download.ts`), Java-Laufzeiten des Cores (`java.ts`, Eclipse Temurin nach
> `<Datenverzeichnis>/runtimes/java-<version>`), Paper über die PaperMC-Schnittstelle Fill v3
> (`paper.ts` – die alte `api.papermc.io/v2` ist abgeschaltet), `server.properties` aus der
> Zuordnung im Egg (`properties.ts`), Ablauf (`minecraft.ts`) und Aufgaben mit Fortschritt
> (`manager.ts`). `POST /api/v1/servers` installiert jetzt wirklich, wenn das Egg
> `minecraft-paper` mit `TYPE=PAPER` ist und der native Treiber läuft; `/reinstall` wiederholt
> es. Stoppen geht zuerst über den Stopp-Befehl an stdin.
> **Abnahme auf Dominiks Windows-PC am 11.11.:** Paper 26.3 mit Java 25 in 15 s installiert, nach
> 14 s bereit, Spielport erreichbar, `stop` speichert die Welt und endet mit Code 0.
> **Bewusst kopiert statt geteilt:** Platzhalter und `.properties`-Patcher sind klein nachgebaut,
> weil der Core `src/` des Panels nicht importieren darf. Ein gemeinsames Paket steht aus.
> **SteamCMD (11.11.2026, Palworld live abgenommen: installiert, gestartet, gestoppt; Enshrouded noch nicht live):** `src/install/{steamcmd,steam-game}.ts`; Egg-Schlüssel `windows` (siehe `docs/EGG-VORLAGE.md`); Palworld und Enshrouded haben ihn. Fehlt noch: Abnahme auf dem Windows-PC mit echter Steam-Verbindung, sauberes Beenden, Startmuster.
> **Noch offen in B2:** Live-Abnahme der Steam-Spiele, weitere Spiele mit `windows`-Block, die anderen Minecraft-Typen (Fabric,
> Forge, Vanilla …), INI/YAML/JSON/XML-Konfiguration, und das Startmuster („Done“) für den
> Zustand „läuft“ – der Treiber meldet „läuft“, sobald der Prozess gestartet ist.

* SteamCMD besorgen und ausführen (Download, Entpacken, `app_update`, Fortschritt in den Event-Bus).
* Java-Server (Paper, Fabric, Vanilla): Java prüfen oder mitliefern, Jar herunterladen, EULA.
* Die Egg-Dateien aus `eggs/` werden schon gelesen (`loadEggs` in `api-v1.ts`), aber nicht
  ausgeführt. Installationsschritt und Startkommando aus dem Egg tatsächlich umsetzen.
* Platzhalterersetzung und Variablenprüfung nicht neu erfinden: das Panel hat das in
  `src/eggs/{rules,variables,config-files}.ts` samt Tests. Entweder in ein gemeinsames Paket ziehen
  oder bewusst kopieren – im Logeintrag festhalten, welcher Weg gewählt wurde.
* Konfigurationsdateien nach dem Anlegen patchen (`properties`, INI mit Abschnitten, YAML, JSON,
  XML) – nur die genannten Schlüssel ändern, Kommentare und Reihenfolge behalten.
* Fortschritt als Aufgabe mit Stufen melden, damit die Oberfläche einen Balken zeigen kann.
* Mindestens Minecraft Paper, Palworld und Enshrouded müssen auf Dominiks Windows-PC
  tatsächlich installierbar und startbar sein. Das ist das Abnahmekriterium, nicht „der Code läuft durch“.

### B3 – Harte Ressourcengrenzen unter Windows (Konzept Abschnitt 6) – Job Objects erledigt 11.11.2026

**Stand:** `helper/nxjob` (Rust, ohne Fremdpakete) startet Spiele in einem Job Object (`KILL_ON_JOB_CLOSE`, Speicher-/CPU-Grenze); der Treiber nutzt es, Grenzen schaltet der Administrator ein (Admin → Hosts). **Offen:** eigener Dienstbenutzer `nxp-<id>` und NTFS-Rechte.

* Job Objects: `JOB_OBJECT_LIMIT_PROCESS_MEMORY` für RAM, CPU-Rate-Limit, und
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, damit kein verwaister Kindprozess übrig bleibt.
* Heute räumt `windows-native.ts` nur mit `taskkill /T` hinterher – das greift erst beim Beenden
  und begrenzt nichts.
* Umsetzung über ein kleines Rust-Hilfsprogramm, das der Core als Prozess aufruft
  (Entscheidung 11.11.2026, Abschnitt 5). Keine native Anbindung im Node-Prozess.
* Erst danach: eigener Dienstbenutzer `nxp-<id>` und NTFS-Rechte (Konzept Abschnitt 6, „Isolierung“).

### B4 – Dateimanager und Backups lokal – Teil 1 (Dateien) erledigt 11.11.2026

> **Umgesetzt:** `src/files/files.ts` und `src/http/routes/files.ts` mit denselben Routen und Antworten wie im
> Panel: auflisten, lesen, speichern, Ordner anlegen, umbenennen, löschen, herunterladen, hochladen.
> Jeder Pfad läuft durch `resolveInsideRoot` aus A3 (vor und nach dem Auflösen von Symlinks). Darüber hinaus:
> Ein Server bekommt nur Dateizugriff, wenn sein Ordner **unter** dem Server-Verzeichnis liegt (nicht gleich
> diesem und nicht außerhalb) – die Testinstanz im Projektordner bleibt damit gesperrt. Unter Windows werden
> Gerätenamen (`nul`, `con` …), `:` (Datenströme) und Punkt/Leerzeichen am Ende abgelehnt. Uploads laufen über
> eine Temp-Datei, haben eine Obergrenze (`NEXUSCORE_MAX_UPLOAD_MB`) und nehmen aus dem Dateinamen nur den Namen.
> **Weg für die Dateilogik:** bewusst nachgebaut statt geteilt (der Core darf `src/` des Panels nicht importieren).
> **Noch offen in B4:** SFTP, Zip64 (über 4 GB), .tar.zst.
>
> **Funktionsliste und Oberfläche:** `GET /api/v1/about` meldet `standalone: true` und `features`
> (heute `files`, `settings`, `logfiles`, `schedules`, `backups`, `players`, `admin`, `audit` und `account`, `configs`, `motd` und `testreport`). Die Oberfläche (`web/src/lib/features.ts`) blendet Menüpunkte, Server-Tabs, Einträge der
> Befehlspalette und ganze Seiten aus, die der Core nicht kann, und zeigt bei einer direkt aufgerufenen Adresse
> „Hier nicht verfügbar“. Fehlt die Angabe (Panel), bleibt alles wie bisher. Die Rechte je Server (`SERVER_PERMISSIONS`)
> enthalten nur noch, wofür es Routen gibt. **Wer eine Funktion baut, trägt sie in `CORE_FEATURES` ein** und nimmt die
> passenden Rechte auf; Bereiche: `backups`, `schedules`, `players`, `subusers`, `logfiles`, `settings`,
> `timeline`, `updates`, `sftp` (je Server) sowie `admin`, `help`, `account` (ganze Seiten). Benutzer, Audit,
> Netzwerk, Integrationen und Hosts: **auch diese sollen in den Core** (Wunsch Dominik, 11.11.2026). Die
> Ausblendung ist nur der Zwischenstand, nicht der Plan – gebaut wird Funktion für Funktion, und jede erscheint in
> der Oberfläche, sobald sie in `CORE_FEATURES` steht. Ziel ist, dass die Standalone-Oberfläche alles kann, was das
> Panel kann; bei den Benutzern ist offen, wie weit (Abschnitt 5, Punkt 6).
> **Einstellungen (11.11.2026, erledigt):** `src/http/routes/settings.ts` mit denselben Routen wie im Panel:
> umbenennen, Tags und Favorit, Server löschen (mit `?force=true` für laufende; Dateien nur unter dem Server-Verzeichnis,
> Verknüpfungen werden nicht verfolgt), Ressourcen, Spiel-Einstellungen als Formular aus dem Egg (`src/eggs/loader.ts`,
> `src/eggs/rules.ts`, bei geänderter Paper-Version automatische Neuinstallation) und Ports (hinzufügen, ändern, löschen,
> neu vergeben, TCP und UDP). Änderungen an Ports, RAM und Spiel-Einstellungen gehen nur im gestoppten Zustand und kommen
> beim nächsten Start beim Treiber an. Zusatzdaten (Tags, Favorit, Speicher, Bandbreite) liegen in `core.db`
> (Einstellung `server.<id>.meta`). **Der Core nimmt nur an, was er auswertet:** Auto-Neustart und Auto-Sleep werden mit
> klarer Meldung abgelehnt; **RAM wirkt über den Java-Heap, CPU, Speicher und Bandbreite werden gespeichert, aber noch nicht
> durchgesetzt (B3).** Neu im Treiber: `unregisterServer` (Mock und Windows; der Docker-Treiber meldet noch nicht ab).
> Die Oberfläche blendet in „Einstellungen“ Konfigurationsdateien, Subdomain, Import, Modpacks, MOTD, Auto-Neustart und
> Auto-Sleep aus (Bereiche `configs`, `domain`, `import`, `modpacks`, `motd`, `autorestart`, `autosleep`).
> **Logdateien und Zeitpläne (11.11.2026, erledigt):** Logs je Server lesen/herunterladen (`log_dirs` im Egg, Pfadgrenze, `.gz` bis 20 MB). Zeitpläne in `core.db` (Migration 2), Takt alle 30 s; Aktionen Neustart und Befehl, Zeitangabe als Intervall, `HH:MM` oder Cron (ungültig = 400); verpasste Läufe werden übersprungen, nicht nachgeholt. Backup-Zeitpläne folgen mit den Backups (bis dahin 400). `src/ops/power.ts` ist der gemeinsame Weg für Start/Stopp/Neustart.
> **Backups (11.11.2026, erledigt):** `src/backups/manager.ts`, Routen wie im Panel, `.tar.gz` über das System-`tar` nach `<Datenverzeichnis>/backups`, SHA-256 und Prüfung, Wiederherstellen nur bei gestopptem Server und mit Prüfung auf unsichere Pfade/Verknüpfungen, Automatik-Zeitplan mit Aufbewahrung, Backup-Zeitpläne. Kein NAS. Deltas bleiben offen.
> **Spieler (11.11.2026, erledigt, nur Minecraft Paper):** `src/players/manager.ts`, `src/games/minecraft.ts`. Server List Ping für den Live-Zustand, Listen aus den Dateien des Servers, Aktionen über die Konsole (kein RCON), Banns auf Zeit mit Aufhebung durch den Core. Noch nicht an einem echten Server erprobt.
> **Packen, Entpacken, Versionsverlauf (11.11.2026, erledigt):** `src/files/archive.ts` (zip lesen/schreiben, tar/tar.gz lesen, mit Schutz gegen Pfad-Ausbruch, Verknüpfungen und Archivbomben), Versionen in `core.db` (Migration 4, 25 je Datei, Rollback sichert den Stand davor).
> **Audit und Admin-Übersicht (11.11.2026, erledigt):** `src/http/routes/admin.ts`, Abfragen in `registry.queryAudit/auditStats`. Übrige Admin-Kacheln (Benutzer, Hosts, Netzwerk, Integrationen, Host-Logs, Testbericht, Dateien) bleiben ausgeblendet.
> **Konto (11.11.2026, erledigt):** `src/http/routes/account.ts`; Profil, Zwei-Faktor (TOTP, Wiederherstellungscodes, jeder Code nur einmal), Sitzungen mit Kennung. Kein QR-Code, keine Passkeys, keine Steam-Anmeldung. Öffentliche Route `/auth/methods` für die Anmeldeseite.

* Dateiendpunkte: auflisten, lesen, schreiben, umbenennen, löschen, hochladen, Archiv entpacken –
  alles unter der Pfadbeschränkung aus A3, ohne Ausnahme.
* Backups: Verzeichnis packen (zstd oder zip), Zeitplan, Aufbewahrungsregel, Wiederherstellen.
* Konzept Abschnitt 5.1 braucht später Deltas der Spielstände – Backupformat jetzt so wählen,
  dass sich Deltas später ergänzen lassen, statt es zweimal zu bauen.

### B5 – Windows-Dienst und Systray (Konzept Abschnitt 6)

* `nexuscored` als echter Windows-Dienst, Autostart, Neustart bei Absturz.
* Systray-Symbol mit Status, Adresse der Oberfläche und Kopplungs-PIN zum Kopieren.
* Firewall-Freigabe je Spiel-Binärdatei über die Windows-Firewall-API, beim Entfernen wieder zurück.
* Das MSI-Paket gibt es schon (`deploy/windows/NexusCore.wxs`, `scripts/build-windows-package.ps1`) –
  Dienst und Systray dort einhängen.

### B6 – Gaming-Modus (Konzept Abschnitt 3.3) – erledigt 11.11.2026

**Stand:** Drosseln (Priorität) oder Stoppen mit Vorwarnung in der Spielkonsole, beides in Admin → Hosts. CPU-Rate-Drosselung zusätzlich über `nxjob` ist möglich, aber noch nicht an den Modus gehängt.

* Schalter, der laufende Instanzen drosselt (Priorität, CPU-Rate) oder mit Vorwarnung pausiert.
* Vorwarnung an die Spieler über die Serverkonsole, nicht nur im Panel.

---

## 3. Block C – Phase 3: Reverse-Tunnel und Cluster (Konzept Abschnitte 3–5)

Erst anfangen, wenn Block A fertig und Block B tragfähig ist. Ein Tunnel über eine unsichere
Schnittstelle vergrößert nur den Schaden.

### C1 – Steuerkanal

* Ausgehender WSS-Client im Core auf `wss://<master>/core/v1/tunnel`, Authentifizierung mit dem
  Knoten-Token.
* Abbruch in unter 2 Sekunden erkennen (Ping/Pong), automatischer Neuaufbau mit exponentiellem
  Backoff und Streuung.
* Befehle und Antworten gemultiplext über eine Verbindung, jede Anfrage mit eigener Kennung.
* Gegenstück im Panel: Endpunkt, Knotenverwaltung, Weiterleitung der Panel-Aktionen an den Knoten.
  Dafür liegt `migrations/0029_host_layer.sql` schon im Baum – daran anschließen.

### C2 – Spiel-Datenverkehr weiterleiten

* TCP- und UDP-Ingress auf dem Master, Pakete durch den Tunnel zum Heim-PC.
* UDP ist der schwierige Teil (ARK, Palworld): Sitzungszuordnung, Zeitüberschreitungen, MTU.
* Messbares Ziel: zusätzliche Latenz und Durchsatz gegen eine direkte Verbindung vergleichen und
  die Zahlen in den Logeintrag schreiben. Wenn der Umweg ein Spiel unspielbar macht, muss das vor
  dem Ausbau auf dem Tisch liegen.

### C3 – Cluster-Beitritt (Konzept Abschnitt 3.1)

* Einladungscode im Panel erzeugen, im Core „Einem Freundes-Cluster beitreten“ mit Codeeingabe.
* Code einmalig, mit Gültigkeitsfrist, Sperre nach Fehlversuchen – Vorbild ist die vorhandene
  PIN-Logik in `src/protocol/security.ts`, aber mit **pro Herkunft** gezählten Fehlversuchen:
  der Zähler ist derzeit global, ein Angreifer sperrt damit die Kopplung für alle.
* Ressourcenbudget je Knoten (Abschnitt 3.3): „maximal 16 von 32 GB“ muss der Core selbst
  durchsetzen, nicht nur anzeigen.

### C4 – Lastverteilung (Konzept Abschnitt 3.2)

* Knoten melden freien RAM, CPU-Last und Plattenplatz.
* Beim Anlegen: Auswahlliste oder automatische Wahl des Knotens mit der geringsten Last.

### C5 – Failover und Split-Brain-Schutz (Konzept Abschnitt 5)

* Heartbeat alle 5 Sekunden, nach 30 Sekunden gilt ein Knoten als offline.
* Spielstand-Deltas alle 5 Minuten oder bei Autosave, zstd-komprimiert und verschlüsselt.
* Notfallstart auf dem Ersatzknoten, Umschalten der Ingress-Ports.
* Split-Brain: der Core fragt **vor jedem Start** beim Master, ob er der berechtigte Host ist.
  Eine Pacht (Lease) mit Ablaufzeit ist dafür sicherer als eine Ja/Nein-Frage, weil die Antwort
  sonst veraltet, sobald das Netz wackelt. Ohne gültige Pacht: Standby, nicht starten.
* Das ist der Teil mit dem größten Risiko für Datenverlust. Vor der Umsetzung eine kurze Spezifikation
  nach `nexuscore/docs/` schreiben und Dominik zeigen, statt direkt zu bauen.

---

## 4. Block D – Weitere Plattformen (Konzept Abschnitte 7–9, Roadmap Phase 4)

Zuletzt, und erst wenn Windows und der Tunnel stehen.

* **macOS:** Universal Binary (arm64 + x86_64), `.dmg`, Homebrew-Formel, `launchd`-Agent,
  Menüleisten-Symbol.
* **Linux:** `.deb` und `.rpm`, `systemd`-Unit `nexuscored.service`, Einzeiler-Installationsskript.
  Podman rootless als zweite Laufzeit neben Docker.
* **NexusPanel OS:** ISO und VM-Abbilder, Einrichtung im Browser, A/B-Updates mit Rücksprung.
* **CI:** Builds für alle Plattformen, Releases mit Prüfsummen, signierter Updater.
  `.github/workflows/release.yml` gibt es bereits – dort anbauen.

---

## 5. Offene Entscheidungen – bei Dominik nachfragen, nicht selbst festlegen

1. ~~Rust oder TypeScript als Kern?~~ **Entschieden am 11.11.2026: TypeScript.** Der TS-Core ist
   das Produkt. `nexuscore/rust/` ist entfernt. Rust ist auf ein kleines Hilfsprogramm für Windows
   begrenzt (Job Objects, Dienst, Tray), das der Core als Prozess aufruft, und auf die Hülle der
   Tauri-Apps. Keine Fachlogik in Rust.
2. ~~SQLite-Anbindung~~ **Entschieden am 11.11.2026:** `node:sqlite`. Keine native Abhängigkeit,
   das Paket als einzelne `.exe` bleibt einfach. Der Core verlangt dafür Node 22.13 oder neuer.
3. ~~Native Windows-Anbindung für Job Objects~~ **Entschieden am 11.11.2026:** kleines
   Rust-Hilfsprogramm (folgt aus Entscheidung 1). Der MSVC-Linker muss dafür auf dem Baurechner
   oder in CI (`windows-latest`) vorhanden sein.
4. ~~Standalone-Anmeldung~~ **Entschieden am 11.11.2026:** ein Konto mit Passwort. Es schützt
   auch dann, wenn der Core im LAN erreichbar ist.
5. **Tunnel-Master:** läuft der Ingress auf der VM 10.0.0.120 hinter Caddy, oder braucht das einen
   eigenen VPS mit eigener IPv4?
6. **Benutzerverwaltung im Standalone-Core:** Der Core kennt bisher bewusst nur ein Konto. Benutzer, Rollen und
   Mitnutzer (Tab „Mitnutzer“, Admin-Seiten) im Core bräuchten eine eigene Benutzer- und Rechtetabelle in `core.db`
   und widersprechen „Der Core kennt keine Nutzer“ aus Abschnitt 0. **Entschieden und gebaut (Ja, bauen):** Benutzer in `users.json`, Rollen, Modul-Rechte, Server-Besitz und Rechte-Flags je Server, zentrale Rechtetabelle (`http/authz.ts`). Auf dem nativen Treiber dürfen nur Administratoren Dateien schreiben und entpacken (`NEXUSCORE_ALLOW_USER_FILE_WRITE` hebt das auf). Offen: Mitnutzer selbst einladen (Tab „Mitnutzer“), Sichtprüfung als anderer Benutzer, Plattenplatz-Grenze je Benutzer, Steam-Anmeldung.

---

## 6. Reihenfolge in einem Satz

Block A komplett → committen → B1, B2 (echte Installation ist das Herz von Phase 2) → B3, B4 →
B5, B6 → Entscheidungen aus Abschnitt 5 einholen → Block C mit Spezifikation vorab → Block D.
