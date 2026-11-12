# Datenübernahme: Panel → Core

Dieses Werkzeug übernimmt die Daten eines laufenden Panels (Postgres) in den Core. Es **verändert das Panel nicht** und
schreibt ohne `--apply` auch im Core nichts (Trockenlauf mit Bericht).

## Was übernommen wird

| Bereich | Übernahme |
|---|---|
| Benutzer | Kennung, Name, E-Mail, **Passwort-Hash (argon2id gilt im Core weiter)**, Rolle, Rechte, Limits, Sprache, Avatar, Steam-Verknüpfung, Passkeys, Zwei-Faktor (neu verschlüsselt) |
| Netzwerk | Öffentliche Adresse und Port-Bereich |
| Einstellungen | CurseForge-Schlüssel, Playit-Schlüssel, Discord-Webhook, DNS (mit Token) – alles neu verschlüsselt |
| Steam-Konten | Name und Passwort (neu verschlüsselt); die bestätigte Steam-Guard-Anmeldung gilt im Core nicht – einmal „Testen“ |
| Server | Spiel (über den Namen), Image, Ports, Variablen, Arbeitsspeicher/CPU, Besitzer, Mitnutzer mit Rechten, Tags, Favorit, Subdomain/SRV, Zeitpläne |
| Spieldaten | **werden nicht kopiert**: der Core nimmt den Server-Ordner des Panels (`<volumes>/<short_id>`) in place |

## Was nicht übernommen wird (der Bericht nennt es)

Backups (Dateien bleiben im Backup-Ordner des Panels), Speicherziele, Wiederherstellungscodes, SFTP-Passwörter,
Spielersperren, gekoppelte Cores, Auto-Restart / Auto-Sleep (gibt es im Core noch nicht), ein vom Spiel abweichendes
Startkommando (es gilt das des Cores).

## Ablauf

1. **Export** auf dem Panel-Rechner (nur lesend):
   ```bash
   ./scripts/export-panel.sh > panel-export.json
   ```
   Die Datei enthält Hashes und verschlüsselte Geheimnisse – wie ein Passwort behandeln, danach löschen.
2. **Trockenlauf** im Core (der Panel-ENCRYPTION_KEY steht in der `.env` des Panels):
   ```bash
   export PANEL_ENCRYPTION_KEY=<64 Hex-Zeichen>
   node dist/cli/import-panel.js --export panel-export.json --volumes /var/lib/panel/volumes
   ```
   Fehler (z. B. „Spiel unbekannt“) zuerst beheben; Hinweise lesen.
3. **Umschalten** (kurze Unterbrechung der laufenden Server!):
   - Spielserver-Container des Panels stoppen und entfernen (`nxp-<short_id>`) – sonst teilen sich Panel und Core Ordner und Ports.
   - Panel stoppen.
   - Core stoppen (falls er läuft), dann mit `--apply` wiederholen.
   - Core starten, anmelden, Server einzeln starten und prüfen.
4. **Nach der Übernahme**: Export-Datei löschen; Steam-Konten „Testen“; Backups und Speicherziele neu einrichten.

Kann man jederzeit wiederholen: was schon da ist, wird übersprungen (nie überschrieben).
