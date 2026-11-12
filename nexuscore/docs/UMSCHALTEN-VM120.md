# Umschalten auf VM 120: Panel → Core

Stand der Erkundung (nur lesend, 12.11.2026): Debian 12, Docker 29.9, 62 GB RAM, Panel als Docker-Stack unter `/opt/nxpanel`
(Panel auf Port 8080, Postgres, Redis). **Kein Node.js auf dem Rechner** (das Panel läuft im Container). Spiele: TeamSpeak 6
(läuft), ARK SA „Simon Ark“ (läuft, 14 GB), ATM11 (aus, Ordner leer). Panel-Spielcontainer haben `restart=no`.
Ordner: `/var/lib/panel/volumes/<kurz-id>` (TeamSpeak gehört `1000:1000`, ARK `25000:25000`), Backups unter
`/var/lib/panel/backups`. Angemeldet wird auf der VM als `root`.

Der Plan hat zwei Teile: **A** läuft nebenher ohne Auswirkung auf die Spieler und lässt sich folgenlos abbrechen,
**B** ist das eigentliche Umschalten mit kurzer Unterbrechung (ARK und TeamSpeak sind einige Minuten aus).

## Was vor dem Start zu klären ist

1. **Node.js ≥ 24.7 installieren** (offizielles Tarball von nodejs.org nach `/opt/node`, Symlink `/usr/bin/node`). Nötig, weil die
   Passwörter des Panels mit argon2id gespeichert sind und Node das ab 24.7 selbst prüfen kann. Das ist ein Download - dein Okay.
2. **Rechte auf den Spiel-Ordnern.** Der Core läuft als Benutzer `nexuscore`; die Ordner gehören `1000`, `25000` oder `root`.
   Lesen geht fast überall, **Schreiben (Dateimanager, Backup-Wiederherstellung) nicht**. Zwei Wege, du entscheidest:
   - **(Empfohlen) Dienst bekommt `CAP_DAC_OVERRIDE`** per Override-Datei (unten). Einfach, der Core steuert ohnehin Docker
     (praktisch Root); gilt für alle Ordner, auch künftige.
   - ACLs je Ordner (`setfacl -R -m u:nexuscore:rwX …`): enger, aber pro Server von Hand und das Paket `acl` muss da sein.
3. **Adresse der Oberfläche.** Das Panel hört auf 8080. Vorschlag: der Core übernimmt Port 8080 (`CORE_HOST=0.0.0.0`,
   `CORE_PORT=8080`, `NEXUSCORE_ALLOWED_HOSTS=<öffentliche Adresse>`), damit sich für die Benutzer nichts ändert. Sobald das Panel
   gestoppt ist, ist der Port frei.
4. **Zeitpunkt.** ARK/TeamSpeak sind einige Minuten offline - sag Simon Bescheid.

## Teil A - Vorbereitung (ohne Unterbrechung)

1. **Sicherung der Panel-Datenbank** (kostet nichts, ist der Rückweg):
   ```bash
   docker exec nxp-postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > /root/panel-db-$(date +%F).sql.gz
   cp /opt/nxpanel/.env /root/panel-env-$(date +%F).bak     # enthält ENCRYPTION_KEY
   ```
2. **Node.js** installieren (siehe oben), `node -v` prüfen.
3. **Core auf die VM bringen**: aus diesem Arbeitsordner `nexuscore` (`dist`, `package.json`, `package-lock.json`, `docs`, `scripts`,
   `deploy`), `eggs` und `web/dist` als Tarball nach `/root/nexuscore-src/` kopieren (`scp`), in der gleichen Ordnerstruktur
   entpacken (`nexuscore/`, `eggs/`, `web/dist`). Auf der VM: `cd nexuscore && npm ci --omit=dev` (lädt von npm).
4. **Core einrichten, aber nicht starten:**
   ```bash
   cd /root/nexuscore-src/nexuscore
   CORE_HOST=0.0.0.0 CORE_PORT=8081 NO_START=1 bash deploy/linux/install-core.sh   # 8081: solange das Panel noch 8080 hat
   ```
   Danach in `/etc/nexuscore/nexuscore.env` ergänzen: `NEXUSCORE_SERVER_ROOT=/var/lib/panel/volumes` und die Port-Spanne des
   Panels `NEXUSCORE_PORT_RANGE=28000-28998`.
   Override-Datei `/etc/systemd/system/nexuscore.service.d/panel-uebernahme.conf`:
   ```ini
   [Service]
   ReadWritePaths=/var/lib/nexuscore /var/lib/panel/volumes
   AmbientCapabilities=CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
   CapabilityBoundingSet=CAP_CHOWN CAP_FOWNER CAP_DAC_OVERRIDE
   ```
   (`ReadWritePaths` braucht der Core, weil `ProtectSystem=strict` sonst jedes Schreiben außerhalb des Datenordners verbietet.)
   Dann `systemctl daemon-reload`.
