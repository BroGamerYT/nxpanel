# NexusCore installieren — ein System, drei Betriebssysteme

Der Core, die API und die Weboberfläche sind auf **Windows, Linux und macOS derselbe Code**. Nur die unterste Schicht
(`src/platform/index.ts`) kennt das Betriebssystem. Dort steht, welcher Treiber läuft, wie der Core als Dienst eingerichtet
wird und was die Firewall kann. Nichts sonst im Core hängt vom System ab (ein Test sorgt dafür).

| | Windows | Linux | macOS |
| --- | --- | --- | --- |
| **Spiele laufen als** | direkter Prozess (`windows-native`, mit harten Grenzen über `nxjob`) **oder** Docker Desktop | Docker Engine | Docker Desktop |
| **Standard-Treiber** | `windows-native` | `docker` | `docker` |
| **Dienst** | Windows-Dienst `nxsvc` + Tray | systemd | LaunchAgent (launchd) |
| **Einrichten** | `scripts\install-service.ps1` | `sudo bash deploy/linux/install-core.sh` | `bash deploy/macos/install-core.sh` |
| **Entfernen** | `scripts\uninstall-service.ps1` | `deploy/linux/uninstall-core.sh` | `deploy/macos/uninstall-core.sh` |
| **Firewall je Spielprogramm** | ja (`netsh`) | nein — Docker umgeht die Rechner-Firewall, die Ports regelt die Firewall des Rechners | nein |
| **Getestet** | ja, auf diesem PC (Dienst-Einrichtung braucht Administrator: nicht live geprüft) | Auf einer echten Debian-12-VM (Docker) getestet: Dienst, Updates und ein Gesamtlauf über alle 47 Spiele (39 bestanden, Stand 13.11.2026; der Rest braucht eine Steam-Lizenz, eine CPU mit AVX2 oder wird noch geprüft). **Noch kein Lauf auf einer frischen Hyper-V-VM mit dem Installer** | Skripte nur per Probelauf. **Noch kein Lauf auf einem Mac** |

## Installer ausprobieren (Windows-Sandbox)

`nexuscore\scripts\sandbox-test.bat` per Doppelklick: startet die Windows-Sandbox mit dem Installer aus `nexuscore\dist` (Protokoll `install.log`) und Notepad. Im Sandbox-Ordner „NexusCore-Test“ liegen `Logs-ansehen.cmd` und `Logs-kopieren.cmd`; was dort liegt, sieht man auch auf dem PC unter `%USERPROFILE%\sbx-nexuscore`.

## Sichern und Reparieren

Im Admin-Hub: „Core-Sicherung & Reparatur“ (sichern, prüfen, wiederherstellen; vor jedem Update automatisch). Startet der Core nicht mehr: Dienst beenden, dann `nexuscore.exe backups` und `nexuscore.exe restore latest`. Fehlen Programmdateien: den Installer erneut starten und „Reparieren“ wählen.

## Gemeinsam auf allen Systemen

* Node.js **22.13 oder neuer**
* bauen: `npm ci && npm run build` in `nexuscore` und in `web`
* Einstellungen in der Umgebung (`NEXUSCORE_*`, Vorlage `.env.example`); `NEXUSCORE_RUNTIME` wählt den Treiber
* Selbsttest für den Docker-Weg: `NEXUSCORE_TOKEN=<Token> bash scripts/smoke-test.sh`
* Wird ein Treiber gewählt, den das System nicht kann (z. B. `windows-native` unter Linux), bricht der Core beim Start mit
  einer klaren Meldung ab.

## Was die Oberfläche vom System erfährt

`GET /api/v1/about` liefert `platform` (System, Treiber, Dienstart, Firewall mit Begründung) und `features`. Funktionen, die es
auf diesem System nicht gibt (z. B. Firewall-Freigaben unter Linux), stehen nicht in `features` — die Oberfläche blendet sie aus.

Weitere Anleitungen: [LINUX-VM-TEST.md](LINUX-VM-TEST.md) · [../README.md](../README.md)
