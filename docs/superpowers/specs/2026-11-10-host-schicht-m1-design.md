# Host-Schicht im Panel (M1) – Design-Spezifikation

**Datum:** 10.11.2026
**Status:** Freigegeben
**Bereich:** Panel-Repo „Gameserver Interface“ (NexusPanel 0.25.0), Meilenstein M1 aus `docs/ARCHITEKTUR.md`

---

## 1. Ziel

M1 legt die Host-Schicht im Panel: jeder Server gehört zu einem Host, und ein Host ist
entweder `local` (der heutige Docker-Code im Panel) oder `core` (ein gekoppelter
NexusCore). Grundlage ist der bereits fertige NexusCore-Prototyp in `nexuscore/`
(Protokoll `/core/v1`, Token-Auth, Echtzeit-Stream).

Nicht-Ziele dieses Durchgangs: mTLS und eigene CA (M2), Installation von Panel-Servern
auf einem Core (braucht Dateien/Backups auf dem Core, M5), Job Objects und
Windows-Benutzertrennung (M3).

## 2. Ausgangslage (geprüft)

* Das Panel hat **bereits** eine `nodes`-Tabelle (`id, name, fqdn, docker_socket, daemon_token,
  ram_total_mb, disk_total_mb, public_ip, public_host, port_from, port_to`) und
  `servers.node_id` sowie `allocations.node_id`.
* `GET/PATCH /api/v1/admin/nodes` und die Permission `admin.nodes` existieren bereits
  (`src/http/routes/admin.ts`, `src/auth/permissions.ts`).
* `src/docker/client.ts` hat ein `ContainerEngine`-Interface mit `LocalDockerEngine` und
  der Singleton `engine` – die heutige Ausführungsebene.
* `src/servers/nodes.ts` legt beim Start genau einen lokalen Node an (`ensureLocalNode`).
* `src/crypto.ts` hat `encrypt`/`decrypt` (AES-256-GCM, Schlüssel aus `ENCRYPTION_KEY`).

**Konsequenz:** Die im Plan genannte Tabelle `hosts` wird **nicht** neu angelegt, sondern
`nodes` wird erweitert. Eine zweite Tabelle für denselben Begriff wäre zwei Wahrheiten
für dieselbe Sache und würde jede Zuordnung doppelt buchen.

## 3. Datenmodell

Migration `0029_host_layer.sql`:

| Spalte in `nodes` | Typ | Bedeutung |
| --- | --- | --- |
| `type` | `local` \| `core` | Art des Hosts (Default `local`) |
| `address` | TEXT | Adresse des NexusCore (nur bei `core`) |
| `runtime` | `docker` \| `podman` \| `windows-native` \| `mock` | Laufzeit auf dem Host |
| `status` | `online` \| `offline` \| `unreachable` \| `unknown` | Erreichbarkeit |
| `cert_fingerprint` | TEXT | Fingerabdruck des TLS-Zertifikats (mTLS, M2) |
| `token_encrypted` | TEXT | **verschlüsseltes** Core-Token (`src/crypto.ts`) |
| `last_seen_at` | TIMESTAMPTZ | letzte erfolgreiche Abfrage |
| `ram_used_mb`, `disk_used_mb`, `cpu_percent` | Zahl | aktuelle Auslastung des Hosts |

Dazu `servers.runtime` (Default `docker`) – welche Laufzeit der Server nutzt.

Bestandsdaten bleiben unangetastet: `type` ist per Default `local`, der vorhandene
lokale Node funktioniert unverändert.

## 4. Code-Struktur

```
src/hosts/
├── types.ts       Host-Interface und gemeinsame Typen
├── local-host.ts  LocalHost – Adapter auf den heutigen Docker-Code
├── core-host.ts   CoreHost – HTTP-Client für das NexusCore-Protokoll /core/v1
├── registry.ts    Host-Auflösung, Anlegen/Ändern/Löschen von Core-Hosts
└── monitor.ts     Hintergrund-Job: Status und Ressourcen der Core-Hosts
```

### 4.1 `Host`-Interface (M1-Umfang)

```ts
export interface Host {
  readonly id: string;
  readonly type: HostType;
  readonly runtime: HostRuntime;
  info(): Promise<HostInfo>;                       // Name, Plattform, Version
  listServers(): Promise<HostServer[]>;            // Instanzen auf dem Host
  power(serverId: string, action: 'start'|'stop'|'kill'): Promise<void>;
  stats(serverId: string): Promise<HostServerStats>;
  logs(serverId: string, limit?: number): Promise<HostLogLine[]>;
}
```

Bewusst ohne `files`, `backups` und `query`: diese liegen auf dem Core und kommen mit M5.

### 4.2 LocalHost

Adapter auf `engine` und die Datenbank – keine Verhaltensänderung für bestehende Server:

