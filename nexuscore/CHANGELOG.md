# Änderungen am NexusCore

Neueste Version oben. Nummerierung wie beim Panel: `0.MINOR.PATCH`, 1.0 erst, wenn Dominik den Core für fertig erklärt.

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
