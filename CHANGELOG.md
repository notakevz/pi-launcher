# Changelog

## 0.0.2 (unreleased)

- Rename the product and repository to Pi Launcher / pi-launcher, with application ID `local.pi.launcher`, data directory `Pi Launcher` and environment prefix `PI_LAUNCHER_`.
- Add a tray action to open the active configuration directory, including custom data directories.
- Keep existing user data untouched; no automatic migration or legacy environment-variable fallback.

## 0.0.1 — initial public snapshot

- Prepare Pi Launcher as a standalone project and start public versioning at 0.0.1.
- Use Pi Launcher consistently for the app, installer, shortcuts and user-data directory, with application ID `local.pi.launcher` and environment prefix `PI_LAUNCHER_`; no legacy-name compatibility or automatic data migration.
- Move machine-specific runtime options into user JSON with safe, portable defaults.
- Separate self-contained unit tests from optional Windows/backend integration tests.
- Use the Pi project logo (MIT License, attributed in THIRD_PARTY_NOTICES.md) as the application icon, unmodified on a transparent background.
- Document manual backend builds, configuration, verification and release boundaries.
- Offer manual Windows x64 builds with opt-in GitHub Release publishing, checksum verification and no overwriting of existing versions.

This list describes source preparation, not a newly validated Windows binary release.