* `listServers()`: `SELECT … FROM servers WHERE node_id = $1`
* `power()`: `engine.start` / `engine.stopGraceful` / `engine.kill` auf `container_id`
* `stats()`: Zustand aus der Datenbank, CPU/RAM über einen einzelnen `engine.streamStats`-Wert
* `logs()`: `engine.tailLogs(containerId, lines)`

### 4.3 CoreHost

Client für das NexusCore-Protokoll, das in `nexuscore/` steht:

| Methode | Aufruf |
| --- | --- |
| `info()` | `GET /core/v1/info` |
| `listServers()` | `GET /core/v1/servers` |
| `power()` | `POST /core/v1/servers/:id/{start,stop,kill}` |
| `stats()` | `GET /core/v1/servers/:id/stats` |
| `logs()` | `GET /core/v1/servers/:id/logs?limit=` |

Authentifizierung mit `Authorization: Bearer <token>`; das Token liegt verschlüsselt in
`nodes.token_encrypted` und wird nur zur Laufzeit entschlüsselt. Zeitlimit 5 s pro
Anfrage, Fehler des Cores werden als lesbare Fehlermeldung durchgereicht.

### 4.4 Anlegen eines Core-Hosts

Der Admin trägt Adresse, Token und optional die PIN ein. Das Panel prüft die Verbindung
echt, bevor etwas gespeichert wird:

1. `POST {adresse}/core/v1/pair` mit der PIN → der Core nennt den Fingerabdruck seines Tokens.
2. Das Panel bildet `sha256(token).slice(0,12)` und vergleicht. **Nur bei Übereinstimmung**
   wird der Host gespeichert – so kann ein Core nicht mit einem falschen Token
   untergeschoben werden.
3. Ohne PIN genügt ein erfolgreicher `GET /core/v1/servers` mit dem Token.
4. Das Token wird mit `encrypt()` gespeichert, nie im Klartext und nie im Log.

## 5. API

Unter `/api/v1/admin/hosts` (nur Admin, passend zu `/admin/nodes`):

| Methode | Endpunkt | Beschreibung |
| --- | --- | --- |
| GET | `/admin/hosts` | alle Hosts mit Status, Ressourcen, Serveranzahl |
| POST | `/admin/hosts` | Core-Host anlegen (Adresse, Token, optional PIN) |
| PATCH | `/admin/hosts/:id` | Name, Adresse oder Token ändern (wird erneut geprüft) |
| DELETE | `/admin/hosts/:id` | Core-Host entfernen (nur wenn keine Server daran hängen) |
| GET | `/admin/hosts/:id/servers` | Instanzen des Hosts |
| POST | `/admin/hosts/:id/check` | Status sofort neu abfragen |

`GET /admin/nodes` bleibt unverändert und liefert weiter die bestehenden Netzwerkdaten.

## 6. Web-Oberfläche

Neue Seite `/admin/hosts` (Permission `admin.nodes`, sichtbar in der Seitenleiste):

* Tabelle aller Hosts: Name, Typ, Adresse, Status (LED), Laufzeit, RAM, CPU, Server, Aktionen
* Formular „Core-Host hinzufügen“: Name, Adresse, Token, PIN
* Aktionen: Status prüfen, Token erneuern, Host entfernen

Texte in `web/src/locales/de.json` und `en.json`.

## 7. Tests (Vitest, echte Testdatenbank)

* `tests/hosts.test.ts`:
  * `CoreHost` gegen einen kleinen HTTP-Server, der das NexusCore-Protokoll nachbildet –
    inklusive Auth-Fehler (401) und Timeout.
  * `createCoreHost`: Fingerabdruck stimmt nicht → kein Host gespeichert; stimmt → gespeichert
    und Token verschlüsselt in der Datenbank (Klartext taucht nirgends auf).
  * API-Routen: Anlegen, Liste, Ändern, Löschen, 401/403 ohne Admin.
  * `LocalHost` gegen eine Attrappe des `engine`.

## 8. Reihenfolge

1. Migration `0029_host_layer.sql`
2. `src/hosts/types.ts`, `local-host.ts`, `core-host.ts`, `registry.ts`, `monitor.ts`
3. `src/http/routes/hosts.ts` + Registrierung in `src/http/server.ts` + `openapi.ts`
4. `src/index.ts`: Monitor starten
5. Tests
6. Web-Seite, Route, Navigation, Locales
7. Verifikation: Typecheck, Tests, Build, manueller Durchlauf

## 9. Abnahmekriterien

- [ ] `npm run typecheck` im Panel ohne neue Fehler
- [ ] `npm test` im Panel vollständig grün (keine bestehende Testdatei geändert)
- [ ] `npm run build` (Panel und `web`) erfolgreich
- [ ] Core-Host lässt sich anlegen, wird mit Status und Ressourcen angezeigt, Token liegt verschlüsselt in der Datenbank
- [ ] Falsches Token → kein Host gespeichert, verständliche Fehlermeldung
- [ ] Bestehender lokaler Node verhält sich exakt wie vorher
