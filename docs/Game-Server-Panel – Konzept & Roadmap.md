# Game-Server-Panel – Konzept & Roadmap

Nov 5, 2026 · @Dominik

## Überblick

Ziel ist ein eigenes Web-Panel, über das Gameserver als Docker-Container erstellt, gestartet, konfiguriert und an andere Nutzer mit frei einstellbaren Rechten vergeben werden. Funktional in Richtung AMP (CubeCoders) und Pterodactyl, aber selbst gebaut und auf dem eigenen Homelab betrieben.

**Drei Leitentscheidungen, auf denen alles weitere aufbaut:**

1. **Templates im Pterodactyl-Egg-Format**, nicht im AMP-Format. AMP-Templates liegen öffentlich auf GitHub (`CubeCoders/AMPTemplates`), sind aber auf AMPs eigene Laufzeit zugeschnitten: Konsolen-Regex, Update-Sources, Setting-Nodes in AMP-Syntax. Wer sie nutzen will, muss AMPs halbe Engine nachbauen. Eggs sind offenes JSON, zum Import gedacht, MIT-lizenziert und beschreiben genau das, was gebraucht wird: Image, Startkommando, Variablen, Install-Script.
2. **Ein Container pro Gameserver.** Keine Prozessverwaltung auf dem Host, keine Systemd-Units. Isolation, RAM-/CPU-Limits und Aufräumen kommen von Docker.
3. **Rechte vollständig einstellbar**, nicht nur zwei fixe Rollen. Globale Panel-Rollen plus pro Server vergebbare Permission-Flags, dazu Presets, damit niemand 25 Checkboxen durchklicken muss.

**Was das Panel ausdrücklich nicht wird:** kein Multi-Node-Cluster in der ersten Version, keine Abrechnung, kein Reseller-System. Ein Host, mehrere Nutzer, viele Server.

## Architektur

&#91;embedded content: Architektur · 9 Komponenten, zwei getrennte Pfade\]

Entscheidend ist der untere Pfad: Spieler verbinden sich per Portweiterleitung direkt mit dem Container. Fällt das Panel aus, laufen die Server weiter – nur die Verwaltung ist dann nicht erreichbar.

| Komponente | Aufgabe |
| --- | --- |
| Frontend | Serverliste, Konsole, Dateimanager; spricht nur mit der eigenen API |
| Panel-Backend | Authentifizierung, Rechteprüfung, REST-API, WebSocket-Verteilung, Zeitplan-Worker |
| Postgres | Nutzer, Server, Eggs, Rechte, Backups, Audit-Log |
| Redis | Ratelimits, widerrufene Tokens, Verteilung der Konsolen-Events |
| Docker Engine | Erstellt, startet und stoppt Container; liefert Logs und Statistiken |
| Spielcontainer | Ein Container pro Gameserver, hartes RAM- und CPU-Limit |
| Volumes | Spieldaten auf dem Host, Grundlage für Dateimanager und Backups |
| Caddy | TLS und Weiterleitung auf das Panel |

**Single-Node zuerst, Multi-Node vorbereitet.** Der Docker-Zugriff liegt hinter einem Interface. Solange Panel und Docker auf einer Maschine laufen, spricht es den lokalen Socket an; später tritt ein Daemon pro Host an dieselbe Stelle, ohne dass die übrige Anwendung sich ändert. Die Tabellen `nodes` und `allocations` existieren von Anfang an – nachträglich eingeführt wäre das eine große Umbauaktion.

## Tech-Stack

| Komponente | Wahl | Warum |
| --- | --- | --- |
| Backend-Sprache | Go 1.23 | Offizielles Docker-SDK, ein statisches Binary ohne Runtime, sauberes Nebenläufigkeits-Modell für viele parallele Log-Streams |
| Alternative Backend | Node.js + TypeScript + Fastify | Schneller Einstieg, `dockerode` als Docker-Client, ein Sprach-Stack mit dem Frontend |
| HTTP-Framework (Go) | chi oder Fiber | Leichtgewichtig, Middleware-Ketten für die Rechteprüfung |
| Datenbank | PostgreSQL 16 | JSONB für Egg-Variablen und Permission-Arrays, saubere Fremdschlüssel |
| Migrations | golang-migrate oder Prisma | Schema versioniert im Repo, kein Handarbeit-Drift |
| Cache / Pub-Sub | Redis | Session-Blacklist, Ratelimits, Verteilung der Konsolen-Events |
| Realtime | WebSocket (gorilla/websocket bzw. `ws`) | Konsole, Stats und Statuswechsel in einem Kanal |
| Container-Zugriff | Docker Engine API via Unix-Socket | Kein Docker-CLI-Aufruf, kein Shell-Parsing |
| Frontend | SvelteKit oder React + Vite | Kleines Bundle, gute WebSocket-Integration |
| UI-Kit | Tailwind + shadcn-ui bzw. skeleton | Dark-Theme-fähig, Formulare lassen sich generieren |
| Konsolen-Terminal | xterm.js | ANSI-Farben, Scrollback, Copy-Paste wie im echten Terminal |
| Charts | uPlot oder Chart.js | CPU-/RAM-Verlauf mit vielen Punkten ohne Ruckeln |
| Auth | JWT (Access 15 Min / Refresh 7 Tage) + Argon2id | Argon2id ist der aktuelle Standard für Passwort-Hashing |
| 2FA | TOTP (`pquerna/otp`) | Authenticator-Apps, keine SMS-Kosten |
| SFTP | eigener SSH-Server (`gliderlabs/ssh` bzw. `pkg/sftp`) | Login gegen die Panel-Datenbank, Chroot pro Server |
| Reverse Proxy | Caddy | Läuft im Homelab bereits, automatisches TLS |
| Logs / Metriken | zerolog + Prometheus-Endpunkt | Später per Grafana auswertbar |

**Empfehlung:** Go fürs Backend. Die Log-Streams von zehn Containern gleichzeitig an mehrere WebSocket-Clients zu verteilen ist genau das, wofür Goroutines gebaut sind, und das Deployment ist ein einzelnes Binary. Wenn der Einstieg wichtiger ist als die Laufzeit, ist TypeScript die pragmatische Wahl – der Rest des Konzepts bleibt identisch.

## Datenmodell

Komplettes Postgres-Schema. `permissions` als Text-Array, `variables` als JSONB – damit bleibt das Egg-Format flexibel, ohne für jedes Spiel eine Spalte zu brauchen.

```sql
-- Nutzer und Zugang
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,              -- Argon2id
  role          TEXT NOT NULL DEFAULT 'user', -- admin | moderator | user
  totp_secret   TEXT,                       -- NULL = 2FA aus
  totp_enabled  BOOLEAN NOT NULL DEFAULT false,
  suspended     BOOLEAN NOT NULL DEFAULT false,
  server_limit  INT NOT NULL DEFAULT 0,     -- wie viele Server er selbst anlegen darf
  ram_limit_mb  INT NOT NULL DEFAULT 0,     -- Gesamtbudget des Nutzers
  disk_limit_mb INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT UNIQUE NOT NULL,
  user_agent    TEXT,
  ip            INET,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

-- Templates (importierte Eggs)
CREATE TABLE nests (                         -- Gruppe, z. B. "Minecraft"
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  description TEXT
);

CREATE TABLE eggs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nest_id         UUID NOT NULL REFERENCES nests(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  author          TEXT,
  docker_images   JSONB NOT NULL,            -- {"Java 21":"itzg/minecraft-server:java21"}
  startup         TEXT NOT NULL,             -- Kommando mit {{VARIABLE}}-Platzhaltern
  stop_command    TEXT NOT NULL DEFAULT '^C',-- "stop", "quit", "^C" = SIGINT
  config_files    JSONB,                     -- welche Dateien beim Start gepatcht werden
  config_startup  JSONB,                     -- Regex, der "Server bereit" erkennt
  install_script  TEXT,                      -- Bash, läuft im Install-Container
  install_image   TEXT,
  features        JSONB,                     -- z. B. ["eula","java_version"]
  raw_egg         JSONB NOT NULL,            -- Original-JSON zur Nachvollziehbarkeit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE egg_variables (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  egg_id        UUID NOT NULL REFERENCES eggs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,              -- Anzeigename im Formular
  description   TEXT,
  env_variable  TEXT NOT NULL,              -- SERVER_NAME, MAX_PLAYERS …
  default_value TEXT,
  rules         TEXT,                        -- "required|string|max:40"
  user_viewable BOOLEAN NOT NULL DEFAULT true,
  user_editable BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (egg_id, env_variable)
);

-- Hosts und Ports
CREATE TABLE nodes (                         -- erst ab Multi-Host relevant
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  fqdn          TEXT NOT NULL,
  docker_socket TEXT NOT NULL DEFAULT '/var/run/docker.sock',
  daemon_token  TEXT,
  ram_total_mb  INT NOT NULL,
  disk_total_mb INT NOT NULL,
  public_ip     INET
);

CREATE TABLE allocations (                   -- Port-Pool
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ip          INET NOT NULL,
  port        INT NOT NULL,
  protocol    TEXT NOT NULL DEFAULT 'both',  -- tcp | udp | both
  server_id   UUID REFERENCES servers(id) ON DELETE SET NULL,
  is_primary  BOOLEAN NOT NULL DEFAULT false,
  notes       TEXT,
  UNIQUE (ip, port, protocol)
);

-- Die Server selbst
CREATE TABLE servers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  short_id        TEXT UNIQUE NOT NULL,      -- 8 Zeichen, für Pfade und URLs
  owner_id        UUID NOT NULL REFERENCES users(id),
  node_id         UUID NOT NULL REFERENCES nodes(id),
  egg_id          UUID NOT NULL REFERENCES eggs(id),
  name            TEXT NOT NULL,
  description     TEXT,
  docker_image    TEXT NOT NULL,
  startup         TEXT NOT NULL,             -- Kopie des Eggs, pro Server änderbar
  container_id    TEXT,                      -- Docker-ID, NULL = noch nicht erstellt
  status          TEXT NOT NULL DEFAULT 'installing',
                  -- installing | offline | starting | running | stopping | crashed | suspended
  ram_mb          INT NOT NULL,
  swap_mb         INT NOT NULL DEFAULT 0,
  cpu_percent     INT NOT NULL DEFAULT 100,  -- 100 = ein Kern
  disk_mb         INT NOT NULL,
  io_weight       INT NOT NULL DEFAULT 500,
  variables       JSONB NOT NULL DEFAULT '{}',
  auto_restart    BOOLEAN NOT NULL DEFAULT true,
  crash_count     INT NOT NULL DEFAULT 0,
  suspended       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_at    TIMESTAMPTZ
);

-- Geteilter Zugriff mit frei wählbaren Rechten
CREATE TABLE subusers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  invited_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (server_id, user_id)
);

CREATE TABLE role_presets (                  -- "Operator", "Co-Admin" …
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  is_system   BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE invites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id  UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  token      TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ
);

-- Backups, Zeitpläne, Protokoll
CREATE TABLE backups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sha256      TEXT,
  size_bytes  BIGINT,
  storage     TEXT NOT NULL DEFAULT 'local', -- local | s3 | cifs
  path        TEXT,
  is_locked   BOOLEAN NOT NULL DEFAULT false,
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE schedules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  cron        TEXT NOT NULL,                 -- "0 4 * * *"
  action      TEXT NOT NULL,                 -- restart | backup | command
  payload     TEXT,                          -- bei command: der Befehl
  only_when_online BOOLEAN NOT NULL DEFAULT true,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  server_id  UUID REFERENCES servers(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,                  -- "server.start", "subuser.create" …
  metadata   JSONB,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (server_id, created_at DESC);
CREATE INDEX ON audit_log (user_id, created_at DESC);
```

**Hinweis zur Reihenfolge:** `allocations` verweist auf `servers`, `servers` auf `nodes` und `eggs`. Beim Anlegen entweder die Fremdschlüssel nachträglich per `ALTER TABLE` setzen oder `allocations` nach `servers` erstellen.

## Rechtesystem

Zwei Ebenen: eine globale Panel-Rolle und frei einstellbare Flags pro Server. Die Rolle entscheidet, was jemand im Panel darf; die Flags entscheiden, was er an einem einzelnen Server darf.

### Globale Rollen

| Rolle | Darf |
| --- | --- |
| `admin` | Alles: Nodes, Eggs, Nutzer, alle Server, Audit-Log |
| `moderator` | Alle Server sehen und steuern, keine Nutzer- oder Node-Verwaltung |
| `user` | Nur eigene Server und solche, bei denen er Subuser ist |

### Permission-Flags pro Server

| Flag | Bedeutung |
| --- | --- |
| `control.console` | Konsolenausgabe mitlesen |
| `control.command` | Befehle in die Konsole senden |
| `control.start` | Server starten |
| `control.stop` | Server stoppen |
| `control.restart` | Server neu starten |
| `control.kill` | Hart abwürgen (SIGKILL) |
| `file.read` | Dateien und Ordner auflisten und lesen |
| `file.write` | Dateien anlegen und ändern |
| `file.delete` | Dateien löschen |
| `file.archive` | Packen und entpacken |
| `file.sftp` | Zugang per SFTP |
| `backup.read` | Backup-Liste sehen |
| `backup.create` | Backup anlegen |
| `backup.restore` | Backup zurückspielen |
| `backup.delete` | Backup löschen |
| `backup.download` | Backup herunterladen |
| `allocation.read` | Ports sehen |
| `allocation.assign` | Zusätzliche Ports zuweisen |
| `startup.read` | Startparameter und Variablen sehen |
| `startup.update` | Variablen ändern |
| `startup.image` | Docker-Image wechseln |
| `schedule.read` | Zeitpläne sehen |
| `schedule.update` | Zeitpläne anlegen und ändern |
| `subuser.read` | Mitnutzer sehen |
| `subuser.create` | Mitnutzer einladen |
| `subuser.update` | Rechte anderer ändern |
| `subuser.delete` | Mitnutzer entfernen |
| `settings.rename` | Server umbenennen |
| `settings.reinstall` | Neu installieren (löscht Daten) |
| `activity.read` | Audit-Log des Servers lesen |

Der Besitzer hat implizit alle Flags – er steht nicht in `subusers`. Nur Admin und Besitzer dürfen den Server löschen; das ist absichtlich kein Flag.

### Presets

Vier Vorlagen für die Einladungsmaske, danach jederzeit einzeln anpassbar. Genau das ist mit „voll einstellbar“ gemeint: Preset wählen, dann Haken setzen oder wegnehmen.

| Preset | Enthält |
| --- | --- |
| Zuschauer | `control.console`, `allocation.read`, `startup.read`, `backup.read` |
| Operator | Zuschauer + `control.start`, `control.stop`, `control.restart`, `control.command` |
| Verwalter | Operator + alle `file.*`, `backup.*`, `schedule.*`, `startup.update` |
| Co-Admin | Verwalter + `subuser.*`, `settings.rename`, `allocation.assign`, `activity.read` |

### Prüfung im Backend

Eine Middleware vor jedem Server-Endpunkt. Die Rechte werden pro Anfrage aus der Datenbank geladen, nicht aus dem Token – so greift ein Rechteentzug sofort.

```go
func RequirePermission(flag string) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            user   := UserFromContext(r.Context())
            server := ServerFromContext(r.Context())

            // Admin und Moderator dürfen alles steuern
            if user.Role == "admin" || user.Role == "moderator" {
                next.ServeHTTP(w, r); return
            }
            // Besitzer hat implizit alle Flags
            if server.OwnerID == user.ID {
                next.ServeHTTP(w, r); return
            }
            // Subuser: Flag muss gesetzt sein
            perms, err := store.SubuserPermissions(r.Context(), server.ID, user.ID)
            if err != nil || !slices.Contains(perms, flag) {
                http.Error(w, "forbidden", http.StatusForbidden); return
            }
            next.ServeHTTP(w, r)
        })
    }
}

// Verwendung
r.Route("/api/servers/{id}", func(r chi.Router) {
    r.Use(LoadServer)
    r.With(RequirePermission("control.start")).Post("/start",   startServer)
    r.With(RequirePermission("control.stop")).Post("/stop",     stopServer)
    r.With(RequirePermission("file.write")).Put("/files/write", writeFile)
})
```

### Fallstricke