5. **Export und Trockenlauf** (nur lesend; der Core darf dabei laufen oder aus sein - der Trockenlauf schreibt nichts):
   ```bash
   cd /root/nexuscore-src/nexuscore
   ./scripts/export-panel.sh > /root/panel-export.json && chmod 600 /root/panel-export.json
   export PANEL_ENCRYPTION_KEY=$(grep ^ENCRYPTION_KEY= /opt/nxpanel/.env | cut -d= -f2)
   set -a; . /etc/nexuscore/nexuscore.env; set +a
   node dist/cli/import-panel.js --export /root/panel-export.json
   ```
   Erwartet: **0 Fehler**; Hinweise zu Steam Guard, Wiederherstellungscodes und Auto-Sleep sind normal. Erst weiter, wenn der Bericht
   sauber ist. (Der Trockenlauf gegen den echten Export war schon sauber: 3 Benutzer, 3 Server, 2 Steam-Konten.)
6. **Prüfen, dass `zstd` da ist** (`zstd --version`, auf der VM vorhanden) und dass Panel- und Core-Ordner auf demselben Datenträger
   liegen (`df /var/lib/panel /var/lib/nexuscore`, beide `/dev/sda1`) - sonst die Backups mit `--copy-backups` kopieren (35 GB, Platz ist da).

## Teil B - Umschalten (Unterbrechung ab hier)

1. **Spiele sauber beenden** - am besten im Panel (Stopp-Taste, wartet aufs Speichern), danach prüfen:
   ```bash
   docker ps --format '{{.Names}} {{.Status}}'      # nxp-c4bf23f2 und nxp-5753f82f dürfen nicht mehr da sein
   ```
   Falls einer hängt: `docker stop -t 180 nxp-c4bf23f2`. **Nicht** `docker rm` - die Container bleiben für den Rückweg.
2. **Panel stoppen, Datenbank bleibt:**
   ```bash
   cd /opt/nxpanel && docker compose stop panel
   ```
3. **Frischer Export** (der alte ist veraltet - seit dem Trockenlauf kann sich etwas geändert haben) und **Übernahme**, als `root`
   (nötig für die harten Verknüpfungen der Backups, `fs.protected_hardlinks=1`):
   ```bash
   ./scripts/export-panel.sh > /root/panel-export.json
   export PANEL_ENCRYPTION_KEY=...   # wie oben
   set -a; . /etc/nexuscore/nexuscore.env; set +a
   node dist/cli/import-panel.js --export /root/panel-export.json                   # noch einmal Trockenlauf, 0 Fehler?
   node dist/cli/import-panel.js --export /root/panel-export.json --apply
   chown -R nexuscore:nexuscore /var/lib/nexuscore
   ```
4. **Port tauschen und starten:** in `/etc/nexuscore/nexuscore.env` `NEXUSCORE_PORT=8080` setzen (+ `NEXUSCORE_ALLOWED_HOSTS`), dann
   `systemctl start nexuscore && journalctl -u nexuscore -n 50 --no-pager`.
5. **Anmelden** mit dem alten Benutzer und Passwort (z. B. `BroGamerYT`). Prüfen: Server-Liste (3 Server), Ports, Mitnutzer Simon,
   Backups (4), Einstellungen (CurseForge-Schlüssel gesetzt).
6. **Server einzeln starten**, zuerst TeamSpeak (klein): Konsole, Verbindung mit dem Client. Dann ARK (Laden dauert; Spieler prüfen).
   Beim ersten Start legt der Core die Container als `nxc-<kurz-id>` an - gleiche Ordner, gleiche Ports.
7. **Steam-Konten** einmal „Testen“ (Steam Guard neu bestätigen), **Backups** und Zeitpläne prüfen, ein kleines Backup anlegen.
8. **Aufräumen erst nach Tagen**, nicht sofort: `/root/panel-export.json` löschen (Hashes und Geheimnisse), die Datenbank-Sicherung
   behalten. Das Panel (`/opt/nxpanel`) bleibt liegen, bis alles gelaufen ist.

## Rückweg (jederzeit bis Schritt 8)

```bash
systemctl stop nexuscore                    # beendet die Spiele sauber (kann bis 3 Minuten dauern)
docker ps -a --format '{{.Names}}' | grep '^nxc-'   # Core-Container ggf. mit docker stop/rm entfernen - die Daten liegen in den Ordnern
cd /opt/nxpanel && docker compose up -d panel
```
Die Panel-Datenbank wurde nie verändert (nur gelesen), die Spielordner liegen unverändert dort; die Panel-Spielcontainer
(`nxp-…`) sind nur gestoppt und lassen sich im Panel wieder starten. Was der Core in der Zwischenzeit in den Spielordnern
geändert hat (Spielstände), gilt natürlich weiter.

## Bekannte Grenzen nach dem Umschalten

- Steam Guard: einmal im Core bestätigen.
- Wiederherstellungscodes und SFTP-Passwörter des Panels werden nicht übernommen (es gab keine); neue anlegen.
- ATM11 hat einen leeren Ordner (nie fertig installiert): im Core „Neu installieren“.
- Gekoppelt ist nichts (das Panel hatte nur den lokalen Host).
