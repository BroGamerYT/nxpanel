# NexusCore

Der dezentrale Host-Daemon des Gameserver-Panels **NexusPanel**. Er läuft auf dem
Rechner, auf dem die Gameserver laufen sollen, und steuert diese als Prozesse
(Windows nativ) oder als Container (Docker/Podman).

Der Panel bringt die Kontrollebene, der Core bringt die Ausführungsebene: Der Core
kennt keine Nutzer, keine Spieleinstanzen und keine Rechte – er kennt nur
Instanzen, Prozesse und Ports.

---

## Schnellstart (Windows)

```powershell
# 1. Abhängigkeiten + Build
npm install
npm run build

# 2. Daemon starten (Beenden mit Strg+C)
.\start-nexuscore.ps1
```

Danach ist der Core unter <http://127.0.0.1:8443> erreichbar:

```powershell
curl.exe http://127.0.0.1:8443/core/v1/info
```

### Vollständiger Selbsttest

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\smoke-test.ps1
```

Der Selbsttest startet einen eigenen Daemon auf Port 18443, prüft alle Endpunkte
und meldet je Schritt PASS oder FAIL. Ein bereits laufender Daemon lässt sich
mit `-BaseUrl` und `-Token` prüfen.

### Entwicklung

```powershell
npm run dev        # Watch-Modus (tsx)
npm test           # Vitest
npm run typecheck  # tsc --noEmit
```

---

## Voraussetzungen

* Node.js 22 oder neuer (`node --version`)
* Für den Windows-Treiber: Windows. Für den Docker-Treiber: ein erreichbarer
  Docker-Daemon. Für Tests: nichts – die Tests laufen ohne Docker und ohne Netz.

---

## Konfiguration

Alles kommt aus der Umgebung. Eine `.env` im Projektordner wird automatisch
gelesen; Vorlage ist `.env.example` (**nur leere Werte**).

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `NEXUSCORE_MODE` | `test` | `test` \| `production` |
| `NEXUSCORE_HOST` | `127.0.0.1` | Bindeadresse |
| `NEXUSCORE_PORT` | `8443` | HTTP-Port |
| `NEXUSCORE_RUNTIME` | plattformabhängig | `windows-native` \| `docker` \| `mock` |
| `NEXUSCORE_DATA_DIR` | `<Projekt>/data` | Datenbank `core.db` und Laufzeitdaten |
| `NEXUSCORE_TOKEN` | leer | Bearer-Token für geschützte Routen |
| `NEXUSCORE_PAIRING_PIN` | leer | Kopplungs-PIN (leer = zufällig erzeugen) |
| `NEXUSCORE_CORS_ORIGINS` | leer | erlaubte CORS-Herkünfte |
| `NEXUSCORE_ALLOWED_HOSTS` | leer | zusätzliche Hostnamen, unter denen der Core erreichbar sein darf (IP-Adressen und `localhost` gehen immer) |
| `NEXUSCORE_SERVER_ROOT` | `<Datenverzeichnis>/servers` | hier müssen alle Server liegen; Pfade außerhalb werden abgelehnt |
| `NEXUSCORE_MAX_UPLOAD_MB` | `2048` | größte Datei, die der Dateimanager hochladen darf |
| `NEXUSCORE_PORT_RANGE` | `25565-25664` | Bereich, aus dem der Core Spielports vergibt |
| `NEXUSCORE_ADMIN_USER` | `admin` | Name des lokalen Kontos der Standalone-Oberfläche |
| `NEXUSCORE_ADMIN_PASSWORD` | leer | festes Passwort des lokalen Kontos (mindestens 10 Zeichen) |
| `NEXUSCORE_LOG_LEVEL` | `info` | Log-Level |

**Minecraft Paper installieren:** Legt man in der Standalone-Oberfläche einen Server mit dem
Egg „Minecraft Java“ (Typ `PAPER`) an, lädt der Core Paper und das passende Java selbst –
Java nach `<Datenverzeichnis>/runtimes`, den Server nach `<Datenverzeichnis>/servers/<id>`.
Alle Downloads kommen über HTTPS von PaperMC und Eclipse Temurin und werden gegen ihre
SHA-256-Prüfsumme geprüft. Andere Spiele und Minecraft-Typen legt der Core noch als
Platzhalter an.

**Anmeldung an der Standalone-Oberfläche:** Ohne `NEXUSCORE_ADMIN_PASSWORD` erzeugt
der Core beim ersten Start ein Passwort, zeigt es einmal im Fenster und schreibt es
nach `ERSTES-PASSWORT.txt` im Datenverzeichnis. Die Datei wird nach der ersten
erfolgreichen Anmeldung gelöscht. Passwort vergessen: `account.json` im
Datenverzeichnis löschen und den Core neu starten.

Im Modus `production` sind Token (mindestens 24 Zeichen) und PIN Pflicht – ohne
sie startet der Core nicht, statt halb offen zu laufen.

> **Geheimnisse gehören in die `.env`, nicht ins Repository.** `.env` und `data/`
> sind von Git ausgenommen. Es gibt keine Default-Passwörter im Code: ohne
> gesetztes Token sind alle geschützten Routen gesperrt.

---

## Protokoll

Die vollständige Beschreibung steht in [`CORE_PROTOCOL.md`](./CORE_PROTOCOL.md).

| Methode | Endpunkt | Beschreibung |
| --- | --- | --- |
| GET | `/core/v1/info` | Host-Status und Systemauslastung (öffentlich) |
| POST | `/core/v1/pair` | Kopplung per PIN (öffentlich) |
| GET | `/core/v1/servers` | Liste der Instanzen |
| POST | `/core/v1/servers` | Instanz registrieren |
| POST | `/core/v1/servers/:id/start` | Starten |
| POST | `/core/v1/servers/:id/stop` | Beenden |
| POST | `/core/v1/servers/:id/kill` | Abbrechen |
| GET | `/core/v1/servers/:id/stats` | CPU, RAM, Laufzeit |
| GET | `/core/v1/servers/:id/logs` | Konsolenausgaben |
| WS | `/core/v1/stream` | Live-Ereignisse (`?serverId=` filtert) |

---

## Aufbau

```
src/
├── index.ts             Bootstrap, Treiberwahl, geordneter Shutdown
├── config/index.ts      Konfiguration aus der Umgebung (zod)
├── logger.ts            pino-Logger mit Redaction
├── protocol/
│   ├── security.ts      Token, PIN, Rate-Limit, zeit-sicherer Vergleich
│   └── events.ts        Event-Bus mit Ringpuffer je Server
├── store/registry.ts    Persistenz der Instanzen (JSON, atomar geschrieben)
├── system/monitor.ts    CPU-, RAM- und Plattenwerte
├── drivers/             windows-native · docker · mock
└── http/                Fastify-Server und Routen
```

Daten liegen in `data/` (`core.db` = Datenbank des Cores). Der Ordner ist von Git
ausgenommen und kann jederzeit gelöscht werden – der Core legt ihn neu an.

---

## Sprache

Der Core ist und bleibt TypeScript (Entscheidung 11.11.2026). Der frühere
Rust-Prototyp unter `rust/` ist entfernt. Rust ist nur noch für ein kleines
Windows-Hilfsprogramm vorgesehen (Job Objects, Dienst, Tray), das der Core als
Prozess aufruft. Das Zielbild steht in
[`../docs/ARCHITEKTUR.md`](../docs/ARCHITEKTUR.md).
