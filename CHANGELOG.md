# Changelog

## 0.0.1 — initial public snapshot (unreleased)

- Prepare Pi Web Launcher as a standalone project and start public versioning at 0.0.1.
- Use Pi Web Launcher consistently for the app, installer, shortcuts and user-data directory, with application ID `local.pi.web.launcher` and environment prefix `PI_WEB_LAUNCHER_`; no legacy-name compatibility or automatic data migration.
- Move machine-specific runtime options into user JSON with safe, portable defaults.
- Separate self-contained unit tests from optional Windows/backend integration tests.
- Replace the upstream official logo with original project artwork.
- Document manual backend builds, configuration, verification and release boundaries.
- Offer manual Windows x64 builds with opt-in GitHub Release publishing, checksum verification and no overwriting of existing versions.

This list describes source preparation, not a newly validated Windows binary release.
