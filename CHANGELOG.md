# Changelog

## 0.1.0 — Tauri / WebView2 migration

### 必须手动卸载旧客户端 / REQUIRED migration

**先退出所有旧 Pi Launcher（包括托盘），手动卸载旧安装器安装的客户端，再安装新版。保留启动器配置和 Pi 凭据、会话；不自动迁移 Electron 浏览器数据。**

**Exit ALL old Pi Launcher instances, including the tray. Manually uninstall the OLD installer/client, THEN install the new Tauri version. There is NO automatic upgrade from the old installer. Never run both clients together.**

**Preserve `%APPDATA%\Pi Launcher` configuration (especially `launcher-config.json`) and `.pi` credentials/sessions, including custom data directories. Do not delete these directories during uninstall.**
Electron browser local storage/profile is **not promised to migrate** to WebView2. Browser-only preferences or sign-in state may need to be set again; preserving Pi credentials/sessions is not browser-profile migration.

### Changes

- Replace the Electron desktop runtime and assets with Tauri 2, Rust and the Windows WebView2 runtime. Keep Pi Launcher identity, `local.pi.launcher`, JSON configuration and the external Pi Web backend model.
- Use native Windows process/ownership handling, a loading page and a custom tray popover; keep backend installation and updates explicit and separate from startup.
- Add the tray “开机自启” switch for current-user Windows logon startup. Registration changes only on explicit clicks; show errors and remove only this installation's matching startup entry on uninstall.
- Remove obsolete Electron packaging dependencies, smoke/integration/runtime tests and scripts. Do not claim their historical results as Tauri evidence.
- Retain the optional explicit fork backend builder, manifests, Windows ESM build-test adapters and portable artifact-delivery regression tests without retaining the Electron runtime.
- Separate portable Node release/backend tooling tests from native Windows Rust fmt/test/clippy checks.
- Add read-only version synchronization checks for npm package/lock, Cargo package/lock and explicit Tauri configuration version.
- Keep manual-only fixed-SHA Windows NSIS builds, stable ASCII installer names and SHA-256 checksums. Publish only through a separately opted-in write-permission job; refuse existing tags/releases and preserve failures for manual inspection.
- Retain MIT and third-party notices in packaged license resources. Node.js >=22.19 and the Pi Web backend remain external prerequisites; source builds additionally need Rust >=1.90/MSVC.

This changelog describes source changes, not completed Windows GUI, installation, uninstallation or release acceptance.

## 0.0.2 — Electron

- Rename the product and repository to Pi Launcher / pi-launcher, with application ID `local.pi.launcher`, data directory `Pi Launcher` and environment prefix `PI_LAUNCHER_`.
- Add a tray action to open the active configuration directory, including custom data directories.
- Keep existing user data untouched; no automatic migration or legacy environment-variable fallback.

## 0.0.1 — initial public snapshot

- Prepare Pi Launcher as a standalone MIT project and start public versioning at 0.0.1.
- Move machine-specific runtime options into user JSON with safe defaults.
- Separate self-contained units from optional Windows/backend integration tests.
- Attribute the unmodified Pi project logo in THIRD_PARTY_NOTICES.md.
- Document explicit backend builds, configuration and release evidence boundaries.
- Offer manual Windows x64 builds and opt-in GitHub Release publishing with checksums and no existing-version overwrite.
