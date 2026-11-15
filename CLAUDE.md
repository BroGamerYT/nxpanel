# NexusPanel / NexusCore – Arbeitsregeln für Claude

Antworte auf Deutsch. Das Repository ist **öffentlich** (BroGamerYT/nxpanel): keine Geheimnisse, keine Zugangsdaten, keine IP-Adressen in Dateien oder Commits.

## Aufbau

| Ordner | Was |
| --- | --- |
| `nexuscore/` | **Der Core** (TypeScript, Fastify): ersetzt das Panel. Eine Codebasis für Windows, Linux, macOS. Hilfsprogramme in Rust: `nexuscore/helper/nxsvc` (Windows-Dienst), `nxjob` (Prozess-Jobs). |
| `web/` | Weboberfläche (React, Vite), wird vom Core und vom alten Panel ausgeliefert. |
| `src/`, `migrations/` | Das **alte Panel** (Postgres, Redis). Wird abgelöst, sobald der Core alles kann; kaum noch Neues hier. |
| `eggs/` | Spielvorlagen (JSON). Spielwissen gehört ins Egg, nie in den Code. |
| `docs/`, `nexuscore/docs/` | Doku. Aufgabenliste: `nexuscore/docs/TODO.md`, Änderungen: `nexuscore/docs/CHANGELOG.md`. |
| `private/`, `scratch/` | Nur lokal, nicht im Repo (`.gitignore`). |

## Befehle

```bash
npm --prefix nexuscore run typecheck      # Typprüfung Core
npm --prefix nexuscore test               # Tests Core (vitest, ca. 1090)
npx tsc --noEmit                          # Typprüfung Panel (im Hauptordner)
(cd web && npx tsc -b && npm run build)   # Weboberfläche
bash nexuscore/scripts/build-linux-package.sh   # Linux-Paket (SKIP_BUILD=1 nur packen)
```

Die Panel-Tests brauchen Postgres und Redis (`npm run db:up`); die Core-Tests nicht.

## Regeln

- **Nicht pushen, taggen oder Releases ändern ohne ausdrückliches Ja** von Dominik. Vor jedem Push den Diff auf Geheimnisse prüfen.
- **Nichts auf VM 120 (Linux, `ssh vm120`) ändern oder deployen ohne Rückfrage**: dort laufen echte Server und Testläufe. Nur Lesen ist nach Frage in Ordnung. Zugangsdaten stehen in `VM-INFOS.md` (nicht im Repo).
- **Der Core auf Port 8443 gehört Dominik.** Vor Änderungen unter `nexuscore/src` prüfen, ob er als `tsx watch` (Änderung startet neu und beendet laufende Spiele hart) oder als `node dist` (zeigt nur den alten Build) läuft. Eigene Tests auf einer Testinstanz mit eigenem Port und Datenordner im Scratchpad.
- **Commits:** lokal, pro fertigem Teil; deutsche Nachricht im Stil `feat(nexuscore): …` / `fix(nexuscore): …`. Eigene Dateien einzeln hinzufügen, nie `git add -A`. Version immer in `nexuscore/src/version.ts`, `package.json` und `package-lock.json` zugleich erhöhen, dazu ein Eintrag im Changelog (ein Test prüft das).
- **Skripte und Dateien mit Python/PowerShell schreiben:** Das Bash-Werkzeug verschluckt doppelte Backslashes in Heredocs. Skripte mit dem Write-Tool anlegen, Windows-Pfade in `r'…'`. Zeilenenden der vorhandenen Datei beibehalten (viele Dateien sind CRLF, `*.sh` sind LF).
- **PowerShell 7:** Native Programme melden Fehler nur über `$LASTEXITCODE`; jeden Schritt prüfen. .NET löst relative Pfade vom Prozessordner auf, nicht von `Set-Location`.
- Nach jeder Änderung: Typprüfung und die betroffenen Tests. Vor dem Abschluss die ganze Testsuite.

## Release (Core)

1. Version erhöhen (siehe oben), Changelog-Eintrag `## [x.y.z]` schreiben, Tests grün.
2. Auf Ja warten, dann `git push origin main` und Tag `core-vx.y.z` (muss zur Version passen).
3. Der Bau (`.github/workflows/core-release.yml`) erzeugt `NexusCore-Setup.msi` (Windows) und `NexusCore-linux.tar.gz` und legt ein Release **als Vorabversion** an.
4. Testen (Windows-VM in Hyper-V; Linux nur nach Rückfrage). Danach gibt Dominik das Release auf GitHub frei (Haken „Pre-release“ entfernen). Erst dann bietet der Core es allen als Update an.
5. Der Bau muss bei jedem Fehler laut abbrechen: ein stilles Weiterbauen hat schon eine Exe ohne Core-Code erzeugt.

## Bekannte Stolpersteine

- `ssh2` erzeugt in ca. 0,5 % der Fälle unlesbare ed25519-Schlüssel: `generateHostKey()` in `nexuscore/src/sftp/server.ts` verwenden.
- `npm audit fix` stuft `dockerode` zurück (4.0.12 → 4.0.2): nicht ungeprüft ausführen.
- Native `.node`-Module (ssh2, cpu-features) werden nur auf dem CI-Rechner gebaut: `scripts/bundle-sea.mjs` hält sie extern.
- Windows-Update: Die Exe-Komponente hat je Version eine eigene GUID; `MajorUpgrade` läuft mit `afterInstallValidate`. Nicht ändern, ohne das Update in der Hyper-V-VM zu testen.
- The Bus braucht AVX2 (VM-CPU hat es nicht); Left 4 Dead 2, Farming Simulator 25 und Assetto Corsa brauchen ein Steam-Konto mit Lizenz. Das sind keine Core-Fehler.
