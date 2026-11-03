# Pi Web Launcher — development notes

## Scope

Windows Electron entry point for an independently built local Pi Web backend.
Keep startup separate from installation and updates. Never silently download,
replace, or select a different backend. Do not modify the upstream/fork backend
as part of launcher changes. Limited Pi tool modes are backend features, not
an OS sandbox implemented by this launcher.

## Configuration and privacy

- Runtime configuration lives in JSON. Keep safe defaults in `config/` and
  machine-specific settings in the ignored user configuration, not source code.
- Preserve environment-variable overrides for existing installs.
- Never commit real credentials, sessions, logs, backend artifacts or user paths.
- Do not log proxy credentials or model secrets.
- Preserve the existing application ID and user-data directory unless a data
  migration is explicitly designed and approved.

## Verification

- `npm run test:unit` runs self-contained Node tests without Electron or a backend.
- Windows/backend/Electron integration tests have explicit external prerequisites;
  they must not be reported as passed merely because unit tests pass.
- Build new backend artifacts into a new directory; never overwrite a running one.
- Tests must use temporary state and independent ports, not real user sessions.
- Only stop a backend whose process identity and ownership have been verified.
- Do not stop external services or make real model requests without approval.

Use the existing minimal CommonJS style. Avoid unrelated formatting or refactors.
Read `README.md` and `docs/releasing.md` before changing startup or packaging.
