# 配置说明与示例

本目录中的 JSON 是**通用默认值和模板**，不是你的实际个人配置。
应用按标准 JSON 解析，不支持 `//` / `/* */` 注释或末尾多余的逗号；字段说明放在本文中。

## 这些文件分别做什么？

| 文件 | 用途 |
| --- | --- |
| [`launcher-defaults.json`](launcher-defaults.json) | 随应用打包的安全默认值，一般不需要修改 |
| [`launcher-config.example.json`](launcher-config.example.json) | 完整的个人配置模板；其中路径只是示例，必须按本机情况修改 |
| `%APPDATA%\Pi Agent Launcher\launcher-config.json` | 应用实际读取的个人配置，不提交到 Git |
| [`backend-build.json`](backend-build.json) | 手动构建后端时的通用参数，不是应用运行配置 |

为兼容已有安装，用户数据目录仍叫 **Pi Agent Launcher**。
如果显式设置了 `PI_AGENT_LAUNCHER_DATA_DIR`，应用改读该目录中的 `launcher-config.json`。
仅修改仓库里的 `.example.json` 不会改变实际运行设置。

## 第一次配置

1. 准备好 Windows 原生 Node.js >=22.19 和已构建完整的 Pi Web 后端。
2. 将示例复制为上表中的实际配置文件，或手动新建该文件。
3. 修改路径、代理等设置，保存为 UTF-8 标准 JSON。
4. 启动应用；之后修改配置，须从托盘退出并重新启动才会生效。

**以下 PowerShell 在启动器源码根目录执行，不覆盖已有配置：**

```powershell
$configDir = Join-Path $env:APPDATA 'Pi Agent Launcher'
$configFile = Join-Path $configDir 'launcher-config.json'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (Test-Path -LiteralPath $configFile) {
    Write-Host "已有配置，保留原文件：$configFile"
} else {
    Copy-Item -LiteralPath 'config/launcher-config.example.json' -Destination $configFile
}
notepad $configFile
```

如果设置了自定义数据目录，须相应调整 `$configDir`。安装包用户也可以直接用文本编辑器
在实际配置目录新建文件，不需要把个人配置写进程序安装目录。

## 字段说明

可以省略不需要修改的字段；缺省字段使用 `launcher-defaults.json` 中的值。
**不要把所有字段都填成 `null`：只有下表明确允许的字段支持它。**

| 字段 | 类型 | 默认值与说明 |
| --- | --- | --- |
| `schemaVersion` | 整数 | `1`，配置格式版本；不需要自行递增 |
| `backendPath` | 字符串或 `null` | 默认 `null`。要启动本地后端时，填构建后运行目录的绝对路径，不是 Git 源码目录或 `bin/pi-web.js` 文件路径 |
| `cwd` | 字符串或 `null` | 默认 `null`，使用当前用户主目录。指定时必须是已存在目录的绝对路径 |
| `port` | 整数 | 默认 `30141`，范围 `1–65535`，不要写成字符串。只监听回环地址 |
| `nodePath` | 字符串或 `null` | 默认 `null`，自动查找 Windows Node。指定时填写已存在的 `node.exe` 绝对路径，不是 Node 安装目录 |
| `proxyUrl` | 字符串或 `null` | `null`：继承已有 HTTP(S) 代理环境；`""`：明确禁用代理；URL：使用指定 HTTP(S) 代理 |
| `noProxy` | 字符串数组 | 默认 `[]`。每项为一个绕过代理的地址/域名，追加到已有 `NO_PROXY`；本地地址始终自动加入 |
| `startupTimeoutMs` | 整数 | 默认 `60000`（60 秒），允许 `1–2147483647` 毫秒；只控制等待新后端就绪的时间，不是模型请求超时 |

### 路径和后端目录

