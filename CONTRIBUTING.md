# Mitmachen

## Entwicklungsumgebung

```bash
git clone <repo> && cd nxpanel
cp deploy/.env.example deploy/.env   # Werte eintragen
cd deploy && docker compose up -d postgres redis
```

## Grundregeln

- Spielwissen gehoert ins Egg, nie in den Code. Wer ein neues Spiel
  unterstuetzen will, schickt ein Egg, keinen Sonderfall im Backend.
- Jede Datenbankaenderung kommt als Migration. Migrationen duerfen niemals
  rueckwaerts brechen - fremde Betreiber aktualisieren ohne Handarbeit.
- Die API ist versioniert. Breaking Changes nur mit neuer Version.
- Keine Geheimnisse im Commit. Auch nicht testweise.

## Eggs

Eggs kommen als eigener Pull Request, ein Egg je PR, mit dem Namen des Spiels
im Titel. Bitte angeben, womit getestet wurde (Spielversion, RAM, Spielerzahl).

## Commits

Kurze Praefixe: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.
