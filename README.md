# Pi Web Launcher

[GitHub](https://github.com/notakevz/pi-web-launcher) · [MIT](LICENSE)

A Windows desktop launcher for an independently built local Pi Web backend.

**Windows / Electron / 外置后端 / 手动升级**

Pi Web Launcher 主要是为了让 **Windows 用户更方便地启动 Pi Web，并管理其后台进程**，
提供独立窗口和托盘。适合希望使用自己构建的 Pi Web 或 fork、并自行控制后端版本的用户。

如果熟悉系统服务管理，建议直接使用系统工具启动和管理 Pi Web，再通过浏览器访问：
Linux 可用 systemd 或 OpenRC，macOS 可用 launchd（通过 `launchctl` 管理），
Windows 可用任务计划程序，或通过合适的服务包装器托管。
支持 PWA 安装的浏览器（如 Chrome、Edge）还可将 Pi Web 安装为独立窗口的应用，
不一定需要额外的 Electron 客户端。**PWA 只提供应用窗口，不负责启动或守护 Pi Web 后端。**

> **版本：0.0.1，正在准备首次公开。** 原始客户端（本次公开整理前的版本）
> 已由项目维护者在 Windows 上手动测试并确认可用。
> 本次新增的 JSON 配置与容错改动已通过 Node 单元测试，尚未在 Windows 上复验。
> 具体边界见 [发布清单](docs/releasing.md)；不将原版验收扩展为新改动或所有测试项均已通过。

## 做什么，不做什么

- 独立桌面窗口、启动页、缩放；关闭窗口隐藏到托盘，再次启动唤回窗口。
- 使用 Windows 原生 Node 启动已构建的 Pi Web，等待本地 HTTP 就绪。
- 复用已有健康服务；只对经过身份验证的自有后端执行退出清理。
- 配置从 JSON 读取；支持临时环境变量覆盖，不绑定作者电脑的目录和代理。
- 后端版本与 commit（有构建清单时）可在托盘查看。
- **不在启动时安装依赖、下载后端、检查更新或自动替换版本。**
- **安装包不包含后端或独立 Node。** 构建和升级由用户手动执行。

Pi Web、Pi CLI、模型认证及工具模式由后端提供，启动器不实现这些能力。
此项目不是上游官方客户端，也不提供操作系统沙箱。

## 环境要求

- Windows 10/11；使用 Windows 原生 Node.js **22.19 或更新版本**。
- 从源码开发/打包需要 npm；构建 Pi Web 后端还需要 Git。
- 一个完整的 Pi Web 运行目录，包括 `package.json`、`bin/pi-web.js`、
  `.next` 与私有生产 `node_modules`。仅有 Git 源码目录不能启动。
- 模型配置和认证需在 Pi Web/Pi 中单独完成；不随启动器提供。

纯 Node 单元测试可在 Linux/Windows 上运行；这不表示 Linux 桌面应用受支持。

## 快速开始

### 1. 准备后端

如果已有可运行的 Pi Web 构建，直接使用其运行目录。

仓库附带的手动构建工具默认面向
[`notakevz/pi-web`](https://github.com/notakevz/pi-web) 的 `local/customizations`
分支；这是构建工具的默认目标，不是运行时自动更新源。
构建配置集中在 `config/backend-build.json`。构建工具依赖该 fork 的目录和测试结构，
修改仓库地址不代表任意上游版本都已经兼容。

Windows PowerShell 示例（安装位置由你决定）：

```powershell
# 在准备存放源码的父目录执行；已有 checkout 时不要重复克隆覆盖。
git clone --branch local/customizations https://github.com/notakevz/pi-web.git pi-web
git clone https://github.com/notakevz/pi-web-launcher.git pi-web-launcher
cd pi-web-launcher
npm ci
npm run build:source
```

上例假定启动器目录和 `pi-web` 源码目录同级；否则通过 `--source` 指定。
首次使用请自行选定并记录后端 commit，不要假定分支 HEAD 永远保持兼容。
脚本不自动 `git pull`，也不修改原 checkout 的代码。

### 2. 写入运行配置

创建 `%APPDATA%\Pi Agent Launcher\launcher-config.json`，参考
[`config/launcher-config.example.json`](config/launcher-config.example.json)。
复制步骤、字段解释和直连/代理配置例子见 **[配置指南](config/README.md)**。
完整模板如下：

```json
{
  "schemaVersion": 1,
  "backendPath": "C:/pi-web/backend",
  "cwd": "C:/work",
  "port": 30141,
  "nodePath": null,
  "proxyUrl": null,
  "noProxy": [],
  "startupTimeoutMs": 60000
}
```

把示例路径换成实际存在的目录。若使用本项目构建脚本，`backendPath` 指向
生成的 `release/backend` 的**绝对路径**。JSON 中可以使用 `/`，使用 `\` 时须写成 `\\`。
可以省略不需要修改的字段；至少应配置本地后端路径。

为兼容已有安装，用户数据目录仍叫 **Pi Agent Launcher**；这不是项目目录名。
不要将真实配置、代理凭据或后端运行数据提交到仓库。

### 3. 启动

```powershell
npm start
```

或者在本机执行 `npm run dist` 生成安装包，安装后从开始菜单启动。
构建过程、EXE 验收和发布前检查见 [docs/releasing.md](docs/releasing.md)。
没有配置本地后端时不会自动下载或回退到 npm 版；若端口上已有可识别的健康外部服务，
启动器可以复用它，退出时不会停止该外部服务。

## JSON 配置

优先级：**显式环境变量覆盖 → 用户 JSON → `config/launcher-defaults.json`**。
通用默认值随应用打包；改个人设置应写用户 JSON，而不是修改已安装程序的文件。

字段类型、默认值、`null` 与空字符串的区别，以及各专用环境变量的映射，
统一维护在 **[config/README.md](config/README.md)**。
配置文件是标准 JSON，不能添加 `//` 注释；说明与可复制示例放在配置指南中。

配置在应用启动时读取，修改后请从托盘退出并重开。启动器拥有的后端会随退出停止，
因此先确认没有运行中的任务。保持端口不变有助于保留对应站点的浏览器存储。

### 临时覆盖和网络

正常设置可全部通过 JSON 完成；已有安装的专用环境变量仍可临时覆盖，
完整对应表见 [配置指南](config/README.md#环境变量覆盖与代理边界)。
`PI_AGENT_LAUNCHER_DATA_DIR` 只用于覆盖配置/日志/浏览器存储目录（例如测试隔离），
属于定位用户 JSON 之前的启动参数。

正常使用无需环境变量。如果 JSON 修改没有生效，先检查是否存在旧环境变量覆盖。
`proxyUrl: null` 并不清除系统环境中的代理；需要强制直连时使用 `"proxyUrl": ""`。
未显式禁用时保留原 `ALL_PROXY`，但不会将 SOCKS 地址提升为 HTTP(S) 代理；
是否使用 `ALL_PROXY` 由具体组件决定。启动器不声明 SOCKS 支持。
Electron 访问本地后端直连；后端使用自身网络栈和代理配置。扩展如单独设置了代理，
仍须自行配置，不能把启动器设置当成所有扩展的全局网络保证。

`npm ci`、Electron 下载和后端构建是独立的联网步骤，必要时先在终端配置代理。
请勿为解决下载问题关闭 TLS 校验，也不要公开包含认证信息的代理 URL。

## 使用与数据

- 关闭窗口：隐藏到托盘，不停止服务。
- 托盘“退出”：停止本应用启动或安全接管的后端进程树，并退出。
- 外部服务：只复用，不停止、不替换；托盘会标记为外部服务。
- 端口冲突：报错，不结束无关程序。
- 日志与进程记录：用户数据目录内的 `launcher.log` 和 `pi-web-<port>.json`。
- Pi 的模型配置、凭据、会话：沿用后端的用户目录，不进行迁移或清空。

当前退出清理可能终止正在运行的任务；退出前请先停止任务。
日志暂未实现大小轮转，长期运行时注意文件体积，不要直接公开日志中的任务内容。

## 开发与测试

```powershell
npm run test:unit       # 自包含的 Node 测试；不需要 Electron 或真实后端
npm run test:integration # Windows 后端/窗口控制集成测试，需先准备后端
npm run test:source-web # 实际 fork API 与 Electron；需完整依赖和后端
npm run test:loading    # 仅启动页的真实 Electron 测试，需桌面环境
npm run test:packaged   # 实际 Windows EXE，需先打包并准备后端
```

`npm test` 默认只跑自包含单元测试。GitHub Actions 目前也只验证这部分，
不代表正式后端、Windows 安装包或真实模型认证已通过。

其他测试的前置条件与隔离方式见 [发布清单](docs/releasing.md)。
子代理测试是可选的外部扩展集成，不属于启动器本身的必需功能。

## 手动升级后端

1. 在新目录构建目标 commit，例如 `release/backend-next`，不要覆盖运行目录。
2. 完成测试，记录 commit；从托盘退出启动器。外部服务由其所有者自行停止。
3. 修改用户 JSON 的 `backendPath`，再启动并核对托盘版本/commit。
4. 回退时退出并把路径改回旧目录；不要删除用户凭据和会话。

```powershell
npm run build:source -- --commit <完整40位SHA> --output release/backend-next
npm run backend:check
npm run backend:check -- --verify
```

构建使用临时 worktree、独立测试环境、生产构建和私有生产依赖，并写入完整性清单。
这些重操作仅在手动命令中执行，不发生在启动器启动时。工具仅支持 Windows 原生构建。

## 相关项目与授权

- [Pi Web](https://github.com/agegr/pi-web)：上游 Web 界面。
- [Pi](https://github.com/earendil-works/pi)：编程代理与 CLI。
- [本工具默认构建的 fork](https://github.com/notakevz/pi-web)：后端定制，与启动器单独维护。

后端依赖与许可证由各自项目提供，本仓库不包含其完整运行产物。
`assets/icon.svg` 及派生 PNG/ICO 使用本项目自有几何图案，不使用上游官方 Logo。
图标可通过 `python scripts/generate-icon.py` 重建（仅此操作需要 Pillow）。

本项目的启动器代码、文档和自有图标采用 [MIT 许可证](LICENSE)。
第三方组件保持各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
本项目的 MIT 许可不替代后端、Electron 或其他依赖的许可及商标规则。
