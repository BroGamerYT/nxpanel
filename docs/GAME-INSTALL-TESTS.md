# NexusPanel – Automatisierter Installations- und Start-Testbericht

Automatisch generierter Testlauf aller Spiel-Vorlagen (Eggs) auf VM 120.
Jedes Spiel wird isoliert in einer temporären Instanz installiert, gestartet und nach der Diagnose vollständig aufgeräumt.

*Status:* Noch nicht gestartet oder in Vorbereitung.

Starte den Testlauf im Hintergrund mit:
```powershell
.\deploy.bat test-games
```
Oder verfolge den Fortschritt live mit:
```powershell
.\deploy.bat test-games-logs
```
