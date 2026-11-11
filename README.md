# Pi Launcher

[GitHub](https://github.com/notakevz/pi-launcher) · [MIT](LICENSE)

Pi Web 的 Windows 启动器（Tauri 2 + WebView2）。它负责启动和管理 Pi Web 后端进程，用独立窗口显示页面；关窗后留在托盘，点托盘图标可以唤回。

后端不随启动器分发。装一份 npm 版 Pi Web，或者自己构建 fork，然后在配置里设置路径。启动器不会下载或更新后端。

也可以让 AI 代劳：先让它读 [AGENTS.md](AGENTS.md)，再按你的机器环境安装配置。

## 安装

从 [Releases](https://github.com/notakevz/pi-launcher/releases) 下 `pi-launcher-*-x64-setup.exe` 安装。安装包未签名，Windows 可能显示 SmartScreen 提醒，确认下载来源后再选择继续运行。

从旧 Electron 版迁移时，先结束任务，从托盘退出所有旧 Pi Launcher，再手动卸载旧客户端，最后安装新版；不要同时运行两个版本。**卸载时保留启动器配置及 `.pi` 凭据、会话，包括自定义目录中的数据。**旧配置可以继续用，但网页登录状态和页面偏好不保证迁移，可能需要重设。

环境要求：

- Windows 10/11 x64，Windows 原生 Node.js 22.19 或更新（带 npm）。
- Microsoft Edge WebView2 Runtime。Windows 11 通常已预装；缺失时，安装包会尝试联网下载安装，离线环境需要提前安装运行时。

## 装后端

### npm 版（推荐）

```powershell
npm install -g @agegr/pi-web
```

装的是原版 Pi Web，Pi SDK 已经包含在内，启动器不需要 CLI。想在终端里敲 `pi` 需要额外再装一个：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### fork 版（notakevz/pi-web）

**以下内容可以全部交给AI帮忙处理**

准备：Windows 原生 Node.js 22.19 以上（带 npm）和 Git。整个过程会访问 GitHub 和 npm registry，网络慢的话先在当前窗口设代理（用自己的代理端口，下面的8080只是举个例子），构建脚本会用环境里的 `HTTPS_PROXY`：

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:8080'
```

第一步，克隆两个仓库，然后构建：

```powershell
mkdir pi-web-build -Force | Out-Null; cd pi-web-build
git clone --depth=1 https://github.com/notakevz/pi-launcher.git
git clone --depth=1 --branch local/customizations https://github.com/notakevz/pi-web.git
cd pi-launcher
npm run build:source
```

产物在 `release/backend`。整个过程比较久，卡在 `npm ci` 多半是网络或代理没通。

第二步，验证（仍在 `pi-web-build\pi-launcher`）：

```powershell
npm run backend:verify -- release/backend
```

打印 `Verified backend <版本> @ <提交>` 就说明产物完整。

构建失败时常见的几种：

- `Output already exists`：构建不覆盖旧目录，也不要直接删除可能正在使用的后端。改用 `npm run build:source -- --output release/backend-next`，输出到一个尚不存在的新目录；验证和配置路径也相应换成新目录。
- `Source checkout has local changes`：先用 `git -C ../pi-web status` 查看改动，提交或另行保存自己的修改后再构建。
- `requires Windows Node.js >=22.19` 或 `Backend builds require Node.js >=22.19`：PATH 里找不到 `node.exe`（WSL 里的 node 不算），或者版本低于 22.19。
- `Source origin is not the configured repository`：`pi-web` 不是从 notakevz/pi-web 克隆的。换了路径用 `--source`，换了仓库用 `--repository`。
- `spawnSync git ENOENT`：当前窗口的 PATH 里没有 git。刚装完 Git 的话关掉窗口重开再试。

`release/backend` 是个整体，包含自己的 `node_modules`，拷到别处或换机器时整个目录一起带走。启动器读的是这个目录，不是 `pi-web` 源码目录。

## 写配置

按装的是哪条，整段复制一版就行。

npm 版：

```powershell
$backendPath = Join-Path ((npm.cmd root -g).Trim()) '@agegr/pi-web'
if (!(Test-Path -LiteralPath $backendPath -PathType Container)) { throw "后端目录不存在：$backendPath" }
$configDir = if ($env:PI_LAUNCHER_DATA_DIR) {
    [IO.Path]::GetFullPath($env:PI_LAUNCHER_DATA_DIR)
} else { Join-Path $env:APPDATA 'Pi Launcher' }
New-Item -ItemType Directory -Force $configDir | Out-Null
$file = Join-Path $configDir 'launcher-config.json'
if (!(Test-Path -LiteralPath $file)) {
    $json = @{ backendPath = $backendPath; cwd = $HOME; port = 30141 } | ConvertTo-Json
    [IO.File]::WriteAllText($file, $json, [Text.UTF8Encoding]::new($false))
}
Write-Host "本次后端路径：$backendPath"
Write-Host "实际配置文件：$file（已有文件不会被覆盖）"
Get-Content -LiteralPath $file
```

fork 版（在 `pi-web-build\pi-launcher` 目录执行；指定过其他 `--output` 时，替换下面的 `release/backend`）：

```powershell
$backendPath = (Resolve-Path './release/backend' -ErrorAction Stop).Path
if (!(Test-Path -LiteralPath $backendPath -PathType Container)) { throw "后端目录不存在：$backendPath" }
$configDir = if ($env:PI_LAUNCHER_DATA_DIR) {
    [IO.Path]::GetFullPath($env:PI_LAUNCHER_DATA_DIR)
} else { Join-Path $env:APPDATA 'Pi Launcher' }
New-Item -ItemType Directory -Force $configDir | Out-Null
$file = Join-Path $configDir 'launcher-config.json'
if (!(Test-Path -LiteralPath $file)) {
    $json = @{ backendPath = $backendPath; cwd = $HOME; port = 30141 } | ConvertTo-Json
    [IO.File]::WriteAllText($file, $json, [Text.UTF8Encoding]::new($false))
}
Write-Host "本次后端路径：$backendPath"
Write-Host "实际配置文件：$file（已有文件不会被覆盖）"
Get-Content -LiteralPath $file
```

默认配置位于 `%APPDATA%\Pi Launcher\launcher-config.json`；设置过 `PI_LAUNCHER_DATA_DIR` 时，脚本和应用都会改用该目录。建议自定义目录使用绝对路径，并确保启动应用时也能读取到这个环境变量。

已有配置不会被覆盖，脚本最后回显的是文件原有内容。若要切换后端，用 `notepad $file` 打开配置，将 `backendPath` 改为脚本打印的“本次后端路径”，保留其他设置。`backendPath: null` 表示未显式指定后端，并不等于本次路径解析失败。字段含义：

- `backendPath`：后端目录，npm 安装目录或 `release/backend` 构建产物。
- `cwd`：默认工作目录，改成一个常用项目目录就行。
- `port`：默认 30141，只监听本机回环地址。
- `proxyUrl`：要代理才能连模型服务时填 `"http://127.0.0.1:8080"`（换成你自己的 HTTP 代理端口）。不写继承环境变量里的代理，写 `""` 表示直连。这是给后端进程用的，不动 Windows 系统代理。

完整字段和例子见 [配置指南](config/README.md)。文件是标准 JSON，不支持注释；改完从托盘退出再打开。

## 启动

从开始菜单或桌面打开 Pi Launcher。窗口显示 `http://127.0.0.1:30141`，改过端口地址跟着变。托盘菜单有这些项：

- 显示主窗口、在浏览器中打开、复制 Web 地址
- 打开配置目录、打开日志目录
- 开机自启开关：默认关闭，仅主动开启时注册当前用户的启动项；此前已开启的设置会保留，不需要管理员权限
- 退出

## 更新

先结束任务，从托盘退出，再更新。

- npm 版：重新执行 `npm install -g @agegr/pi-web`。装的还是同一个目录就不用改配置。
- fork 版：在 `pi-launcher` 目录执行。先用 `git -C ../pi-web pull` 拉到新提交，再 `npm run build:source -- --output release/backend-next`，然后把 `backendPath` 改成新目录。老目录留着，想回退时改回去就行。输出目录不能已经存在，所以每次都换一个新名字。

## 不装客户端也能用

熟悉服务管理的话，用任务计划程序或某个服务包装器把 `pi-web` 挂起来，浏览器访问 `http://127.0.0.1:30141` 即可。Chrome、Edge 可以把页面装成 PWA 窗口，看着和客户端差不多，但 PWA 不会帮你启动或守护后端。

## 开发者

改启动器本身：在 `pi-launcher` 目录 `npm ci`，然后 `npm start`（等于 `tauri dev`，会先用 Vite 编译本地 Vue 3/PrimeVue 托盘界面）。第一次要编译 Rust，需要 Rust stable 1.90 以上（MSVC 工具链）、Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”和 Windows SDK。打包发布见 [docs/releasing.md](docs/releasing.md)，测试和日志解读见 [docs/ai-maintenance.md](docs/ai-maintenance.md)。

## 相关项目与许可

- [Pi Web](https://github.com/agegr/pi-web) · [Pi](https://github.com/earendil-works/pi) · [notakevz/pi-web](https://github.com/notakevz/pi-web)

本项目不是上游官方客户端，代码和文档用 [MIT 许可证](LICENSE)。应用图标是 [Pi 项目](https://github.com/earendil-works/pi) 的 logo（MIT），署名见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
