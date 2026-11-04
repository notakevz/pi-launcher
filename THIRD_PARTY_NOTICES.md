# Third-party notices

Pi Web Launcher code and documentation are licensed under this repository's MIT
license. The project is not an official Pi or Pi Web client and does not claim
ownership of third-party names, trademarks or code.

## Application icon

The application icon (`assets/icon.svg`, and the generated PNG/ICO files) is the Pi
project logo, used unmodified on a transparent background under the Pi project's
MIT License (Copyright (c) 2025 Mario Zechner).
Source: [pi.dev/logo-auto.svg](https://pi.dev/logo-auto.svg) · [earendil-works/pi](https://github.com/earendil-works/pi)

## Desktop runtime and build tools

- [Electron](https://github.com/electron/electron) is used as the desktop runtime.
  Electron includes Chromium, Node.js and other components with their own notices.
  Preserve the license and notice files distributed with Electron when packaging
  or redistributing the application; this repository's MIT license does not replace them.
- [electron-builder](https://github.com/electron-userland/electron-builder) and its
  dependencies are build-time tools. Their licenses remain with their authors.
- Pillow is optional and used only to regenerate the icon PNG/ICO from
  `assets/icon.svg`; it is not bundled with the launcher.

`package-lock.json` pins the dependency graph; dependencies retain their upstream
licenses. This document is an overview, not a replacement for bundled notices.

## External backend

[Pi Web](https://github.com/agegr/pi-web), the configured Pi Web fork and
[Pi](https://github.com/earendil-works/pi) are external projects. Their complete
runtime artifacts, credentials and sessions are not included in this repository
or the launcher's packaging file list. Builds created with the manual backend
script include the backend's own license, which must remain with that artifact.

Do not describe the launcher's MIT license as licensing all external tools,
plugins, model services or backend code.
