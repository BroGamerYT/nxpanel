# NexusCore – Aufgaben

Was ansteht und was erledigt ist. Die Oberfläche zeigt diese Datei unter „Hilfe & Doku → Geplant“.

Format: `- [ ] Aufgabe` offen, `- [x] Aufgabe (0.3.2)` erledigt mit der Version, in der es kam.

## Bis 1.0

1.0 gibt es erst, wenn Dominik den Core für fertig erklärt.

- [x] Core ersetzt das Panel 1:1 auf Linux (Docker-Treiber, getestet auf VM 120) (0.3.0)
- [x] Windows-Dienst, Firewall je Spielprogramm und MSI-Installer (0.2.0)
- [x] Übernahme der Daten aus dem alten Panel (Benutzer, Server, Backups, Steam-Konten) (0.2.0)
- [x] Gesamttestlauf über alle 47 Spiele auf dem echten Core (0.3.2)
- [ ] Doku fertig schreiben (Installation, Betrieb, Fehlerbilder)
- [ ] Installation auf einer frischen Hyper-V-VM mit dem Installer testen
- [ ] Windows: MSI-Installation und Direktbetrieb (`windows-native`) in der Windows-Sandbox / Hyper-V prüfen
- [ ] macOS-Installer auf einem echten Mac testen

## Spiele

- [x] Satisfactory und V Rising: Steam-Wiederholung beim Start (0.3.1)
- [x] Sven Co-op startet wieder (0.3.2)
- [ ] Astroneer startet unter Proton nicht (Code 0 ohne Log), vermutlich CPU/Proton – auf einem Rechner mit AVX2 prüfen
- [ ] The Bus braucht eine CPU mit AVX2 (Test auf anderem Rechner)
- [ ] Left 4 Dead 2, Farming Simulator 25, Assetto Corsa brauchen ein Steam-Konto mit Lizenz – mit echtem Konto testen
- [ ] Steam-Wiederholung auch beim normalen Start (nicht nur im Testlauf)
- [ ] ATM11-Modpack nach „Neu installieren“ prüfen

## Betrieb

- [ ] Steam-Guard „Testen“ für die zwei Steam-Konten (nur der Besitzer kann den Code bestätigen)
- [ ] ARK und TeamSpeak mit echten Spielern
- [ ] Hetzner-DNS und S3-Backup-Ziel mit echten Zugangsdaten testen
- [ ] Oberfläche in allen Bereichen im Browser durchgehen
