# NexusCore – Rust-Prototyp (Planungsstand)

Dieser Ordner enthält den **frühen Rust-Prototyp** von NexusCore. Er ist Planung,
kein lauffähiger Bestandteil.

Der fertige, lauffähige Core liegt in `../src` (TypeScript) und wird lokal unter
Windows getestet. Die Zielarchitektur für den Rust-Kern steht in
[`docs/ARCHITEKTUR.md`](../../docs/ARCHITEKTUR.md) – dort sind die Meilensteine
M2 bis M5 beschrieben (Dienst `nexuscored`, Kopplung mit mTLS, Windows Job Objects,
Benutzertrennung, Podman, `nxctl`).

## Warum liegt der Code hier und nicht in `src/`?

* Die TypeScript-Implementierung nutzt `src/` als Wurzel – ein Rust-Workspace mit
  eigenem `Cargo.toml` wäre dort nicht baubar (das TypeScript-`tsconfig` schließt
  `src/**/*.ts` ein, `cargo` erwartet ein `Cargo.toml` daneben).
* So bleiben der lauffähige Teil und die Planung sauber getrennt.

## Bekannte offene Punkte (bewusst nicht kaschiert)

Der Prototyp ist **nicht baubar** – auch nicht syntaktisch fehlerfrei:

1. **Doppelte Typdefinitionen.** `ProcessConfig` und `ServerStatus` sind sowohl in
   `src/lib.rs` als auch (in der alten Fassung) in `src/main.rs` definiert.
2. **Falscher Modulpfad.** `src/server.rs` importiert `use crate::core::{ProcessConfig, ServerStatus};`.
   Weder in der Lib (`crate::`) noch im Bin-Crate (`crate::core` existiert dort nicht)
   stimmt dieser Pfad.
3. **Fehlender Linker auf diesem Rechner.** `cargo` braucht für das MSVC-Target
   `link.exe` aus den Visual Studio Build Tools. Die sind hier nicht installiert,
   deshalb bricht schon `cargo check` an den Build-Skripten ab.
   Nachinstallation: Visual Studio Build Tools → „C++-Buildtools“.
4. **Keine API-Oberfläche.** Der Prototyp enthält weder HTTP-Routen noch die
   Treiber-Schnittstelle – er ist ein Gerüst für `ServerHandle`.

## Nächster Schritt

Bevor hier weitergebaut wird, sollte die Panel-Seite (Host-Schicht, Meilenstein M1
aus `docs/ARCHITEKTUR.md`) stehen – dann ist das Protokoll `/core/v1` fest und der
Kern kann dagegen implementiert werden. Die TypeScript-Implementierung in `../src`
liefert diese Protokolldefinition bereits.
