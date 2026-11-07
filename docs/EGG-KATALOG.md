# Egg-Katalog – alle einbaubaren Spielvorlagen

Stand: 07.11.2026, 21:15 · NexusPanel 0.20.0

Diese Liste umfasst alle Eggs aus den Pelican-Sammlungen (Nachfolger der Pterodactyl-Eggs, MIT-Lizenz), die der Import von NexusPanel lesen kann. Alle 263 Vorlagen wurden testweise importiert – der Import ist bei allen fehlerfrei durchgelaufen. Ob der Server danach auch wirklich startet, ist damit noch nicht geprüft.

## Kurzfassung

| | Anzahl |
|---|---|
| Vorlagen insgesamt (ohne Duplikate) | 263 |
| schon im Panel enthalten | 40 |
| Bewertung **direkt** | 209 |
| Bewertung **prüfen** | 44 |
| Bewertung **Steam-Konto** | 10 |

## Was der Import automatisch anpasst

Pelican- und Pterodactyl-Eggs funktionieren ohne Handarbeit, weil der Import (`src/eggs/import.ts`, `normalizeForeignEgg`) Folgendes umbaut:

- **Zusatzports:** Variablen wie `QUERY_PORT`, `RCON_PORT` oder `STEAM_PORT` werden zu eigenen Ports. Das Panel vergibt sie beim Anlegen und trägt sie in die Variable ein. RCON-Ports werden nur intern freigegeben, also nicht ins Internet.
- **Startmuster:** Der `done`-Text des Eggs wird zum Bereitschafts-Check. Erst wenn die Zeile in der Konsole erscheint, gilt der Server als „läuft“.
- **Konfigurationsdateien:** Als Text gespeicherte `config.files` werden gelesen. `yml` wird als YAML behandelt, und der Parser `file` ersetzt ganze Zeilen.
- **Benutzer und Rechte:** Bei den Pelican-/Parkervcp-Images läuft der Server als `1000:1000`. Nach der Installation werden die Dateien diesem Benutzer übergeben (chown).
- **Installer:** Die Shell des Installers (`bash`, `ash` oder `sh`) wird aus dem Egg übernommen.
- **Vorlagen-Variablen:** Variablen, die auf andere Variablen oder Ports verweisen (`{{SERVER_PORT}}`), werden korrekt aufgelöst.
- **Ältere Felder:** `startup_commands` und Bilder als Link werden umgerechnet bzw. verworfen.

