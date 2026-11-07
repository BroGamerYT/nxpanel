# Tests

```bash
npm test          # einmal durchlaufen
npm run test:watch
```

## Was wo geprueft wird

| Datei | Braucht Postgres | Inhalt |
| --- | --- | --- |
| `rules.test.ts` | nein | Egg-Regeln werden korrekt in Bedienelemente und Pruefungen uebersetzt |
| `variables.test.ts` | nein | Platzhalter-Ersetzung, beide Schreibweisen, Variablenpruefung |
| `db.test.ts` | ja | Statusmaschine, Ereignisse, Egg-Import gegen eine echte Datenbank |
| `foreign-eggs.test.ts` | ja | Pelican/Pterodactyl-Eggs: Anpassung beim Import, Ports, Vorlagen-Variablen |
| `steam-tuning.test.ts` | nein | SteamCMD-Beschleunigung im Installationsskript, steam_dev.cfg (bash und sh) |
| `test-db.test.ts` | nein | Schutz: Tests laufen nur gegen eine Datenbank mit "test" im Namen |

Insgesamt gibt es über 40 Testdateien; die Tabelle nennt die wichtigsten.

## Eigene Testdatenbank

Die Datenbanktests leeren vor jedem Test Tabellen. Darum laufen sie **nie**
gegen die Datenbank aus `DATABASE_URL`, sondern immer gegen eine eigene:

- `TEST_DATABASE_URL`, wenn gesetzt (der Name muss "test" enthalten),
- sonst derselbe Server mit `_test` am Namen, z. B. `panel` → `panel_test`.

Die Testdatenbank wird beim ersten Lauf automatisch angelegt
(`tests/setup/global.ts`), die Migrationen fahren die Tests selbst. Redis
nutzt in Tests die Datenbank 15. Ein lokal laufendes Panel stört die Tests
deshalb nicht mehr und umgekehrt.

```bash
npm run db:up
npm test
```

Ohne laufendes Postgres bricht der Lauf sofort mit einem klaren Hinweis ab.

## Was hier nicht geprueft werden kann

Alles, was einen laufenden Docker-Daemon braucht: Container anlegen, starten,
stoppen, der Ereignisstrom. Das wird am eigenen Rechner oder auf der
Linux-VM von Hand geprueft - siehe `docs/ENTWICKLUNGSLOG.md`.