- **`file.write` ist faktisch Vollzugriff.** Wer Startskripte, Plugin-Jars oder Konfigurationsdateien schreiben darf, führt beliebigen Code im Container aus. Das Flag gehört in kein „harmloses“ Preset.
- **`startup.update` ebenso**, sobald das Egg Variablen in die Kommandozeile einsetzt. Variablen mit `user_editable = false` markieren, wenn sie ins Startkommando wandern.
- **`settings.reinstall` löscht Spielstände.** Nur für Besitzer und Co-Admin, mit Bestätigungsdialog.
- **WebSocket separat autorisieren.** Ein Konsolen-Token muss an eine Server-ID gebunden sein, sonst hört jemand bei fremden Servern mit.
- **Rechteentzug muss sofort greifen.** Darum keine Flags im JWT; der Access-Token läuft zusätzlich nach 15 Minuten ab.

## Template-System

Das Herzstück: ein Egg-Parser. Damit kommt die gesamte Spielebibliothek von Pterodactyl ab Tag eins mit, ohne pro Spiel Code zu schreiben.

### Aufbau eines Eggs

```json
{
  "name": "Paper",
  "author": "panel@example.com",
  "docker_images": {
    "Java 21": "ghcr.io/pterodactyl/yolks:java_21",
    "Java 17": "ghcr.io/pterodactyl/yolks:java_17"
  },
  "startup": "java -Xms128M -Xmx{{SERVER_MEMORY}}M -jar {{SERVER_JARFILE}}",
  "config": {
    "files": "{\"server.properties\":{\"parser\":\"properties\",\"find\":{\"server-ip\":\"0.0.0.0\",\"server-port\":\"{{server.build.default.port}}\"}}}",
    "startup": "{\"done\":\")! For help, type \"}",
    "stop": "stop"
  },
  "scripts": {
    "installation": {
      "script": "#!/bin/bash\napt update && apt install -y curl jq\n...",
      "container": "ghcr.io/pterodactyl/installers:debian",
      "entrypoint": "bash"
    }
  },
  "variables": [
    {
      "name": "Server Jar File",
      "env_variable": "SERVER_JARFILE",
      "default_value": "server.jar",
      "user_viewable": true,
      "user_editable": true,
      "rules": "required|regex:/^([\\w\\d._-]+)(\\.jar)$/"
    }
  ]
}
```

### Was der Parser daraus macht

| Egg-Feld | Verwendung im Panel |
| --- | --- |
| `docker_images` | Dropdown „Image/Version“ in der Server-Erstellung |
| `startup` | Startkommando, `{{VAR}}` wird aus `servers.variables` ersetzt |
| `variables[]` | Formularfelder, Validierung aus `rules` |
| `config.startup.done` | Regex, der aus dem Log „Server ist bereit“ erkennt → Status `running` |
| `config.stop` | Stop-Verhalten: Text = an stdin senden, `^C` = SIGINT |
| `config.files` | Dateien, die vor dem Start gepatcht werden (Port, IP) |
| `scripts.installation` | Einmal-Container, der Serverdateien herunterlädt |

### Variablen-Ersetzung

```go
func BuildStartup(tmpl string, vars map[string]string, alloc Allocation, ramMB int) string {
    built := map[string]string{
        "SERVER_MEMORY": strconv.Itoa(ramMB),
        "SERVER_IP":     alloc.IP,
        "SERVER_PORT":   strconv.Itoa(alloc.Port),
    }
    maps.Copy(built, vars)

    re := regexp.MustCompile(`\{\{\s*([A-Za-z0-9_.]+)\s*\}\}`)
    return re.ReplaceAllStringFunc(tmpl, func(m string) string {
        key := re.FindStringSubmatch(m)[1]
        key = strings.TrimPrefix(key, "server.build.env.")
        if v, ok := built[key]; ok {
            return v
        }
        return ""   // unbekannte Variable leer lassen, nie den Platzhalter stehen lassen
    })
}
```

### Install-Phase

Eggs laden Serverdateien nicht im Spielcontainer, sondern in einem separaten Installer-Container. Ablauf:

1. Volume für den Server anlegen (`/var/lib/panel/volumes/<short_id>`)
2. Installer-Container starten: `install_image`, Volume gemountet auf `/mnt/server`, Install-Script als Entrypoint, Egg-Variablen als Env
3. Logs mitschreiben und live ins Panel streamen (Nutzer sieht die Installation)
4. Exit-Code 0 → Status auf `offline`, Container entfernen; sonst Status `install_failed`
5. Erst danach den eigentlichen Spielcontainer erstellen

### Import-Wege

- **Datei-Upload**: Egg-JSON hochladen, Felder in `eggs` und `egg_variables` schreiben, Original in `raw_egg` behalten
- **URL-Import**: Direktlink auf eine Raw-JSON, etwa aus den Community-Sammlungen auf GitHub
- **Validierung beim Import**: Pflichtfelder prüfen (`startup`, mindestens ein Image), `rules` in eigene Validatoren übersetzen, Install-Script darf nicht leer sein, wenn das Egg eins erwartet

### Offene Punkte beim Parser

- Laravel-Validierungsregeln (`required|string|max:20`) müssen nachgebaut werden. In der Praxis reichen `required`, `nullable`, `string`, `numeric`, `boolean`, `in:a,b,c`, `between:x,y`, `regex:`.
- `config.files` nutzt eigene Parser-Typen (`properties`, `yaml`, `json`, `ini`, `xml`, `file`). Für den Start genügen `properties` und `yaml` – das deckt Minecraft und die meisten Steam-Spiele ab.
- Egg-Versionen: beim erneuten Import eines bekannten Eggs nicht überschreiben, sondern als neue Version anlegen, sonst brechen laufende Server.

## Container-Verwaltung

Jeder Gameserver ist ein langlebiger Docker-Container. Das Panel spricht die Engine-API über den Unix-Socket an – kein `docker`-CLI-Aufruf, kein Parsen von Textausgabe.

### Container-Erstellung

```go
resp, err := cli.ContainerCreate(ctx,
    &container.Config{
        Image:        srv.DockerImage,
        Env:          buildEnv(srv),       // Egg-Variablen + STARTUP + SERVER_MEMORY
        Entrypoint:   []string{"/bin/bash", "/entrypoint.sh"},
        OpenStdin:    true,                // Pflicht für Konsolenbefehle
        StdinOnce:    false,
        Tty:          false,               // getrennte stdout/stderr-Streams
        AttachStdin:  true,
        AttachStdout: true,
        AttachStderr: true,
        Labels: map[string]string{
            "panel.server_id": srv.ID.String(),
            "panel.owner":     srv.OwnerID.String(),
        },
    },
    &container.HostConfig{
        Resources: container.Resources{
            Memory:            int64(srv.RamMB) * 1024 * 1024,
            MemoryReservation: int64(srv.RamMB) * 1024 * 1024 * 8 / 10,
            MemorySwap:        int64(srv.RamMB+srv.SwapMB) * 1024 * 1024,
            CPUQuota:          int64(srv.CPUPercent) * 1000,
            CPUPeriod:         100000,
            BlkioWeight:       uint16(srv.IOWeight),
            PidsLimit:         ptr(int64(512)),
        },
        Mounts: []mount.Mount{{
            Type:   mount.TypeBind,
            Source: filepath.Join("/var/lib/panel/volumes", srv.ShortID),
            Target: "/home/container",
        }},
        PortBindings: buildPortBindings(srv.Allocations),
        RestartPolicy: container.RestartPolicy{Name: "no"}, // Neustart steuert das Panel
        DNS:        []string{"1.1.1.1", "8.8.8.8"},
        CapDrop:    []string{"ALL"},
        SecurityOpt: []string{"no-new-privileges"},
        ReadonlyRootfs: false,
        Tmpfs: map[string]string{"/tmp": "rw,exec,nosuid,size=256m"},
    },
    nil, nil, "panel-"+srv.ShortID)
```

### Lifecycle

| Aktion | Umsetzung |
| --- | --- |
| Start | `ContainerStart`, Status auf `starting`, Logs auf den Done-Regex prüfen → `running` |
| Stop | Stop-Kommando aus dem Egg an stdin schreiben; nach 30 s Timeout `ContainerStop` (SIGTERM), nach weiteren 15 s SIGKILL |
| Restart | Stop, auf Exit warten, Start – nicht `ContainerRestart`, weil das Stop-Kommando des Spiels übersprungen würde |
| Kill | `ContainerKill` mit SIGKILL, Status `offline`, Hinweis im Log, dass Daten verloren gehen können |
| Crash-Erkennung | Exit-Code ≠ 0 ohne vorherige Stop-Anfrage → Status `crashed`, bei `auto_restart` neu starten, `crash_count` zählen und nach 5 Abstürzen in 10 Minuten aufgeben |
| Löschen | Container entfernen, Volume löschen, Allocations freigeben, Backups nach Rückfrage |

### Statusmaschine

`installing` → `offline` ⇄ `starting` → `running` → `stopping` → `offline`, dazu `crashed` als Seitenzweig und `suspended` als Sperre durch den Admin. Statuswechsel laufen immer über eine zentrale Funktion, die den Wert in die Datenbank schreibt und auf dem WebSocket ankündigt – nie direkt per SQL.

### Ports und Allocations

- Port-Pool wird vom Admin definiert (etwa 25500–25600 TCP/UDP) und als Zeilen in `allocations` angelegt
- Beim Erstellen eines Servers wird eine freie Allocation zur primären; weitere lassen sich mit `allocation.assign` zuordnen
- Spiele brauchen oft mehrere Ports: ARK will Game, Query und RCON, Minecraft zusätzlich Query bei aktiviertem Bedrock-Bridge
- UDP nicht vergessen – die meisten Steam-Spiele sind reines UDP

### Reconciliation

Beim Start des Panels alle Container mit dem Label `panel.server_id` auflisten und den tatsächlichen Zustand mit der Datenbank abgleichen. Ohne diesen Schritt zeigt das Panel nach jedem Neustart falsche Status an.

## Live-Konsole und Realtime

Ein WebSocket pro geöffnetem Server, der drei Dinge trägt: Konsolenausgabe, Ressourcen-Statistiken und Statuswechsel.

### Verbindungsaufbau

1. Client fragt `POST /api/servers/{id}/ws-token` – das Backend prüft `control.console` und gibt ein kurzlebiges Token aus (60 Sekunden gültig, gebunden an Nutzer-ID und Server-ID)
2. Client verbindet sich auf `wss://panel/ws?token=…`
3. Backend validiert das Token, attacht per `ContainerAttach` an stdin/stdout/stderr und liefert zuerst die letzten 200 Logzeilen als Scrollback
4. Token verfällt; die offene Verbindung bleibt. Alle 5 Minuten wird die Berechtigung erneut geprüft – fehlt sie, wird getrennt

### Nachrichtenformat

```json
// Server → Client
{ "event": "console", "data": "[12:04:31 INFO]: Done (3.241s)!" }
{ "event": "status",  "data": "running" }
{ "event": "stats",   "data": { "cpu": 42.1, "mem": 3221225472, "mem_limit": 6442450944,
                                "net_rx": 182344, "net_tx": 99120, "uptime": 8412 } }
{ "event": "install", "data": "Downloading paper-1.21.jar…" }

// Client → Server
{ "event": "command", "data": "say Server startet in 5 Minuten neu" }
{ "event": "power",   "data": "restart" }
```

### Stats-Stream

`ContainerStats` liefert einen fortlaufenden JSON-Stream. CPU-Prozent muss selbst berechnet werden:

```go
cpuDelta    := stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage
systemDelta := stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage
cpuPercent  := float64(cpuDelta) / float64(systemDelta) * float64(len(stats.CPUStats.CPUUsage.PercpuUsage)) * 100
```

Auf eine Nachricht pro Sekunde drosseln, sonst flutet der Stream das Frontend.

### Fan-out

Ein Container-Attach pro Server, nicht pro Browser-Tab. Die Ausgabe geht in einen internen Broadcast-Channel, aus dem alle verbundenen Clients lesen. Ohne dieses Muster öffnet jeder Tab einen eigenen Attach und die Engine-API wird zum Engpass.

### RCON als Zusatz

Für Spiele, deren Konsole nichts annimmt (CS2, ARK, Palworld), zusätzlich RCON anbinden: Host ist der Container, Passwort kommt aus einer Egg-Variable. Das Panel unterscheidet dann „Befehl an stdin“ und „Befehl per RCON“ anhand eines Feldes im Egg. Minecraft kann beides – stdin ist dort der robustere Weg.

### Logs dauerhaft

Docker-Logs mit `--log-opt max-size=10m --log-opt max-file=3` begrenzen, sonst füllt ein gesprächiger Server die Systemplatte. Bei wenig lokalem Speicher auf dem Host ist das kein Detail, sondern Pflicht.

## Dateimanager, SFTP und Backups

### Dateimanager

Das Panel arbeitet direkt auf dem Volume-Verzeichnis des Servers auf dem Host, nicht per `docker exec`. Das ist schneller und funktioniert auch bei gestopptem Container.

Endpunkte:

| Route | Flag | Zweck |
| --- | --- | --- |
| `GET /files/list?dir=` | `file.read` | Verzeichnis auflisten |
| `GET /files/contents?file=` | `file.read` | Datei lesen (Texteditor) |
| `POST /files/write` | `file.write` | Datei speichern |
| `POST /files/rename` | `file.write` | Umbenennen und verschieben |
| `POST /files/copy` | `file.write` | Kopieren |
| `POST /files/delete` | `file.delete` | Löschen |
| `POST /files/compress` | `file.archive` | Als tar.gz packen |
| `POST /files/decompress` | `file.archive` | Entpacken |
| `POST /files/upload` | `file.write` | Upload (chunked) |
| `GET /files/download?file=` | `file.read` | Download über Einmal-Token |

**Die wichtigste Regel: Pfad-Traversal verhindern.** Jeder Pfad wird gegen die Server-Wurzel aufgelöst und geprüft, bevor irgendetwas passiert:

```go
func SafePath(root, requested string) (string, error) {
    clean := filepath.Join(root, filepath.Clean("/"+requested))
    real, err := filepath.EvalSymlinks(clean)   // Symlinks auflösen!
    if err != nil && !os.IsNotExist(err) {
        return "", err
    }
    if err == nil && !strings.HasPrefix(real, root+string(os.PathSeparator)) && real != root {
        return "", errors.New("pfad ausserhalb des servers")
    }
    return clean, nil
}
```

Ohne `EvalSymlinks` legt ein Nutzer einen Symlink nach `/` an und liest den ganzen Host aus. Größenlimit beim Texteditor setzen (etwa 2 MB), sonst lädt jemand ein 4-GB-Worldfile in den Browser.

### SFTP

Eigener SSH-Server im Panel, nicht OpenSSH. Login mit `username.shortid` als Benutzername und dem Panel-Passwort; die Authentifizierung prüft `file.sftp` und setzt die Server-Wurzel als Chroot. Vorteil: keine Systembenutzer, keine Shell, dieselben Rechte wie im Panel. Schreibrechte spiegeln `file.write`, Löschrechte `file.delete` – sonst umgeht jemand das Panel komplett.

### Backups

Ablauf eines Backups:

1. Flag `backup.create` prüfen, Limit pro Server prüfen (z. B. 5 Backups)
2. Optional vorher `save-all` bzw. das spielspezifische Speicherkommando senden und 5 Sekunden warten – ohne das ist das Backup inkonsistent
3. Volume als `tar.zst` packen, Ignore-Liste aus einer `.panelignore` beachten (Logs, Caches, `cache/`, `crash-reports/`)
4. SHA-256 bilden, Größe und Pfad in `backups` schreiben
5. Ziel: lokal, S3-kompatibel oder CIFS-Mount. Bei knappem lokalem Speicher direkt auf den Netzwerkspeicher streamen, nicht erst lokal zwischenlagern

Wiederherstellen: Server stoppen, Volume leeren, Archiv entpacken, Status zurücksetzen. Immer mit Bestätigungsdialog – das ist der häufigste Weg, einen Spielstand zu verlieren.

**Gesperrte Backups** (`is_locked`) lassen sich nicht automatisch wegrotieren. Praktisch für den Stand vor einem großen Update.

### Zeitpläne

Ein Cron-Worker im Backend liest `schedules`, berechnet `next_run_at` und führt fällige Aktionen aus. Typische Einträge: nächtlicher Neustart um 4 Uhr, tägliches Backup, `say`-Warnung 5 Minuten vor dem Neustart. `only_when_online` verhindert, dass ein gestoppter Server nachts hochgefahren wird.

## Spiele-Katalog

Alle genannten Spiele existieren als fertige Images bzw. Eggs – selbst bauen ist nicht nötig. RAM-Werte sind Richtwerte für kleine Runden (bis \~10 Spieler).

