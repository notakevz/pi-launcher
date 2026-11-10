# Pi Launcher — instructions for AI assistants

普通用户入口是 [README.md](README.md)。README 仅写用途、安装、配置和日常使用，不写测试命令、验收报告或内部实现。

## 先阅读

1. [README.md](README.md)：用户流程及 **0.1.0 手动迁移要求**。
2. [config/README.md](config/README.md)：配置字段、覆盖优先级与示例。
3. [docs/ai-maintenance.md](docs/ai-maintenance.md)：开发、测试及证据边界。
4. [docs/releasing.md](docs/releasing.md)：构建与发布操作，涉及打包时必读。

## 帮用户部署

- 先检查环境与现有服务，不照搬路径。安装版需要 Windows 10/11 x64、原生 Node.js >=22.19、WebView2 Runtime；源码还需 Rust stable >=1.90、MSVC C++ Build Tools、Windows SDK 和 Git。
- **从旧 Electron 安装版迁移：先退出所有旧 Pi Launcher（含托盘），手动卸载 OLD 安装器/客户端，再装新 Tauri 版。无旧安装器自动升级，不同时运行两个客户端。**
- 保留 `%APPDATA%\Pi Launcher` 配置及 `.pi` 凭据/会话（包括自定义目录），不通过删除数据来迁移。Electron browser local storage/profile 不保证迁移到 WebView2，不承诺免登录或保留页面偏好。
- 没有 fork 需求时推荐 npm `@agegr/pi-web`；用 `npm root -g` 找实际包目录。fork 使用 `notakevz/pi-web` 的 `local/customizations`，先确认版本，再手动构建到新目录；不擅自换成上游。
- Pi CLI 可选。Web 已依赖 Pi SDK，不无条件安装 CLI，也不把 CLI 的 `--ignore-scripts` 照搬给 Web。
- 个人设置写 `%APPDATA%\Pi Launcher\launcher-config.json` 或 `PI_LAUNCHER_DATA_DIR`，已有配置先读比较，覆盖前获准。不要把本机路径、密钥、代理账号写进源码。
- `backendPath` 指向 npm 包根目录或完整 fork 运行产物，不是 checkout、npm root 或 CLI 文件；`cwd` 必须存在。专用 `PI_LAUNCHER_` 环境变量覆盖 JSON。
- 网络按实际环境配置，不猜端口、不关闭 TLS 校验。后端回环直连；后端代理、系统 WebView2 代理和构建终端代理是不同边界。不修改 Windows 系统代理或外部服务环境。
- 不清空凭据、会话、浏览器 profile 或 npm 缓存，不全局结束 Node。停止服务、覆盖配置、迁移数据或修改系统设置前获准，先验证进程身份与所有权。
- 实际桌面验收须验证页面、所选后端、关闭隐藏、再次唤回、退出清理和重开配置。模型请求会产生费用，先获准；缺少桌面或 Windows 时说明未验。
- 模型认证与扩展属于 Pi Web/Pi，不放启动器 JSON；只使用已审查的外部扩展。
- 交付实际目录、版本、运行结果与未验项，脱敏日志。构建安装器、提交、推送、打标签、发布各须单独授权；不要自行触发。

## Architecture and change boundaries

- Windows Tauri 2 / Rust launcher, static `ui/` frontend and system WebView2. No Electron runtime.
- Application identity: Pi Launcher, `local.pi.launcher`, data directory `Pi Launcher`, launcher environment prefix `PI_LAUNCHER_`.
- Keep startup separate from backend installation/updates. Never silently download, replace or select another backend. No automatic old-installer upgrade.
- Do not modify the backend repository as part of launcher changes without separate authorization. Tool modes are backend features, not an OS sandbox.
- Rust owns configuration, health checks, process ownership, windows and tray. Remote Pi Web must not gain Tauri IPC privileges.
- `scripts/build-source.js`, `backend-build-tools.js`, `backend-manifest.js`, `windows-test-*.mjs` and `config/backend-build.json` are optional explicit fork build tooling only; never call them during app startup.
- Preserve third-party attribution and packaged `LICENSE` / `THIRD_PARTY_NOTICES.md` resources. Do not reintroduce Electron to keep obsolete tests passing.
- Never commit credentials, sessions, logs, backend artifacts, browser profiles, caches or real user configuration. Do not log secrets.
- Never stop an external backend by guessing; verify identity and ownership before stopping a launcher-owned process.
- Build Windows is manual-only, fixed-SHA, read-only. Publishing is opt-in in a separate `contents: write` job, bound to built SHA/checksums, refusing existing tags/releases and failing closed on API errors.
- Keep scripts minimal CommonJS with Node built-ins. Avoid unrelated refactors and new dependency frameworks.

## Verification rules

- Node tools tests, Windows Rust tests, desktop behavior and packaged installer acceptance are separate evidence levels.
- `npm test` tests release/backend tooling, not the application runtime. Run Windows Rust fmt/test/clippy separately as documented.
- Use temporary state, isolated Pi data and independent ports. Do not use real sessions or credentials as fixtures.
- Missing prerequisites are not a pass. Old Electron results do not validate Tauri; Linux Node checks do not validate Win32 Rust or the EXE.
- Record actual commands/outcomes in the task report, not README. Do not invent success rates or claim CI ran merely because YAML exists.
- Build backend artifacts into fresh directories, never overwrite running installations or delete failure-recovery artifacts automatically.
- Synchronize package.json, npm lock root versions, Cargo package/lock entry and explicit Tauri version; version checks must not rewrite Cargo.lock.
