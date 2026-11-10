# Windows 构建与发布清单（Tauri 0.1.0）

面向维护者/AI。先读 [AGENTS](../AGENTS.md) 和 [维护说明](ai-maintenance.md)。
普通用户安装见 [README](../README.md)。以下是待执行清单，不是新安装器已通过验收的声明。

## 必须置顶的旧版迁移要求

**无旧 Electron 安装器自动升级。先退出所有旧 Pi Launcher（包括托盘），手动卸载 OLD 安装器/客户端，然后安装新的 Tauri 版。禁止两个客户端同时运行。**

**保留 `%APPDATA%\Pi Launcher` 配置（尤其 `launcher-config.json`）及 `.pi` 凭据和会话，包括自定义数据目录。不要在卸载时清空数据。**
Electron browser local storage/profile 不保证迁移到 WebView2，不能承诺页面偏好、浏览器登录状态自动保留。
以上要求必须保留在 README、CHANGELOG 和自动生成的 Release body 顶部；`test-release-unit.js` 对发布文案作断言。

## 1. 源码与工具检查

- [ ] 源码无个人配置、凭据、会话、日志、后端产物、浏览器 profile、缓存或真实用户路径。
- [ ] `LICENSE`、图标署名、`THIRD_PARTY_NOTICES.md` 保留；Tauri bundle 携带两份许可/通知资源。
- [ ] package、npm lock 两个根版本、Cargo package/lock 中本包版本、Tauri 显式版本全部为目标版本；不要无故重写 Cargo.lock。
- [ ] 原生 Windows 10/11 x64；Node >=22.19、npm、Git、Rust stable >=1.90、MSVC C++ Build Tools / Windows SDK、WebView2 Runtime。
- [ ] 仓库/终端网络正确，不关闭 TLS，不提交本机 Cargo 镜像或代理认证。

```powershell
npm ci
npm run check:version
npm run check:syntax
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings
```

Node 测试是可移植 release/backend 工具检查，Rust 是 Windows 应用回归，两者不是安装/GUI 验收。
不把 Linux Node 成功写成 Win32 Rust 成功。历史 Electron 正常使用反馈不能替代新 Tauri 验收。
记录实际命令/退出码和未运行项，不虚报 CI 或安装器通过。

本轮源码迁移验证不停止或替换已有安装，也不启动同一 appId 的 GUI；真实安装、卸载与完整桌面流程未验。
隔离后端生命周期 fixture 与 Rust 单测只提供各自层级的证据，不能替代这些未执行项。

## 2. 准备后端与隔离配置

npm 上游路线见 README；fork 可显式构建，使用干净 checkout 和新输出目录：

```powershell
npm run build:source -- --source C:/src/pi-web --commit <完整40位SHA> --output release/backend-next
npm run backend:verify -- release/backend-next
```

builder 不自动拉取源码，不在应用启动时执行。默认 `windows-core` 是选定核心用例，不是全量上游认证。
交付失败可能留下完成产物和部分输出；按错误恢复路径人工检查，不自动删除、覆盖或让应用使用部分输出。
npm 发布版没有 `source-release.json` 正常；`backend:verify` 只针对有清单的 fork 运行产物。

桌面验证使用临时 `PI_LAUNCHER_DATA_DIR`、独立端口及隔离 `PI_CODING_AGENT_DIR`，
不复用真实会话或直接覆盖个人配置。记录 backend 版本/commit 与 Windows/Node 版本。
真实模型请求涉及账号和费用，必须先获准。

## 3. Windows 桌面验收

```powershell
npm run dev
```

- [ ] 首次配置、缺 Node/后端、错误 JSON/路径提示清楚，秘密不回显。
- [ ] npm/fork 后端均按所选路径启动；页面实际显示 Pi Web，不自动下载/切换后端。
- [ ] 显式代理、禁用代理、继承代理、本机回环绕过符合配置，系统代理不被修改。
- [ ] 关闭窗口隐藏到托盘，再次启动唤回；退出前结束任务。
- [ ] 托盘菜单定位、失焦/Esc、外链系统浏览器符合预期。
- [ ] 在获准的隔离用户环境验证“开机自启”：读实际登记状态、显式开启/关闭、登录后启动、权限失败及冲突提示。不得用 mock 测试冒充真实注册表/登录验收，也不改真实用户启动项。
- [ ] 外部健康服务可复用，退出不停止它；无关占用进程不被杀。
- [ ] 就绪超时、取消、后端退出可诊断，所有权/进程身份匹配才清理。
- [ ] 从开始菜单启动、退出重开后个人 JSON 仍生效。
- [ ] 凭据/会话仍在；不将 WebView2 页面状态当作 Electron profile 迁移成功。