| Spiel | Image | Ports | RAM | Stop |
| --- | --- | --- | --- | --- |
| Minecraft (Java) | `itzg/minecraft-server` | 25565 TCP | 2–6 GB | `stop` an stdin |
| Minecraft (Bedrock) | `itzg/minecraft-bedrock-server` | 19132 UDP | 1–2 GB | `stop` an stdin |
| Palworld | `thijsvanloef/palworld-server-docker` | 8211 UDP, 27015 UDP | 16–32 GB | SIGTERM, RCON `Shutdown` |
| Enshrouded | `mornedhels/enshrouded-server` | 15636–15637 UDP | 8–16 GB | SIGTERM |
| ARK: Survival Evolved | `hermsi/ark-server` | 7777–7778 UDP, 27015 UDP, 27020 TCP | 8–16 GB | RCON `DoExit` |
| ARK: Survival Ascended | `acekorneya/asa_server` | 7777 UDP, 27015 UDP | 20–32 GB | RCON `DoExit` |
| Counter-Strike 2 | `joedwards32/cs2` | 27015 TCP+UDP | 2–4 GB | SIGTERM |
| Valheim | `lloesche/valheim-server` | 2456–2458 UDP | 4–8 GB | SIGTERM |
| Rust | `didstopia/rust-server` | 28015 UDP, 28016 TCP | 8–16 GB | RCON `quit` |
| Satisfactory | `wolveix/satisfactory-server` | 7777 TCP+UDP | 8–16 GB | SIGTERM |
| 7 Days to Die | `vinanrra/7dtd-server` | 26900 TCP+UDP, 26901–26902 UDP | 6–12 GB | Telnet `shutdown` |
| Terraria (TShock) | `ryshe/terraria` | 7777 TCP | 1–2 GB | `exit` an stdin |
| Farming Simulator 25 | kein offizielles Linux-Dedi | 10823 TCP, 8080 TCP | – | über Webinterface |

### Besonderheiten, die im Panel abgefangen werden müssen

- **Minecraft** braucht die EULA-Zustimmung. Das `itzg`-Image löst das über `EULA=TRUE` – im Erstellformular als Checkbox abbilden.
- **CS2** braucht einen Steam Game Server Login Token (GSLT) von Valve. Als Pflicht-Variable im Egg, sonst startet der Server nicht.
- **ARK und Palworld** haben Startzeiten von mehreren Minuten. Der Done-Regex muss stimmen, sonst zeigt das Panel minutenlang `starting` oder fälschlich `crashed`. Start-Timeout auf 15 Minuten setzen.
- **Enshrouded und FS25** sind Windows-Server. Sie laufen unter Proton/Wine im Container – funktioniert, braucht aber mehr RAM und verzeiht harte Kills schlechter.
- **Steam-Spiele mit SteamCMD** laden beim ersten Start viele GB herunter. Die Install-Phase muss das live streamen, sonst denkt der Nutzer, es hängt.
- **FS25** hat keinen offiziellen dedizierten Linux-Server. Entweder Windows-Container/VM oder im Panel bewusst als nicht unterstützt kennzeichnen.

### Realitätscheck Ressourcen

ARK: Survival Ascended und Palworld gleichzeitig sprengen 48 GB RAM. Minecraft, Enshrouded und CS2 parallel sind dagegen entspannt. Darum gehören `users.ram_limit_mb` und eine Prüfung bei der Server-Erstellung ins MVP – nicht als späteres Feature.

### Weitere installierbare Spiele

Alles, was über Eggs oder fertige Images verfügbar ist und damit ohne Mehraufwand im Katalog landet. Die Liste wird mit jedem importierten Egg länger – sie ist keine Code-Arbeit, nur ein Import.

| Kategorie | Spiele |
| --- | --- |
| Sandbox / Survival | Minecraft (Java, Bedrock, Forge, Fabric, Paper, Purpur, Spigot, Velocity, BungeeCord), Terraria, Starbound, Factorio, Satisfactory, Vintage Story, Core Keeper, Necesse, Eco |
| Survival-Koop | Valheim, Palworld, Enshrouded, V Rising, Sons of the Forest, Grounded, Icarus, Conan Exiles, The Forest, Green Hell, Soulmask, Nightingale |
| ARK-Familie | ARK: Survival Evolved, ARK: Survival Ascended |
| Hardcore-Survival | Rust, DayZ, SCUM, 7 Days to Die, Project Zomboid, Unturned, Zomboid-Mods |
| Shooter | Counter-Strike 2, CS:GO-Legacy, Team Fortress 2, Garry's Mod, Left 4 Dead 2, Insurgency: Sandstorm, Squad, Arma 3, Arma Reforger, Hell Let Loose, Battlebit, Killing Floor 2, Pavlov VR, Onward |
| Rennen / Simulation | Assetto Corsa, BeamMP (BeamNG), rFactor 2, Euro Truck Simulator 2 (Convoy), American Truck Simulator, Farming Simulator 22/25 (Windows) |
| Open-World-Multiplayer | FiveM / RedM (GTA, RDR2), alt:V, SA-MP, MTA:SA, Minetest |
| Teamspiele / Party | Among Us (Impostor-Server), Barotrauma, Risk of Rain 2, Deep Rock Galactic, Astroneer, Raft, Stardew Valley (SMAPI-Koop), Don't Starve Together, Teeworlds |
| Klassiker | Quake 3, OpenArca, Minecraft Classic, Doom (Zandronum), Xonotic, Veloren, Mindustry, OpenTTD, Cuberite |
| Voice / Infrastruktur | TeamSpeak 3, Mumble, Discord-Bots, Pterodactyl-Datenbank-Hosts, Nginx/Caddy-Webspace, Postgres, MariaDB, Redis |
| Bots & Tools | Lavalink, SinusBot, JMusicBot, Node.js-Dienste, Python-Dienste, generische Docker-Container |

**Wichtig:** Jeder dieser Einträge ist ein Egg-Import, keine Entwicklungsaufgabe. Wer den Parser fertig hat, bekommt den Katalog praktisch geschenkt. Die einzige echte Arbeit entsteht bei Windows-only-Spielen (FS25, teils Enshrouded-Varianten) und bei Spielen ohne stdin-Konsole, die RCON brauchen.

## Sicherheit

Sobald fremde Nutzer eigene Server bekommen, laufen fremde Prozesse auf dem Host. Das ist der Punkt, an dem ein Hobby-Panel zum Risiko wird.

### Container-Härtung

- Alle Capabilities entfernen, keine zusätzlichen vergeben
- Option `no-new-privileges` setzen
- Niemals privilegierte Container, niemals den Docker-Socket in einen Spielcontainer mounten
- Prozess im Container läuft als unprivilegierter Benutzer, nicht als root
- Prozesslimit setzen (512), sonst legt eine Fork-Bombe den ganzen Host lahm
- Speicherlimit hart, Swap begrenzt – ohne Limit zieht ein Minecraft-Server mit falscher Heap-Größe den Host in den OOM-Killer
- Festplattenkontingent per XFS-Projektquota oder Loop-Device; reine Größenprüfungen im Panel lassen sich umgehen
- Eigenes Docker-Netzwerk pro Server, kein Host-Netzmodus. Spielcontainer dürfen das interne Netz nicht erreichen
- Egress-Regeln: Container dürfen ins Internet, aber nicht auf Panel oder Datenbank

### Authentifizierung

- Argon2id mit mindestens 64 MB Speicher und 3 Iterationen
- Access-Token 15 Minuten, Refresh-Token 7 Tage, Rotation mit Erkennung von Wiederverwendung
- TOTP-2FA für Admins verpflichtend, für alle anderen empfohlen
- Ratelimit auf Login: 5 Versuche pro 15 Minuten je IP und Konto
- Ratelimit auf Power-Aktionen: etwa 10 pro Minute je Server, verhindert Container-Flapping
- Einladung immer per Token-Link, nie durch Passwortvergabe des Besitzers
- Aktive Sessions einsehbar und einzeln widerrufbar

### Typische Lücken in selbstgebauten Panels

| Lücke | Gegenmaßnahme |
| --- | --- |
| Pfad-Traversal im Dateimanager | Pfade auflösen, Symlinks prüfen, Ergebnis gegen die Server-Wurzel vergleichen |
| Rechte nur im Frontend geprüft | Jede Route serverseitig durch die Permission-Middleware |
| WebSocket ohne Autorisierung | Kurzlebiges Token, gebunden an Nutzer und Server, periodische Nachprüfung |
| Startparameter frei editierbar | Variablen mit Kommandozeilen-Einfluss auf nicht-editierbar setzen |
| Egg-Install-Script als root | Installer-Container unprivilegiert, nur das Server-Volume gemountet |
| Backup-Download ohne Prüfung | Einmal-Token mit kurzer Laufzeit, nie direkte Dateipfade in der URL |
| Konsolenbefehle ungefiltert | Befehle protokollieren; bei Minecraft `op` und `stop` als eigene Rechte denken |
| Admin-Panel öffentlich erreichbar | Hinter Reverse Proxy, zusätzlich über VPN-Tunnel statt IP-Whitelist, wenn die eigene IP wechselt |

### Audit-Log

Jede Aktion mit Nutzer, Server, Zeit und IP. Mindestens: Login und Fehlversuch, Power-Aktionen, Dateiänderungen und Löschungen, Backup-Erstellung und -Wiederherstellung, Subuser- und Rechteänderungen, Variablenänderungen, Reinstall, Serverlöschung. Das Log ist die einzige Chance zu rekonstruieren, wer eine Welt gelöscht hat.

### Was bewusst nicht gemacht wird

Keine Shell im Container über das Panel. Wer eine Shell braucht, bekommt SFTP und die Spielkonsole. Eine Web-Shell ist faktisch Root-Zugang auf den Container und damit der kürzeste Weg zu einem Ausbruchsversuch.

## Deployment im Homelab

Passt auf das bestehende Proxmox-Setup: Caddy als Reverse Proxy im LXC, Domain über `brogameryt.de`, Backups auf die Storage Box.

### Gast-Layout

| Gast | Typ | Inhalt | Ressourcen |
| --- | --- | --- | --- |
| `panel-app` | LXC | Panel-Backend und Frontend, Postgres, Redis | 2 vCPU, 4 GB RAM, 20 GB |
| `panel-nodes` | VM | Docker-Host für die Gameserver | so viel wie verfügbar, mindestens 8 vCPU, 48 GB RAM |
| bestehender Caddy-LXC | LXC | TLS und Weiterleitung auf `panel-app` | unverändert |

**Warum eine VM für die Gameserver und kein LXC:** Docker in einem unprivilegierten LXC funktioniert, bringt aber ständig Probleme mit Netzwerk-Namespaces, Overlay-Dateisystem und `nesting`. Eine VM kostet etwas Leistung und erspart viel Fehlersuche. Dazu kommt die Isolation – fremde Spielcontainer sollen nicht im selben Kernel wie der Proxmox-Host laufen.

### Caddy-Eintrag

```caddyfile
panel.brogameryt.de {
    reverse_proxy 10.0.0.x:8080 {
        header_up X-Real-IP {remote_host}
    }
}
```

WebSockets laufen bei Caddy ohne Zusatzkonfiguration durch. Wichtig ist nur, dass das Backend die echte Client-IP aus dem Header liest – sonst steht in jedem Audit-Log-Eintrag die Proxy-IP.

### Netzwerk und Ports

- Die Spielports werden per DNAT auf die Docker-VM weitergeleitet – wie die bestehenden Forwards in `/etc/network/interfaces`
- Einen zusammenhängenden Bereich reservieren (etwa 25500–25600 TCP und UDP), dann ist eine Regel pro Bereich statt pro Server nötig
- UDP nicht vergessen, sonst startet kein Steam-Spiel
- Panel selbst nur über Caddy erreichbar, Port 8080 nicht nach außen
- Verwaltungszugriff über den Tailscale-Tunnel; IP-Whitelisting ist bei wechselnder VPN-IP nicht praktikabel

### Speicher

Der Host hat wenig lokalen Platz – das ist die eigentliche Grenze des Projekts, nicht die CPU.

- Spielvolumes auf eine eigene Disk der Docker-VM legen, nicht auf das Root-Dateisystem
- Docker-Logs begrenzen (10 MB, 3 Dateien je Container)
- Backups direkt auf die Storage Box streamen, nicht lokal zwischenlagern
- Pro Server ein Disk-Kontingent setzen, sonst füllt ein ARK-Server mit Mods still die Platte
- Richtwert: Minecraft 2–10 GB, Palworld 10–20 GB, ARK ASA 40–100 GB je Server

### Backup der Panel-Daten

Zwei getrennte Dinge, die beide gesichert werden müssen:

1. **Postgres-Dump** des Panels, täglich per `pg_dump` in das bestehende Skript-Verzeichnis unter `/opt` und von dort auf die Storage Box
2. **Spielvolumes**, über die Backup-Funktion des Panels selbst – nicht per Proxmox-Snapshot, weil ein Snapshot eines laufenden Spielservers inkonsistent ist

Die Panel-Datenbank ohne Volumes ist nutzlos und umgekehrt. Beide Sicherungen zeitlich versetzen, damit nicht gleichzeitig die Leitung belegt ist.

### Reihenfolge der Inbetriebnahme

1. Docker-VM aufsetzen, Docker installieren, Testcontainer starten
2. Panel-LXC mit Postgres und Redis, Schema migrieren
3. Panel lokal gegen den Docker-Socket der VM testen (per TCP mit TLS oder SSH-Tunnel)
4. Caddy-Eintrag und TLS
5. Ein Minecraft-Egg importieren und einen Testserver anlegen
6. Erst danach Portfreigaben für den Spielbereich setzen

## Roadmap

Sieben Phasen. Jede endet mit etwas, das funktioniert – keine Phase besteht nur aus Vorarbeit.

### Phase 0 – Grundlage

- [ ] Repo anlegen, Go-Modul und Projektstruktur (`cmd/`, `internal/`, `web/`)
- [ ] Docker-Compose für die Entwicklung: Postgres, Redis
- [ ] Migrations-Werkzeug einrichten, erstes Schema aus dem Datenmodell anlegen
- [ ] Konfiguration über Umgebungsvariablen, `.env.example` ins Repo
- [ ] Strukturiertes Logging, Health-Endpunkt `/healthz`
- [ ] Docker-VM im Homelab aufsetzen, Engine-API vom Entwicklungsrechner erreichbar

### Phase 1 – Container-Kern

- [ ] Docker-Client kapseln: Create, Start, Stop, Kill, Remove, Inspect
- [ ] Volume-Verwaltung unter `/var/lib/panel/volumes/<short_id>`
- [ ] Statusmaschine mit einer zentralen Wechsel-Funktion
- [ ] Stop-Logik: Kommando an stdin, Timeout, SIGTERM, SIGKILL
- [ ] Crash-Erkennung und Auto-Restart mit Zähler
- [ ] Reconciliation beim Start des Panels
- [ ] CLI-Test: Container von Hand anlegen und wieder entfernen

### Phase 2 – Egg-Parser

- [ ] Egg-JSON einlesen und in `eggs` und `egg_variables` schreiben
- [ ] Variablen-Ersetzung im Startkommando
- [ ] Validierungsregeln übersetzen (`required`, `string`, `numeric`, `in:`, `between:`, `regex:`)
- [ ] Install-Phase: Installer-Container, Logs live streamen, Exit-Code auswerten
- [ ] Done-Regex auswerten → Statuswechsel auf `running`
- [ ] Config-Datei-Patching für `properties` und `yaml`
- [ ] Minecraft-Egg importieren und bis zum laufenden Server durchspielen

### Phase 3 – API und Auth

- [ ] Registrierung, Login, Argon2id, JWT mit Refresh-Rotation
- [ ] Permission-Middleware mit allen Flags
- [ ] CRUD für Server, Eggs, Nutzer, Allocations
- [ ] Ratelimits auf Login und Power-Aktionen
- [ ] Audit-Log schreiben und abfragbar machen
- [ ] TOTP-2FA
- [ ] API-Dokumentation (OpenAPI)

### Phase 4 – Frontend-MVP

- [ ] Login, Navigation, dunkles Theme
- [ ] Serverliste mit Live-Status
- [ ] Konsole mit xterm.js, Befehlszeile, Scrollback
- [ ] Power-Knöpfe mit optimistischem UI und Fehlerbehandlung
- [ ] Ressourcen-Graphen für CPU und RAM
- [ ] Erstellungsdialog in drei Schritten, Formular aus Egg-Variablen generiert
- [ ] **Meilenstein: ein Minecraft-Server komplett über die Weboberfläche erstellen, starten und bespielen**
- [ ] Automatische Portvergabe mit echtem Belegungstest und Nebenport-Reservierung
- [ ] Formulare vollständig aus Egg-Regeln erzeugt, Dropdowns statt Freitext

### Phase 5 – Dateien und Backups

