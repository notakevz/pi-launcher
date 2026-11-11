# AI 维护说明：Tauri 实现、测试和证据

先读 [AGENTS](../AGENTS.md)。用户流程见 [README](../README.md)，字段见 [配置指南](../config/README.md)，
打包与发布见 [releasing](releasing.md)。README 不放测试清单或机器运行历史。

## 实现与工具入口

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/` | Rust 应用：配置、Node/后端检查、健康探测、进程身份与所有权、窗口和托盘 |
| `src-tauri/Cargo.toml` / `Cargo.lock` | Rust 包版本、最低 Rust 1.90 与锁定依赖 |
| `src-tauri/tauri.conf.json` | Tauri 应用身份、版本、静态资源、安全与 NSIS 打包配置 |
| `ui/` | 加载页、Vue 3/PrimeVue 托盘与组件测试；Vite 编译到 `.build/ui/`，不加载 CDN |
| `vite.config.mjs` / `vitest.config.mjs` | 多页前端构建、完整生产依赖许可收集、jsdom 真实组件测试 |
| `playwright.config.mjs` / `tests/ui/` | 独立 Edge 布局/交互验证，不运行 Tauri 或真实注册表 |
| `src-tauri/src/tray_layout.rs` | 严格尺寸信号解析、逻辑像素/DPI 与显示器工作区限幅 |
| `src-tauri/src/autostart.rs` | 当前用户 Run 启动项读取、显式切换及 mock 回归；不开放远程 IPC |
| `src-tauri/nsis/hooks.nsh` | 真正卸载时仅删除与本次安装 EXE 命令匹配的启动项，更新时保留 |
| `src-tauri/nsis/installer.nsi` | 固定 CLI 2.12.4 模板，去掉默认无条件 Run 删除逻辑；升级 CLI 时审查模板差异及许可 |
| `config/launcher-defaults.json` | 内嵌安全默认值，个人设置在应用数据目录 |
| `scripts/build-source.js` | 可选的、显式手动 fork 构建，输出生产依赖与 source-release.json |
| `scripts/backend-build-tools.js` | 构建专用 Windows Node/npm 发现与环境净化，不是旧 JS 应用运行时 |
| `scripts/backend-manifest.js` / `verify-backend.js` | 显式清单完整性验证，不参与应用启动 |
| `scripts/windows-test-imports.mjs` / `windows-test-loader.mjs` | fork 构建测试的 Windows ESM 绝对路径适配 |
| `scripts/check-version.js` | 比较 package、npm lock、Cargo package/lock、Tauri 显式版本，只读 |
| `scripts/stage-installer.js` | 默认在 Tauri 原生 bundle/nsis 目录生成校验和，不复制 EXE；仅 CI 显式指定 runner 临时目录时准备 ASCII 发布附件 |
| `scripts/publish-release.js` | 附件白名单、哈希、固定 SHA、拒绝已有版本、草稿上传后公开 |

原 Electron `src/`、`assets/`、Electron 构建依赖/配置和相关 JS 运行时测试已移除。
不保留 Electron 作为兼容运行时，也不把旧测试改名后当作 Tauri 覆盖。
后端 builder 不依赖这些已删除文件；只使用 Node 内置模块，fork 自身依赖在显式构建时安装。

## 开发前提与运行

Windows 10/11 x64，原生 Node >=22.19、npm、Git、Rust stable >=1.90（`x86_64-pc-windows-msvc`），
Visual Studio 2022 C++ Build Tools / Windows SDK，WebView2 Runtime。
不要用 WSL 编译结果冒充 Windows 验证；crates 镜像/代理是本机偏好，不提交机器级 Cargo 配置。

```powershell
npm ci
npm run dev
```

`npm run dev` / 安装器构建会先由 Tauri hook 执行 `npm run build:ui`，将两页和前端许可输出到忽略的 `.build/ui/`，再由 Rust 嵌入；不新增本地安装包交付目录。单独运行 Cargo 检查前也须构建 UI。刷新窗口不替代重新编译。开发运行也会管理实际后端，
先选择隔离配置与后端目录，避免抢占真实客户端端口/进程记录。

## 自动检查与证据边界

### 1. Node release/backend tools（可移植）

```powershell
npm run check:version
npm run check:syntax
npm run test:tools
```

`npm run test:tools` 只运行：

- `scripts/test-release-unit.js`：mock GitHub API、分页/草稿/标签冲突、失败保留、白名单、symlink、校验与迁移文案。
- `scripts/test-backend-tools.js`：repository 规范化、清单哈希/安全路径、构建环境、交付跨盘/竞争/失败保留。
- `scripts/test-version-unit.js`：所有版本一致与缺失/错配拒绝，不修改锁文件。
- `scripts/test-stage-unit.js`：本地原地校验、CI 临时附件命名/哈希、拒绝多产物或覆盖已有 CI 暂存目录。
旧 `scripts/test-tray-unit.js` fake DOM 测试已移除，改为下述真实组件与浏览器检查。

这些检查不启动真实 Pi Web、不下载 Electron、不调用模型，也不是应用配置或 Win32 行为回归。
符号链接测试在缺少 Windows symlink 权限时可明确 skip；不要把 skip 计为已验证。

### 2. Vue/PrimeVue 与实际浏览器布局

```powershell
npm run build:ui
npm run test:ui
npm run test:ui:layout
```

`npm test` 组合工具检查与 Vitest/jsdom 组件检查。组件测试挂载真实 PrimeVue 控件，验证原生状态回放、默认不登记自启、未知/错误提示、防双击及尺寸测量。
布局测试使用本机安装的 Microsoft Edge（Playwright `msedge`），新建隔离浏览器上下文，只打开本地构建页并模拟 native 信号；不连接 Pi Web、不读写 Run、不复用浏览器 profile。覆盖明暗主题、125%/150% DPR、双倍字号、小工作区、无正常滚动条及底部留白、悬停/焦点不改变尺寸、真实点击/Space/Esc 和 CSP。结果与预览图在 `.build/playwright/`。

浏览器测试不等于真实托盘定位、Windows 登录、安装/卸载验收；未运行时不能将组件测试当作布局证据。

### 3. Rust Windows 应用检查

在原生 Windows 工具链执行：

```powershell
npm run build:ui
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings
```

Rust 代码使用 Win32 API，不提供假装等价的 Linux Rust 测试路线。缺少工具链/网络依赖就记录未运行。
GitHub push/PR 的 Source checks 在 Windows 执行两层检查，不等于桌面或安装器验收。

配置/启动修改应覆盖：环境覆盖优先级、非法类型/路径、代理严格校验与秘密不回显、npm/fork 布局、
外部健康服务复用、HTTP 总 deadline、响应限长、取消/超时、身份验证、清理失败不误杀等。
Rust fixture 通过也不代表真实 npm 安装、真实模型请求或 Windows 桌面通过。

## 显式 fork 后端构建

构建保留 `config/backend-build.json` 的通用设置；不在启动时调用，不自动拉取/切换 backend。
需要干净的 fork checkout 与正确 origin，默认与启动器同级 `../pi-web`。

```powershell
npm run build:source -- --source C:/src/pi-web --commit <完整40位SHA> --output release/backend-next
npm run backend:verify -- release/backend-next
```

脚本在临时 worktree 安装依赖、运行指定范围测试、typecheck、lint、Next 生产构建，输出完整运行目录和清单。
`windows-core` 只是选定核心测试，不是 fork 全量认证。构建命令支持 `--test-scope full`。
Next 构建与测试使用隔离 Pi 数据/构建 profile，不碰真实凭据/会话；安装依赖使用终端代理，不关闭 TLS。
目的目录必须全新，跨盘交付会暂存；交付失败保留完整产物和部分输出供人工核对，不自动删除恢复材料。
旧 `backend:check` 已移除；`backend:verify` 必须显式传入有 `source-release.json` 的构建产物，
不隐式读取用户 JSON。npm 发布后端没有该清单正常，不要因此拒绝应用启动。

## 安全、数据与诊断

- Rust 管理配置、进程与窗口；加载页/托盘不应暴露 Tauri IPC 给远程 Pi Web。Vue 通过受限 `window.open` 信号握手和上报尺寸，尺寸只在本地 tray webview 处理，并限制范围；不开启远程 IPC 或开发服务器来源。
  `withGlobalTauri` 关闭、capabilities 保持最小；远程页面 CSP 由后端响应决定。
- `%APPDATA%\Pi Launcher`（或 `PI_LAUNCHER_DATA_DIR`）保留配置、日志、进程记录；
  `%LOCALAPPDATA%\Pi Launcher\webview2` 是独立 WebView2 profile，不能共用 Electron profile。
- 0.1.0 无旧安装器自动升级。必须先退出所有旧实例、手动卸载旧客户端，再装新版；保留配置和 `.pi` 数据。
  不承诺 Electron browser local storage、profile、页面偏好或浏览器登录状态迁移。
- 启动错误看活动数据目录的 `launcher.log`。日志带相对时间；后端输出以 `[pi-web]` 标记。
  `Health check` 的 HTTP 次数和耗时用于区分 Node 启动、端口监听和 Next 首次路由加载；不硬编码开发机测量值。
- 开机自启仅使用 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 的本产品值，正确引用当前 EXE 路径；不修改 HKLM、StartupApproved 或系统策略。界面显示登记状态，Windows 仍可能另行禁用该启动项。默认不自动写入，读写失败必须显示且不能假报成功；不要覆盖其他路径的冲突项。
- 自启状态以注册表为准，不另存 launcher JSON。单测用 mock，不能改真实 Run 启动项；卸载 hook 也只删除与本次安装完整命令匹配的值。必须使用定制 NSIS 模板：默认模板会在 hook 后无条件按产品名删除启动项，不能直接回退。
- 原生错误框或加载错误页、关闭隐藏、托盘定位/失焦行为需实际桌面观察，不用静态单测替代。
- 不公开用户日志、凭据、会话、真实路径、代理认证 URL。模型请求须获准。

## 证据边界

历史 Electron 客户端有维护者正常使用反馈，但不构成 0.1.0 Tauri 的验收基线。
分别报告：实际工具命令/退出码、Rust 测试、真实后端版本、桌面操作、安装/卸载与发布状态。
仅提交工作流不等于 CI 成功；生成 EXE 不等于已安装验收；创建 Release 不等于实际 GUI 通过。
当前任务的结果写交付报告，不在公开文档加入私人机器历史或未经复现的速度/成功率。
