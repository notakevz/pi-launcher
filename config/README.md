# 配置说明与示例

本目录的 JSON 是**通用默认值和模板**，不是个人配置。应用读取标准 JSON，不支持注释或末尾逗号。
安装与旧版迁移顺序见 [README](../README.md#从旧-electron-版迁移必须先手动卸载)。

## 文件与目录

| 文件 | 用途 |
| --- | --- |
| [`launcher-defaults.json`](launcher-defaults.json) | 随应用打包的安全默认值，一般不需要修改 |
| [`launcher-config.example.json`](launcher-config.example.json) | 个人配置模板，示例路径须按本机修改 |
| `%APPDATA%\Pi Launcher\launcher-config.json` | 实际个人配置，不提交到 Git |
| [`backend-build.json`](backend-build.json) | 可选的显式 fork 后端构建参数，不参与应用启动或自动更新 |
| `src-tauri/tauri.conf.json` | 开发者的 Tauri 打包配置，不是个人运行配置 |

设置 `PI_LAUNCHER_DATA_DIR` 时，应用改读该目录中的 `launcher-config.json`，建议用绝对路径。
仅修改仓库模板不会改变实际设置。旧 Electron 版同一路径的配置可保留沿用；其他旧名称目录不会自动迁移。
**先退出所有旧启动器、手动卸载旧客户端，再装新版；保留启动器配置及 `.pi` 凭据和会话。**
WebView2 与 Electron 的 browser local storage / profile 不保证互相迁移，不要让两个客户端同时运行。

## 第一次配置

1. 准备 Windows 原生 Node.js >=22.19、WebView2 Runtime 和已安装或自行构建的 Pi Web 后端。
2. 复制模板到个人配置目录，或直接创建最小 JSON。已有配置先读取比较，不覆盖。
3. 保存为 UTF-8 标准 JSON；UTF-8 BOM 也会被忽略。
4. 修改后从托盘退出再重开，确保没有运行中的任务。

以下 PowerShell 在源码根目录执行，不覆盖已有配置；安装包用户也可直接用文本编辑器创建文件：

```powershell
$configDir = if ($env:PI_LAUNCHER_DATA_DIR) {
    [IO.Path]::GetFullPath($env:PI_LAUNCHER_DATA_DIR)
} else { Join-Path $env:APPDATA 'Pi Launcher' }
$configFile = Join-Path $configDir 'launcher-config.json'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (Test-Path -LiteralPath $configFile) {
    Write-Host "已有配置，保留原文件：$configFile"
} else {
    Copy-Item -LiteralPath 'config/launcher-config.example.json' -Destination $configFile
}
notepad $configFile
```

## 字段说明

缺省字段使用 `launcher-defaults.json`；只有下表明确允许的字段支持 `null`。

| 字段 | 类型 | 默认值与说明 |
| --- | --- | --- |
| `schemaVersion` | 整数 | `1`，配置格式版本，不自行递增 |
| `backendPath` | 字符串或 `null` | 默认 `null`。填 npm 安装的 Pi Web 包根目录或 fork 运行产物目录的绝对路径，不是 Git checkout 或 CLI 文件 |
| `cwd` | 字符串或 `null` | 默认 `null`，使用当前用户主目录；指定时必须是已存在目录的绝对路径 |
| `port` | 整数 | 默认 `30141`，范围 `1–65535`；仅监听回环地址，不写成字符串 |
| `nodePath` | 字符串或 `null` | 默认 `null`，自动查找 Windows Node；指定时填已存在的 `node.exe` 绝对路径 |
| `proxyUrl` | 字符串或 `null` | `null`：继承 HTTP(S) 代理环境；`""`：明确禁用；URL：指定 HTTP(S) 代理 |
| `noProxy` | 字符串数组 | 默认 `[]`，追加到已有 `NO_PROXY`；回环地址始终加入 |
| `startupTimeoutMs` | 整数 | 默认 `60000`，允许 `1–2147483647` 毫秒；仅控制新后端就绪等待，不是模型请求超时 |

### 路径和后端目录

- 路径必须绝对，不展开 JSON 中的 `%USERPROFILE%`、`$HOME` 或 `~`。
- 推荐写 `C:/work`；反斜杠需转义成 `"C:\\work"`。
- 后端根目录应有 `package.json`、`bin/pi-web.js`、`.next/BUILD_ID` 和可解析的运行依赖。
- npm 版路径：在 PowerShell 执行 `Join-Path ((npm root -g).Trim()) '@agegr/pi-web'`，不要只填全局 npm root。
- fork 版可使用源码中的 `npm run build:source` 手动构建，见 [README](../README.md)；配置指向完整运行产物，不是源码。
- 未配置后端时不会自动下载；端口上已有可识别的健康 Pi Web 服务时可以复用。

## 最小配置示例

以下分别是完整文件，不是追加到模板末尾的片段。路径、端口都只是示例。

### 本地后端，明确直连

```json
{
  "backendPath": "C:/pi-web/backend",
  "proxyUrl": ""
}
```

默认工作目录为用户主目录，端口 `30141`，Node 自动查找。不写 `proxyUrl` 或写 `null` 会继承环境代理。

### 工作目录与 HTTP 代理

```json
{
  "backendPath": "C:/pi-web/backend",
  "cwd": "C:/work",
  "proxyUrl": "http://127.0.0.1:8080",
  "noProxy": ["internal.example"]
}
```

将 `8080` 换成实际 **HTTP** 代理端口；不声明 SOCKS 支持，不把 SOCKS 端口当作 HTTP 端口。

### Node、端口与启动等待

```json
{
  "backendPath": "C:/pi-web/backend-next",
  "cwd": "C:/work",
  "port": 30142,
  "nodePath": "C:/Program Files/nodejs/node.exe",
  "proxyUrl": null,
  "startupTimeoutMs": 120000
}
```

这是 120 秒等待。端口改变会改变浏览器来源，原端口浏览器存储不会自动迁移，日常建议保持端口。

## 环境变量与代理边界

优先级：**专用环境变量 → 用户 JSON → 默认 JSON**。旧名称的启动器变量不再读取。

| 字段 | 临时覆盖变量 |
| --- | --- |
| `backendPath` | `PI_LAUNCHER_BACKEND_PATH` |
| `cwd` | `PI_LAUNCHER_CWD` |
| `port` | `PI_LAUNCHER_PORT` |
| `nodePath` | `PI_LAUNCHER_NODE` |
| `proxyUrl` | `PI_LAUNCHER_PROXY_URL` |
| `noProxy` | `PI_LAUNCHER_NO_PROXY`，逗号分隔 |
| `startupTimeoutMs` | `PI_LAUNCHER_STARTUP_TIMEOUT_MS` |

`proxyUrl: null` 时按 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、`http_proxy` 顺序选取。
没有这些变量则直连。`ALL_PROXY` 可保留给支持它的组件，但不提升为 HTTP(S) 代理。
`proxyUrl: ""` 清除传给后端的 HTTP(S)/ALL_PROXY 大小写变量。

传给后端的 `NO_PROXY` 自动加入 `localhost` / `127.0.0.1` / `::1`。WebView2 使用 Windows 系统代理，
启动器不修改系统代理，也不改变外部已运行服务的环境。安装或构建时的终端代理须单独设置，不关闭 TLS 校验。

## 数据与排障

配置、日志和进程记录位于活动数据目录；WebView2 profile 在 `%LOCALAPPDATA%\Pi Launcher\webview2`。
不要与 Electron `session/` 混用，不保证浏览器状态迁移。Pi Web/Pi 管理模型凭据及会话，
个人启动器 JSON 不应包含模型 API Key。不要公开代理凭据、配置、会话或原始日志。

启动失败先看活动数据目录中的 `launcher.log`；后端输出以 `[pi-web]` 标记。
检查 Node 版本、目录、端口所有者和配置覆盖，不能通过全局结束 Node 来排障。
开发实现、测试、启动日志解读及打包方法见 [AI 维护说明](../docs/ai-maintenance.md) 和 [发布清单](../docs/releasing.md)。