- [ ] Dateimanager-API mit abgesicherter Pfadauflösung
- [ ] Dateibaum, Breadcrumb, Mehrfachauswahl, Kontextmenü
- [ ] Drag-and-Drop-Upload, chunked mit Resume und Fortschritt
- [ ] Verschieben per Ziehen
- [ ] Monaco-Editor mit Syntax-Hervorhebung
- [ ] Packen und Entpacken im Hintergrund
- [ ] Backup-Erstellung als `tar.zst` mit Ignore-Liste
- [ ] Backup-Wiederherstellung mit Bestätigung
- [ ] Auto-Backup mit Voreinstellungen, Aufbewahrung und Sperren
- [ ] Ziel Storage Box per CIFS, direkt gestreamt
- [ ] Zeitplan-Worker (Neustart, Backup, Befehl)
- [ ] Log-Reiter: Dateiliste, Suche, Absturz-Hervorhebung, Download, Rotation
- [ ] Konfigurations-Editor als Formular mit Schema im Egg, plus Rohansicht
- [ ] Versionshistorie der Konfigurationsdateien mit Vergleich und Rücksprung

### Phase 6 – Mehrbenutzer-Betrieb

- [ ] Subuser-Verwaltung mit Flag-Matrix in der Oberfläche
- [ ] Presets Zuschauer, Operator, Verwalter, Co-Admin
- [ ] Einladung per E-Mail-Token
- [ ] Nutzer-Budgets (RAM, Speicher, Serveranzahl) und Prüfung bei der Erstellung
- [ ] Admin-Bereich: Nutzer, Eggs, Allocations, globales Audit-Log
- [ ] Suspendieren von Nutzern und Servern
- [ ] Aktivitätsansicht pro Server

### Phase 7 – Komfort und Skalierung

- [ ] Suche und Filterleiste mit Chips, Ansichtswechsel Karten/Tabelle
- [ ] Massenaktionen für mehrere Server
- [ ] Befehlspalette (`Strg+K`) und Tastaturkürzel
- [ ] Favoriten und Tags
- [ ] SFTP-Server mit Panel-Login und Chroot
- [ ] RCON-Anbindung für Spiele ohne stdin-Konsole
- [ ] Benachrichtigungen: Panel-Glocke, Discord-Webhook bei Absturz und Backup-Fehler
- [ ] Besitzerwechsel
- [ ] Umzug zwischen Nodes mit Fortschrittsanzeige
- [ ] Multi-Node: `nodes`-Tabelle produktiv, Daemon-Token, Node-Auswahl bei der Erstellung
- [ ] Prometheus-Endpunkt und Grafana-Dashboard
- [ ] Mobile Ansicht für Serverliste und Konsole
- [ ] Egg-Import per URL und Egg-Versionierung
- [ ] Modpack-Installer: Modrinth-Suche, Pack-Auflösung, Fallback bei gesperrten Mods
- [ ] Versions-Updater mit erzwungenem Backup und automatischem Rückrollen
- [ ] Mod- und Plugin-Reiter je Egg-Quelle (Modrinth, uMod, Workshop, CurseForge)
- [ ] Konfigurationsprofile exportieren, importieren und auf mehrere Server anwenden
- [ ] Ressourcen-Rechner im Erstellungsdialog mit Budget-Balken und Warnungen
- [ ] Statistik-Seite mit Zeitreihen, Verdichtung und gemeinsamer Zeitraumwahl
- [ ] Theme-System über CSS-Variablen, sechs Themes, Theme-Editor
- [ ] Tablet-Layout zweispaltig, Handy-Layout mit unterer Navigation
- [ ] PWA-Manifest und Service Worker, danach Tauri-Hülle für den Desktop
- [ ] Ereignis-Zeitachse: events-Tabelle, Log-Watcher je Egg, Klick vom Graph ins Log
- [ ] Spieler-Sitzungen mit Herkunft aus lokaler Datenbank und Aufbewahrungsgrenze
- [ ] AMP-Import-Assistent: Instanzen finden, Egg zuordnen, Daten spiegeln, Probestart
- [ ] Veröffentlichung vorbereiten: Lizenz, SECURITY.md, CI, Release-Images
- [ ] Regelbaukasten für Benachrichtigungen mit Abklingzeit, Ruhezeiten und Testknopf

### Zeitgefühl

Phase 0 bis 4 sind der harte Kern und das, was sich wie ein Panel anfühlt – realistisch einige Wochenenden, wenn Go schon sitzt. Phase 5 und 6 sind je nach Detailtiefe ähnlich groß. Phase 7 ist nie wirklich fertig, das ist bei AMP und Pterodactyl genauso.

## Bedienoberfläche

Das Panel soll bei 3 Servern aufgeräumt und bei 80 Servern noch benutzbar sein. Das entscheidet sich an vier Stellen: Serverliste, Server-Detailansicht, Dateimanager und Erstellungsdialog.

### Serverliste als Startseite

- **Suche mit sofortiger Reaktion** über Name, Spiel, Besitzer und Port. Debounce 150 ms, Treffer im Namen hervorgehoben.
- **Filterleiste** als Chips: Status (läuft / offline / abgestürzt / installiert), Spiel, Besitzer, Node, Tag. Mehrere Filter kombinierbar, aktive Filter als entfernbare Chips sichtbar.
- **Ansichtswechsel** zwischen Karten (große Kacheln mit Spiel-Icon, Spielerzahl, CPU-/RAM-Balken) und Tabelle (dicht, sortierbar, für viele Server).
- **Sortierung** nach Name, Status, RAM-Auslastung, letzter Aktivität.
- **Favoriten** anpinnen, damit die eigenen zwei wichtigen Server oben stehen.
- **Massenaktionen**: Mehrfachauswahl per Checkbox, dann Starten, Stoppen, Neustarten oder Backup für alle Ausgewählten. Bei mehr als 5 Servern eine Rückfrage.
- **Live-Aktualisierung** über einen einzigen WebSocket, der Statuswechsel aller sichtbaren Server trägt – nicht einer pro Karte.
- **Tastatur**: `/` springt in die Suche, `Strg+K` öffnet eine Befehlspalette (Server suchen, starten, Konsole öffnen).

### Server-Detailansicht

Links eine schmale Navigation, rechts der Inhalt. Reiter: Konsole, Dateien, Backups, Zeitpläne, Nutzer, Netzwerk, Startparameter, Einstellungen, Aktivität. Reiter, für die der Nutzer kein Recht hat, werden gar nicht angezeigt – nicht ausgegraut.

Kopfzeile immer sichtbar: Servername, Statuspunkt mit Farbe, Spielerzahl, Uptime, die drei Power-Knöpfe, Verbindungsadresse mit Kopier-Button.

Konsole: xterm.js mit ANSI-Farben, Scrollback 2000 Zeilen, Suche im Puffer, Auto-Scroll abschaltbar, Befehlszeile mit History per Pfeiltaste und Autovervollständigung häufiger Befehle.

### Dateimanager mit Drag-and-Drop

| Funktion | Umsetzung |
| --- | --- |
| Upload per Ziehen | Drop-Zone über dem ganzen Dateibereich, mehrere Dateien und ganze Ordner (`webkitGetAsEntry`) |
| Verschieben per Ziehen | Datei auf einen Ordner oder in die Breadcrumb-Leiste ziehen → `POST /files/rename` |
| Fortschritt | Pro Datei ein Balken, Gesamtfortschritt oben, Abbrechen möglich |
| Große Dateien | Chunked Upload in 10-MB-Stücken mit Resume – sonst scheitert jeder 3-GB-Weltupload |
| Mehrfachauswahl | Klick, Shift-Klick, Strg-Klick; Massenaktionen Verschieben, Löschen, Packen |
| Editor | Monaco mit Syntax-Hervorhebung für YAML, JSON, Properties, TOML; Strg+S speichert |
| Archive | Rechtsklick → Packen oder Entpacken, läuft im Hintergrund mit Fortschrittsanzeige |
| Navigation | Breadcrumb-Pfad, Doppelklick öffnet, Zurück-Taste funktioniert, Pfad in der URL |
| Kontextmenü | Rechtsklick auf Datei: Öffnen, Umbenennen, Kopieren, Herunterladen, Löschen, Rechte |

Abbruchsicherheit: Ein unterbrochener Upload darf keine halbe Datei stehen lassen – in eine `.part`-Datei schreiben und erst am Ende umbenennen.

### Auto-Backup in der Oberfläche

- Schalter „Automatische Backups“ direkt im Backup-Reiter, nicht versteckt in den Zeitplänen
- Drei Voreinstellungen: täglich 4 Uhr, alle 6 Stunden, wöchentlich – plus eigener Cron für Fortgeschrittene
- Aufbewahrung einstellbar („die letzten 5 behalten“), gesperrte Backups werden nie rotiert
- Vor jedem automatischen Backup das Speicherkommando des Spiels senden, sonst ist der Stand inkonsistent
- Status sichtbar: letztes Backup mit Zeit und Größe, nächstes geplantes, Fehlschläge rot mit Grund
- Fehlgeschlagene Backups lösen eine Benachrichtigung aus (Panel-Glocke, optional Discord-Webhook)

### Erstellungsdialog

Drei Schritte statt eines langen Formulars: Spiel wählen (Kachelgitter mit Icons und Suche) → Ressourcen und Ports → spielspezifische Variablen aus dem Egg. Live-Anzeige des verbleibenden RAM-Budgets des Nutzers, Warnung bei Mindestanforderungen („ARK ASA läuft unter 20 GB praktisch nicht“).

### Gestaltung

Dunkles Theme als Standard, helles umschaltbar. Statusfarben konsequent: grün läuft, grau offline, gelb startet oder stoppt, rot abgestürzt, blau installiert. Status nie nur über Farbe – immer mit Text oder Symbol, sonst ist das Panel für Farbenblinde unbrauchbar. Mobil: Serverliste und Konsole müssen auf dem Handy funktionieren, der Dateimanager darf Desktop-first sein.

## Server-Migration

Drei verschiedene Dinge werden oft gleich genannt, brauchen aber unterschiedliche Umsetzung.

### Besitzerwechsel

Der einfachste Fall: `servers.owner_id` auf einen anderen Nutzer setzen. Zu beachten: RAM- und Server-Budget des neuen Besitzers prüfen, der alte Besitzer wird optional als Subuser mit Co-Admin-Rechten eingetragen, Eintrag im Audit-Log. Keine Daten bewegen sich.

### Umzug auf einen anderen Host

Relevant, sobald ein zweiter Node dazukommt. Ablauf:

1. Server stoppen und auf `suspended` setzen, damit niemand ihn währenddessen startet
2. Freie Allocation auf dem Ziel-Node reservieren – Ports können sich ändern, der Nutzer muss das sehen
3. Volume übertragen: `rsync -a --info=progress2` über SSH oder Tailscale, bei großen Welten in zwei Läufen (einmal live, einmal nach dem Stop für das Delta)
4. Checksumme vergleichen, erst dann weitermachen
5. Container auf dem Ziel-Node erstellen, `node_id` und Allocation in der Datenbank umstellen
6. Probestart, Log prüfen
7. Quell-Volume erst nach erfolgreicher Prüfung löschen – nie vorher, nie automatisch

Fortschritt live im Panel anzeigen, der Nutzer soll nicht raten, wie lange 40 GB ARK-Welt brauchen.

### Import aus bestehenden Panels

| Quelle | Was geht | Was nicht geht |
| --- | --- | --- |
| Pterodactyl | Eggs direkt importieren, Volumes kopieren, Nutzer und Server per API auslesen und anlegen | Passwort-Hashes (Bcrypt gegen Argon2id) – Nutzer müssen Passwort zurücksetzen |
| AMP | Spieldaten kopieren (liegen unter `.ampdata/instances/<name>`) | Templates sind nicht übertragbar, Instanz-Konfiguration muss als neues Egg nachgebaut werden |
| Nackte Docker-Container | Volume kopieren, passendes Egg wählen, Variablen von Hand setzen | Automatik – das bleibt Handarbeit |
| Gemieteter Gameserver | Welt- und Konfigurationsdateien per FTP ziehen und ins Volume legen | Plugins mit Lizenzbindung, Datenbanken ohne Export |

Für den eigenen Umstieg ist der realistische Weg: Eggs zuerst importieren, dann einen Testserver anlegen, dessen Volume durch die Daten des alten Servers ersetzen und starten. Spielstände sind portabel, Panel-Konfiguration ist es nicht.

### Fallstricke

- **Ports ändern sich** beim Umzug fast immer. Alte Verbindungsadresse im Panel noch 7 Tage mit Hinweis anzeigen.
- **Mod-Pfade sind oft absolut.** Nach einem Umzug Konfigurationsdateien nach dem alten Pfad durchsuchen.
- **Laufende Backups** blockieren den Umzug. Vorher prüfen, ob ein Backup-Job aktiv ist.
- **Niemals während eines Umzugs den Quellserver starten.** Ein Lock in der Datenbank verhindert das zuverlässiger als Disziplin.

## Offene Entscheidungen

Punkte, die vor Phase 0 festgelegt werden sollten, weil sie später teuer zu ändern sind.

| Frage | Optionen | Empfehlung |
| --- | --- | --- |
| Backend-Sprache | Go oder TypeScript | Go, wegen Log-Fan-out und Deployment als Binary |
| Panel und Daemon getrennt? | Monolith oder Panel plus Daemon pro Node | Monolith starten, Daemon-Schnittstelle aber von Anfang an als Interface kapseln |
| Docker-Zugriff | Unix-Socket lokal oder TCP mit TLS | Lokaler Socket, solange Panel und Docker auf derselben Maschine liegen |
| Panel und Docker zusammen? | Beides in der VM oder getrennt | Getrennt, damit ein abgestürzter Gameserver das Panel nicht mitnimmt |
| Festplattenkontingent | XFS-Projektquota, Loop-Device oder nur Überwachung | Loop-Device pro Server ist am einfachsten zuverlässig |
| Egg-Quelle | Eigene Sammlung pflegen oder bei Bedarf importieren | Bei Bedarf importieren, Originale in `raw_egg` behalten |
| Mehrsprachigkeit | Nur Deutsch oder von Anfang an i18n | i18n-Struktur gleich anlegen, auch wenn zunächst nur Deutsch gefüllt wird |
| Registrierung | Offen, auf Einladung oder nur Admin | Nur Admin legt Nutzer an, solange es ein privates Panel ist |

### Noch zu klären

- Sollen Nutzer eigene Server erstellen dürfen, oder legt der Admin sie an und vergibt sie? Das ändert den Erstellungsdialog und die Budget-Logik.
- Wie viel RAM steht auf dem Server insgesamt zur Verfügung? Davon hängt ab, welche Spiele überhaupt sinnvoll angeboten werden können.
- Soll das Panel öffentlich erreichbar sein oder nur über den Tunnel? Bei öffentlichem Zugang sind 2FA und Ratelimits Pflicht, nicht optional.
- Windows-Spiele wie FS25: eigene Windows-VM mit Agent, oder bewusst außen vor?

## Modpack-Installer

Modpacks lassen sich vollautomatisch installieren. Der Nutzer wählt ein Pack, das Panel lädt es herunter und richtet den Server ein – kein manuelles Hochladen von Mod-Ordnern.

### Der einfache Weg: das Image macht es selbst

Das `itzg/minecraft-server`-Image kann Modpacks eigenständig installieren. Das Panel setzt nur Umgebungsvariablen – kein eigener Download-Code nötig:

| Quelle | Variablen |
| --- | --- |
| Modrinth | `MODPACK_PLATFORM=MODRINTH`, `MODRINTH_MODPACK=<slug oder URL>`, optional `MODRINTH_VERSION` |
| CurseForge | `MODPACK_PLATFORM=AUTO_CURSEFORGE`, `CF_PAGE_URL` oder `CF_SLUG`, `CF_API_KEY`, optional `CF_FILE_ID` |
| FTB | `MODPACK_PLATFORM=FTBA`, `FTB_MODPACK_ID`, optional `FTB_MODPACK_VERSION_ID` |
| Eigene Datei | `GENERIC_PACK=/data/pack.zip` nach Upload über den Dateimanager |

Für das Panel heißt das: ein eigenes Egg „Minecraft Modpack“ mit diesen Variablen als Formularfelder. Mehr braucht die erste Version nicht.

### Der eigene Weg: Pack selbst auflösen

Sinnvoll, sobald das Panel Pack-Suche, Versionsvergleich und Update-Erkennung in der Oberfläche anbieten soll.

**Modrinth** ist der angenehmere Dienst: offene API ohne Schlüssel.

