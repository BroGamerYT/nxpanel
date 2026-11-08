# Egg-Vorlage & Abgleich-Checkliste (NexusPanel)

Mit dieser Vorlage kannst du **jedes Egg aus dem Internet** (z. B. von [pelican-eggs](https://github.com/pelican-eggs) oder Pterodactyl) Punkt für Punkt abgleichen, korrigieren und auf den vollen Funktionsumfang von NexusPanel bringen.

> **Wichtig:** Wenn du eine Beispiel-JSON-Datei anlegst, speichere sie **nicht** als `.json` direkt im Ordner `eggs/`, solange es nur eine Vorlage ist – sonst lädt das Panel sie beim Start als echtes Spiel in die Datenbank und die automatischen Tests (`tests/bundled-eggs.test.ts`) prüfen sie mit!

---

## 1. Das Muster-Egg (Komplett-Exemplar mit allen Feldern)

Hier stehen **alle Felder**, die NexusPanel kennt. Du musst nicht jedes Feld in jedem Egg haben – nimm das als Nachschlagewerk beim Abgleichen:

```jsonc
{
  // ============================================================================
  // 1. GRUNDDATEN & KATEGORIE
  // ============================================================================
  "_comment": "Herkunft, Besonderheiten zum Image oder Lizenzhinweis (z. B. angepasst nach pelican-eggs, MIT).",
  "name": "Beispiel-Spiel",                 // PFLICHT: Eindeutiger Name des Spiels im Panel
  "author": "nxpanel",                      // Optional: Autor der Vorlage
  "nest": "Survival",                       // Kategorie im Panel (z. B. Survival, Shooter, Simulation, Aufbau, Minecraft, Voice, Sonstige)

  // ============================================================================
  // 2. TITELBILD (Cover)
  // ============================================================================
  // WICHTIG BEIM ABGLEICH: In SteamCMD steht oft die Dedicated-Server-AppID (z. B. 2394010 bei Palworld).
  // Hier unter cover.steam muss aber die HAUPTSPIEL-AppID aus dem Steam-Store stehen (z. B. 1623730),
  // weil nur das Hauptspiel im Store ein Header-Banner hat!
  "cover": {
    "steam": 1623730
  },

  // ============================================================================
  // 3. CONTAINER, LAUFZEIT & RECHTE
  // ============================================================================
  // PFLICHT: Mindestens ein Image. Der erste Eintrag ist immer der Standard!
  "docker_images": {
    "Standard (Debian)": "ghcr.io/parkervcp/yolks:debian",
    "Alternativ (Proton)": "ghcr.io/parkervcp/steamcmd:proton"
  },

  // PFLICHT: Startbefehl des Servers.
  // Nutzt das Image seinen eigenen Docker-Entrypoint (wie itzg, cm2network, didstopia),
  // schreibe "/start", "./start.sh" oder "(Einstiegspunkt des Images)".
  "startup": "./ServerBinary -port {{SERVER_PORT}} -queryport {{QUERY_PORT}} -maxplayers {{MAX_PLAYERS}}",

  // Optional: Überschreibt den Entrypoint des Docker-Images (nur nötig, wenn das Image keinen passenden hat)
  "entrypoint": ["/usr/bin/start_server"],

  // Wo liegen die Spieldaten im Container?
  // Standard (wenn weggelassen): "/home/container" (so arbeiten alle Pterodactyl/Pelican-Images).
  // Andere Images brauchen oft eigene Pfade: "/data" (itzg), "/config" (lloesche/wolveix), "/palworld" usw.
  // Verboten sind Systempfade wie /root, /etc, /usr, /bin!
  "data_dir": "/home/container",

  // Als welcher Benutzer (uid:gid) läuft der Container? (Darf NICHT "0:0" oder ein Name sein).
  // Bei ghcr.io/(pelican-eggs|parkervcp|pterodactyl)/* setzt der Import automatisch "1000:1000".
  "run_as": "1000:1000",

  // Linux-Capabilities (Erlaubnisliste: CHOWN, SETUID, SETGID, DAC_OVERRIDE, FOWNER, KILL, NET_BIND_SERVICE).
  // Alles andere wie SYS_ADMIN oder NET_ADMIN wird aus Sicherheitsgründen abgewiesen.
  "capabilities": ["CHOWN", "SETUID", "SETGID", "DAC_OVERRIDE", "FOWNER"],

  // /tmp-Verzeichnis im Container:
  // WICHTIG FÜR WINE / PROTON: Proton entpackt beim ersten Start über 500 MB nach /tmp.
  // Deshalb bei Wine/Proton-Spielen immer "tmp": "disk" setzen (oder { "size_mb": 1024 })!
  "tmp": "disk",

  // ============================================================================
  // 4. KONSOLE, STOP & BEREITSCHAFT (Ready-Check)
  // ============================================================================
  // "full" = Befehle über stdin tippen erlaubt (Standard)
  // "readonly" = Konsole zeigt nur Logs, nimmt keine Befehle an (viele Steam-/Proton-Server)
  // "none" = gar keine Konsole
  "console": "full",

  // Wie wird der Server sauber heruntergefahren?
  // Entweder ein Konsolenbefehl (z. B. "stop", "quit", "exit", "save-and-exit")
  // ODER ein Objekt mit "method": "SIGTERM" (bzw. "^C") und "timeout_seconds" (5 bis 600, Standard: 30).
  "stop": {
    "method": "SIGTERM",
    "timeout_seconds": 60
  },

  // Wann wechselt der Status im Panel von "Startet..." auf "Läuft"?
  // Variante A ("done"): Sobald eine Logzeile auf den Regex-Ausdruck passt.
  // (Aus Pterodactyls config.startup.done baut der Import das automatisch, aber oft ist das Muster dort veraltet!)
  "ready_check": {
    "kind": "done",
    "regex": "Server started|Listening on|Game server connected",
    "timeout_seconds": 600
  },
  // Variante B ("tcp_port"): Wenn das Spiel nichts ins Log schreibt (z. B. TeamSpeak 6),
  // prüft das Panel stattdessen, ob ein TCP-Port Verbindungen annimmt:
  // "ready_check": { "kind": "tcp_port", "port_ref": "query", "timeout_seconds": 180 },

  // Optional: Falls das Spiel sein Haupt-Log NICHT in die Konsole (stdout), sondern nur in eine
  // Datei schreibt (wie ARK: Survival Ascended), liest das Panel diese Datei live für Konsole & Ready-Check mit:
  "log_file": "Saved/Logs/Server.log",

  // Optional: Ordner für den Log-Viewer im Panel
  "log_dirs": ["logs", "Saved/Logs"],

  // Optional: Hat der Server ein eigenes Webinterface (z. B. Farming Simulator)?
  "web_interface": {
    "url": "http://{{SERVER_IP}}:{{WEB_PORT}}",
    "label": "Webinterface öffnen",
    "note": "Zugangsdaten stehen in den Server-Einstellungen."
  },

  // ============================================================================
  // 5. PORTS (Hauptport & Nebenports)
  // ============================================================================
  // WICHTIG BEIM ABGLEICH:
  // Pterodactyl-Eggs kennen keine Port-Struktur und definieren Zusatzports nur als Variablen (z. B. QUERY_PORT).
  // Unser Import wandelt *_PORT-Variablen zwar automatisch um (mit protocol: "both"), ABER:
  // 1. Spiele, die "Spielport + 1" fest einrechnen (ohne Variable!), fehlen in Pterodactyl-Eggs komplett!
  //    -> Hier als secondary mit "offset": 1 eintragen!
  // 2. Saubere Protokolle ("udp" / "tcp" statt "both") und Wunsch-Portbereiche ("start" / "end")
  //    kannst du hier exakt festlegen.
  "ports": {
    "primary": {
      "ref": "game",                        // Ergibt Platzhalter {{SERVER_PORT}} (und {{GAME_PORT}})
      "name": "Spiel",
      "start": 7777,
      "end": 7876,
      "protocol": "udp"                     // "tcp" | "udp" | "both"
    },
    "secondary": [
      {
        "ref": "query",                     // Ergibt Platzhalter {{QUERY_PORT}}
        "name": "Steam Query",
        "offset": 1,                        // Alternativ zu start/end: immer Hauptport + X (z. B. 7778)
        "protocol": "udp",
        "optional": false
      },
      {
        "ref": "rcon",                      // Ergibt Platzhalter {{RCON_PORT}}
        "name": "RCON",
        "start": 27020,
        "end": 27119,
        "protocol": "tcp",
        "optional": false,
        "internal": true                    // WICHTIG für RCON: true = nur intern für das Panel erreichbar, nicht im Internet offen!
      }
    ]
  },

  // ============================================================================
  // 6. RESSOURCEN-EMPFEHLUNG (im Erstellen-Dialog)
  // ============================================================================
  // Fehlt in fast allen Internet-Eggs komplett! Immer ergänzen, damit Nutzer wissen, was das Spiel braucht.
  "resources": {
    "base_ram_mb": 4096,                    // Empfohlener Basis-RAM in MB
    "ram_per_player_mb": 150,               // Zusätzlicher RAM pro Spieler in MB
    "min_cpu_percent": 200,                 // Empfohlene CPU (100 = 1 Kern, 200 = 2 Kerne)
    "disk_mb": 20000,                       // Empfohlener Festplattenspeicher in MB
    "notes": "Kurzer Hinweis zum Ressourcenverbrauch (z. B. Proton braucht extra RAM)."
  },

  // ============================================================================
  // 7. INSTALLATIONSSKRIPT
  // ============================================================================
  // Läuft beim Anlegen/Neuinstallieren in einem eigenen Installer-Container.
  // Arbeitsverzeichnis im Installer ist immer /mnt/server ($SERVER_DIR).
  // (Bei Images wie itzg/minecraft-server, die sich beim Start selbst installieren, weglassen).
  "scripts": {
    "installation": {
      "container": "ghcr.io/parkervcp/installers:debian", // Auf Alpine-Images achten: die brauchen entrypoint "ash"!
      "entrypoint": "bash",                               // "bash" | "ash" | "sh"
      "script": "#!/bin/bash\n# Hier steht das SteamCMD- oder Download-Skript aus dem Original-Egg\n"
    }
  },

  // ============================================================================
  // 8. KONFIGURATIONSDATEIEN AUTOMATISCH PATCHEN
  // ============================================================================
  // Wird vor JEDEM Serverstart ausgeführt, damit Ports, Passwörter und Einstellungen immer stimmen.
  // Unterstützte Parser: "properties", "ini", "yaml" (auch "yml"), "json", "xml", "file" (Zeilenersetzung), "sqlite"
  //
  // Eingebaute Platzhalter:
  // {{SERVER_PORT}}, {{SERVER_IP}}, {{SERVER_MEMORY}}, {{SERVER_MEMORY_HEAP}} (85% für Java),
  // {{SERVER_NAME}}, {{SERVER_DIR}} sowie jeder Nebenport als {{<REF>_PORT}} (z. B. {{QUERY_PORT}}, {{RCON_PORT}})
  // und jede Variable als {{ENV_VARIABLE}}.
  "config_files": {
    "Config/ServerSettings.ini": {
      "parser": "ini",
      "find": {
        "ServerSettings.ServerName": "{{SERVER_NAME}}",
        "ServerSettings.Port": "{{SERVER_PORT}}",
        "ServerSettings.RCONPort": "{{RCON_PORT}}",
        "ServerSettings.AdminPassword": "{{ADMIN_PASSWORD}}"
      }
    }
  },

  // ============================================================================
  // 9. VARIABLEN (Formular-Felder im Panel)
  // ============================================================================
  // WICHTIGE REGELN FÜR DIE TESTS (tests/bundled-eggs.test.ts):
  // 1. Keine doppelten "env_variable"-Namen!
  // 2. Jede Variable mit "required" in "rules" MUSS einen nicht-leeren "default_value" haben!
  //    -> Ausnahme 1: Für Pflicht-Passwörter "{{GENERATE_PASSWORD}}" als default_value nutzen!
  //    -> Ausnahme 2: Echte Nutzer-Logins wie STEAM_USER, STEAM_PASS, GSLT, SERVER_TOKEN (oder stell sie auf "nullable|string").
  // 3. Die Regel ("rules") bestimmt automatisch das Bedienelement (Widget) in der Oberfläche:
  //    - Name endet auf PASS, SECRET, TOKEN, KEY -> Passwort-Feld (zusätzlich "secret": true setzen!)
  //    - "in:A,B,C"                               -> Dropdown-Auswahl (Select)
  //    - "boolean" (oder "in:true,false")         -> Schalter (Toggle)
  //    - "numeric|between:1,100" (Spanne <= 1000) -> Schieberegler (Slider)
  //    - "numeric" / "integer"                    -> Zahlenfeld
  //    - "string|max:500" (max > 200)             -> Mehrzeiliges Textfeld (Textarea)
  //    - sonst                                    -> Normales Textfeld
  "variables": [
    {
      "name": "Servername",
      "name_locales": {
        "de": "Servername",
        "en": "Server Name"
      },
      "description": "Anzeigename des Servers in der Serverliste.",
      "description_locales": {
        "de": "Anzeigename des Servers in der Serverliste.",
        "en": "Display name of the server in the server browser."
      },
      "env_variable": "SERVER_NAME",
      "default_value": "NexusPanel Server",
      "rules": "required|string|max:64",
      "user_viewable": true,
      "user_editable": true
    },
    {
      "name": "Admin-Passwort",
      "name_locales": {
        "de": "Admin-Passwort",
        "en": "Admin Password"
      },
      "description": "Passwort für Admin-Befehle und RCON. Leer lassen erzeugt automatisch eines.",
      "description_locales": {
        "de": "Passwort für Admin-Befehle und RCON. Leer lassen erzeugt automatisch eines.",
        "en": "Password for admin commands and RCON. Leave blank to generate one."
      },
      "env_variable": "ADMIN_PASSWORD",
      "default_value": "{{GENERATE_PASSWORD}}", // Erzeugt beim Server-Anlegen automatisch ein sicheres Passwort!
      "rules": "required|string|min:8|max:64",
      "secret": true,                           // Verschlüsselt in der DB & im UI maskiert
      "user_viewable": true,
      "user_editable": true
    },
    {
      "name": "Maximale Spieler",
      "name_locales": {
        "de": "Maximale Spieler",
        "en": "Maximum Players"
      },
      "env_variable": "MAX_PLAYERS",
      "default_value": "16",
      "rules": "required|numeric|between:1,64", // Wird im UI automatisch zum Slider!
      "user_viewable": true,
      "user_editable": true
    },
    {
      "name": "Spielmodus",
      "name_locales": {
        "de": "Spielmodus",
        "en": "Game Mode"
      },
      "env_variable": "GAME_MODE",
      "default_value": "survival",
      "rules": "required|in:survival,creative", // Wird im UI automatisch zum Dropdown!
      "user_viewable": true,
      "user_editable": true
    },
    {
      "name": "Cheats aktivieren",
      "name_locales": {
        "de": "Nur im Kreativmodus sichtbar",
        "en": "Only visible in creative mode"
      },
      "env_variable": "ENABLE_CHEATS",
      "default_value": "false",
      "rules": "required|in:true,false",
      "requires": "GAME_MODE=creative",         // Bedingtes Feld: Wird im UI nur angezeigt, wenn GAME_MODE=creative ist!
      "user_viewable": true,
      "user_editable": true
    },
    {
      "name": "Steam App-ID (Intern)",
      "env_variable": "SRCDS_APPID",
      "default_value": "123456",
      "rules": "required|string",
      "user_viewable": false,                   // Unsichtbar für den Nutzer
      "user_editable": false                    // Nicht änderbar (gehört fest dem Egg)
    }
  ],

  // ============================================================================
  // 10. LIVE-SPIELERABFRAGE & RCON (Spielerliste, Kick/Ban, TPS)
  // ============================================================================
  // Unterstützte "kind"-Werte:
  // - "source":    Valve A2S-Query (für fast alle Steam-Spiele wie CS2, Garry's Mod, Valheim, Rust, ARK, 7DTD, Squad...)
  // - "minecraft": Server List Ping + RCON (für TPS, Spielerliste, Kick/Ban/Op/Whitelist)
  // - "palworld":  RCON-Abfrage für Palworld (ShowPlayers, Kick/Ban)
  // - "ark":       RCON-Abfrage für ARK (ListPlayers, KickPlayer/BanPlayer)
  "query": {
    "kind": "source",
    "port_ref": "query",                    // Welcher Port aus "ports" antwortet auf A2S? (Standard: "game")
    "rcon": {
      "port_ref": "rcon",                   // Welcher Port aus "ports" ist der RCON-Port?
      "password_var": "ADMIN_PASSWORD",     // Welche Variable enthält das RCON-Passwort?
      "password_files": [".rcon-cli.env"]   // Optional: Datei im Serverordner, falls das Image das Passwort selbst anlegt
    }
  },

  // ============================================================================
  // 11. KONSOLEN-HINWEISE (Automatische Fehler- & Status-Erklärung)
  // ============================================================================
  // Wenn eine Zeile in der Konsole auf "match" (Regex) passt, zeigt das Panel dem Nutzer
  // eine verständliche Erklärung an (oder blendet harmlose Warnungen bei "ignore" aus).
  // Level: "error" | "warn" | "ok" | "ignore"
  "hints": [
    {
      "match": "No space left on device|state is 0x202",
      "flags": "i",
      "level": "error",
      "text": "Festplatte voll: Nicht genug freier Speicher für die Spieldateien.",
      "text_locales": {
        "de": "Festplatte voll: Nicht genug freier Speicher für die Spieldateien.",
        "en": "Disk full: Not enough free space for the game files."
      }
    },
    {
      "match": "ProtonFixes\\[\\d+\\] WARN|fsync: up and running",
      "flags": "",
      "level": "ignore",
      "text": "Harmlose Meldung von Proton – kann ignoriert werden.",
      "text_locales": {
        "de": "Harmlose Meldung von Proton – kann ignoriert werden.",
        "en": "Harmless message from Proton – safe to ignore."
      }
    }
  ],

  // ============================================================================
  // 12. BACKUP-IMPORT & AUTOMATISCHE ERKENNUNG (aus AMP / Pterodactyl / Zip)
  // ============================================================================
  "import": {
    "notes": "Erklärung, welche Ordner beim Backup-Import übernommen werden.",
    "rules": [
      {
        "match": "Saved/SaveGames",         // Pfadstück, nach dem im ZIP gesucht wird (egal wie tief verschachtelt)
        "to": "Saved/SaveGames",            // Zielpfad im Datenordner des Servers
        "exclude": ["Logs", "Crashes"]      // Unterordner, die beim Import übersprungen werden
      }
    ],
    "detect": {
      "markers": ["Saved/SaveGames", "ServerSettings.ini"], // Eindeutige Dateien, an denen das Panel dieses Spiel im ZIP erkennt
      "vars": [
        // Automatisch Einstellungen aus dem Backup auslesen (from: "ini" | "properties" | "json" | "nbt" | "filename" | "dir_child" | "exists" | "set")
        {
          "var": "SERVER_NAME",
          "from": "ini",
          "file": "ServerSettings.ini",
          "section": "ServerSettings",
          "key": "ServerName"
        }
      ]
    }
  },

  // ============================================================================
  // 13. INTERNE NOTIZEN FÜR ADMINS / ENTWICKLER
  // ============================================================================
  "notes": [
    "Wichtige Hinweise zum Verhalten des Servers oder besondere Voraussetzungen."
  ]
}
```

---

## 2. Checkliste: Egg aus dem Internet abgleichen & korrigieren

Wenn du dir ein Egg aus dem Internet (z. B. von GitHub aus `pelican-eggs`) herunterlädst, gehe diese **10 Punkte** der Reihe nach durch:

### ☐ 1. Was der Importer ohnehin schon automatisch macht (keine Handarbeit nötig)
Wenn du ein fremdes Egg importierst oder in `eggs/` ablegst, repariert `normalizeForeignEgg()` in `src/eggs/import.ts` bereits automatisch:
- `config.files`, `config.startup` und `config.logs` werden aus JSON-Strings in echte Objekte umgewandelt.
- `parser: "yml"` wird automatisch zu `"yaml"`.
- `startup_commands` (Pelican v3) wird automatisch zu `startup` gemacht.
- `config.startup.done` wird automatisch in einen `ready_check` mit Regex umgewandelt.
- Variablen nach dem Schema `*_PORT` (wie `QUERY_PORT`, `RCON_PORT`) werden automatisch zu Nebenports gemacht (`RCON_PORT` wird automatisch `internal: true`).
- Bei `ghcr.io/pelican-eggs/...`, `parkervcp` und `pterodactyl` Images wird automatisch `run_as: "1000:1000"` gesetzt.
- Alte Pterodactyl-Platzhalter wie `{{server.build.default.port}}` oder `{{server.build.env.FOO}}` versteht NexusPanel direkt.

### ☐ 2. Pflichtfelder ohne Standardwert (`default_value`) korrigieren! *(Häufigster Fehler!)*
In Internet-Eggs stehen oft Variablen auf `"rules": "required|string..."`, haben aber `"default_value": ""`.
- **Folge:** Unser Test (`tests/bundled-eggs.test.ts`) und das Server-Anlegen schlagen fehl!
- **Lösung:**
  - Ist es ein **Passwort** (z. B. `SERVER_PASSWORD`, `ADMIN_PASSWORD`, `RCON_PASSWORD`), das Pflicht ist? Setze `"default_value": "{{GENERATE_PASSWORD}}"` und `"secret": true`.
  - Ist das Feld eigentlich **optional** (z. B. Server-Passwort zum Beitreten, Zusatzparameter, Mods)? Ändere `required` in `rules` auf `nullable` (z. B. `"nullable|string|max:64"`).
  - Ist es eine normale Einstellung (z. B. Servername, Map, Slots)? Trag einen sinnvollen Standardwert in `"default_value"` ein.

### ☐ 3. Versteckte oder berechnete Ports prüfen (`ports`)
- Manche Spiele öffnen **„Spielport + 1“** (z. B. Valheim Query-Port = Game-Port + 1, oder Rust RCON = Game-Port + 1), **ohne** dass im Pterodactyl-Egg dafür eine Variable existiert!
- Prüfe im `startup`-Befehl oder der Spieldokumentation, welche Ports das Spiel wirklich braucht, und lege einen sauberen `ports`-Block mit `primary` und `secondary` (inkl. `protocol: "udp"` / `"tcp"` und ggf. `"offset": 1`) an.

### ☐ 4. Wine / Proton Besonderheiten (`tmp` & `resources`)
Nutzt das Egg `wine` oder `proton` im Docker-Image (`ghcr.io/parkervcp/steamcmd:proton`, `yolks:wine_latest` o. ä.)?
- **Zwingend:** Füge `"tmp": "disk"` auf oberster Ebene hinzu! (Ohne das läuft die 256-MB-RAM-Disk in `/tmp` beim Entpacken von Proton voll).
- Plane in `"resources"` mindestens `4096` bis `8192` MB `base_ram_mb` und `min_cpu_percent: 200` ein.
- Wenn die Konsole keine Befehle annimmt (fast immer bei Wine/Proton), setze `"console": "readonly"`.

### ☐ 5. Titelbild (`cover.steam`) und Kategorie (`nest`) ergänzen
- Setze `"nest"` auf eine passende Kategorie (`"Survival"`, `"Shooter"`, `"Simulation"`, `"Aufbau"`, `"Minecraft"`, `"Sprachserver"`).
- Suche die **Steam-Store-AppID des Hauptspiels** (nicht die des Dedicated Servers!) heraus und trage sie ein:
  ```json
  "cover": { "steam": 123456 }
  ```
  *(Tipp: Die Nummer steht in der normalen Steam-Shop-URL des Spiels: `store.steampowered.com/app/<NUMMER>/...`)*.

### ☐ 6. Ressourcen-Vorschlag (`resources`) eintragen
Fremde Eggs haben keinen `resources`-Block. Ergänze ihn, damit im „Server erstellen“-Dialog sinnvolle Standardwerte vorgeschlagen werden:
```json
"resources": {
  "base_ram_mb": 4096,
  "ram_per_player_mb": 100,
  "min_cpu_percent": 200,
  "disk_mb": 20000
}
```

### ☐ 7. Bereitschaftsmuster (`ready_check` / `config.startup.done`) prüfen
- Schau dir `config.startup.done` im Internet-Egg an. Oft steht dort ein veralteter Text oder gar nichts.
- Wenn das Spiel beim Starten eine bestimmte Zeile ausgibt, trage sie als `ready_check` ein:
  ```json
  "ready_check": {
    "kind": "done",
    "regex": "Server started|Game server connected",
    "timeout_seconds": 600
  }
  ```

### ☐ 8. Live-Abfrage (`query`) für Spielerliste & RCON aktivieren
Damit das Panel live anzeigt, wie viele Spieler online sind (und ggf. Kicken/Bannen erlaubt):
- Unterstützt das Spiel **Steam / Source Query (A2S)**? (Fast alle SteamCMD-Spiele mit Query-Port):
  ```json
  "query": {
    "kind": "source",
    "port_ref": "query"
  }
  ```
  *(Falls der Hauptport selbst auf A2S antwortet, wie bei CS2 oder Garry's Mod: `"port_ref": "game"`)*.

### ☐ 9. Deutsche & Englische Übersetzungen (`name_locales`, `description_locales`)
Damit die Variablen-Formulare auf Deutsch und Englisch sauber aussehen:
- Ergänze bei den sichtbaren Variablen (`"user_viewable": true`) jeweils:
  ```json
  "name_locales": { "de": "Deutscher Name", "en": "English Name" },
  "description_locales": { "de": "Deutsche Beschreibung.", "en": "English description." }
  ```
- Entferne unschöne Präfixe wie `[SERVER] ` oder `[STEAM] ` aus dem sichtbaren `"name"`.

### ☐ 10. Automatischer Testlauf
Wenn du das fertige Egg in `eggs/<spielname>.json` gespeichert hast, führe im Terminal diesen Befehl aus:
```powershell
npx vitest run tests/bundled-eggs.test.ts tests/egg-locales.test.ts tests/foreign-eggs.test.ts
```
Wenn alle 3 Tests **grün** sind, sind alle Variablen, Pflichtfelder, Standardwerte, Platzhalter, Regex-Hinweise und Übersetzungen 100 % gültig!
