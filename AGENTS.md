# Pi Web Launcher — instructions for AI assistants

本文件面向协助用户部署、维护和开发的 AI。普通用户入口是 [README.md](README.md)。
**README 只写产品用途、安装、配置和日常使用，不写测试命令、验收报告或内部实现细节。**

## 先阅读

- 人类使用流程：[README.md](README.md)。
- 配置字段和示例：[config/README.md](config/README.md)。
- 开发、测试及证据边界：[docs/ai-maintenance.md](docs/ai-maintenance.md)。
- Windows 构建/发布操作：[docs/releasing.md](docs/releasing.md)，部署涉及构建或打包时必读。

## 帮用户部署

1. **先检查，不照搬路径。** 使用 Windows 原生 Node.js >=22.19、npm；源码构建还需 Git。
   检查现有启动器、Pi Web 服务、安装目录、Node/npm 位置和配置。缺少的信息集中询问用户。
2. **明确后端路线。** 没有 fork 定制需求时优先推荐 npm 版 `@agegr/pi-web`，用
   `npm root -g` 确定实际安装目录。需要定制时使用 `notakevz/pi-web` 的
   `local/customizations` 分支，先确认目标版本，再构建到新目录。不要擅自把 fork 换成上游。
3. **Pi CLI 是可选的。** Web 已依赖 Pi SDK；只有用户还需要独立的 `pi` 命令时才全局安装 CLI。
   Web 与 CLI 的安装脚本要求不同，不要无条件把 CLI 的 `--ignore-scripts` 用在 Web 安装上。
4. **网络按本机实际情况配置。** 检查已有代理配置，不能确定时询问用户；不要猜测端口，
   不关闭 TLS 校验。安装/构建终端的网络和应用运行时的 JSON 代理设置是两件事。
   后端回环访问直连。应用配置不会修改 Windows 系统代理，也不会改变外部已运行服务的环境。
5. **个人设置写用户 JSON。** 配置路径为 `%APPDATA%\Pi Web Launcher\launcher-config.json`；
   若设置 `PI_WEB_LAUNCHER_DATA_DIR` 则用该目录。不要把本机路径、凭据或代理账号写进源码默认值。
   使用 UTF-8 无 BOM 写入标准 JSON；已有文件先读取比较，覆盖前取得用户确认。
6. **检查路径和覆盖优先级。** `backendPath` 指向 npm 包根目录或 fork 的完整运行产物，
   不是 Git checkout、全局 npm root 或 CLI 文件。`cwd` 必须存在，Node 路径可自动发现。
   专用环境变量会覆盖 JSON；排除旧环境变量导致的误配置。
7. **保护已有环境。** 不清空凭据、会话、Electron 存储或 npm 缓存，不全局结束 Node。
   停止已有服务、覆盖配置、迁移数据或修改系统级设置前必须征得同意。
   端口优先用配置默认值；发生冲突先确认所有者，不误杀无关程序。
8. **验证用户实际会用的入口。** 有 Windows 环境且获准操作时，检查客户端页面、所选后端、
   关闭隐藏、再次唤回、退出清理及重开后的配置。真实模型请求会使用账号/费用，必须先取得许可。
   缺少桌面或 Windows 时说明限制，不声称已验收 EXE。
9. **模型与扩展分开配置。** 模型凭据由 Pi Web/Pi 管理，不放到启动器 JSON。
   用户需要额外扩展时，先确认来源和后端兼容性，不复制未知代码或绕过权限策略。
10. **交付简明记录。** 告知实际安装/后端/配置/日志目录、版本、代理配置位置、运行结果及未验项目；
    不输出密钥或完整认证代理 URL。只有用户需要安装包时才打包，不自行发布 Release。

## Architecture and change boundaries

- Windows Electron entry point for an externally installed or locally built Pi Web backend.
- Keep startup separate from installation and updates. Never silently download, replace or select a different backend.
- Do not modify the backend repository as part of launcher changes without a separate task basis.
- Limited Pi tool modes are backend features, not an OS sandbox implemented by this launcher.
- Use one product identity: Pi Web Launcher, application ID `local.pi.web.launcher`, data directory `Pi Web Launcher`.
- Version 0.0.1 has no legacy-name aliases, fallback directories or automatic migration. Do not move or delete existing user data.
- Runtime configuration lives in JSON; keep safe defaults in `config/` and personal settings outside source.
- Launcher-specific environment variables use only `PI_WEB_LAUNCHER_`. Do not log proxy credentials or model secrets.
- Never commit credentials, sessions, logs, backend artifacts, thumbnail caches or real user configuration.
- Only stop a backend whose process identity and ownership have been verified; never stop external services by guessing.
- Use the existing minimal CommonJS style. Avoid unrelated formatting, refactors and feature expansion.

## Verification rules

- Self-contained Node units, Windows/backend integration, Electron UI and packaged EXE are separate evidence levels.
- Tests use temporary state and independent ports, not real user sessions.
- Missing prerequisites are not a pass. An old client's successful Windows run does not validate later changes.
- Record actual commands and outcomes in the task report, not the user README; do not invent success or percentages.
- Build new backend artifacts into a fresh directory. Never overwrite a running installation.
- Read the maintenance documents above before changing startup, backend checks, packaging or tests.