1. `GET https://api.modrinth.com/v2/search?facets=[["project_type:modpack"]]&query=…` für die Suche im Panel
2. `GET /v2/project/{slug}/version` liefert alle Versionen mit Minecraft-Version und Loader
3. Die `.mrpack`-Datei herunterladen – ein ZIP mit `modrinth.index.json` und einem `overrides/`-Ordner
4. `modrinth.index.json` auflisten: jede Datei hat Zielpfad, Download-URL und Hashes
5. Dateien parallel laden, SHA-512 prüfen, an den angegebenen Pfad legen
6. `overrides/` über das Serververzeichnis kopieren (Konfigurationen, Skripte)
7. Loader installieren (Fabric, Forge, NeoForge, Quilt) in der im Index genannten Version

**CurseForge** braucht einen API-Schlüssel (kostenlos über das Entwicklerportal). Der Serverpack enthält eine `manifest.json` mit Paaren aus Projekt- und Datei-ID, die einzeln über `GET /v1/mods/{modId}/files/{fileId}` aufgelöst werden.

**Der bekannte Haken:** Manche Mod-Autoren sperren die Verteilung über die API (`downloadUrl: null`). Dann lässt sich die Datei nicht automatisch holen. Das Panel muss diesen Fall sauber melden – mit Liste der betroffenen Mods und Direktlink – und anbieten, die Dateien über den Dateimanager nachzureichen. Wer das verschweigt, produziert Server, die ohne erkennbaren Grund nicht starten.

### Im Erstellungsdialog

Schritt 1 Spiel wählen → Minecraft → Unterauswahl: Vanilla, Paper, Modpack. Bei Modpack eine Suchleiste mit Pack-Bildern, darunter die Versionsauswahl und automatisch gesetzter RAM-Vorschlag aus den Pack-Angaben. Große Packs brauchen 6–10 GB – eine Warnung bei zu knappem Budget spart die häufigste Supportfrage.

## Versions-Updater

Dasselbe Prinzip für alle Spiele: Das Panel kennt die installierte Version, fragt die jeweilige Quelle nach der neuesten und bietet das Update an. Jedes Egg bringt dazu ein Feld mit, woher die Versionsinfo kommt.

| Serverart | Installierte Version | Quelle für die neueste | Update |
| --- | --- | --- | --- |
| Modpack (Modrinth) | Version-ID in den Servervariablen | `GET /v2/project/{slug}/version` | Pack neu auflösen, Mods ersetzen, Welt behalten |
| Modpack (CurseForge) | File-ID | `GET /v1/mods/{id}/files` | wie oben, gesperrte Mods melden |
| Paper / Purpur / Folia | Build-Nummer | Build-API des Projekts | Jar tauschen, Plugins und Welt bleiben |
| Fabric / NeoForge | Loader-Version | Meta-API des Loaders | Loader neu installieren |
| Steam-Spiele | Build-ID aus `appmanifest` | `steamcmd +app_info_print <appid>` | `app_update <appid> validate` beim Start |
| Docker-Image allgemein | Image-Digest | Registry-Manifest per `HEAD` | Image ziehen, Container neu erstellen, Volume bleibt |
| Plugins (Minecraft) | Dateiversion | Spiget- oder Modrinth-API | Jar ersetzen, Konfiguration behalten |

### Ablauf eines Updates

1. Prüfen, ob Spieler online sind – wenn ja, Warnung oder Verschiebung auf das nächste Wartungsfenster
2. `say`-Warnung ins Spiel senden, 5 Minuten zählen
3. Server sauber stoppen
4. **Automatisches Backup erzwingen** – ohne Ausnahme, auch wenn der Nutzer es abwählt
5. Update einspielen
6. Starten, Log auf den Done-Regex prüfen
7. Startet er nicht innerhalb des Timeouts: automatisch auf das Backup zurückrollen und den Nutzer informieren

Schritt 7 ist der Unterschied zwischen einem Updater, dem man traut, und einem, den niemand benutzt.

### Einstellungen pro Server

- **Manuell** – Panel zeigt nur an, dass ein Update bereitsteht (Standard für Modpacks)
- **Beim Neustart** – Update wird eingespielt, wenn der Server ohnehin neu startet (sinnvoll für Steam-Spiele)
- **Nach Zeitplan** – etwa jeden Montag um 5 Uhr
- **Version festnageln** – kein Update, auch nicht manuell versehentlich. Wichtig bei laufenden Modpack-Welten

### Fallstricke

- **Minecraft-Hauptversionen brechen Welten.** Ein Sprung von 1.20 auf 1.21 ist kein Update, sondern ein Umzug. Das Panel muss zwischen Pack-Patch und Versionssprung unterscheiden und bei Letzterem deutlich warnen.
- **Overrides überschreiben Nutzeränderungen.** Beim Pack-Update werden Konfigurationsdateien ersetzt. Eine Schutzliste (`server.properties`, `ops.json`, `whitelist.json`, eigene Einträge) bewahrt, was der Nutzer angepasst hat.
- **Steam-Updates erzwingen oft Client-Updates.** Nach einem ARK- oder Palworld-Update können Spieler mit älterem Client nicht mehr verbinden – das gehört in die Update-Meldung.
- **Plugins hängen an der Server-Version.** Nach einem Paper-Update auf eine neue Minecraft-Version laufen alte Plugins oft nicht mehr. Vor dem Update die Plugin-Liste gegen die Zielversion prüfen, soweit die API das hergibt.
- **Mod-Abhängigkeiten.** Ein einzelner Mod lässt sich selten isoliert aktualisieren. Entweder das ganze Pack oder gar nichts.
- **Doppelte Updates vermeiden.** Ein Lock pro Server verhindert, dass Zeitplan und Nutzer gleichzeitig aktualisieren.

## Mod- und Plugin-Verwaltung

Jedes Spiel löst Mods anders. Das Panel braucht deshalb kein universelles Mod-System, sondern pro Egg einen hinterlegten Mod-Typ mit Quelle, Zielordner und Installationsweg.

| Spiel | Typ | Quelle | Wohin |
| --- | --- | --- | --- |
| Minecraft (Paper/Spigot) | Plugins | Modrinth-API, Hangar-API, Spiget | `plugins/*.jar` |
| Minecraft (Fabric/Forge) | Mods | Modrinth-API, CurseForge-API | `mods/*.jar` |
| ARK: Survival Evolved | Workshop-Mods | Steam Workshop (AppID 346110) | `ShooterGame/Content/Mods/<id>` |
| ARK: Survival Ascended | CurseForge-Mods | CurseForge (ARK ASA) | über `-mods=<id,id>` am Startkommando |
| Rust | Oxide/uMod-Plugins | uMod-API | `oxide/plugins/*.cs` |
| Valheim | BepInEx-Mods | Thunderstore-API | `BepInEx/plugins` |
| 7 Days to Die | Mods | Nexus, manuell | `Mods/<name>` |
| Project Zomboid | Workshop-Mods | Steam Workshop | IDs in `servertest.ini` |
| CS2 | Metamod + CSSharp | GitHub-Releases | `game/csgo/addons` |
| Satisfactory | SMM-Mods | ficsit.app-API | `FactoryGame/Mods` |
| Palworld | Pak-Mods / UE4SS | manuell | `Pal/Binaries/Win64/Mods` |

### Was der Mod-Reiter im Panel kann

- **Durchsuchen und installieren** aus der Quelle, die zum Egg gehört – bei Modrinth und uMod ohne Schlüssel, bei CurseForge mit API-Key
- **Installierte Liste** mit Version, Autor und Hinweis, ob ein Update bereitsteht
- **Aktivieren und deaktivieren** ohne Löschen: `plugin.jar` nach `plugin.jar.disabled` umbenennen. Bei ARK und Workshop-Mods stattdessen die ID aus dem Startkommando nehmen
- **Abhängigkeiten prüfen**: Modrinth liefert sie in den Versionsdaten mit, das Panel warnt vor fehlenden Pflicht-Mods
- **Hochladen** per Drag-and-Drop für alles, was keine API hat
- **Neustart-Hinweis**: Mods greifen erst nach einem Neustart. Eine Ausnahme sind Oxide-Plugins bei Rust, die zur Laufzeit nachgeladen werden

### Workshop-Mods im Detail

Für ARK: Survival Evolved und Project Zomboid lädt SteamCMD die Mods:

```bash
steamcmd +login anonymous \
  +workshop_download_item 346110 <modid> \
  +quit
```

Das Ergebnis liegt unter `steamapps/workshop/content/346110/<modid>` und muss anschließend in den Spielordner kopiert und bei ARK entpackt werden (die `.z`-Dateien). Das Panel sollte das als Hintergrundjob mit Fortschrittsanzeige ausführen – große ARK-Mods sind mehrere Gigabyte.

**Wichtig bei ARK: Survival Ascended:** Hier gibt es keinen Steam Workshop mehr, Mods laufen über CurseForge und werden vom Server selbst nachgeladen, wenn die IDs im Startkommando stehen. Das Panel verwaltet also nur eine Liste von IDs, nicht die Dateien.

### Fallstricke

- **Mod-Reihenfolge zählt** bei ARK und Rust. Die Liste muss sortierbar sein, nicht nur eine Menge.
- **Ein Mod-Update kann die Welt beschädigen.** Vor jeder Modänderung dieselbe Backup-Regel wie beim Versions-Update.
- **Client-Mods auf dem Server** sind der häufigste Startfehler. Wo die API es hergibt, Server-Tauglichkeit prüfen und sonst warnen.
- **Lizenzsperren** gibt es bei CurseForge auch für einzelne Mods – gleicher Fallback wie beim Modpack-Installer.

## Konfigurations-Verwaltung

Die Spieleinstellungen stecken in Dateien unterschiedlichster Formate. Das Panel zeigt sie als Formular, wenn es die Datei kennt, und als Texteditor, wenn nicht.

| Spiel | Datei | Format |
| --- | --- | --- |
| Minecraft | `server.properties` | Properties |
| Minecraft (Paper) | `paper-global.yml`, `bukkit.yml`, `spigot.yml` | YAML |
| ARK | `GameUserSettings.ini`, `Game.ini` | INI mit Mehrfachschlüsseln |
| Palworld | `PalWorldSettings.ini` | INI mit einer langen Optionszeile |
| Valheim | Startparameter | Kommandozeile |
| Rust | `server.cfg` | Zeilenbasierte Befehle |
| 7 Days to Die | `serverconfig.xml` | XML |
| Project Zomboid | `servertest.ini` | INI |
| CS2 | `server.cfg`, `gamemode_*.cfg` | Konsolenbefehle |
| Satisfactory | `ServerSettings.ini` | INI |

### Formular statt Texteditor

Für die bekannten Dateien hinterlegt das Egg ein Schema: Schlüssel, Typ, Standardwert, erlaubter Bereich, Beschreibung. Daraus baut das Panel ein Formular mit Schiebereglern, Schaltern und Auswahlfeldern – gruppiert nach Themen wie Spielwelt, Spieler, Schwierigkeit, Netzwerk. Eine Suche über alle Einstellungen gehört dazu, denn `GameUserSettings.ini` hat bei ARK mehrere hundert Zeilen.

Daneben immer ein Umschalter auf die Rohansicht. Wer ARK kennt, will die INI direkt bearbeiten.

**Geschützte Schlüssel:** Port, IP und RCON-Port gehören dem Panel. Sie werden im Formular als gesperrt angezeigt und beim Speichern aus der Datei wieder überschrieben – sonst richtet sich ein Nutzer den Server unerreichbar ein.

**Palworld-Sonderfall:** Dort stehen alle Optionen in einer einzigen Klammerzeile hinter `OptionSettings=`. Der Parser muss diese Zeile zerlegen und beim Speichern exakt wieder zusammensetzen, sonst startet der Server ohne Meldung mit Standardwerten.

### Versionshistorie

Jede Speicherung legt eine Kopie an – Zeit, Nutzer, Datei, vorheriger Inhalt. In der Oberfläche ein Vergleich Zeile für Zeile und ein Knopf „zurück zu dieser Fassung“. Zehn Versionen pro Datei aufbewahren reicht; das kostet fast nichts und rettet den Abend, an dem jemand ein Semikolon zu viel setzt.

### Import und Export

- **Exportieren**: alle Konfigurationsdateien eines Servers als ZIP, oder als Profil in der Datenbank mit Namen („ARK PvE Standard“, „Minecraft Hardcore“)
- **Importieren**: Profil auf einen anderen Server anwenden. Dabei geschützte Schlüssel ausnehmen und vorher eine Vorschau der Änderungen zeigen
- **Teilen**: Profile können privat oder für alle Panel-Nutzer sichtbar sein
- **Kompatibilitätsprüfung**: ein Profil trägt die Egg-ID, aus der es stammt. Ein ARK-Profil auf einem Minecraft-Server wird gar nicht erst angeboten
- **Massenanwendung**: ein Profil auf mehrere Server gleichzeitig – praktisch bei einem Netzwerk aus mehreren Welten

## Log-Verwaltung

Die Live-Konsole zeigt, was gerade passiert. Die Log-Verwaltung beantwortet die Frage, was gestern um drei Uhr passiert ist – das sind zwei verschiedene Dinge.

### Was gesammelt wird

| Quelle | Inhalt |
| --- | --- |
| Docker-Logs | Alles von stdout und stderr, die Grundlage der Konsole |
| Spiel-Logdateien | `logs/latest.log` und `logs/*.log.gz` bei Minecraft, `ShooterGame/Saved/Logs` bei ARK, `Saved/Logs` bei UE-Spielen |
| Absturzberichte | `crash-reports/` bei Minecraft, `.dmp`-Dateien bei UE-Spielen |
| Installations-Logs | Ausgabe des Installer-Containers, dauerhaft pro Server gespeichert |
| Panel-Aktivität | Audit-Log aus der Datenbank, kein Dateilog |

### Funktionen im Log-Reiter

- **Dateiliste** mit Größe und Datum, neueste oben, `.gz`-Dateien werden beim Öffnen entpackt
- **Volltextsuche** über eine Datei, Treffer hervorgehoben, Sprung zur Zeile
- **Filter nach Stufe** (INFO, WARN, ERROR) und nach Zeitfenster, wo das Format es hergibt
- **Absturz hervorheben**: Zeilen mit `Exception`, `FATAL` oder `crash` farbig markiert, Sprung zum ersten Fehler
- **Herunterladen** einzelner Dateien oder aller Logs als ZIP
- **Teilen**: Logzeilen in einen Textdienst hochladen und einen Link erzeugen – praktisch, wenn jemand im Discord um Hilfe bittet
- **Live-Verfolgung** einer Datei, nicht nur der Konsole (wichtig bei Spielen, die wenig auf stdout schreiben)

### Rotation und Aufbewahrung

Das ist bei knappem Speicher die eigentliche Aufgabe:

- Docker-Logs auf 10 MB in 3 Dateien je Container begrenzen – ohne das füllt ein gesprächiger ARK-Server die Platte
- Spiel-Logs älter als 14 Tage automatisch löschen, einstellbar pro Server
- Absturzberichte länger behalten (90 Tage), sie sind klein und wertvoll
- Gesamtgröße der Logs im Speicherkontingent des Servers mitzählen, sonst umgeht man das Limit über Logs
- Warnung im Panel, wenn ein einzelnes Log über 500 MB wächst – das ist fast immer ein Fehler in Dauerschleife

### Nicht vergessen

Logs enthalten IP-Adressen von Spielern. Wer das Panel mit anderen teilt, sollte den Log-Zugriff an `file.read` koppeln und nicht jedem Zuschauer geben.

## Ressourcen-Rechner

Im Erstellungsdialog rechnet das Panel vor, was der Server braucht, und vergleicht es mit dem freien Budget. Das verhindert die beiden häufigsten Fehler: zu wenig RAM vergeben und den Host überbuchen.

### Richtwerte pro Spiel

| Spiel | Grund-RAM | Pro Spieler | CPU-Kerne | Anmerkung |
| --- | --- | --- | --- | --- |
| Minecraft Vanilla | 1,5 GB | 100 MB | 1–2 | Haupt-Thread ist entscheidend |
| Minecraft Paper | 2 GB | 120 MB | 2 | Bessere Mehrkern-Nutzung als Vanilla |
| Minecraft Modpack (50–150 Mods) | 4 GB | 200 MB | 2 | Große Packs eher 8 GB Grund-RAM |
| Minecraft Modpack (200+ Mods) | 8 GB | 250 MB | 2–3 | Weltgenerierung ist der Spitzenverbrauch |
| Palworld | 12 GB | 500 MB | 4 | Speicherverbrauch steigt mit der Spielzeit |
| Enshrouded | 6 GB | 400 MB | 3–4 | Läuft unter Proton, Aufschlag einrechnen |
| ARK: Survival Evolved | 6 GB | 250 MB | 2–3 | Pro Karte, nicht pro Cluster |
| ARK: Survival Ascended | 16 GB | 500 MB | 4 | Mods erhöhen das deutlich |
| Valheim | 3 GB | 300 MB | 2 |  |
| Rust | 6 GB | 150 MB | 4 | Kartengröße wiegt schwerer als Spielerzahl |
| CS2 | 1,5 GB | 50 MB | 2 | Braucht konstante Tickrate, nicht viel RAM |
| 7 Days to Die | 6 GB | 300 MB | 3 |  |
| Satisfactory | 6 GB | 500 MB | 3–4 | Steigt stark mit Fabrikgröße |
| Terraria | 1 GB | 50 MB | 1 |  |

