# Changelog

<p align="center">
  <a href="CHANGELOG.md"><b>🇩🇪 Deutsch</b></a> &nbsp;•&nbsp; <b>🇬🇧 English</b>
</p>

All versions of NexusPanel, newest first. The panel displays this file under "What's New" (click the version number in the bottom left).

Version numbering follows [Semantic Versioning](https://semver.org/):
`0.MINOR.PATCH` – MINOR for new features, PATCH for bug fixes.
As long as the version starts with 0, anything can still change. **Version 1.0 will only be released once Dominik considers the panel fully satisfactory** – until then, it continues counting 0.10, 0.11, 0.12 ... (after 0.9 comes 0.10, not 1.0).

Version format (as parsed by the panel):

    ## [1.2.3] - YYYY-MM-DD - Short Title
    ### Added | Changed | Fixed | Security
    - Entry

Until 0.4.x, intermediate revisions were deployed without individual version numbers; they are cataloged here retrospectively based on the development log. Starting with 0.5.0, every deployment receives its own version number.

## [0.24.0] - 2026-11-09 – Per-server bandwidth limits

### Added
- **Bandwidth limit per server (upload/download)**: Admins and owners can now set a per-server bandwidth limit in KB/s for file downloads and uploads (e.g. via `PATCH /api/v1/servers/:id/resources` with `bandwidthDownloadKbps` and `bandwidthUploadKbps`, or newly via the UI under „Settings → Resources“). `null` means unlimited. Throttling is applied at the application layer via a token-bucket stream during file transfers.

## [0.22.1] - 2026-11-07

### Changed
- **VM Files: Server folders with descriptive names.** Under `volumes`, each folder (short ID) now shows its server name and game, e.g. "Simon Ark · ARK: Survival Ascended", including in the storage breakdown. The directories retain their short ID on disk so Docker and the panel address them reliably.
- Folders without an existing database server are flagged as "no server found – leftover of a deleted server" and can be safely deleted to reclaim space.

## [0.22.0] - 2026-11-07

### Added
- **File Manager for the Host VM (Admins only)**: New menu item "Files (VM)" (`/admin/dateien`). Displays all panel directories on the host VM – game data of all servers, backups, test reports (`/var/lib/panel`), and NAS backup shares. Same rich toolset as the server file manager: folder browsing, file editing, uploads/downloads, renaming, deletion, archiving, and extraction.
- **Storage Usage Analyzer**: "Show Storage Breakdown" calculates the size of subdirectories (largest first, click to drill down). Helps quickly clean up full disks.
- Additional roots can be added via `ADMIN_FILE_ROOTS` (e.g. `Panel-Installation=/opt/nxpanel`), provided they are mounted in the panel container. Direct access to `/` of the host is intentionally disallowed.
- Every modifying action is recorded in the audit log (`admin.file.*`). Same strict path verification as the server file manager (no `..`, no outward symlinks).
- Full REST API documentation at `/api/v1/admin/files/...`, verified by `admin-files.test.ts`.

## [0.21.2] - 2026-11-07

### Fixed (from automated game installation tests)
- **Project Zomboid** could not be provisioned ("Invalid values: ADMINPASSWORD"). Mandatory passwords without defaults now automatically receive a secure random password via the new `{{GENERATE_PASSWORD}}` placeholder in eggs. Converted: ARK (Admin password), Abiotic Factor, Assetto Corsa, CS2 (RCON password).
- **Counter-Strike 2:** Removed duplicate variable `CS2_RCON_PASSWORD`. Fixed "state is 0x202" disk space requirement (increased allocation requirement to 64 GB with console advisory).
- **Velocity:** Fixed empty mandatory `USER_AGENT` variable.
- **V Rising:** Added hint for temporary SteamCMD error "Missing configuration" (restart to resolve).
- **7 Days to Die:** Added alerts for full disk and low RAM; storage requirement updated to 30 GB.

### Added
- Installation log warning when available disk space is less than the allocated server storage limit.
- "Disk Full" advice (including SteamCMD code 0x202) for CS2, 7 Days to Die, V Rising, and Project Zomboid.
- Automated egg validation test `bundled-eggs.test.ts` checking for duplicate variables, mandatory fields, and regex alert patterns.

## [0.21.1] - 2026-11-07

### Changed
- **Accelerated Deployment:** Docker images now leverage multi-stage caching for npm packages; version bumps in `package.json` no longer invalidate the `npm ci` layer caches.
- `remote-update.sh` now displays execution elapsed times and polls health every 0.5s instead of 2s.
- `deploy.bat` prints total deployment duration.

## [0.21.0] - 2026-11-07 - Documentation Library & Universal Markdown Viewer

### Added
- **Documentation Library (`/docs`, `/hilfe`)**: New "Documentation (.md)" tab in Help & Docs to browse and inspect all 12 markdown documents (`ARCHITEKTUR.md`, `EGG-KATALOG.md`, `KONZEPT-APPS.md`, `Game-Server-Panel – Konzept & Roadmap.md`, `GAME-INSTALL-TESTS.md`, `TODO.md`, `ENTWICKLUNGSLOG.md`, `CHANGELOG.md`, `README.md`, `VM-INFOS.md`, `SECURITY.md`, `CONTRIBUTING.md`).
- **Universal .md Switcher**: Quick switching between documents across categories, live search, tile overview, and Previous/Next buttons.
- **Structured Markdown Viewer (`MarkdownViewer`)**: Secure GitHub-Flavored-Markdown (GFM) styling with syntax badges, formatted tables, checkboxes, callout alerts, heading anchors, and split view between rendered HTML and raw source.
- **Table of Contents & Actions**: Automatic TOC with jump anchors, 1-click copy, and .md download.
- **File Manager Preview**: .md files in the file editor can toggle between edit mode and rich rendered preview.
- **Global Search (Ctrl+K)**: All markdown documents indexed and directly searchable from Spotlight.

## [0.20.2] - 2026-11-07

### Fixed
- `deploy.bat` failed when local Postgres was offline. Integration tests now log a graceful warning and unit tests proceed.
- `MarkdownViewer` updated for Marked v18 token format, restoring table formatting.

## [0.20.1] - 2026-11-07

### Changed
- **Accelerated SteamCMD Game Downloads:** Appended multi-connection parameters (`+@nClientDownloadEnableHTTP2PlatformLinux 0 +@fDownloadRateImprovementToAddAnotherConnection 1.0 +@cMaxInitialDownloadSources 15`) and auto-generated `steam_dev.cfg` for faster server installs. Configurable via `STEAMCMD_FAST_DOWNLOAD=false`.
- Isolated test database runs against `<name>_test` and Redis DB 15, preventing test runs from interfering with live servers.

## [0.20.0] - 2026-11-07

### Added
- **Egg Catalog** `docs/EGG-KATALOG.md`: All 263 Pelican/Pterodactyl eggs cataloged by category with Steam app IDs, runtimes, port mappings, and evaluation notes.
- **25 New Built-in Games** (converted from MIT Pelican eggs): Garry's Mod, Left 4 Dead 2, Counter-Strike: Source, Sven Co-op, Insurgency: Sandstorm, Squad, Mordhau, Unturned, Barotrauma, Don't Starve Together, The Forest, Abiotic Factor, Soulmask, Necesse, Hurtworld, Astroneer, Vintage Story, Space Engineers, Empyrion, Eco, Arma Reforger, Euro Truck Simulator 2, American Truck Simulator, Assetto Corsa, Velocity.
- **Admin: "Import Game (JSON)"** dialog directly in the game selection modal.

## [0.19.0] - 2026-11-07 - Faster Frontend, Internal RCON & App Concepts

### Changed
- **Faster Startup**: Split code loading with dynamic route imports reduces initial bundle size from 1.1 MB to 0.45 MB; xterm console loads on demand.
- **Security**: RCON for ARK and Palworld kept internal to the Docker network by default.
- **Concept `docs/KONZEPT-APPS.md`**: Cross-platform desktop/mobile companion apps (Tauri 2, Rust) and native Windows installer.

## [0.18.1] - 2026-11-07

### Security
- **Secret Values**: Passwords and keys in game settings are masked for users without write permissions.
- **Minecraft RCON**: Kept internal on the container network.

### Added
- New game templates: **Terraria** (Vanilla & tModLoader), **Project Zomboid**, **Mumble**.

## [0.18.0] - 2026-11-07 - Modpacks: 1-Click Search & Updates, Live Versions & Tooltips

### Added
- **Interactive Help & Documentation (`/hilfe`)**: 5 tabs (Help & FAQ, Changelog, Devlog, Roadmap, System & API).
- **Tooltip System (`Tooltip.tsx`)**: Hover explanations on status badges, power controls, and host metrics.
- **Modpack Browser**: Search **CurseForge, Modrinth, and Feed the Beast** directly when creating servers.
- **1-Click Modpack Updates**: Automatic pre-update backup, version migration, and restart sequence.
- **Game & Modpack Versions**: Visualized across all dashboard views, server headers, and lists.

## [0.16.2] - 2026-11-07 - Multi-User, Co-Users & Granular RBAC

### Added
- **Server Co-Users**: Invite users with presets (*Viewer*, *Operator*, *Manager*, *Co-Admin*, *Custom*) and granular permissions.
- **User Management (`/admin/users`)**: Role assignments, egg whitelisting, and quota budgets.
- **Audit Logging (`/admin/audit`)**: Filterable chronological log of security and management events.

## [0.15.0] - 2026-11-07 - Schedules, Revisions, Storage Targets & UGREEN NAS

### Added
- **Schedules**: Automated recurring tasks (restarts, backups, console commands) via interval or cron.
- **File Revisions**: Automatic snapshot history (up to 25 revisions per file) with diff and 1-click rollback.
- **Storage Targets**: S3, Hetzner Storage Box SFTP, and local/SMB targets.
- **Readable NAS Names**: Backups organized as `<ServerName>/<BackupFile>.tar.zst`.
- **Live Player Lists**: RCON and A2S player queries for ARK, Palworld, Valheim, 7 Days to Die, Sons of the Forest, and CS2.

## [0.14.0] - 2026-11-07 - Storage Quotas, Pruning & UGREEN NAS

### Added
- **UGREEN NAS Sync**: Automatic and manual backup mirroring via SMB/CIFS with one-click restore.
- **Backup Verification**: SHA-256 validation and archive integrity checks.
- **Disk Quotas**: Enforcement of allocated server storage limits.
- **Prune Docker**: One-click cleanup of unused Docker images and build caches for admins.
- **Network Traffic Graphs**: Live 1-hour throughput history per server.

## [0.13.0] - 2026-11-07 - Minecraft Live: Players, TPS, MOTD

### Added
- Live Minecraft telemetry: Player count, TPS with ms/tick, server ping latency, and version.
- Player moderation: Kick, ban (with automatic expiration), operator privileges, and whitelist management.
- Visual MOTD editor with color picker and 64x64 server icon uploader.

## [0.12.0] - 2026-11-07 - File Manager, Backups & Global Spotlight

### Added
- Full web file manager with code editor, syntax highlighting, drag-and-drop upload, and archive extraction.
- Zstandard streaming backup engine (`tar.zst`) with integrity hashing.
- Global Spotlight search (`Ctrl+K`).
- Visual config file editor for `.ini`, `.properties`, `.cfg`, and `.json`.

## [0.6.0] - 2026-11-06 - Modular Multi-Language Architecture

### Added
- Modular localization framework (`web/src/locales/de.json`, `en.json`).
- Language selector in sidebar and login page with automatic browser locale fallback.
- Automated test validation for missing translation keys and placeholders.

## [0.1.0] - 2026-11-05 - Initial Architecture & Container Engine

### Added
- Core architecture (TypeScript, Fastify, PostgreSQL, Redis, Docker Engine).
- Egg parsing, provisioning pipeline, readiness health checks, and port management.