旧 Electron `test:integration`、`test:loading`、`test:packaged`、外部子代理测试入口已删除。
没有等价 Tauri GUI 自动化时就手动验证并记录，不保留无效命令冒充覆盖。

## 4. 生成安装包（仅获准后）

```powershell
npm run build
npm run stage:installer
```

build 实际命令：`tauri build --ci --no-sign --bundles nsis -- --locked`，使用 Windows x64 原生 MSVC 工具链及 Tauri 默认输出目录。
`--locked` 是传给 Cargo 的参数，不是 Tauri CLI 自身的选项。
使用锁文件执行 Cargo release build，再生成 NSIS；不构建/捆绑外置 Pi Web，不隐式发布，不签名。

本地唯一交付目录使用 Tauri 默认的 `src-tauri/target/release/bundle/nsis/`：

- `Pi Launcher_0.1.0_x64-setup.exe`：保留 Tauri 原生文件名，同版本重打包覆盖旧包。
- `SHA256SUMS.txt`：`npm run stage:installer` 原地验证当前版本/架构/产品名、MZ 签名并更新校验和，不复制 EXE、不创建 dist。

仅 GitHub Actions 发布时，显式传入 `--release-output <runner.temp>/pi-launcher-release`，
在 runner 临时目录准备 ASCII 名附件，避免 GitHub 改写含空格文件名；这不是本地交付目录。
文件名/MZ/哈希验证不等于可执行文件签名认证或 Windows 安装验收。

- [ ] 按置顶迁移流程实际卸载旧客户端后安装新版，验证安装路径含空格时可用。
- [ ] 名称、快捷方式、窗口、托盘为 Pi Launcher，应用 ID `local.pi.launcher`。
- [ ] 重装后配置保留；`.pi` 凭据/会话不删除；不承诺 Electron profile 迁移。
- [ ] 安装包无后端、用户配置、凭据、日志或 profile；许可/通知资源存在。
- [ ] 实际启动、关闭隐藏、唤回、退出、卸载流程分别确认；未签名可能触发 SmartScreen。
- [ ] 新版真正卸载只清理与本次安装匹配的 Run 启动项，保留其他路径/值及用户配置；更新模式不删除本产品启动登记。

## 5. GitHub Actions

### 自动 Source checks

push/PR 执行 Windows Node 工具检查及 Rust fmt/test/clippy，Node 22 缓存 npm，Rust stable MSVC 与 Cargo cache。
不构建安装器，不触发发布，不调用模型。工作流存在不代表检查已执行。

### 手动 Build Windows（默认仅附件）

`.github/workflows/build-windows.yml` **仅 `workflow_dispatch`**；普通 push/PR/tag 不打包或发布。
选择明确源码后运行，`publish_release` 默认 false。

- build job 保持 `contents: read`，检出 `github.sha`，不跟随移动分支头，不持久化 checkout 凭据。
- Windows runner、Node 22/npm cache、Rust stable >=1.90 MSVC、rustfmt/clippy/Cargo cache。
- `npm ci`、版本/语法/Node 测试及 Windows Rust 检查后执行上述 locked NSIS build 与 staging。
- 仅从 runner 临时发布目录上传 ASCII installer EXE 与 SHA256SUMS.txt 为 `pi-launcher-windows-x64`，保留 7 天；
  不上传整个 target、工作区、依赖、调试文件、后端或个人数据。
- 不配置模型凭据、个人 PAT、代理秘密或签名证书。看到实际日志/附件后才能报告打包成功。

### 可选独立 Release job

仅手动勾选发布且 build 成功后执行；**只有 release job** 申请 `contents: write`，使用内置 `GITHUB_TOKEN`。
若组织策略拒绝写权限则失败，不绕过策略。Ubuntu 仅负责上传附件，不运行 Win32 Rust 测试。

1. 检出与 build 相同的固定 SHA，下载本次 run 的附件，不重新构建。
2. `publish-release.js` 校验纯文件/非 symlink、ASCII 白名单与 EXE 哈希，缓存已校验字节后上传。
3. 从该 SHA 的 package version 生成 `v0.1.0`，完整分页查询所有 Release（含未打标签的草稿）。
   已有同名 tag 或 Release 就停止，即使 tag 指向同一 SHA；API 查询失败不当作不存在。
4. 原子创建指向构建 SHA 的 tag，再建草稿；上传 EXE/校验文件并检查服务端实际文件名一致后才公开。
   prerelease 标记按版本识别，body 顶部含强制手动卸载/安装及数据保留警告。
5. 任一步失败保留 tag/草稿供人工检查，不自动删除、复用或覆盖；并发发布串行，原子 tag 创建仍是最终防线。

Release 公开附件不受 Actions 的 7 天限制。发布成功只证明上传完成，不替代桌面/安装/卸载验收。
没有用户授权，不提交、推送、打标签、运行真实安装器构建或发布。
