# NexusCore auf einer Linux-VM testen (Docker)

Ziel: **Interface → Core → Docker** einmal wirklich laufen lassen. Bisher ist der Docker-Weg nur mit einer
Docker-Attrappe getestet (`tests/docker-*.test.ts`); dieser Test zeigt, ob er mit echtem Docker funktioniert.

## Was du brauchst

* Debian 12 oder Ubuntu 22.04+ (VM oder Server), mindestens 4 GB RAM und 20 GB frei
* Docker Engine (<https://docs.docker.com/engine/install/>), `docker run hello-world` muss gehen
* Node.js **22.13 oder neuer** (<https://nodejs.org>)
* den Quellcode dieses Repositories auf der VM (Ordner `nexuscore`, `web`, `eggs`)
* Internet (Docker lädt Images: Minecraft ca. 400 MB)

## 1. Bauen (auf der VM oder auf dem PC)

```bash
cd nexuscore && npm ci && npm run build
cd ../web && npm ci && npm run build
```

## 2. Einrichten

```bash
sudo bash nexuscore/deploy/linux/install-core.sh --dry-run   # erst ansehen, was passiert (ohne root)
sudo bash nexuscore/deploy/linux/install-core.sh
```

Das legt den Benutzer `nexuscore` an, kopiert alles nach `/opt/nexuscore`, schreibt die Einstellungen nach
`/etc/nexuscore/nexuscore.env` (mit neuem Zugriffstoken) und startet den Dienst. Daten liegen in `/var/lib/nexuscore`.

* Erreichbar nur von der VM selbst (`127.0.0.1:8443`). Von außen: `CORE_HOST=0.0.0.0 sudo -E bash …/install-core.sh`
  und in `/etc/nexuscore/nexuscore.env` `NEXUSCORE_ALLOWED_HOSTS` auf den Namen setzen, unter dem du den Core erreichst.
* Status: `systemctl status nexuscore`, Log: `journalctl -u nexuscore -f`

## 3. Selbsttest

```bash
export NEXUSCORE_TOKEN=$(sudo grep NEXUSCORE_TOKEN /etc/nexuscore/nexuscore.env | cut -d= -f2)
bash nexuscore/scripts/smoke-test.sh
```

Der Test legt einen Minecraft-Server an, startet ihn (beim ersten Mal lädt Docker das Image: `WAIT_START=900` setzen, wenn
es länger dauert), prüft Grenzen und Mount, schickt einen Konsolenbefehl, stoppt ihn mit dem Stop-Befehl und löscht ihn wieder.
**Erwartet: „Alles in Ordnung.“** Mit `KEEP=1` bleibt der Server zum Ansehen stehen.

## 4. Oberfläche und Spiele mit Installation

* Weboberfläche: `http://127.0.0.1:8443` (Anmeldung `admin`, Passwort in `/var/lib/nexuscore/ERSTES-PASSWORT.txt`)
* Ein Spiel **mit** Installationsskript probieren, z. B. *Garry's Mod* oder *Unturned*: Die Installation läuft in einem
  Installer-Container, die Ausgabe erscheint in der Konsole. Danach lässt sich der Server starten.
* Gaming-Modus, Backups, SFTP (`NEXUSCORE_SFTP_ENABLED=true` in der env-Datei) und Dateimanager arbeiten auf demselben
  Server-Ordner wie der Container.

## 5. Mit dem Panel koppeln (Interface → Core)

Kopplungs-PIN holen:

```bash
curl -s -H "Authorization: Bearer $NEXUSCORE_TOKEN" http://127.0.0.1:8443/api/v1/admin/pairing
```

Im Panel unter *Admin → Hosts* einen Core hinzufügen (Adresse des Cores und PIN).

## Wenn etwas nicht klappt

| Meldung / Verhalten | Ursache und Abhilfe |
| --- | --- |
| „Kein Docker-Daemon erreichbar“ im Log | `systemctl status docker`; der Dienst läuft als `nexuscore` mit Gruppe `docker` — nach dem Anlegen der Gruppe `systemctl restart nexuscore` |
| Start hängt lange auf „starting“ | Docker lädt das Image (`docker images`, `journalctl -u nexuscore -f` zeigt Fortschritt in der Konsole des Servers) |
| „port is already allocated“ | Ein anderer Dienst belegt den Spielport; `NEXUSCORE_PORT_RANGE` ändern oder Server-Ports ändern |
| Spiel darf nicht in den Datenordner schreiben | Egg mit `run_as` (z. B. 1000:1000): der Core übergibt den Ordner per `chown` (darf er, `CAP_CHOWN`). Liegt `/var/lib/nexuscore` auf einem NFS/anderen Dateisystem ohne `chown`, geht das nicht |
| Von außen nicht erreichbar | `NEXUSCORE_HOST=0.0.0.0` und `NEXUSCORE_ALLOWED_HOSTS` setzen; Firewall (`ufw allow 8443/tcp`). **Docker veröffentlicht Spielports am Host-Firewall vorbei** (eigene iptables-Regeln) |

## Bekannte Grenzen

* Die Windows-Teile (Dienst `nxsvc`, Tray, Firewall-Freigaben per `netsh`) gibt es unter Linux nicht; dort übernimmt `systemd` den Dienst.
* Der Core ist nach wie vor ein Rechner. Mehrere Hosts unter einer Oberfläche (Tunnel, Cluster) sind Block C.
* Der Dienst-Benutzer ist in der Gruppe `docker` — das ist praktisch Root auf dieser VM. Deshalb: **nichts anderes auf diesem Rechner betreiben.**

## Entfernen

```bash
sudo bash nexuscore/deploy/linux/uninstall-core.sh                     # Daten bleiben
sudo bash nexuscore/deploy/linux/uninstall-core.sh --remove-containers   # plus Spiel-Container
sudo bash nexuscore/deploy/linux/uninstall-core.sh --purge             # plus ALLE Daten
```
