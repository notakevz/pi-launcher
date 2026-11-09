# Pi Launcher

[GitHub](https://github.com/notakevz/pi-launcher) · [MIT](LICENSE)

Pi Web 的 Windows 启动器：负责启动和管理 Pi Web 后端进程，并提供独立窗口。
关闭窗口会隐藏到托盘，再次打开会唤回窗口。

支持两种后端：npm 安装的原版 Pi Web，或自己构建的 Pi Web fork。
启动器不捆绑后端，也不会自动安装或更新它。

**也可以让 AI 协助部署。先让它阅读本项目的 [AGENTS.md](AGENTS.md)，再让它根据你的电脑环境安装和配置。**

## 环境要求

- Windows 10/11，Windows 原生 Node.js 22.19 或更新版本（包含 npm）。
- 从源码运行启动器、构建 fork 时还需要 Git。
- 模型账号与 API Key 在 Pi Web 中配置，不需要写进启动器配置。

以下命令均在 Windows PowerShell 中执行。

## 1. 准备启动器

下载安装包：打开 [Releases](https://github.com/notakevz/pi-launcher/releases)，
在已发布版本的 **Assets** 中下载 EXE 并安装，不要把 Source code 压缩包当作安装包。
Release 附件无需登录，长期有效。安装包未签名，Windows 可能显示 SmartScreen 提醒。
如果 Releases 还没有可用的安装包，可请维护者构建发布，或先用源码方式。

也可以从源码运行，fork 路线和参与开发时需要：

```powershell
git clone https://github.com/notakevz/pi-launcher.git
cd pi-launcher
npm ci
```

接下来选择一种后端，完成后再启动应用。

## 2. 选择后端

### A. 使用 npm 版 Pi Web（推荐普通用户）

无需构建 Pi Web，直接安装上游发布的 npm 包：

```powershell
npm install -g @agegr/pi-web
$backendPath = Join-Path ((npm root -g).Trim()) '@agegr/pi-web'
```

`$backendPath` 是 npm 实际安装目录，不要写死为某个用户的 AppData 路径。
这里装的是原版 Pi Web，不包含 fork 的 Plan / Build / Full 等定制。

Pi Web 已包含所需的 Pi SDK。如果还想在终端单独使用 `pi` 命令，可额外安装 CLI；
这不是启动器的必需依赖：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### B. 使用 notakevz/pi-web（需要 fork 定制时）

此路线需要启动器源码，因为构建脚本在源码里；只安装了客户端的话，
请先按第 1 节"从源码运行"准备一份源码。在启动器源码目录内执行：

```powershell
git clone --branch local/customizations https://github.com/notakevz/pi-web.git ../pi-web
npm run build:source
$backendPath = (Resolve-Path './release/backend').Path
```

这会把 fork 构建为独立运行目录 `release/backend`。已有同级 `pi-web` 源码目录时，
不必再次克隆。配置应指向构建产物，而不是源码目录。
构建参数在 [`config/backend-build.json`](config/backend-build.json) 中。

## 3. 写入配置

完成 A 或 B 后，继续在同一个 PowerShell 窗口执行以下命令。
它会使用刚才的 `$backendPath` 创建个人配置，并打开编辑器；已有配置不会被覆盖。

```powershell
if (!$backendPath -or !(Test-Path -LiteralPath $backendPath -PathType Container)) {
    throw '请先完成上面的后端安装或构建，再写入配置。'
}
$configDir = if ($env:PI_LAUNCHER_DATA_DIR) {
    [IO.Path]::GetFullPath($env:PI_LAUNCHER_DATA_DIR)
} else { Join-Path $env:APPDATA 'Pi Launcher' }
$configFile = Join-Path $configDir 'launcher-config.json'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (!(Test-Path -LiteralPath $configFile)) {
    $settings = @{ backendPath = $backendPath; cwd = $HOME; port = 30141 }
    [IO.File]::WriteAllText($configFile, ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
Write-Host "本次选择的后端目录：$backendPath"
notepad $configFile
```

配置文件默认位于 `%APPDATA%\Pi Launcher\launcher-config.json`。
设置过 `PI_LAUNCHER_DATA_DIR` 时，上面的命令与应用都会使用该自定义目录。
旧名称下的配置不会自动迁移，旧版启动器环境变量不再读取；原有用户数据保持不变，
如需沿用旧配置，请先自行核对，再手动复制到新配置目录。
如果已有配置，切换后端时只需把 `backendPath` 改为上面打印的目录。
`cwd` 是默认工作目录，可以改为你实际使用的项目目录。

需要代理连接模型服务时，在配置中添加 `proxyUrl`，例如 `"proxyUrl": "http://127.0.0.1:8080"`，
并换成你自己的 HTTP 代理端口。不填写则继承环境代理；设为 `""` 可明确禁用代理。
这是启动器传给其后端进程的代理，不会修改 Windows 系统代理。

完整字段说明、路径写法与更多例子见 [配置指南](config/README.md)。
配置使用标准 JSON，不支持注释；修改后需从托盘退出并重开。

## 4. 启动与使用

从源码运行时，在启动器目录执行：

```powershell
npm start
```

已安装客户端的用户，直接打开桌面或开始菜单中的 Pi Launcher。
第一次使用时，在 Pi Web 的 Models 面板中登录模型提供方或配置 API Key。
启动成功后浏览器会自动打开 http://127.0.0.1:30141，改过端口的话地址跟着变化。

- 关闭窗口只是隐藏到托盘，后端继续运行。
- 托盘菜单的"退出"会停止启动器拥有的后端并退出，请先结束正在进行的任务。
- 同一端口上已有健康的 Pi Web 服务时，启动器直接复用，不接管也不停止它。
- 托盘菜单的"打开日志目录"可以查看日志。

## 更新后端

更新前先结束任务，并从托盘退出启动器。

- npm 版：重新执行 `npm install -g @agegr/pi-web`；若 npm 安装位置未变，无需改配置。
- fork 版：在源码目录选择要使用的版本，再从启动器目录执行
  `npm run build:source -- --output release/backend-next`，完成后将 `backendPath` 改到新目录。
  不要覆盖正在使用的构建目录；保留旧目录即可手动切回。

## 数据与清理

- 启动器自己的数据（配置、日志、进程记录）都在 `%APPDATA%\Pi Launcher`；
  删除整个目录即可重置启动器，下次启动会重新生成。
- 卸载程序不会删除该目录，需要手动清理。
- 模型账号、会话和 Pi 的配置在 Pi 的用户目录（默认 `%USERPROFILE%\.pi`，
  可用 `PI_CODING_AGENT_DIR` 覆盖）中，启动器不会读取、迁移或清空它们。

## 也可以直接使用浏览器

如果熟悉系统服务管理，可以不使用这个客户端：Linux 用 systemd/OpenRC，macOS 用
launchd（`launchctl`），Windows 用任务计划程序或合适的服务包装器管理 Pi Web，
再通过浏览器访问。Chrome、Edge 等浏览器的 PWA 安装功能可提供独立应用窗口，
但 PWA 不负责启动或守护后端服务。

## 相关项目与许可

- [Pi Web](https://github.com/agegr/pi-web) · [Pi](https://github.com/earendil-works/pi) · [notakevz/pi-web](https://github.com/notakevz/pi-web)

本项目不是上游官方客户端，代码与文档采用 [MIT 许可证](LICENSE)。
应用图标为 [Pi 项目](https://github.com/earendil-works/pi) 的 logo（MIT 许可证），
已在 [第三方许可说明](THIRD_PARTY_NOTICES.md) 中署名；其他第三方组件保持各自许可证。