- 所有显式路径必须为绝对路径，不支持把 `%USERPROFILE%`、`$HOME` 或 `~` 写入 JSON 后自动展开。
- 推荐使用 `C:/work`；如果用反斜杠，应写成 `"C:\\work"`。
- `backendPath` 对应目录应有 `package.json`、`bin/pi-web.js`、`.next` 和生产 `node_modules`。
- 使用本项目构建工具时，填写产物 `release/backend` 或新输出目录的实际绝对路径。
- 未配置本地后端时不会自动下载；若端口上已有可识别的健康 Pi Web 服务，可以直接复用。

## 常用配置例子

以下是**完整的最小配置文件**，不是要追加到完整模板末尾的片段。
示例路径和代理端口都不代表你的实际环境；请先确认路径存在、代理可用。

### 例 1：本地后端，明确直连

```json
{
  "backendPath": "C:/pi-web/backend",
  "proxyUrl": ""
}
```

工作目录使用用户主目录，端口使用 `30141`，Node 自动查找。
不设置 `proxyUrl` 或设为 `null` 会保留环境代理；要强制禁用应使用空字符串。

### 例 2：指定工作目录和 HTTP 代理

```json
{
  "backendPath": "C:/pi-web/backend",
  "cwd": "C:/work",
  "proxyUrl": "http://127.0.0.1:8080",
  "noProxy": ["internal.example"]
}
```

把 `8080` 换成代理软件实际的 **HTTP 代理端口**。
启动器不声明 SOCKS 支持，不要将 SOCKS 端口直接填成 HTTP 代理。
不需要额外绕过域名时，可省略 `noProxy` 或使用空数组。

### 例 3：指定 Node、端口和启动等待时间

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

这是 120 秒的后端启动等待时间。更改端口会改变站点来源，原端口的浏览器存储不会
自动迁移；没有端口冲突时，日常建议保持端口不变。

## 环境变量覆盖与代理边界

逐字段优先级：**专用环境变量 → 用户 JSON → 通用默认 JSON**。
JSON 改了不生效时，先检查是否存在对应的旧环境变量。

| JSON 字段 | 临时覆盖变量 |
| --- | --- |
| `backendPath` | `PI_AGENT_LAUNCHER_BACKEND_PATH` |
| `cwd` | `PI_AGENT_LAUNCHER_CWD` |
| `port` | `PI_AGENT_LAUNCHER_PORT` |
| `nodePath` | `PI_AGENT_LAUNCHER_NODE` |
| `proxyUrl` | `PI_AGENT_LAUNCHER_PROXY_URL` |
| `noProxy` | `PI_AGENT_LAUNCHER_NO_PROXY`，使用逗号分隔 |
| `startupTimeoutMs` | `PI_AGENT_LAUNCHER_STARTUP_TIMEOUT_MS` |

`proxyUrl: null` 时，HTTP(S) 代理按 `HTTPS_PROXY`、`https_proxy`、`HTTP_PROXY`、
`http_proxy` 的顺序选取。没有这些变量时，对应 HTTP(S) 请求直连。
原 `ALL_PROXY` 在未明确禁用时保留给支持它的组件，但不会提升为 HTTP(S) 代理。
`proxyUrl: ""` 会清除传给后端的 HTTP(S)/ALL_PROXY 大小写变量。

Electron 访问本地后端始终直连。某些扩展有独立网络设置，仍需单独配置；
启动器设置不是所有扩展的全局网络保证。
`npm ci`、Electron 下载和手动构建的终端网络也需要独立配置，不能关闭 TLS 校验。

## 构建配置与日常维护

`backend-build.json` 中的 `repository`、`source`、`output`、`commit`、`testScope`
用于显式的手动构建。默认 source/output 相对于启动器项目根目录，CLI 参数可以覆盖。
应用启动时不会读取它来自动拉取或升级后端；构建过程见
[发布清单](../docs/releasing.md)。

个人 JSON 不应包含模型 API Key；模型认证由 Pi Web/Pi 管理。
不要公开实际代理凭据、用户配置、会话或日志。退出启动器会停止它拥有的后端，
修改配置前请先确认没有运行中的任务。