Was **nicht** automatisch geht, findest du unter [Bewertung](#bewertung) und [Bekannte Grenzen](#bekannte-grenzen).

## So importierst du ein Egg

1. Den GitHub-Link aus der Tabelle öffnen und auf **Download raw file** klicken. Die `.json` wird gespeichert.
2. Im Panel als Admin **Server erstellen** öffnen und **Spiel importieren (JSON)** wählen.
3. Die Datei auswählen. Das Panel zeigt den Namen und eventuelle Hinweise an. Danach ist das Spiel sofort in der Auswahl.
4. Server anlegen und den ersten Start in der Konsole beobachten.

Per API geht es ebenfalls: `POST /api/admin/eggs` mit dem Egg-JSON als Body.

Eggs, die im Panel mitgeliefert werden (Ordner `eggs/`), werden beim Start automatisch eingespielt. Die mit ✅ markierten Einträge sind schon dabei.

## Bewertung

| Bewertung | Bedeutung |
|---|---|
| **direkt** | Linux-Server mit Startmuster, ohne Login. Sollte nach dem Import einfach laufen. |
| **prüfen** | Läuft unter Wine/Proton, rechnet Ports selbst aus (z. B. „Spielport + 1“) oder hat kein Startmuster. Vor dem Einsatz einmal testen. |
| **Steam-Konto** | Der Server lädt nur mit einem echten Steam-Konto, das das Spiel besitzt. Zugangsdaten werden als Variable beim Server eingetragen. |

**Laufzeit:** Linux = nativer Server · Java/Mono/.NET/Node/Python = passende Laufzeit im Image · Wine/Proton = Windows-Server unter Linux (mehr RAM und CPU, längerer erster Start).

## Steam-Spiele (SteamCMD) (134)

| Spiel | Im Panel | Steam-ID | Laufzeit | Zusatzports | Bewertung | Quelle |
|---|---|---|---|---|---|---|
| 7 Days To Die | ✅ `7days-to-die` | [294420](https://steamdb.info/app/294420/) | Linux | `TELNET_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/7_days_to_die/egg-7-days-to-die.json) |
| Abiotic Factor | ✅ `abiotic-factor` | [2857200](https://steamdb.info/app/2857200/) | Proton | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/abiotic_factor/egg-pterodactyl-abiotic-factor.json) |
| American Truck Simulator Dedicated Server | ✅ `american-truck-simulator` | [2239530](https://steamdb.info/app/2239530/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/truck-simulator/american-truck-simulator/egg-american-truck-simulator-dedicated-server.json) |
| ARK: Survival Ascended | ✅ `ark-survival-ascended` | [2430930](https://steamdb.info/app/2430930/) | Proton | `RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/ark_survival_ascended/egg-a-r-k--survival-ascended.json) |
| Ark: Survival Evolved |  | [376030](https://steamdb.info/app/376030/) | Linux | `RCON_PORT`, `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/ark_survival_evolved/egg-pterodactyl-ark--survival-evolved.json) |
| Arma 3 |  | – | Linux | `RCON_PORT` | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/arma/arma3/egg-arma3.json) |
| Arma Reforger | ✅ `arma-reforger` | [1874900](https://steamdb.info/app/1874900/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/arma/arma_reforger/egg-arma-reforger.json) |
| Assetto Corsa | ✅ `assetto-corsa` | [302550](https://steamdb.info/app/302550/) | Linux | `HTTP_PORT` | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/assetto_corsa/egg-assetto-corsa.json) |
| Assetto Corsa (Freeroam + AI) |  | – | Mono/.NET | `HTTP_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/assetto_corsa/egg-assetto-corsa--freeroam--a-i.json) |
| Astro Colony |  | [2934900](https://steamdb.info/app/2934900/) | Linux | `SERVER_QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/astro_colony/egg-astro-colony.json) |
| Astroneer Dedicated Server | ✅ `astroneer` | [728470](https://steamdb.info/app/728470/) | Proton | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/astroneer/egg-astroneer-dedicated-server.json) |
| Avorion |  | [565060](https://steamdb.info/app/565060/) | Linux | `STEAM_MASTER_PORT`, `STEAM_QUERY_PORT`, `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/avorion/egg-avorion.json) |
| Banana Shooter |  | [2406780](https://steamdb.info/app/2406780/) | Linux | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/banana_shooter/pterodactyl-egg-banana-shooter.json) |
| Barotrauma | ✅ `barotrauma` | [1026340](https://steamdb.info/app/1026340/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/barotrauma/egg-barotrauma.json) |
| BATTALION: Legacy |  | [805140](https://steamdb.info/app/805140/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/battalion_legacy/egg-b-a-t-t-a-l-i-o-n--legacy.json) |
| Black Mesa |  | [346680](https://steamdb.info/app/346680/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/black_mesa/egg-black-mesa.json) |
| Brickadia |  | [3017590](https://steamdb.info/app/3017590/) | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/brickadia/egg-brickadia.json) |
| Citadel: Forged with Fire |  | [489650](https://steamdb.info/app/489650/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/citadel/egg-citadel--forged-with-fire.json) |
| Colony Survival |  | [748090](https://steamdb.info/app/748090/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/colony_survival/egg-colony-survival.json) |
| Conan Exiles |  | [443030](https://steamdb.info/app/443030/) | Proton | `QUERY_PORT`, `RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/conan_exiles/pterodactyl-egg-conan-exiles-legacy.json) |
| Conan Exiles Enhanced |  | [443030](https://steamdb.info/app/443030/) | Linux | `QUERY_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/conan_exiles/pterodactyl-egg-conan-exiles-enhanced.json) |
| Core Keeper | ✅ `core-keeper` | [1963720](https://steamdb.info/app/1963720/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/core_keeper/egg-core-keeper.json) |
| Counter-Strike 2 | ✅ `cs2` | [730](https://steamdb.info/app/730/) | Linux | `TV_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/counter_strike/counter_strike_2/egg-pterodactyl-counter--strike2.json) |
| Counter-Strike: Source | ✅ `counter-strike-source` | [232330](https://steamdb.info/app/232330/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/counter_strike/counter_strike_source/egg-pterodactyl-counter--strike--source.json) |
| Craftopia |  | [1670340](https://steamdb.info/app/1670340/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/craftopia/pterodactyl-egg-craftopia.json) |
| CryoFall |  | [1061710](https://steamdb.info/app/1061710/) | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/cryofall/egg-cryo-fall.json) |
| Cubic Odyssey |  | [3858450](https://steamdb.info/app/3858450/) | Wine | `ENDING_PORT`, `STARTING_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/cubic_odyssey/pterodactyl-egg-cubic-odyssey.json) |
| Custom HLDS Engine Game |  | [90](https://steamdb.info/app/90/) | Linux | `VAC_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/hlds_server/vanilla/egg-custom-h-l-d-s-engine-game.json) |
| Custom ReHLDS Engine Game |  | [90](https://steamdb.info/app/90/) | Linux | `VAC_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/hlds_server/rehlds/egg-custom-re-h-l-d-s-engine-game.json) |
| DayZ |  | – | Linux | `QUERY_PORT`, `RCON_PORT` | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/dayz/egg-day-z.json) |
| DDNet |  | [412220](https://steamdb.info/app/412220/) | Linux | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/ddnet/egg-d-d-net.json) |
| Dead Matter |  | [2584780](https://steamdb.info/app/2584780/) | Proton | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/dead_matter/egg-dead-matter.json) |
| Don't Starve Together | ✅ `dont-starve-together` | [343050](https://steamdb.info/app/343050/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/dont_starve/egg-pterodactyl-don-t-starve-together.json) |
| Eco | ✅ `eco` | [739590](https://steamdb.info/app/739590/) | Mono/.NET | `WEB_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/eco/egg-eco.json) |
| Empyrion: Galactic Survival | ✅ `empyrion` | [530870](https://steamdb.info/app/530870/) | Wine | `TELNET_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/empyrion/egg-empyrion--galactic-survival.json) |
| Enshrouded | ✅ `enshrouded` | [2278520](https://steamdb.info/app/2278520/) | Proton | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/enshrouded/egg-pterodactyl-enshrouded.json) |
| Euro Truck Simulator 2 Dedicated server | ✅ `euro-truck-simulator-2` | [1948160](https://steamdb.info/app/1948160/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/truck-simulator/euro-truck-simulator2/egg-euro-truck-simulator2-dedicated-server.json) |
| Fof |  | [295230](https://steamdb.info/app/295230/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/fof/egg-fof.json) |
| Foundry |  | [2915550](https://steamdb.info/app/2915550/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/foundry/egg-foundry.json) |
| Frozen Flame |  | [1348640](https://steamdb.info/app/1348640/) | Linux | `QUERY_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/frozen_flame/egg-frozen-flame.json) |
| Garry's Mod - Reworked | ✅ `garrys-mod` | [4020](https://steamdb.info/app/4020/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/gmod/egg-pterodactyl-garry-s-mod--reworked.json) |
| Ground Branch |  | [476400](https://steamdb.info/app/476400/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/ground_branch/egg-ground-branch.json) |
| Holdfast NaW |  | [1424230](https://steamdb.info/app/1424230/) | Linux | `SERVER_COMM_PORT`, `SERVER_QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/holdfast/egg-holdfast-na-w.json) |
| HumanitZ |  | [2728330](https://steamdb.info/app/2728330/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/humanitz/egg-humanit-z.json) |
| Hurtworld | ✅ `hurtworld` | [405100](https://steamdb.info/app/405100/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/hurtworld/egg-hurtworld.json) |
| Icarus |  | [2089300](https://steamdb.info/app/2089300/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/icarus/pterodactyl-egg-icarus.json) |
| Insurgency |  | [237410](https://steamdb.info/app/237410/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/insurgency/pterodactyl-egg-insurgency.json) |
| Insurgency: Sandstorm | ✅ `insurgency-sandstorm` | [581330](https://steamdb.info/app/581330/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/insurgency_sandstorm/egg-insurgency--sandstorm.json) |
| Iosoccer server |  | [673990](https://steamdb.info/app/673990/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/iosoccer/egg-iosoccer-server.json) |
| Killing Floor 2 |  | [232130](https://steamdb.info/app/232130/) | Linux | `QUERY_PORT`, `WEB_ADMIN_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/killing_floor_2/egg-killing-floor2.json) |
| Left 4 Dead |  | [222840](https://steamdb.info/app/222840/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/left4dead/egg-left4-dead.json) |
| Left 4 Dead 2 | ✅ `left-4-dead-2` | [222860](https://steamdb.info/app/222860/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/left4dead_2/egg-left4-dead2.json) |
| Longvinter |  | [1007](https://steamdb.info/app/1007/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/longvinter/egg-longvinter.json) |
| Midnight Ghost Hunt |  | [1118810](https://steamdb.info/app/1118810/) | Proton | `QUERY_PORT`, `BEACON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/midnight_ghost_hunt/egg-midnight-ghost-hunt.json) |
| Military Conflict: Vietnam |  | [1136190](https://steamdb.info/app/1136190/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/military_conflict_vietnam/pterodactyl-egg-military-conflict-vietnam.json) |
| Modiverse |  | [1549820](https://steamdb.info/app/1549820/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/modiverse/egg-modiverse.json) |
| Mordhau | ✅ `mordhau` | [629800](https://steamdb.info/app/629800/) | Linux | `QUERY_PORT`, `BEACON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/mordhau/egg-mordhau.json) |
| Mordhau Wine |  | [629800](https://steamdb.info/app/629800/) | Wine | `QUERY_PORT`, `BEACON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/mordhau/egg-mordhau-wine.json) |
| Mount & Blade II: Bannerlord |  | [1863440](https://steamdb.info/app/1863440/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/mount_blade_II_bannerlord/egg-mount--blade-i-i--bannerlord.json) |
| Myth of Empires |  | [1794810](https://steamdb.info/app/1794810/) | Proton | `QUERY_PORT`, `RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/myth_of_empires/egg-myth-of-empires.json) |
| Necesse | ✅ `necesse` | [1169370](https://steamdb.info/app/1169370/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/necesse/egg-necesse.json) |
| NeosVR |  | [740250](https://steamdb.info/app/740250/) | Mono/.NET | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/neosvr/egg-neos-v-r.json) |
| Night Of The Dead |  | [1420710](https://steamdb.info/app/1420710/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/night_of_the_dead/egg-night-of-the-dead.json) |
| Nightingale |  | [3796810](https://steamdb.info/app/3796810/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/nightingale/pterodactyl-egg-nightingale.json) |
| nmrih |  | [317670](https://steamdb.info/app/317670/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/nmrih/egg-nmrih.json) |
| No Love Lost |  | [2833050](https://steamdb.info/app/2833050/) | Proton | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/no_love_lost/egg-no-love-lost.json) |
| No One Survived |  | [2329680](https://steamdb.info/app/2329680/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/no_one_survived/egg-no-one-survived.json) |
| Nova-Life: Amboise |  | [1665030](https://steamdb.info/app/1665030/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/novalife_amboise/egg-nova--life--amboise.json) |
| Onset |  | [1204170](https://steamdb.info/app/1204170/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/onset/egg-onset.json) |
| Open Fortress |  | [244310](https://steamdb.info/app/244310/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/open_fortress/egg-open-fortress.json) |
| Operation Harsh Doorstop |  | [950900](https://steamdb.info/app/950900/) | Linux | `QUERY_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/operation_harsh_doorstop/egg-operation-harsh-doorstop.json) |
| Palworld | ✅ `palworld` | [2394010](https://steamdb.info/app/2394010/) | Linux | `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/palworld/egg-pterodactyl-palworld.json) |
| Palworld Proton |  | [2394010](https://steamdb.info/app/2394010/) | Proton | `RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/palworld/egg-pterodactyl-palworld-proton.json) |
| Pavlov VR |  | [622970](https://steamdb.info/app/622970/) | Linux | `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/pavlov_vr/egg-pavlov-v-r.json) |
| PixARK |  | [824360](https://steamdb.info/app/824360/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/pixark/egg-pix-a-r-k.json) |
| Plains of Pain |  | [2227360](https://steamdb.info/app/2227360/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/plains_of_pain/pterodactyl-egg-plains-of-pain.json) |
| Portal Knights |  | [374040](https://steamdb.info/app/374040/) | Wine | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/portal_knights/egg-portal-knights.json) |
| Post Scriptum |  | [746200](https://steamdb.info/app/746200/) | Linux | `QUERY_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/post_scriptum/egg-post-scriptum.json) |
| Project Zomboid | ✅ `project-zomboid` | [380870](https://steamdb.info/app/380870/) | Linux | `STEAM_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/project_zomboid/egg-project-zomboid.json) |
| Puck |  | [3481440](https://steamdb.info/app/3481440/) | Linux | `PING_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/puck/egg-puck.json) |
| QANGA |  | [1652070](https://steamdb.info/app/1652070/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/qanga/egg-pterodactyl-q-a-n-g-a.json) |
| Quake Live |  | [349090](https://steamdb.info/app/349090/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/quake_live/egg-pterodactyl-quake-live.json) |
| Resonite |  | [2519830](https://steamdb.info/app/2519830/) | Mono/.NET | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/resonite/egg-pterodactyl-resonite.json) |
| Rising World Java Legacy |  | [339010](https://steamdb.info/app/339010/) | Java | `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/rising_world/legacy/egg-pterodactyl-rising-world-java-legacy.json) |
| Rising World Unity |  | [339010](https://steamdb.info/app/339010/) | Linux | `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/rising_world/unity/egg-pterodactyl-rising-world-unity.json) |
| Risk of Rain 2 |  | [1180760](https://steamdb.info/app/1180760/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/risk_of_rain_2/egg-pterodactyl-risk-of-rain2.json) |
| RuneScape: Dragonwilds |  | [4019830](https://steamdb.info/app/4019830/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/runescape_dragonwilds/egg-pterodactyl-runescape-dragonwilds.json) |
| Rust | ✅ `rust` | [258550](https://steamdb.info/app/258550/) | Linux | `QUERY_PORT`, `RCON_PORT`, `APP_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/rust/vanilla/egg-pterodactyl-rust.json) |
| Rust Autowipe |  | [258550](https://steamdb.info/app/258550/) | Linux | `RCON_PORT`, `QUERY_PORT`, `APP_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/rust/rust_autowipe/egg-pterodactyl-rust-autowipe.json) |
| Rust Staging |  | [258550](https://steamdb.info/app/258550/) | Linux | `RCON_PORT`, `APP_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/rust/rust_staging/egg-pterodactyl-rust-staging.json) |
| Satisfactory | ✅ `satisfactory` | [1690800](https://steamdb.info/app/1690800/) | Linux | `RELIABLE_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/satisfactory/egg-pterodactyl-satisfactory.json) |
| SCP:SL |  | [996560](https://steamdb.info/app/996560/) | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/scpsl/dedicated/egg-pterodactyl-s-c-p--s-l.json) |
| SCP:SL - Exiled |  | [996560](https://steamdb.info/app/996560/) | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/scpsl/exiled/pterodactyl-egg-s-c-p-s-l-exiled.json) |
| Smalland: Survive the Wilds |  | [808040](https://steamdb.info/app/808040/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/smalland_survive_the_wilds/egg-pterodactyl-smalland--survive-the-wilds.json) |
| Solace Crafting |  | [1086950](https://steamdb.info/app/1086950/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/solace_crafting/egg-pterodactyl-solace-crafting.json) |
| Soldat |  | [638500](https://steamdb.info/app/638500/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/soldat/egg-pterodactyl-soldat.json) |
| Sons Of The Forest | ✅ `sons-of-the-forest` | [2465200](https://steamdb.info/app/2465200/) | Wine | `QUERY_PORT`, `BLOBSYNC_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/sonsoftheforest/egg-pterodactyl-sons-of-the-forest.json) |
| Soulmask | ✅ `soulmask` | [3017300](https://steamdb.info/app/3017300/) | Linux | `QUERY_PORT`, `ECHO_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/soulmask/egg-pterodactyl-soulmask.json) |
| SourceCoop |  | [346680](https://steamdb.info/app/346680/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/sourcecoop/egg-pterodactyl-source-coop.json) |
| Space Engineers | ✅ `space-engineers` | [298740](https://steamdb.info/app/298740/) | Wine | `STEAM_PORT`, `REMOTEAPI_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/space_engineers/default/egg-pterodactyl-space-engineers.json) |
| Space Engineers - Torch Server |  | [298740](https://steamdb.info/app/298740/) | Wine | `STEAM_PORT`, `REMOTEAPI_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/space_engineers/torch/egg-pterodactyl-space-engineers--torch-server.json) |
| Squad | ✅ `squad` | [403240](https://steamdb.info/app/403240/) | Linux | `QUERY_PORT`, `BEACON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/squad/egg-pterodactyl-squad.json) |
| Squad Wine |  | [403240](https://steamdb.info/app/403240/) | Wine | `BEACON_PORT`, `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/squad/egg-squad-wine.json) |
| Starbound |  | [211820](https://steamdb.info/app/211820/) | Linux | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/starbound/egg-pterodactyl-starbound.json) |
| StarRupture |  | [3809400](https://steamdb.info/app/3809400/) | Proton | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/star_rupture/egg-pterodactyl-star-rupture.json) |
| Stationeers |  | [600760](https://steamdb.info/app/600760/) | Linux | `UPDATE_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/stationeers/stationeers_vanilla/egg-pterodactyl-stationeers.json) |
| Stationeers (BepInEx) |  | [600760](https://steamdb.info/app/600760/) | Linux | `UPDATE_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/stationeers/stationeers_bepinex/egg-pterodactyl-stationeers--bep-in-ex.json) |
| Stormworks: Build and Rescue |  | [1247090](https://steamdb.info/app/1247090/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/stormworks/egg-pterodactyl-stormworks--build-and-rescue.json) |
| Subnautica |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/subnautica_nitrox_mod/egg-pterodactyl-subnautica.json) |
| Subsistence |  | [1362640](https://steamdb.info/app/1362640/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/subsistence/pterodactyl-egg-subsistence.json) |
| Sven Co-op | ✅ `sven-coop` | [276060](https://steamdb.info/app/276060/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/svencoop/egg-pterodactyl-sven-co-op.json) |
| Swords 'n Magic and Stuff |  | [2058450](https://steamdb.info/app/2058450/) | Wine | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/swords_'n_Magic_and_Stuff/egg-pterodactyl-swords-n-magic-and-stuff.json) |
| Team Fortress 2 Classic |  | [244310](https://steamdb.info/app/244310/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/team_fortress_2_classic/egg-pterodactyl-team-fortress2-classic.json) |
| TerraTech Worlds |  | [2533070](https://steamdb.info/app/2533070/) | Proton | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/terratech_worlds/egg-pterodactyl-terra-tech-worlds.json) |
| The Bus |  | [507320](https://steamdb.info/app/507320/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/the_bus/egg-the-bus.json) |
| The Forest | ✅ `the-forest` | [556450](https://steamdb.info/app/556450/) | Wine | `STEAM_PORT`, `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/the_forest/egg-pterodactyl-the-forest.json) |
| The Front |  | [2334200](https://steamdb.info/app/2334200/) | Linux | `BEACON_PORT`, `QUERY_PORT`, `SHUTDOWN_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/thefront/egg-pterodactyl-the-front.json) |
| The Isle |  | [412680](https://steamdb.info/app/412680/) | Linux | `QUEUE_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/the_isle/evrima/egg-pterodactyl-the-isle.json) |
| The Lord of the Rings: Return to Moria |  | [3349480](https://steamdb.info/app/3349480/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/lotr_moria/egg-pterodactyl-lotr-return-to-moria.json) |
| The Ship: Murder Party |  | [2403](https://steamdb.info/app/2403/) | Wine | – | Steam-Konto | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/the_ship/egg-pterodactyl-the-ship.json) |
| Tower Unite |  | [439660](https://steamdb.info/app/439660/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/tower_unite/egg-pterodactyl-tower-unite.json) |
| Unturned | ✅ `unturned` | [1110390](https://steamdb.info/app/1110390/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/unturned/egg-pterodactyl-unturned.json) |
| V Rising | ✅ `v-rising` | [1829350](https://steamdb.info/app/1829350/) | Wine | `VR_QUERY_PORT`, `VR_RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/v_rising/v_rising_vanilla/egg-pterodactyl-v-rising.json) |
| V Rising BepInEx |  | [1829350](https://steamdb.info/app/1829350/) | Wine | `QUERY_PORT`, `RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/v_rising/v_rising_bepinex/egg-pterodactyl-v-rising-bep-in-ex.json) |
| Valheim | ✅ `valheim` | [896660](https://steamdb.info/app/896660/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/valheim/valheim_vanilla/egg-pterodactyl-valheim.json) |
| Valheim BepINex |  | [896660](https://steamdb.info/app/896660/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/valheim/valheim_bepinex/egg-pterodactyl-valheim-bep-i-nex.json) |
| Valheim Plus Mod |  | [896660](https://steamdb.info/app/896660/) | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/valheim/valheim_plus/egg-pterodactyl-valheim-plus-mod.json) |
| VEIN |  | [2131400](https://steamdb.info/app/2131400/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/vein/egg-pterodactyl-v-e-i-n.json) |
| Voyagers of Nera |  | [3937860](https://steamdb.info/app/3937860/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/voyagers_of_nera/pterodactyl-egg-voyagers-of-nera.json) |
| Windrose |  | [4129620](https://steamdb.info/app/4129620/) | Proton | `DIRECT_CONNECTION_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/windrose/pterodactyl-egg-windrose.json) |
| Wreckfest |  | [361580](https://steamdb.info/app/361580/) | Wine | `QUERY_PORT`, `STEAM_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/wreckfest/pterodactyl-egg-wreckfest.json) |
| Wreckfest 2 |  | [3519390](https://steamdb.info/app/3519390/) | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/wreckfest_2/egg-pterodactyl-wreckfest2.json) |
| Wurm Unlimited |  | [402370](https://steamdb.info/app/402370/) | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/wurm_unlimited/egg-pterodactyl-wurm-unlimited.json) |
| Zombie Survival Game Online |  | [2536350](https://steamdb.info/app/2536350/) | Proton | `QUERY_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-steamcmd/blob/main/zombie_survival_game_online/egg-pterodactyl-zombie-survival-game-online.json) |

## Eigenständige Spiele (69)

| Spiel | Im Panel | Steam-ID | Laufzeit | Zusatzports | Bewertung | Quelle |
|---|---|---|---|---|---|---|
| alt:V |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/altv/egg-alt--v.json) |
| Among Us - Impostor Server |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/among_us/impostor_server/egg-among-us--impostor-server.json) |
| Archean |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/archean/egg-archean.json) |
| AssaultCube |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/cubeengine/assaultcube/egg-assault-cube.json) |
| BeamMP Servers |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/beamng/beammp/egg-beam-m-p-servers.json) |
| BetterCrewlink Server |  | – | Node | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/among_us/bettercrewlink_server/egg-better-crewlink-server.json) |
| ClassiCube(MGC) |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/classicube/mcgalaxy/egg-classi-cube--m-g-c.json) |
| Clone Hero |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/clone_hero/egg-clone-hero.json) |
| Clusterio |  | – | Node | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/factorio/clusterio/egg-clusterio.json) |
| Crewlink server |  | – | Node | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/among_us/crewlink_server/egg-crewlink-server.json) |
| CS2D |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/cs2d/egg-c-s2-d.json) |
| Cube 2: Sauerbraten |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/cubeengine/cube2/egg-cube2--sauerbraten.json) |
| DDRaceNetwork |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/ddracenetwork/egg-d-d-race-network.json) |
| ET Legacy |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/wolfenstein_enemy_territory/etlegacy/egg-e-t-legacy.json) |
| Factorio | ✅ `factorio` | – | Linux | `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/factorio/factorio/egg-pterodactyl-factorio.json) |
| Factorio ARM64 |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/factorio/factorio/egg-factorio-a-r-m64.json) |
| Factorio-ModUpdate |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/factorio/factorio-modupdate/egg-factorio--mod-update.json) |
| FiveM |  | – | Linux | `TXHOST_TXA_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/fivem/egg-five-m.json) |
| Foundry VTT |  | – | Node | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/foundry_vtt/egg-foundry-v-t-t.json) |
| Grand Theft Auto Connected |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/gtac/egg-grand-theft-auto-connected.json) |
| Hogwarp |  | – | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/hogwarp/egg-hogwarp.json) |
| Hytale |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/hytale/pterodactyl-egg-hytale.json) |
| KissMP Server |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/beamng/kissmp/egg-kiss-m-p-server.json) |
| KSP DMP |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/ksp/egg-k-s-p-d-m-p.json) |
| LAC-Online Public Server |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/losangelescrimes/egg-l-a-c--online-public-server.json) |
| LeagueSandbox |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/leaguesandbox/egg-league-sandbox.json) |
| Mindustry |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/mindustry/egg-mindustry.json) |
| Minetest |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/minetest/egg-minetest.json) |
| mohaa |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/mohaa/egg-mohaa.json) |
| Multi Theft Auto |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/mtasa/egg-multi-theft-auto.json) |
| Nazi Zombies: Portable |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/nazi_zombies_portable/egg-nazi-zombies-portable.json) |
| Neverwinter Nights: Enhanced Edition |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/neverwinter_nights_ee/egg-neverwinter-nights--enhanced-edition.json) |
| One Hour One Life |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/OneHourOneLife/pterodactyl-egg-one-hour-one-life.json) |
| OpenArena |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/openarena/egg-open-arena.json) |
| OpenMP |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/openmp/egg-open-m-p.json) |
| OpenRA |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/openra/openra_red_alert/egg-open-r-a.json) |
| OpenRA - Dune2000 |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/openra/openra_dune2000/egg-open-r-a--dune2000.json) |
| OpenRA - Tiberian Dawn |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/openra/openra_tiberian_dawn/egg-open-r-a--tiberian-dawn.json) |
| OpenRCT2 |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/openrct2/egg-pterodactyl-open-r-c-t2.json) |
| OpenTTD |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/openttd/egg-open-t-t-d-server.json) |
| Path Of Titans |  | – | Linux | `QUERY_PORT`, `RCON_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/path_of_titans/egg-path-of-titans.json) |
| Rage.MP |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/ragemp/egg-pterodactyl-rage--m-p.json) |
| RageCOOP |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/ragecoop/egg-pterodactyl-rage-c-o-o-p.json) |
| RedM |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/rdr/redm/egg-pterodactyl-red-m.json) |
| Rimworld Together |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/rimworld/together/egg-pterodactyl-rimworld-together.json) |
| Rimworld: Open World |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/rimworld/open_world/egg-pterodactyl-rimworld--open-world.json) |
| SA-MP |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/gta/samp/egg-pterodactyl-s-a--m-p.json) |
| Single Player Tarkov |  | – | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/eft/spt/egg-single-player-tarkov.json) |
| Space Station 14 |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/spacestation_14/egg-pterodactyl-spacestation14.json) |
| starmade |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/starmade/egg-pterodactyl-starmade.json) |
| Stay In Tarkov |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/eft/sit/egg-pterodactyl-stay-in-tarkov.json) |
| SuperTuxKart |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/SuperTuxKart/egg-pterodactyl-super-tux-kart.json) |
| Tachyon |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/ftl_tachyon/egg-pterodactyl-tachyon.json) |
| Teeworlds |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/teeworlds/egg-pterodactyl-teeworlds.json) |
| Terraria Vanilla |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/terraria/vanilla/egg-pterodactyl-terraria-vanilla.json) |
| The Battle for Wesnoth |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/thebattleforwesnoth/egg-pterodactyl-the-battle-for-wesnoth.json) |
| Tiny Block Server |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/tiny_block/egg-pterodactyl-tiny-block-server.json) |
| tModloader |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/terraria/tmodloader/egg-pterodactyl-t-modloader.json) |
| Trackmania (2020) |  | – | Linux | `XMLRPC_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/trackmania2020/egg-trackmania2020.json) |
| tshock |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/terraria/tshock/egg-pterodactyl-tshock.json) |
| tshock legacy |  | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/terraria/tshock/egg-pterodactyl-tshock-legacy.json) |
| Urban Terror |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/urbanterror/egg-pterodactyl-urban-terror.json) |
| Veloren |  | – | Linux | `METRICS_PORT` | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/veloren/egg-pterodactyl-veloren.json) |
| Venice Unleashed |  | – | Wine | `HARMONY_PORT`, `RCON_PORT` | prüfen | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/venice_unleashed/egg-pterodactyl-venice-unleashed.json) |
| Vintage Story | ✅ `vintage-story` | – | Mono/.NET | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/vintage_story/egg-pterodactyl-vintage-story.json) |
| Wine Generic |  | – | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/wine/generic/egg-pterodactyl-wine-generic.json) |
| World of PADMAN |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/world_of_padman/pterodactyl-egg-world-of-p-a-d-m-a-n.json) |
| Xonotic |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/xonotic/egg-pterodactyl-xonotic.json) |
| Zandronum |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/games-standalone/blob/main/doom/zandronum/egg-pterodactyl-zandronum.json) |

## Minecraft (54)

| Spiel | Im Panel | Steam-ID | Laufzeit | Zusatzports | Bewertung | Quelle |
|---|---|---|---|---|---|---|
| Always Auth |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/alwaysauth/egg-pterodactyl-always-auth.json) |
| Attack of the B-Team |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/attack-of-the-bteam/egg-attack-of-the-b--team.json) |
| Blightfall |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/blightfall/egg-blightfall.json) |
| Bungeecord |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/bungeecord/pterodactyl-egg-bungeecord.json) |
| Cuberite |  | – | Linux | `WEB_PORT` | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/cuberite/egg-cuberite.json) |
| CurseForge Generic |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/curseforge/egg-pterodactyl-curse-forge-generic.json) |
| Fabric |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/fabric/egg-pterodactyl-fabric.json) |
| Feather |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/feather/egg-feather.json) |
| Feed the Beast |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/ftb/outdated/egg-feed-the-beast.json) |
| Folia |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/folia/egg-pterodactyl-folia.json) |
| Forge Minecraft |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/forge/pterodactyl-egg-forge-minecraft.json) |
| FTB Revelation |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/ftb/outdated/egg-f-t-b-revelation.json) |
| FTB Server |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/ftb/egg-pterodactyl-f-t-b-server.json) |
| FTB-modpacks.ch Server |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/ftb/outdated/egg-f-t-b-modpacks-ch-server.json) |
| Glowstone |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/glowstone/egg-pterodactyl-glowstone.json) |
| GoMint |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/gomint/egg-go-mint.json) |
| Hexxit |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/hexxit/egg-hexxit.json) |
| Ketting |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/ketting/egg-ketting.json) |
| Krypton |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/krypton/egg-krypton.json) |
| Limbo |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/limbo/egg-limbo.json) |
| Liteloader Bedrock Dedicated Server |  | – | Wine | – | prüfen | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/LiteLoader-bedrock/egg-liteloader-bedrock-dedicated-server.json) |
| Magma |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/magma/egg-magma.json) |
| Modrinth Generic |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/modrinth/egg-pterodactyl-modrinth-generic.json) |
| MohistMC |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/mohist/egg-pterodactyl-mohist.json) |
| NanoLimbo |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/nanolimbo/egg-nano-limbo.json) |
| NeoForge |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/neoforge/egg-pterodactyl-neo-forge.json) |
| Nukkit |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/nukkit/egg-nukkit.json) |
| Paper |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/paper/pterodactyl-egg-paper.json) |
| PocketmineMP |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/pocketmine_mp/egg-pterodactyl-pocketmine-m-p.json) |
| PowerNukkitX |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/PowerNukkitX/egg-power-nukkit-x.json) |
| Purpur |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/purpur/egg-pterodactyl-purpur.json) |
| Purpur-Geyser-Floodgate |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/crossplay/purpur-geysermc-floodgate/egg-pterodactyl-purpur--geyser--floodgate.json) |
| Quilt |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/quilt/egg-pterodactyl-quilt.json) |
| Spigot |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/spigot/egg-pterodactyl-spigot.json) |
| Sponge |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/spongevanilla/egg-pterodactyl-sponge-vanilla.json) |
| SpongeForge |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/spongeforge/egg-pterodactyl-sponge-forge.json) |
| Tekkit |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/Tekkit/egg-pterodactyl-tekkit.json) |
| Tekkit 2 |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/Tekkit-2/egg-pterodactyl-tekkit2.json) |
| Tekkit Classic |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/tekkit-classic/egg-pterodactyl-tekkit-classic.json) |
| Tekkit Legends |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/tekkit-legends/egg-pterodactyl-tekkit-legends.json) |
| Tekkit SMP |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/tekkit-smp/egg-pterodactyl-tekkit-smp.json) |
| The 1.12.2 Pack |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/the-1-12-2-pack/egg-pterodactyl-the1-12-2-pack.json) |
| The 1.7.10 Pack |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/technic/the-1-7-10-pack/egg-pterodactyl-the1-7-10-pack.json) |
| Travertine |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/travertine/egg-pterodactyl-travertine.json) |
| Vanilla Bedrock |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/bedrock/egg-pterodactyl-vanilla-bedrock.json) |
| Vanilla Bedrock ARM64 |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/bedrock/bedrock/egg-pterodactyl-vanilla-bedrock-a-r-m64.json) |
| Vanilla Minecraft |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/vanilla/pterodactyl-egg-vanilla-minecraft.json) |
| VanillaCord |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/java/vanillacord/egg-pterodactyl-vanilla-cord.json) |
| Velocity | ✅ `velocity` | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/velocity/egg-pterodactyl-velocity.json) |
| VIAaaS |  | – | Java | `WEBSERVER_PORT` | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/viaaas/egg-pterodactyl-v-i-aaa-s.json) |
| ViaProxy |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/viaproxy/egg-pterodactyl-via-proxy.json) |
| Waterdog |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/cross_platform/waterdog/egg-pterodactyl-waterdog.json) |
| Waterdog PE |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/bedrock/waterdog_pe/egg-pterodactyl-waterdog-p-e.json) |
| Waterfall |  | – | Java | – | direkt | [Egg](https://github.com/pelican-eggs/minecraft/blob/main/proxy/java/waterfall/egg-pterodactyl-waterfall.json) |

## Sprachserver (6)

| Spiel | Im Panel | Steam-ID | Laufzeit | Zusatzports | Bewertung | Quelle |
|---|---|---|---|---|---|---|
| Gryt Server |  | – | Node | `SFU_PORT`, `ICE_UDP_MUX_PORT` | direkt | [Egg](https://github.com/pelican-eggs/voice/blob/main/gryt/pterodactyl-egg-gryt-server.json) |
| Mumble Server |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/voice/blob/main/mumble/egg-pterodactyl-mumble-server.json) |
| TeamSpeak 3 | ✅ `teamspeak3` | – | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/voice/blob/main/teamspeak/ts3/egg-pterodactyl-teamspeak3.json) |
| TeamSpeak 3 (ARM64) |  | – | Linux | `QUERY_PORT` | direkt | [Egg](https://github.com/pelican-eggs/voice/blob/main/teamspeak/ts3/arm64/egg-pterodactyl-teamspeak3-arm64.json) |
| TeamSpeak 6 | ✅ `teamspeak6` | – | Linux | `TSSERVER_FILE_TRANSFER_PORT`, `TSSERVER_QUERY_SSH_PORT`, `TSSERVER_QUERY_HTTP_PORT` | direkt | [Egg](https://github.com/pelican-eggs/voice/blob/main/teamspeak/ts6/egg-pterodactyl-teamspeak6.json) |
| TS3 Manager |  | – | Linux | – | direkt | [Egg](https://github.com/pelican-eggs/voice/blob/main/teamspeak/ts3_manager/egg-pterodactyl-ts3-manager.json) |

## Direkt eingebaut (in 0.20.0)

Diese Vorlagen waren genauso schnell selbst zu erstellen wie zu beschreiben. Sie liegen deshalb als fertige Panel-Eggs in `eggs/`: konvertiert, mit Steam-Titelbild, deutschen und englischen Namen sowie sinnvollen Ressourcen-Vorgaben.

- `garrys-mod` – Garry's Mod
- `left-4-dead-2` – Left 4 Dead 2
- `counter-strike-source` – Counter-Strike: Source
- `sven-coop` – Sven Co-op
- `insurgency-sandstorm` – Insurgency: Sandstorm
- `squad` – Squad
- `mordhau` – Mordhau
- `unturned` – Unturned
- `barotrauma` – Barotrauma
- `dont-starve-together` – Don't Starve Together
- `the-forest` – The Forest
- `abiotic-factor` – Abiotic Factor
- `soulmask` – Soulmask
- `necesse` – Necesse
- `hurtworld` – Hurtworld
- `astroneer` – Astroneer
- `vintage-story` – Vintage Story
- `space-engineers` – Space Engineers
- `empyrion` – Empyrion: Galactic Survival
- `eco` – Eco
- `arma-reforger` – Arma Reforger
- `euro-truck-simulator-2` – Euro Truck Simulator 2
- `american-truck-simulator` – American Truck Simulator
- `assetto-corsa` – Assetto Corsa
- `velocity` – Velocity

## Bekannte Grenzen

- **Rechnerische Ports:** Manche Spiele öffnen zusätzlich „Spielport + 1“, ohne dafür eine eigene Variable zu haben (z. B. Unturned, einige Source-Spiele). Diese Ports werden nicht automatisch freigegeben. Abhilfe: im Egg einen sekundären Port mit `offset` ergänzen.
- **Steam-Konto:** Für Spiele mit der Bewertung „Steam-Konto“ braucht der Server einen Login. Steam Guard per Mail muss beim ersten Mal bestätigt werden. Am besten ein eigenes Konto nur für Server nehmen.
- **Kein Startmuster:** Ohne `done`-Text springt der Status erst nach dem Timeout (15 min) auf „läuft“. Bis dahin funktioniert der Server trotzdem. Man kann das Muster nachträglich im Egg setzen.
- **Wine/Proton:** Windows-Server laufen, brauchen aber spürbar mehr Ressourcen. Der erste Start kann mehrere Minuten dauern.
- **Datenpfade außerhalb von `/home/container` bzw. `/mnt/server`** (z. B. `/root/...`) lehnt das Panel aus Sicherheitsgründen ab. In dem Fall gibt es oft eine alternative Vorlage, so wie bei Terraria.
- **Ungetestet auf der VM:** Alle Bewertungen stammen aus der Analyse der Egg-Dateien. Der echte Start auf VM 120 steht noch aus.

## Lizenz und Quellen

Die Eggs stammen aus den Repositories von [pelican-eggs](https://github.com/pelican-eggs) und stehen unter MIT-Lizenz. Bei den konvertierten Eggs steht die Herkunft im Feld `_comment`.

- [games-steamcmd](https://github.com/pelican-eggs/games-steamcmd)
- [games-standalone](https://github.com/pelican-eggs/games-standalone)
- [minecraft](https://github.com/pelican-eggs/minecraft)
- [voice](https://github.com/pelican-eggs/voice)

*Die Liste wurde automatisch aus den Egg-Dateien erzeugt. Wenn sich die Sammlungen ändern, kann sie neu generiert werden.*
