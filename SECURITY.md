# Sicherheitsluecken melden

NexusPanel steuert Docker auf dem Hostsystem. Eine Luecke hier bedeutet im
Zweifel vollen Zugriff auf den Server. Darum: Sicherheitsluecken bitte **nicht**
als oeffentliches Issue melden.

## Weg

1. Auf GitHub unter "Security" -> "Report a vulnerability" (private Meldung), oder
2. per E-Mail an die im Repo hinterlegte Adresse.

Bitte mit dabei: betroffene Version, Schritte zum Nachstellen, und was sich
damit erreichen laesst.

## Was du erwarten kannst

- Eingangsbestaetigung innerhalb weniger Tage
- Rueckmeldung, ob die Meldung nachvollziehbar ist
- Nennung im Changelog, wenn gewuenscht

Dies ist ein privat gepflegtes Projekt ohne Bug-Bounty und ohne zugesagte
Reaktionszeiten.

## Bekannte Risiken by design

- Der Panel-Container hat Zugriff auf den Docker-Socket. Das ist
  Root-gleichwertig auf dem Host und bewusst so gewaehlt.
- Das Recht `file.write` erlaubt faktisch Codeausfuehrung im Spielcontainer.
- Spielcontainer laufen unprivilegiert, aber ein Kernel-Exploit bleibt moeglich.

Wer NexusPanel betreibt, sollte dem Host nichts anderes anvertrauen.
