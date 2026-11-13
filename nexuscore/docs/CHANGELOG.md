# Änderungen am NexusCore

Neueste Version oben. Nummerierung wie beim Panel: `0.MINOR.PATCH`, 1.0 erst, wenn Dominik den Core für fertig erklärt.

## [0.3.6] – 2026-11-13 – Oberfläche als App

### Neu
- Die Oberfläche lässt sich als App installieren (Web-App-Manifest und Symbole): in Chrome, Edge oder Opera erscheint „Als App installieren“; sie öffnet sich dann in einem eigenen Fenster ohne Adressleiste.
- Windows-Installer: Startmenü-Eintrag „NexusCore öffnen“ öffnet die Oberfläche mit Edge im App-Modus.

## [0.3.5] – 2026-11-13 – Windows-Dienst startet

### Behoben
- Der Dienst „NexusCore Host Daemon“ startete nach der Installation nicht: der Arbeitsordner `[INSTALLFOLDER]` endet mit `\`, und `\"` zerlegte die Befehlszeile des Dienstes (`nxsvc`: „Es fehlt das Programm“). Der Backslash wird jetzt verdoppelt.

## [0.3.4] – 2026-11-13 – Windows-Installer enthält Oberfläche und Spielvorlagen

### Neu
- Der Windows-Installer hat jetzt ein Installationsfenster mit Willkommensseite, Zielordner, Fortschrittsbalken und Fertig-Seite (Deutsch).

### Behoben
- Die `nexuscore.exe` stürzte beim Start sofort ab (`fileURLToPath(undefined)`): im gebündelten Code fehlte `import.meta.url`. Der Dienst „NexusCore Host Daemon“ konnte deshalb nach der Installation nie starten. Der Bau setzt jetzt den Ort der Programmdatei dafür ein.
- Der Bau-Skript meldete „erfolgreich“, auch wenn der MSI-Bau fehlschlug; jetzt bricht es ab.
- Der Windows-Installer (MSI) enthielt nur die Programme, aber weder die Weboberfläche noch die Spielvorlagen (`eggs`) noch die Doku. Ein damit installierter Core hätte keine Oberfläche und keine Spiele gehabt. Jetzt liegen `web`, `eggs` und `docs` neben `nexuscore.exe`.

## [0.3.3] – 2026-11-13 – Schnelleres Dashboard, Modpack-Version wählbar, Hilfe gefüllt

### Neu
- Modpack-Version beim Anlegen wählbar: Unter „Leistung“ steht eine Liste aller Versionen (neueste vorausgewählt); die Java-Version stellt sich passend ein (`GET /api/v1/modpacks/versions`).
- „Hilfe & Doku“: „Was ist neu“, „Geplant“ und „Entwickler-Log“ sind nicht mehr leer, sie lesen `CHANGELOG.md`, `TODO.md` und `ENTWICKLUNGSLOG.md` aus den docs-Ordnern.

### Geändert
- Server-Übersicht (Dashboard) lädt viel schneller: die Auslastung der Server wird gleichzeitig statt nacheinander gemessen (vorher rund 5 s bei 3 Servern), gleichzeitige Anfragen teilen sich eine Messung und frische Werte kommen aus einem kurzen Zwischenspeicher.
- Der Changelog des Cores liegt jetzt in `docs/CHANGELOG.md`.

## [0.3.2] – 2026-11-13 – Sven Co-op startet wieder

### Behoben
- Sven Co-op stürzte beim Start ab (Segfault, Code 130): Die Steam-Aktualisierung beim Start legt eine `steamclient.so` in den Spielordner, die der Server nicht verträgt. Das Egg löscht sie jetzt vor dem Start; der Server nutzt die Datei aus `.steam/sdk32`.

### Offen
- Astroneer beendet sich unter Proton still mit Code 0 (kein Spiel-Log). Ursache auf der Test-VM nicht geklärt; möglicherweise die CPU ohne AVX2 oder ein Proton-Problem. Test auf einem anderen Rechner steht aus.

## [0.3.1] – 2026-11-13 – Steam-Wiederholung auch beim Start

### Neu
- Testlauf: Steam meldet beim anonymen Start oft erst beim 2. oder 3. Versuch Erfolg („Missing configuration“). Der Test startet das Spiel deshalb bis zu dreimal (Satisfactory und V Rising laufen damit durch).
- Testbericht nennt die fehlende Lizenz bei Assetto Corsa.

### Offen
- Astroneer (beendet sich unter Proton still mit Code 0) und Sven Co-op (Absturz in `svends`, Code 130) scheitern weiterhin; Ursache noch unklar.

## [0.3.0] – 2026-11-13 – Linux-Test auf echter VM, Installer-Log, Steam-Wiederholung

### Neu
- Spiele-Testbericht nennt den Grund bei fehlender Steam-Lizenz (Left 4 Dead 2, Farming Simulator 25, Arma 3) und bei CPU ohne AVX2 (The Bus, Code 132).
- Steam-Fehler bei der Installation werden erkannt; vorübergehende Fehler („Missing configuration“, Zeitüberschreitung) wiederholt der Core bis zu dreimal.
- Windows-Installer (MSI) nimmt die Versionsnummer automatisch aus `package.json`.

### Behoben
- Das Installer-Log kam nie an, weil es vor dem Start des Containers abgerufen wurde.
- Tests laufen auch auf Linux-Runnern und Node 22 (temporärer Datenordner, argon2 nur ab Node 24.7, WebSocket-Ablehnung unter Node 22).

## [0.2.0] – 2026-11-10 – Erster lauffähiger Core
Core mit Weboberfläche, Windows- und Docker-Treiber, Benutzerverwaltung, SFTP, Panel-Übernahme.