### Formel im Panel

```
empfohlen_mb = grund_mb
             + spieler * pro_spieler_mb
             + mods * mod_aufschlag_mb        // Minecraft: 20 MB je Mod
             + welt_faktor                     // große/alte Welt: +25 %

minimum_mb   = empfohlen_mb * 0.7
```

Die Werte kommen aus dem Egg, nicht aus dem Code – so lässt sich ein neues Spiel ohne Änderung am Panel ergänzen:

```json
"resources": {
  "base_ram_mb": 2048,
  "ram_per_player_mb": 120,
  "ram_per_mod_mb": 20,
  "min_cpu_percent": 200,
  "notes": "Paper nutzt mehrere Kerne, Vanilla nicht"
}
```

### Anzeige im Erstellungsdialog

- Schieberegler für erwartete Spielerzahl, daneben die errechnete Empfehlung in Echtzeit
- Balken mit dem Budget des Nutzers: belegt, dieser Server, frei
- Rote Warnung unterhalb des Minimums mit klarer Begründung statt nur „zu wenig Speicher“
- Hinweis auf dem Host-Balken, wenn der gesamte Node knapp wird

### Überbuchung

- **RAM niemals überbuchen.** Die Summe der Limits muss unter dem physischen Speicher bleiben, abzüglich etwa 4 GB für das Wirtssystem. Wird der Speicher knapp, beendet der Kernel Prozesse – ohne Vorwarnung und meist den größten Server.
- **CPU darf überbucht werden.** Zwei bis drei Mal die physischen Kerne ist üblich, weil Server selten gleichzeitig unter Volllast stehen. Minecraft und ARK hängen ohnehin an der Einzelkernleistung.
- **Nicht alle Server laufen gleichzeitig.** Das Panel kann zwischen vergebenem und tatsächlich laufendem RAM unterscheiden und beides anzeigen – das erlaubt mehr Server, ohne das harte Limit aufzuweichen.
- **Festplatte wird unterschätzt.** Ein ARK-ASA-Server mit Mods und Backups belegt schnell 150 GB. Der Rechner sollte Speicherplatz genauso vorrechnen wie RAM.

### Zum eigenen Host

Bei begrenztem Arbeitsspeicher bedeutet das praktisch: entweder ein großer ARK-ASA- oder Palworld-Server, oder vier bis fünf Minecraft- und CS2-Server. Beides zusammen geht nicht – und genau diese Rechnung soll das Panel dem Nutzer abnehmen, bevor er den Server anlegt.

## Statistik-Seite

Zwei Ebenen: eine Statistik pro Server für den Besitzer und eine Gesamtübersicht für den Admin.

### Pro Server

| Kennzahl | Quelle | Darstellung |
| --- | --- | --- |
| CPU-Auslastung | Docker-Stats | Linie über Zeit, 1 Stunde bis 30 Tage |
| RAM-Verbrauch | Docker-Stats | Linie mit Limit als Referenzlinie |
| Netzwerk ein und aus | Docker-Stats | Linie, zwei Reihen |
| Festplattenbelegung | Volume-Größe, stündlich | Linie plus Anteil am Kontingent |
| Spielerzahl | RCON-Abfrage oder Log | Linie mit Tagesspitzen |
| Verfügbarkeit | Statuswechsel | Prozentwert und Balken je Tag |
| Abstürze | Crash-Zähler | Balken je Tag, Sprung ins Log |
| Tickrate oder TPS | Spielkonsole, wo verfügbar | Linie, Minecraft und Rust |
| Startdauer | Zeit bis Done-Regex | Balken je Start |

### Gesamtübersicht für den Admin

- Belegter gegen freien RAM auf dem Host, vergeben gegen tatsächlich laufend
- Anzahl Server nach Status und nach Spiel
- Top-Verbraucher: welche fünf Server ziehen die meiste CPU, den meisten Speicher, den meisten Platz
- Backup-Lage: Größe gesamt, letzter Lauf, fehlgeschlagene Jobs
- Aktive Nutzer und Anmeldungen der letzten Tage
- Netzwerkdurchsatz des Hosts

### Datenerfassung

Ein Sammler im Backend liest alle 10 Sekunden die Docker-Statistiken und schreibt sie weg. Rohdaten in dieser Auflösung nur 48 Stunden halten, danach verdichten:

| Alter | Auflösung |
| --- | --- |
| bis 48 Stunden | 10 Sekunden |
| bis 14 Tage | 1 Minute |
| bis 90 Tage | 5 Minuten |
| darüber | 1 Stunde |

Ohne diese Verdichtung wächst die Tabelle bei zehn Servern um mehrere Millionen Zeilen im Monat. Umsetzung entweder mit TimescaleDB als Postgres-Erweiterung oder mit einem eigenen Verdichtungs-Job – für ein Homelab reicht der eigene Job.

### Darstellung

Zeitraumwahl als Leiste (1 h, 6 h, 24 h, 7 d, 30 d), alle Diagramme der Seite folgen derselben Auswahl. Beim Überfahren eine gemeinsame Hilfslinie über alle Diagramme, damit sich Werte zum selben Zeitpunkt vergleichen lassen. Statuswechsel und Neustarts als senkrechte Markierungen in den Verlauf einzeichnen – so wird auf einen Blick sichtbar, dass die Speicherkurve nach jedem Neustart von vorn beginnt.

Export als CSV und ein Prometheus-Endpunkt für alle, die das lieber in Grafana ansehen.

## Themes und Gestaltung

Das Theme-System kostet wenig, wenn es von Anfang an steht, und ist später mühsam nachzurüsten.

### Grundlage

Alle Farben als CSS-Variablen auf `:root`, nirgends ein fester Farbwert im Code:

```css
:root {
  --bg-base: #0f1115;
  --bg-raised: #171a21;
  --border: #262b36;
  --text-primary: #e6e8ec;
  --text-muted: #9aa1ad;
  --accent: #4f7cff;
  --status-running: #3fb950;
  --status-offline: #6e7681;
  --status-starting: #d29922;
  --status-crashed: #f85149;
  --radius: 8px;
}
```

Ein Theme ist dann nur eine Wertetabelle. Umschalten heißt, ein Attribut am `html`-Element zu setzen – kein Neuladen, keine zweite Stylesheet-Datei.

### Mitgelieferte Themes

| Theme | Charakter |
| --- | --- |
| Dunkel | Standard, ruhiges Blaugrau |
| Hell | Für helle Räume und Beamer |
| Mitternacht | Fast schwarz, für OLED-Displays |
| Kontrast | Hohe Kontraste, dicke Rahmen, für schlechte Sicht |
| Terminal | Monospace-Schrift, Grün auf Schwarz |
| Nach System | Folgt der Einstellung des Betriebssystems |

### Eigene Themes

- Akzentfarbe frei wählbar, der Rest wird daraus abgeleitet
- Vollständiger Theme-Editor mit Vorschau, Export und Import als JSON
- Pro Nutzer gespeichert, nicht global – jeder sieht sein eigenes
- Ein Panel-weites Standard-Theme, das der Admin setzt
- Schriftgröße und Dichte (normal, kompakt) getrennt vom Theme einstellbar

### Barrierefreiheit

Status nie allein über Farbe – immer zusätzlich Text oder Symbol. Kontrast mindestens 4,5 zu 1 für Text; der Theme-Editor sollte den Wert direkt anzeigen und bei Unterschreitung warnen. `prefers-reduced-motion` beachten und Animationen abschalten. Vollständige Tastaturbedienung mit sichtbarem Fokusring.

## Mobil und Tablet

Der typische Fall unterwegs ist nicht „Server einrichten“, sondern „schnell nachsehen, ob er läuft, und notfalls neu starten“. Danach richtet sich, was auf kleinen Bildschirmen Vorrang hat.

| Ansicht | Handy | Tablet | Desktop |
| --- | --- | --- | --- |
| Serverliste | Karten untereinander, Status groß | Zweispaltig | Tabelle oder Karten |
| Power-Knöpfe | Voll bedienbar | Voll | Voll |
| Konsole | Lesen und kurze Befehle | Voll | Voll |
| Statistik | Zwei Diagramme, gestapelt | Alle, zweispaltig | Alle |
| Dateimanager | Nur Liste, Ansehen und Löschen | Fast voll, Upload per Auswahl | Voll mit Drag-and-Drop |
| Konfigurations-Formular | Voll | Voll | Voll |
| Mod-Verwaltung | Liste, an- und abschalten | Voll | Voll |
| Erstellungsdialog | Möglich, aber unbequem | Gut | Gut |
| Admin-Bereich | Nur Lesen | Voll | Voll |

### Anpassungen fürs Handy

- Untere Navigationsleiste statt Seitenleiste: Server, Konsole, Dateien, Mehr
- Berührungsflächen mindestens 44 Pixel, Abstände größer als am Desktop
- Wischgesten in der Serverliste: nach rechts starten, nach links stoppen – mit Bestätigung
- Konsole im Querformat mit kleinerer Schrift, Befehlszeile über der Tastatur fixiert
- Häufige Befehle als antippbare Schaltflächen über der Tastatur (`list`, `save-all`, `stop`), damit niemand auf dem Handy lange Befehle tippt
- Diagramme ohne Überfahren bedienbar: antippen zeigt den Wert
- Pull-to-Refresh in der Serverliste

### Tablet

Der Zwischenbereich wird oft vergessen. Ab etwa 768 Pixel Breite lohnt eine zweispaltige Ansicht: links die Serverliste, rechts die geöffnete Konsole. Das ist auf einem Tablet im Querformat die angenehmste Art, mehrere Server im Blick zu behalten. Im Hochformat zurück auf eine Spalte.

### Technisch

- Breakpoints bei 480, 768, 1024 und 1440 Pixel
- Dateimanager-Drag-and-Drop nur ab 1024 anbieten, darunter ein Hochladen-Knopf – Ziehen auf Touch ist unzuverlässig
- WebSocket bei Hintergrundwechsel trennen und beim Zurückkehren neu verbinden, sonst leert sich der Akku
- Virtualisierte Listen ab etwa 50 Servern, sonst ruckelt das Scrollen auf älteren Geräten

## Apps für alle Plattformen

Möglich ist alles, aber der Aufwand unterscheidet sich stark. Die Reihenfolge unten ist die, die sich lohnt.

| Weg | Plattformen | Aufwand | Was dazukommt |
| --- | --- | --- | --- |
| PWA | Alle | Sehr gering | Installierbar, eigenes Fenster, Icon, Offline-Schale, Web-Push |
| Tauri | Windows, macOS, Linux | Gering | Echtes Programm, Autostart, Tray-Symbol, native Benachrichtigungen |
| Capacitor | Android, iOS | Mittel | App Store, native Push, Biometrie-Login |
| Electron | Desktop | Gering | Wie Tauri, aber 100+ MB pro Installation |
| Nativ (Swift, Kotlin) | Je eine | Hoch | Beste Integration, dreifache Pflege |

### Empfehlung

**Zuerst PWA.** Eine gute mobile Weboberfläche plus Manifest und Service Worker ergibt auf Android und Desktop eine installierbare App ohne zweite Codebasis. Auf dem iPhone funktioniert das über „Zum Home-Bildschirm“ ebenfalls, inzwischen auch mit Web-Push.

**Dann Tauri für den Desktop.** Dieselbe Weboberfläche in einer schlanken Hülle, ein Installer je Betriebssystem, unter 10 MB. Der Mehrwert liegt in den Kleinigkeiten: Tray-Symbol mit Serverstatus, Benachrichtigung bei Absturz, Autostart.

**Capacitor nur, wenn es wirklich gebraucht wird.** Lohnt sich vor allem wegen zuverlässiger Push-Nachrichten auf iOS und Fingerabdruck-Login. Dafür kommen Store-Konten, Signierung und Review-Prozesse dazu – bei einem privaten Panel oft mehr Last als Nutzen.

### Was die App-Hülle anbieten sollte

- Benachrichtigung bei Absturz, fehlgeschlagenem Backup und abgeschlossener Installation
- Schnellaktionen von außen: lange auf das Icon drücken → Lieblingsserver starten
- Tray oder Menüleiste mit Statuspunkt je Server
- Angemeldet bleiben über den Refresh-Token, mit Biometrie als Schutz

### Voraussetzung für alles

Die API muss vollständig und sauber dokumentiert sein, bevor eine App Sinn ergibt. Jede Hülle ist nur ein Client. Wer die API ordentlich baut, kann später jede Plattform bedienen – und auch Dritte können eigene Werkzeuge anbinden, etwa einen Discord-Bot, der den Serverstatus meldet.

## Ereignis-Zeitachse

Das ist die Funktion, die ein Panel von einem Startknopf unterscheidet: Ein Ausschlag im Graph muss anklickbar sein und erklären, was zu diesem Zeitpunkt passiert ist.

&#91;embedded content: Ereignis-Pipeline · drei Quellen, zwei Speicher, eine Zeitachse\]

### Die zentrale Tabelle

Alles, was je passiert, landet in einer einzigen Ereignistabelle – unabhängig davon, ob es aus dem Log, aus dem Panel oder aus einer Schwellwertüberwachung stammt.

```sql
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  server_id  UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts         TIMESTAMPTZ NOT NULL,
  kind       TEXT NOT NULL,
     -- status_change | crash | restart_attempt | restart_skipped
     -- backup_start | backup_done | backup_failed
     -- player_join | player_leave | command | config_change
     -- mod_change | update_applied | threshold_breach | install_done
  severity   TEXT NOT NULL DEFAULT 'info',   -- info | warn | error
  actor_id   UUID REFERENCES users(id),      -- NULL = vom System ausgelöst
  summary    TEXT NOT NULL,                  -- eine Zeile für die Zeitachse
  payload    JSONB,                          -- Details, je nach kind
  log_file   TEXT,                           -- Datei, in der es steht
  log_offset BIGINT,                         -- Byte-Position für den Sprung
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON events (server_id, ts DESC);
CREATE INDEX ON events (server_id, kind, ts DESC);
```

**Der Trick sind `log_file` und `log_offset`.** Die Logs bleiben als Dateien liegen – in die Datenbank wandert nur der Zeiger darauf. Ein Klick auf ein Ereignis öffnet die Logdatei an genau dieser Stelle. Die Datenbank bleibt klein, und trotzdem führt jeder Punkt im Graph direkt zur passenden Zeile.

### Der Log-Watcher

Jedes Egg bringt Muster mit, nach denen im Logstrom gesucht wird:

```json
"watchers": [
  { "kind": "player_join",
    "regex": "^\\[(?<time>[^\\]]+)\\] .*?: (?<player>\\w+)\\[/(?<ip>[0-9.]+):\\d+\\] logged in" },
  { "kind": "player_leave",
    "regex": "^\\[(?<time>[^\\]]+)\\] .*?: (?<player>\\w+) lost connection: (?<reason>.*)$" },
  { "kind": "crash", "severity": "error",
    "regex": "(java\\.lang\\.OutOfMemoryError|Fatal error|---- Minecraft Crash Report)" },
  { "kind": "lag_warning", "severity": "warn",
    "regex": "Can't keep up! Is the server overloaded\\? Running (?<ms>\\d+)ms" }
]
```

So kommen neue Spiele ohne Codeänderung dazu. Der Watcher läuft im selben Datenstrom wie die Konsole, kostet also keine zusätzliche Datei-Leserei.

### Schwellwerte

Eine Überwachung schreibt selbst Ereignisse, damit auffällige Stellen im Graph markiert sind:

- CPU über 90 Prozent für mehr als 5 Minuten
- RAM über 95 Prozent des Limits
- Festplatte über 90 Prozent des Kontingents
- Keine Spieler seit 14 Tagen (Hinweis zum Abschalten)
- TPS unter 15 bei Minecraft

### Die Ansicht

Klick auf einen Punkt im Diagramm öffnet seitlich ein Fenster mit dem gewählten Zeitpunkt. Darin:

