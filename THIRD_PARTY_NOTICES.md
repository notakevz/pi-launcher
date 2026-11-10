# Third-party notices

Pi Launcher code and documentation are licensed under this repository's MIT
license. The project is not an official Pi or Pi Web client and does not claim
ownership of third-party names, trademarks or code.

## Application icon

The application icon (`ui/icon.svg`, with `src-tauri/icons/icon.png` and `icon.ico`)
is the Pi project logo, used unmodified on a transparent background under the Pi project's
MIT License (Copyright (c) 2025 Mario Zechner).
Source: [pi.dev/logo-auto.svg](https://pi.dev/logo-auto.svg) · [earendil-works/pi](https://github.com/earendil-works/pi)

## Desktop runtime and build tools

- [Tauri v2](https://github.com/tauri-apps/tauri) is the desktop runtime, with
  [wry](https://github.com/tauri-apps/wry) providing the webview. On Windows the
  system WebView2 runtime (Microsoft) is used and is not bundled with the launcher.
  Tauri and wry use MIT / Apache-2.0 licensing; other dependencies retain their
  individual upstream licenses, which are not all replaced by this project's MIT license.
- [tauri-plugin-positioner](https://github.com/tauri-apps/plugins-workspace) (MIT / Apache-2.0)
  anchors the custom tray popover window relative to the tray icon.
- [windows-sys](https://github.com/microsoft/windows-rs) (MIT / Apache-2.0) provides the raw
  Win32 bindings used for process inspection, job objects and the tray icon.
- `@tauri-apps/cli` and NSIS are build-time tools; their licenses remain with their authors.
- `src-tauri/nsis/installer.nsi` is the Tauri CLI 2.12.4 NSIS template, used under
  the MIT license (Copyright (c) 2017 - Present Tauri Apps Contributors), with the
  unconditional Run startup-value deletion removed. Source:
  https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
  Its complete notice is in `src-tauri/nsis/LICENSE-TAURI-MIT` and is bundled as
  `LICENSE-TAURI-MIT`. The CLI version is pinned; template updates require review.
- The PNG/ICO icon files are checked in directly; this version ships no icon generation script.

`package-lock.json` pins the JS tooling and `src-tauri/Cargo.lock` pins the Rust
dependency graph; dependencies retain their upstream licenses. This document is an
overview, not a replacement for bundled notices.

## Packaged license resources

The Tauri bundle configuration uses `../LICENSE` as its license file and maps
`../LICENSE` and `../THIRD_PARTY_NOTICES.md` into the installed resources as
`LICENSE` and `THIRD_PARTY_NOTICES.md`. Preserve both resources and the icon
attribution when changing packaging. The launcher does not bundle the Electron
runtime or a Pi Web backend; independently distributed runtimes and backend
artifacts retain their own license notices.

## External backend

[Pi Web](https://github.com/agegr/pi-web), the configured Pi Web fork and
[Pi](https://github.com/earendil-works/pi) are external projects. Their complete
runtime artifacts, credentials and sessions are not included in this repository
or the launcher's installer. The desktop application never automatically builds,
installs or updates a backend. The optional explicit `scripts/build-source.js`
can build a separately checked-out fork; keep that backend's LICENSE and its
runtime dependencies' notices with the resulting artifact, not in the launcher installer.

Do not describe the launcher's MIT license as licensing all external tools,
plugins, model services or backend code.
