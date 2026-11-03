# Pi Web Launcher

[GitHub](https://github.com/notakevz/pi-web-launcher) · [MIT](LICENSE)

让 Windows 用户更方便地启动 Pi Web、管理后台进程，并通过独立窗口使用它。
关闭窗口会隐藏到托盘，再次打开会唤回窗口。

支持两种后端：**npm 安装的原版 Pi Web**，或**自己构建的 Pi Web fork**。
启动器不捆绑后端，也不会自动安装或更新它。

**也可以让 AI 协助部署：请先让它阅读本项目的 [AGENTS.md](AGENTS.md)，再根据你的电脑环境安装和配置。**

## 环境要求

- Windows 10/11，Windows 原生 Node.js **22.19 或更新版本**（包含 npm）。
- 从源码运行启动器、构建 fork 时还需要 Git。
- 模型账号与 API Key 在 Pi Web 中配置，不需要写进启动器配置。

以下命令均在 **Windows PowerShell** 中执行。

## 1. 准备启动器

目前仓库提供源码，可以这样运行；如果已经安装了打包客户端，可跳过这一步。

```powershell
git clone https://github.com/notakevz/pi-web-launcher.git
cd pi-web-launcher
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
**这里装的是原版 Pi Web，不包含 fork 的 Plan / Build / Full 等定制。**

Pi Web 已包含所需的 Pi SDK。如果还想在终端单独使用 `pi` 命令，可额外安装 CLI；
这不是启动器的必需依赖：

```powershell
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### B. 使用 notakevz/pi-web（需要 fork 定制时）

在启动器源码目录内执行：

```powershell
git clone --branch local/customizations https://github.com/notakevz/pi-web.git ../pi-web
npm run build:source
$backendPath = (Resolve-Path './release/backend').Path
```

这会把 fork 构建为独立运行目录 `release/backend`。已有同级 `pi-web` 源码目录时，
不必再次克隆；**配置应指向构建产物，而不是源码目录**。
构建参数在 [`config/backend-build.json`](config/backend-build.json) 中。

## 3. 写入配置

完成 A 或 B 后，继续在**同一个 PowerShell 窗口**执行以下命令。
它会使用刚才的 `$backendPath` 创建个人配置，并打开编辑器；已有配置不会被覆盖。

```powershell
if (!$backendPath -or !(Test-Path -LiteralPath $backendPath -PathType Container)) {
    throw '请先完成上面的后端安装或构建，再写入配置。'
}
$configDir = if ($env:PI_AGENT_LAUNCHER_DATA_DIR) {
    [IO.Path]::GetFullPath($env:PI_AGENT_LAUNCHER_DATA_DIR)
} else { Join-Path $env:APPDATA 'Pi Agent Launcher' }
$configFile = Join-Path $configDir 'launcher-config.json'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null
if (!(Test-Path -LiteralPath $configFile)) {
    $settings = @{ backendPath = $backendPath; cwd = $HOME; port = 30141 }
    [IO.File]::WriteAllText($configFile, ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
Write-Host "本次选择的后端目录：$backendPath"
notepad $configFile
```

配置文件默认位于 **`%APPDATA%\Pi Agent Launcher\launcher-config.json`**，目录名称为兼容旧版而保留。
设置过 `PI_AGENT_LAUNCHER_DATA_DIR` 时，上面的命令与应用都会使用该自定义目录。
如果已有配置，切换后端时只需把 `backendPath` 改为上面打印的目录。
`cwd` 是默认工作目录，可以改为你实际使用的项目目录。

需要代理连接模型服务时，在配置中添加 `proxyUrl`，例如 `"proxyUrl": "http://127.0.0.1:8080"`，
并换成你自己的 HTTP 代理端口。不填写则继承环境代理；设为 `""` 可明确禁用代理。
这是启动器传给其后端进程的代理，不会修改 Windows 系统代理。

完整字段说明、路径写法与更多例子见 **[配置指南](config/README.md)**。
配置使用标准 JSON，不支持注释；修改后需从托盘退出并重开。

## 4. 启动与使用

从源码运行时，在启动器目录执行：

```powershell
npm start
```

已安装客户端的用户，直接打开桌面或开始菜单中的 **Pi Launcher**。
第一次使用时，在 Pi Web 的 Models 面板中登录模型提供方或配置 API Key。

- **关闭窗口**：隐藏到托盘，后端继续运行。
- **托盘“退出”**：停止启动器拥有的后端并退出；请先结束正在进行的任务。
- **已有 Pi Web 服务**：复用同一端口上的健康服务，不接管或停止外部服务。
- **查看日志**：托盘中选择“打开日志目录”。

想自己生成 Windows 安装包，在启动器目录执行 `npm run dist`，产物位于 `dist/`。
安装包仍需配合已安装的 Node 和外置 Pi Web 后端使用。

## 更新后端

更新前先结束任务，并从托盘退出启动器。

- **npm 版**：重新执行 `npm install -g @agegr/pi-web`；若 npm 安装位置未变，无需改配置。
- **fork 版**：在源码目录选择要使用的版本，再从启动器目录执行
  `npm run build:source -- --output release/backend-next`，完成后将 `backendPath` 改到新目录。
  不要覆盖正在使用的构建目录；保留旧目录即可手动切回。

模型配置和会话沿用 Pi Web/Pi 的用户目录，启动器不会迁移或清空它们。

## 也可以直接使用浏览器

如果熟悉系统服务管理，可以不使用这个客户端：Linux 用 systemd/OpenRC，macOS 用
launchd（`launchctl`），Windows 用任务计划程序或合适的服务包装器管理 Pi Web，
再通过浏览器访问。Chrome、Edge 等浏览器的 PWA 安装功能可提供独立应用窗口，
但 **PWA 不负责启动或守护后端服务**。

## 相关项目与许可

- [Pi Web](https://github.com/agegr/pi-web) · [Pi](https://github.com/earendil-works/pi) · [notakevz/pi-web](https://github.com/notakevz/pi-web)

本项目不是上游官方客户端，代码、文档与自有图标采用 [MIT 许可证](LICENSE)。
第三方组件保持各自许可证，见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。