1. **Ereignisse im Umkreis von fünf Minuten**, nach Zeit sortiert, mit Symbol und Schweregrad
2. **Messwerte zum Zeitpunkt**: CPU, RAM, Netz, Spielerzahl
3. **Logausschnitt**: zwanzig Zeilen vor und nach dem Ereignis, direkt aus der Datei gelesen
4. **Weiterlesen** springt in die vollständige Logdatei an diese Stelle

Ereignisse werden zusätzlich als senkrechte Markierungen in die Diagramme gezeichnet: rot für Abstürze, grau für Neustarts, blau für Backups. Damit sieht man den Zusammenhang schon vor dem ersten Klick.

### Dein Beispiel, konkret

Am 10.10. um 11:00 Uhr steht die CPU auf 110 Prozent, danach auf 0. Die Zeitachse zeigt für dieses Fenster:

| Zeit | Ereignis |
| --- | --- |
| 10:58 | `threshold_breach` – CPU seit 5 Minuten über 90 Prozent |
| 11:01 | `lag_warning` – Server kann nicht mithalten, 8400 ms |
| 11:02 | `crash` – OutOfMemoryError, Sprung ins Log |
| 11:02 | `restart_skipped` – kein automatischer Neustart, weil `auto_restart` ausgeschaltet ist |

Genau die letzte Zeile ist der Punkt, der sonst fehlt: Das Panel protokolliert nicht nur, dass nichts passiert ist, sondern auch **warum** nicht. Jeder unterlassene Neustart bekommt einen Grund – ausgeschaltet, Absturzgrenze erreicht, Server gesperrt oder Update lief. Sonst steht man vor einem toten Server und sieht nur, dass nichts geschehen ist.

## Spieler-Verfolgung

Wer war wann drauf, wie lange, von wo – und welches Ereignis hängt an welchem Spieler.

### Woher die Daten kommen

| Spiel | Quelle | Enthält IP |
| --- | --- | --- |
| Minecraft | Logzeile beim Verbinden | Ja |
| Rust, 7 Days to Die | Konsolenausgabe | Ja |
| ARK, Palworld | RCON-Abfrage der Spielerliste | Nein, nur Name und ID |
| CS2 | `status`-Befehl per RCON | Ja |
| Valheim | Logdatei | Teilweise |
| Allgemein | Steam-Query-Protokoll (A2S) | Nein, nur Anzahl und Namen |

Für Spiele ohne IP im Log bleibt die Spielerliste per RCON im Minutentakt – das reicht für Sitzungsdauer und Spielerzahl, nur eben ohne Herkunft.

### Sitzungen statt Einzelereignissen

Die Ereignisse `player_join` und `player_leave` werden zu Sitzungen zusammengeführt:

```sql
CREATE TABLE player_sessions (
  id          BIGSERIAL PRIMARY KEY,
  server_id   UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  player_name TEXT NOT NULL,
  player_uid  TEXT,                 -- UUID, SteamID, je nach Spiel
  ip          INET,
  country     TEXT,                 -- ISO-Code aus der lokalen Datenbank
  joined_at   TIMESTAMPTZ NOT NULL,
  left_at     TIMESTAMPTZ,
  leave_reason TEXT
);
CREATE INDEX ON player_sessions (server_id, joined_at DESC);
CREATE INDEX ON player_sessions (player_uid);
```

Eine offene Sitzung ohne `left_at` ist ein Spieler, der gerade online ist. Stürzt der Server ab, werden alle offenen Sitzungen mit dem Absturzzeitpunkt und dem Grund `server_crash` geschlossen – sonst steht in der Statistik ein Spieler, der seit drei Wochen online ist.

### Herkunft bestimmen

**Lokale Datenbank, kein externer Dienst.** Eine kostenlose Offline-Datenbank wie GeoLite2 oder DB-IP Lite wird einmal im Monat aktualisiert und lokal abgefragt. Gründe: keine Abfragegrenzen, keine Verzögerung, und vor allem werden keine IP-Adressen deiner Spieler an einen fremden Dienst geschickt.

Genauigkeit ehrlich darstellen: Land ist meist richtig, Stadt oft nicht, und bei VPN-Nutzern ist beides falsch. Die Oberfläche sollte deshalb Land und grobe Region zeigen, keine Kartennadel auf eine Straße.

### Was die Spieleransicht zeigt

- Aktuell online mit Spieldauer der laufenden Sitzung
- Verlauf: letzte Sitzungen mit Dauer, Herkunftsland, Verbindungsende
- Pro Spieler: Gesamtspielzeit, erste und letzte Sitzung, genutzte IP-Adressen
- Spielerzahl im Zeitverlauf, als Linie neben CPU und RAM
- Verbindung zur Zeitachse: Klick auf eine Sitzung springt in den Logausschnitt
- Schnellaktionen, wo RCON es hergibt: Kicken, Bannen, Nachricht senden

### Datenschutz – besonders wichtig vor der Veröffentlichung

IP-Adressen sind nach DSGVO personenbezogene Daten. Sobald andere Leute dein Panel betreiben, hängt an diesen Entscheidungen ihre Rechtslage:

- **Aufbewahrung begrenzen.** Standard 30 Tage für IP-Adressen, danach automatisch löschen. Sitzungsdaten ohne IP dürfen länger bleiben.
- **Anonymisierung anbieten.** Ein Schalter, der das letzte Oktett entfernt (`192.168.178.0`). Für Statistik reicht das, für Missbrauchsabwehr nicht – der Betreiber entscheidet.
- **Ganz abschaltbar machen.** Wer keine IPs speichern will, schaltet die Erfassung aus, und das Panel funktioniert weiterhin.
- **Zugriff beschränken.** IP und Herkunft nur für Besitzer und Admin, nicht für Subuser mit `control.console`. Ein eigenes Recht `player.ip_read` ist sauberer.
- **Im Audit-Log festhalten**, wer Spieler-IPs eingesehen hat.
- **In der Dokumentation benennen**, welche personenbezogenen Daten anfallen und wie lange sie bleiben. Das ist für ein veröffentlichtes Projekt kein Beiwerk, sondern das, was Betreiber brauchen.

### Was bewusst nicht gemacht wird

Keine Verknüpfung von Spielerprofilen über mehrere Server hinweg zu einem Gesamtprofil, keine Weitergabe an externe Dienste, keine Standortkarte auf Hausnummernebene. Das Ziel ist Nachvollziehbarkeit beim Betrieb, nicht Überwachung.

## Performance

Ein Panel bricht nicht beim zehnten Server ein, sondern an fünf konkreten Stellen. Alle fünf lassen sich von Anfang an richtig bauen.

| Engpass | Was passiert | Lösung |
| --- | --- | --- |
| Ein Attach pro Browser-Tab | Drei offene Tabs = drei Log-Streams pro Server, die Engine-API wird langsam | Ein Attach je Server, intern verteilen |
| Metriken einzeln schreiben | 10 Server mal 6 Werte alle 10 Sekunden = Dauerlast auf der Datenbank | Im Speicher sammeln, einmal pro Minute als Stapel schreiben |
| Rechte pro Anfrage neu laden | Jeder Tastendruck in der Konsole erzeugt eine Datenbankabfrage | In Redis zwischenspeichern, 60 Sekunden, bei Änderung sofort verwerfen |
| Langsame WebSocket-Clients | Ein Handy im schlechten Netz bremst den ganzen Verteiler aus | Begrenzter Puffer je Client, bei Überlauf Statistiken überspringen und trennen |
| Logs neu einlesen | Jede Aktualisierung liest die ganze Datei | Position merken und nur Neues lesen |

### Weitere Punkte

- **Statistiken zusammenfassen statt durchreichen.** Der Stats-Stream von Docker liefert mehrmals pro Sekunde; eine Nachricht pro Sekunde an die Oberfläche genügt.
- **Serverliste in einer Abfrage.** Status, Besitzer und Spielerzahl für 80 Server in einem SQL-Statement, nicht eine Abfrage je Zeile.
- **Ein WebSocket für die Liste.** Nicht einer je Karte – der Browser begrenzt gleichzeitige Verbindungen.
- **Lange Operationen als Job.** Backup, Installation, Packen, Umzug laufen im Hintergrund mit Fortschritt über WebSocket, niemals in der HTTP-Anfrage.
- **Dateilisten begrenzen.** Ein Ordner mit 30 000 Chunk-Dateien darf das Panel nicht lahmlegen: seitenweise laden, ab 1000 Einträgen Hinweis.
- **Virtualisierte Listen** ab etwa 50 Zeilen im Frontend.
- **Indizes setzen**, bevor es langsam wird: `events(server_id, ts DESC)`, `metrics(server_id, ts DESC)`, `audit_log(server_id, created_at DESC)`, `player_sessions(server_id, joined_at DESC)`.
- **Alte Daten wegräumen.** Ein nächtlicher Job für Metrik-Verdichtung, Ereignis- und Log-Aufbewahrung. Ohne ihn wird die Datenbank nach einem halben Jahr zum Problem.

### Richtwerte

Mit diesen Maßnahmen trägt ein Go-Backend auf einem normalen Homelab-Host 30 bis 50 gleichzeitig laufende Server und einige Dutzend gleichzeitige Nutzer, ohne dass das Panel selbst nennenswert Last erzeugt. Die Grenze liegt praktisch immer beim RAM der Spielserver, nicht beim Panel.

## Nicht nachträglich änderbar

Das Wichtigste an diesem Dokument. Diese Punkte lassen sich später nur mit einem Umbau korrigieren, der größer ist als die ursprüngliche Arbeit. Alles andere darf ruhig erst einmal schlecht sein.

| Entscheidung | Richtig von Anfang an | Was sonst passiert |
| --- | --- | --- |
| Schlüssel | UUIDs, nicht fortlaufende Zahlen | Beim Zusammenführen zweier Panels kollidieren alle IDs |
| Zeitstempel | `TIMESTAMPTZ`, intern immer UTC, erst in der Oberfläche umgerechnet | Zeitachse und Logs passen nach der Zeitumstellung nicht mehr zusammen |
| Rechte | Flag-Liste je Server | Fixe Rollen lassen sich nicht in Flags zerlegen, ohne jede Prüfung anzufassen |
| Node-Bezug | `node_id` an jedem Server, auch bei einem Host | Multi-Node nachträglich bedeutet jede Abfrage und jeden Pfad anfassen |
| Ports | Eigene `allocations`-Tabelle | Ein Port-Feld am Server macht Mehrfachports und Umzüge unmöglich |
| Ereignisse | Eine `events`-Tabelle von Tag eins | Eine Zeitachse lässt sich nicht rückwirkend füllen – die Vergangenheit fehlt für immer |
| Docker-Zugriff | Hinter einem Interface, nicht direkt im Handler | Der Daemon für den zweiten Host zieht sich sonst durch die ganze Anwendung |
| API | `/api/v1/` ab der ersten Zeile | Eine veröffentlichte API ohne Version kann man nicht ändern, ohne fremde Werkzeuge zu brechen |
| Spielspezifisches | Im Egg, nie im Code | Jedes neue Spiel wäre sonst eine Codeänderung samt Release |
| Texte | Von Anfang an über Sprachschlüssel | Hunderte fest eingebaute Strings nachträglich herauszuziehen ist stumpfe Arbeit |
| Dateipfade | Über `short_id`, nie über den Servernamen | Umbenennen bricht sonst Volumes, Backups und SFTP |
| Gelöschtes | Audit-Log bleibt, auch wenn Server und Nutzer verschwinden | Mit `ON DELETE CASCADE` am Audit-Log löscht sich der Beweis mit |
| Geheimnisse | Nie in der Datenbank im Klartext, Schlüssel aus der Umgebung | Ein veröffentlichtes Projekt mit Klartext-Token ist nicht reparierbar |
| Migrationen | Versioniert ab der ersten Tabelle | Ohne sie ist jedes Update bei fremden Betreibern Handarbeit |

### Drei Trennlinien im Code

Wenn diese drei Grenzen sauber sind, lässt sich fast alles andere später ersetzen:

1. **Oberfläche spricht nur mit der API.** Keine Logik im Frontend, die das Backend nicht auch kennt. Dann sind PWA, Desktop-Hülle und fremde Werkzeuge nur weitere Clients.
2. **API spricht nur mit Diensten, nie direkt mit Docker oder dem Dateisystem.** Ein Handler ruft `serverService.Start(ctx, id)` auf. Ob dahinter ein lokaler Socket oder ein entfernter Daemon steckt, ist seine Sache nicht.
3. **Spielwissen steckt ausschließlich in Eggs.** Startkommandos, Stop-Verhalten, Log-Muster, Konfigurationsschemata, Ressourcen-Richtwerte. Im Code steht nur, wie ein Egg gelesen wird.

### Was ruhig erst einmal grob sein darf

Die Gestaltung, die Zahl der Themes, der Dateimanager, Backups auf externe Ziele, Benachrichtigungen, Statistik-Diagramme, Mod-Verwaltung – das alles lässt sich jederzeit austauschen oder erweitern, ohne das Fundament zu berühren. Zeit gehört in die Tabelle oben, nicht in das zweite Theme.

## Veröffentlichung auf GitHub

Ein Gameserver-Panel ist sicherheitskritische Software: Wer es betreibt, lässt fremden Code auf seinem Rechner laufen. Das ändert, was vor der Veröffentlichung stehen muss.

### Lizenz

| Lizenz | Bedeutet | Passt wenn |
| --- | --- | --- |
| MIT | Jeder darf alles, auch geschlossen weiterverkaufen | Größtmögliche Verbreitung ist das Ziel |
| Apache 2.0 | Wie MIT, zusätzlich Patentschutz und Namensschutz | Dasselbe, nur etwas vorsichtiger |
| AGPL 3.0 | Wer es als Dienst anbietet, muss seine Änderungen offenlegen | Kein Hoster soll eine geschlossene Version daraus machen |

Für ein Panel, das andere als Hosting-Grundlage nehmen könnten, ist AGPL die übliche Wahl. Wichtig: Die Lizenz steht ab dem ersten öffentlichen Commit fest – später restriktiver zu werden, geht nur mit Zustimmung aller Beitragenden.

### Vor dem ersten Push

- [ ] `.env` und alle Schlüssel aus dem Verlauf entfernen – nicht nur aus dem letzten Stand. Ein einmal gepushtes Token gilt als verbrannt und muss ersetzt werden
- [ ] `.env.example` mit allen Variablen und Erklärung, ohne Werte
- [ ] Keine echten Domains, IPs oder Pfade in Beispielen
- [ ] Schlüssel beim ersten Start erzeugen, nicht mitliefern – kein Standard-Passwort im Repo
- [ ] Lizenzdatei und Urheberzeile
- [ ] `SECURITY.md` mit Kontaktweg für Sicherheitslücken und der Bitte, sie nicht als öffentliches Issue zu melden
- [ ] Ehrlicher Hinweis in der README, dass es sich um ein junges Projekt handelt und wo es noch nicht sicher ist

### Was die README enthalten muss

Installation per Docker-Compose in zehn Zeilen, Anforderungen, erste Schritte bis zum ersten laufenden Server, wie Eggs importiert werden, Hinweise zu Ports und Firewall, welche personenbezogenen Daten anfallen, und eine klare Abgrenzung: wobei das Panel hilft und wobei nicht.

Ein Bild sagt hier mehr als zwei Absätze – Bildschirmfotos der Serverliste und der Konsole gehören ganz nach oben.

### Technische Voraussetzungen für fremde Betreiber

- **Migrationen, die nie rückwärts brechen.** Ein Update darf beim Fremdbetreiber niemals Handarbeit erfordern
- **Semantische Versionen** und ein Changelog, der Breaking Changes deutlich markiert
- **Fertige Container-Images** je Release, mehrarchitektur, damit es auch auf einem ARM-Rechner läuft
- **CI**: Bauen, Tests, Linter bei jedem Pull Request; Release-Images nur aus einem Tag
- **Abhängigkeiten prüfen** lassen (Dependabot oder Ähnliches) – bei sicherheitskritischer Software nicht optional
- **Ein Demo-Modus oder Bildschirmfotos**, damit niemand zum Ausprobieren erst einen Server aufsetzen muss

### Beiträge

`CONTRIBUTING.md` mit Entwicklungsaufbau, Code-Stil und dem Hinweis, dass Eggs als eigene Pull Requests kommen sollen. Issue-Vorlagen für Fehler, Wunsch und neues Egg. Und eine Entscheidung, die du dir vorher überlegen solltest: Nimmst du fremde Eggs ins Hauptrepo auf, oder bleibt das eine getrennte Sammlung? Getrennt ist meist ruhiger.

### Realistische Erwartung

Die meisten veröffentlichten Panels bekommen wenige Sterne und kaum Beiträge – das ist normal und kein Maßstab. Der eigentliche Gewinn ist, dass fremde Augen Fehler finden, die man selbst nie sieht. Deshalb lohnt die Veröffentlichung auch dann, wenn nie jemand einen Pull Request schickt.

## AMP-Import

Ein eigener Assistent, der bestehende AMP-Instanzen übernimmt. Technisch gut machbar, aber nur halb automatisch – und genau das muss der Assistent offen sagen.

### Wo AMP seine Daten ablegt

AMP legt alles unter dem Datenverzeichnis des AMP-Benutzers ab, üblicherweise `/home/amp/.ampdata/`:

| Pfad | Inhalt |
| --- | --- |
| `.ampdata/instances/<Name>/` | Eine Instanz, ihre Konfiguration und ihr Zustand |
| `.ampdata/instances/<Name>/AMPConfig.conf` | Haupteinstellungen als Schlüssel-Wert-Paare |
| `.ampdata/instances/<Name>/<Modul>.kvp` | Modulspezifische Einstellungen, etwa für Minecraft |
| `.ampdata/instances/<Name>/Minecraft/` oder `.../<Name>/` | Die eigentlichen Spieldateien, Welten, Plugins, Mods |
| `.ampdata/instances/<Name>/Backups/` | AMP-eigene Sicherungen |

Die Konfigurationsdateien sind einfache Textdateien mit Zeilen der Form `Bereich.Schlüssel=Wert` – gut mit einem kleinen Parser zu lesen. Welche Schlüssel genau vorkommen, hängt von AMP-Version und Modul ab, deshalb darf der Importer sich auf keine feste Liste verlassen, sondern liest alles ein und sucht gezielt nach dem, was er braucht.

Außerdem gibt es das Verwaltungswerkzeug `ampinstmgr`, mit dem sich die vorhandenen Instanzen auflisten lassen. Das ist der bequemere Weg, um überhaupt erst zu erfahren, was auf dem Rechner existiert.

### Ablauf des Assistenten

1. **Finden** – Pfad zum `.ampdata`-Verzeichnis angeben oder automatisch suchen. Der Importer listet alle Instanzen mit Name, Modul, belegtem Port und Größe auf.
2. **Zuordnen** – Zu jeder Instanz schlägt das Panel ein passendes Egg vor: AMP-Modul `Minecraft` mit einer Paper-Jar wird zum Paper-Egg, `GenericModule` mit SteamCMD-Angaben zum passenden Steam-Egg. Der Vorschlag ist eine Vermutung und muss bestätigt werden.
3. **Werte übernehmen** – Aus der AMP-Konfiguration liest der Importer, was sich eindeutig abbilden lässt: Servername, Spielerzahl, RAM-Zuteilung, Ports, Jar-Datei oder Steam-AppID.
4. **Vorschau** – Eine Tabelle zeigt pro Instanz: erkanntes Spiel, gewähltes Egg, übernommene Werte, Größe der Spieldaten und was **nicht** übernommen werden konnte.
5. **Kopieren** – Die Spieldateien werden mit `rsync` in das neue Volume gespiegelt, mit Fortschrittsanzeige. Die AMP-Instanz bleibt unangetastet.
6. **Probestart** – Der neue Server startet einmal, das Log wird mitgelesen. Erst danach gilt der Import als gelungen.

### Was übernommen wird und was nicht

| Bereich | Übernahme |
| --- | --- |
| Welten und Spielstände | Vollständig – das sind reine Dateien |
| Plugins und Mods | Vollständig, als Dateien |
| Spielkonfiguration (`server.properties`, INI-Dateien) | Vollständig |
| Ports und RAM | Als Startwerte, danach vom Panel verwaltet |
| AMP-Benutzer und deren Rechte | Nicht – das Rechtemodell ist ein anderes, Nutzer werden neu angelegt |
| AMP-Zeitpläne und Trigger | Nicht automatisch, werden in der Vorschau aufgelistet, damit man sie nachbaut |
| AMP-eigene Backups | Als Dateien kopierbar, aber nicht als Panel-Backups wiederherstellbar |
| AMP-Templates | Gar nicht – sie beschreiben AMPs Laufzeit, nicht die des Panels |

### Fallstricke

- **Rechte und Besitzer.** Die Dateien gehören dem AMP-Benutzer. Nach dem Kopieren muss der Besitzer auf den Container-Benutzer gesetzt werden, sonst startet der Server nicht und die Fehlermeldung ist nichtssagend.
- **Nie gleichzeitig laufen lassen.** Dieselbe Welt in AMP und im neuen Panel gleichzeitig zu starten beschädigt den Spielstand. Der Assistent sollte anbieten, die AMP-Instanz danach zu deaktivieren.
- **Ports kollidieren.** Läuft AMP noch, sind die alten Ports belegt. Der Importer vergibt neue und zeigt die neue Verbindungsadresse deutlich an.
- **Große Instanzen.** Eine ARK-Instanz mit Mods kann 100 GB haben. Zweistufiges `rsync` wie beim Node-Umzug: einmal im laufenden Betrieb, einmal nach dem Stoppen für die Differenz.
- **Schlüsselnamen ändern sich.** Zwischen AMP-Versionen heißen Einstellungen unterschiedlich. Der Importer sollte unbekannte Schlüssel ignorieren statt abzubrechen – und in der Vorschau nennen, was er nicht verstanden hat.

### Dasselbe für Pterodactyl

Deutlich einfacher, weil die Formate schon passen: Eggs lassen sich direkt importieren, Server und Nutzer über die API auslesen, Volumes aus `/var/lib/pterodactyl/volumes/<uuid>` kopieren. Einzig die Passwörter wandern nicht mit – jeder Nutzer setzt sein Passwort neu.

## Automatische Portvergabe

Der Nutzer soll nie einen Port eintippen. Das Panel vergibt ihn, zeigt ihn an und sorgt dafür, dass er frei ist.

### Portbereich pro Spiel

Jedes Egg bringt seinen Wunschbereich mit. Der erste Minecraft-Server bekommt 25565, der zweite 25566, der dritte 25567 – ohne dass jemand etwas einstellt.

```json
"ports": {
  "primary":   { "name": "Spiel",  "start": 25565, "end": 25664, "protocol": "tcp" },
  "secondary": [
    { "name": "Query", "offset": 0,  "protocol": "udp" },
    { "name": "RCON",  "offset": 10, "protocol": "tcp" }
  ]
}
```

| Spiel | Bereich | Nebenports |
| --- | --- | --- |
| Minecraft Java | 25565–25664 TCP | Query auf demselben Port per UDP, RCON +10 |
| Minecraft Bedrock | 19132–19231 UDP | – |
| Palworld | 8211–8310 UDP | Query 27015+ |
| ARK | 7777–7876 UDP | Query +1, RCON eigener Bereich |
| CS2 | 27015–27114 TCP+UDP | – |
| Valheim | 2456–2555 UDP | +1 und +2 automatisch mitreserviert |
| Rust | 28015–28114 UDP | RCON 28016+ |

### Der Vergabe-Algorithmus

1. Wunschbereich des Eggs auf dem gewählten Node nehmen
2. Den **niedrigsten freien** Port darin suchen – nicht den nächsthöheren nach dem zuletzt vergebenen. So bleiben die Nummern dicht beieinander, auch wenn zwischendurch ein Server gelöscht wurde
3. Prüfen, ob die Nebenports nach ihren Offsets ebenfalls frei sind – sonst weitersuchen, denn ein halb belegtes Portpaar bringt nichts
4. Ist der Bereich voll, auf den allgemeinen Pool ausweichen und im Dialog darauf hinweisen
5. Alle Ports in einer Transaktion reservieren, damit zwei gleichzeitige Erstellungen nicht denselben Port bekommen

### Nicht nur in der Datenbank nachsehen

Der häufigste Fehler bei selbstgebauten Panels: Es wird nur die eigene Tabelle geprüft. Dann vergibt das Panel 25565, während dort schon ein Dienst läuft, der nicht vom Panel stammt – etwa ein alter AMP-Server. Der Container startet, der Port ist belegt, und die Fehlermeldung steht irgendwo tief im Log.

Deshalb vor der Vergabe ein echter Belegungstest auf dem Host: einmal kurz auf den Port binden, und nur wenn das klappt, ihn als frei behandeln. Gesperrte Ports (22, 80, 443, der Panel-Port selbst, alles unter 1024) stehen zusätzlich auf einer Ausschlussliste, die der Admin pflegen kann.

### Anzeige im Dialog

Statt eines Eingabefelds eine ruhige Zeile mit dem Ergebnis:

> **Verbindungsadresse:** `mc.brogameryt.de:25566` · Query 25566/UDP · RCON 25576

Daneben ein Kopier-Knopf und ein kleines „ändern“ für alle, die es doch selbst wissen wollen – dann als Dropdown der freien Ports, nicht als Freitextfeld. Ein Textfeld lädt zu Tippfehlern ein, eine Liste nicht.

### Beim Löschen und Umziehen

- Ports werden beim Löschen des Servers wieder freigegeben, aber mit einer Sperrfrist von ein paar Minuten, damit nicht sofort ein anderer Server die Adresse erbt, die Spieler noch im Launcher stehen haben
- Beim Umzug auf einen anderen Node ändert sich der Port in der Regel. Die alte Adresse bleibt im Panel sieben Tage mit Hinweis sichtbar
- Wird ein Server gesperrt, bleiben seine Ports reserviert – sonst sind sie nach dem Entsperren weg

## Bedienkomfort

Grundregel: **Wo die möglichen Werte bekannt sind, gibt es kein Textfeld.** Jedes Freitextfeld ist eine Gelegenheit für einen Tippfehler, der den Server nicht starten lässt.

### Vom Egg zum Bedienelement

Die Validierungsregel einer Egg-Variable bestimmt, womit sie bedient wird:

| Regel im Egg | Bedienelement |
| --- | --- |
| `in:survival,creative,adventure` | Dropdown mit den drei Werten |
| `boolean` | Schalter |
| `between:1,100` oder \`numeric | min:1 |
| `numeric` ohne Grenzen | Zahlenfeld mit Pfeilen |
| \`required | string |
| Name enthält `password` oder `token` | Maskiertes Feld mit Augensymbol und Zufallsgenerator |
| Verweis auf eine Datei | Auswahl aus den vorhandenen Dateien, kein Pfad zum Tippen |
| Mehrere Werte (Mod-IDs) | Liste mit Hinzufügen und Sortieren, kein Komma-Text |

Damit bekommt jedes neue Spiel automatisch eine ordentliche Oberfläche, ohne dass dafür Code geschrieben wird.

### Dropdowns statt Eingabe, konkret

- Spiel und Variante, mit Suche und Icon
- Version: nur tatsächlich verfügbare Versionen, neueste vorausgewählt, „empfohlen“ markiert
- Java-Version: aus den Images des Eggs, passend zur Spielversion vorgewählt
- RAM: Schieberegler mit Empfehlung aus dem Ressourcen-Rechner
- Zeitpläne: Voreinstellungen wie „täglich 4 Uhr“ statt Cron-Syntax, mit Umschalter auf Cron für Fortgeschrittene
- Rechte: Preset wählen, danach einzelne Haken anpassen
- Backup-Aufbewahrung: „die letzten 3 / 5 / 10 behalten“
- Theme, Sprache, Zeitzone

### Weniger auf einmal zeigen

Im Erstellungsdialog nur, was wirklich gebraucht wird: Name, Spiel, Version, RAM, Spielerzahl. Alles andere steht vorausgefüllt unter „Erweiterte Einstellungen“, eingeklappt. Wer nichts anfasst, bekommt einen funktionierenden Server – das ist der Maßstab.

### Kleinigkeiten, die den Unterschied machen

- Jede Einstellung hat einen Hilfetext aus dem Egg, als Fragezeichen daneben
- Ungültige Eingaben sofort markieren, nicht erst beim Speichern
- Nie ohne Grund blockieren: wenn ein Wert nicht geht, danebenschreiben warum
- Standardwerte sichtbar machen („Standard: 20“) und ein „zurücksetzen“ je Feld
- Gefährliche Aktionen (Neuinstallation, Löschen) verlangen das Eintippen des Servernamens – das ist die eine Stelle, an der ein Textfeld richtig ist
- Nach dem Erstellen direkt in die Konsole springen, damit man die Installation mitlesen kann

## Benachrichtigungen und Auslöser

Die `events`-Tabelle liefert die Ereignisse, der Regelbaukasten macht etwas daraus. Jede Regel ist ein Satz, den man in der Oberfläche aus Dropdowns zusammenklickt:

> **Wenn** `Absturz` **auf** `Minecraft SMP` **dann** `Discord-Nachricht` **und** `Server neu starten`

### Bedingungen

| Bedingung | Zusatzangabe |
| --- | --- |
| Server abgestürzt | – |
| Server offline länger als | Minuten |
| Start fehlgeschlagen | – |
| Backup fehlgeschlagen | – |
| Backup fertig | – |
| CPU über Schwelle | Prozent, Dauer |
| RAM über Schwelle | Prozent, Dauer |
| Festplatte über Schwelle | Prozent |
| Spieler verbindet sich | optional bestimmter Name |
| Erster Spieler online / letzter offline | – |
| Spielerzahl über | Anzahl |
| Keine Spieler seit | Tage |
| Update verfügbar | – |
| Installation abgeschlossen | – |
| Logzeile passt auf Muster | eigener regulärer Ausdruck |

Die letzte Zeile macht den Baukasten offen: Wer ein Spiel hat, das etwas Eigenes ins Log schreibt, baut sich daraus selbst einen Auslöser.

### Aktionen

| Aktion | Bemerkung |
| --- | --- |
| Panel-Benachrichtigung | Glocke in der Oberfläche |
| Push aufs Handy | über die PWA |
| E-Mail |  |
| Discord-Webhook | Mit Serverfarbe und Sprung ins Log |
| Server neu starten | Mit Begrenzung, siehe unten |
| Backup anlegen | Etwa vor jedem Update |
| Konsolenbefehl senden | `say`, `save-all`, eigene Befehle |
| Nachricht an Spieler | Wo RCON es hergibt |
| HTTP-Aufruf | Für alles andere, eigene Weiterverarbeitung |

### Wiederholungsschutz

Der Punkt, an dem solche Systeme meist unbrauchbar werden: Ein Server in der Absturzschleife erzeugt 50 Discord-Nachrichten in zehn Minuten, und danach schaltet man die Benachrichtigungen ganz ab. Dagegen:

- **Abklingzeit pro Regel**, Standard 15 Minuten – dieselbe Regel löst in diesem Zeitraum nur einmal aus
- **Zusammenfassen**: Mehrere gleiche Ereignisse werden zu einer Meldung gebuchelt („Dreimal abgestürzt in 10 Minuten“)
- **Abbruch nach Eskalation**: Nach fünf Auslösungen in einer Stunde pausiert die Regel automatisch und meldet genau das einmal
- **Ruhezeiten** pro Nutzer: zwischen 23 und 8 Uhr nur Fehler, keine Hinweise
- **Entwarnung schicken**, wenn der Zustand vorbei ist – eine Warnung ohne Entwarnung lässt den Empfänger im Ungewissen

### Vorgefertigte Regeln

Frisch angelegte Server bekommen drei Regeln mitgeliefert, die sich abschalten lassen:

1. Absturz → Panel-Benachrichtigung an den Besitzer
2. Backup fehlgeschlagen → Panel-Benachrichtigung
3. Festplatte über 90 Prozent → Panel-Benachrichtigung

Das deckt ab, was man wirklich wissen muss, ohne jemanden mit Meldungen zu überhäufen.

### Datenmodell

```sql
CREATE TABLE notification_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   UUID REFERENCES servers(id) ON DELETE CASCADE, -- NULL = alle Server des Nutzers
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  condition   JSONB NOT NULL,   -- {"kind":"threshold","metric":"cpu","over":90,"minutes":5}
  actions     JSONB NOT NULL,   -- [{"kind":"discord","webhook_id":"…"},{"kind":"restart"}]
  cooldown_s  INT NOT NULL DEFAULT 900,
  quiet_hours INT4RANGE,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  last_fired_at TIMESTAMPTZ,
  fire_count  INT NOT NULL DEFAULT 0
);
```

### Testen

Jede Regel hat einen Knopf „Test auslösen“, der eine Beispielmeldung über alle eingestellten Kanäle schickt. Ohne den merkt man erst beim echten Absturz, dass die Webhook-Adresse einen Tippfehler hatte.
