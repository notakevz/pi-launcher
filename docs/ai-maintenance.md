# AI 维护说明：实现、测试和验证

本文面向修改或维护本项目的 AI 和贡献者。用户如何安装、选择后端和使用应用，
统一放在 [README](../README.md)；不要向 README 追加测试清单、内部证据或机器部署历史。
开始任务前先读根 [AGENTS.md](../AGENTS.md)。

## 实现入口

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | Electron 窗口、托盘、单实例、启动与退出 |
| `src/backend.js` | 外置 Node、环境代理、服务就绪、进程记录与自有进程清理 |
| `src/local-backend.js` | JSON 配置、后端身份/产物与依赖检查 |
| `src/process-tools.js` | Windows PowerShell/CIM 查询与按身份终止进程树 |
| `config/launcher-defaults.json` | 打包时的通用运行默认值 |
| `config/backend-build.json` | 显式手动构建参数，不参与自动升级 |
| `scripts/build-source.js` | fork 构建、产物清单和不覆盖式交付 |
| `scripts/backend-manifest.js` | 手动完整性检查与仓库地址规范化 |
| `.github/workflows/build-windows.yml` | 手动 Windows x64 打包、临时附件及勾选后才执行的 Release 发布 |
| `scripts/publish-release.js` | 校验附件、拒绝已有版本、创建标签与草稿并在上传完成后发布 |

## 产品命名

对外名称统一为 **Pi Launcher**；安装程序、EXE、快捷方式、窗口、托盘和启动页均使用同名。
Windows 应用 ID 为 `local.pi.launcher`，默认数据目录为 `%APPDATA%\Pi Launcher`，
所有启动器专用环境变量使用 `PI_LAUNCHER_` 前缀。0.0.1 不读取旧版启动器环境变量，不提供旧名称别名或自动迁移；
不要自动移动或删除用户机器上的其他配置目录。Pi SDK 自身的变量和数据目录不属于此次命名范围。

## 两种后端的边界

- **npm 发布版**：安装后已有 `bin/pi-web.js` 和 `.next/BUILD_ID`，不需要用户再构建 Next.js。
  `backendPath` 应由 `npm root -g` 得到模块目录后追加 `@agegr/pi-web`。
- **fork 构建版**：使用本项目的显式构建命令，产物带生产依赖及 `source-release.json`。
  npm 版没有该清单是正常情况，不能因此拒绝启动。
- 依赖检查必须从**后端位置**出发，兼容私有和合法提升布局；不要因启动器自身能解析某包
  就认定后端完整。SDK 的 `exports` 未必导出 `package.json`，检查不能依赖这个子路径被导出。
- 启动器不是 Pi SDK 的第二套安装器。不要为了文档方便新增自动下载、隐式 npm/npx 或后端切换。
- fork 的工具模式、扩展和 API 回归不能当成 npm 上游具有相同功能的证据。

## 自包含检查

在启动器项目根目录执行：

```sh
npm run test:unit
npm run check:syntax
```

`npm test` 默认也只执行自包含单测。此类测试使用 Node 内置模块，不需要安装 Electron、
真实后端、模型账号或用户 home 中的扩展，可在 Linux 和 Windows 上运行。
GitHub Actions 的 Node/OS 矩阵只覆盖这一层，不是安装包或真实模型验收。

修改配置与目录检查时，至少覆盖优先级、非法输入、秘密不回显、npm/fork 布局、缺文件、
可选构建清单、外部服务复用、进程身份及失败清理。测试文件为：

- `scripts/test-local-backend.js`
- `scripts/test-config-unit.js`
- `scripts/test-main-unit.js`
- `scripts/test-release-unit.js`（临时附件与 mock GitHub API，不连接实际仓库）

配置或错误消息测试可能故意触发错误日志，以测试断言和最终退出码判断，不能仅看到
“Fatal error”字样就宣称失败，也不能忽略真正的非零退出码。

## Windows 和 Electron 检查

先按 [Windows 构建/发布清单](releasing.md) 准备明确的后端目录和隔离环境。

| 命令 | 作用与前置条件 |
| --- | --- |
| `npm run test:integration` | Windows 原生后端启停和窗口控制集成；需要显式外置后端 |
| `npm run test:source-web` | fork API、模式与实际 Electron；需要对应 fork 构建和完整依赖 |
| `npm run test:loading` | 真实 Electron 的本地启动页；需要桌面环境，不需要真实模型 |
| `npm run test:packaged` | 实际 Windows EXE；需要先打包并准备后端 |
| `npm run test:subagent` | 可选的外部子代理适配测试，输入与准备方式见发布清单 |
| `npm run backend:check` | 根据用户运行配置诊断 Node 与后端 |
| `npm run backend:check -- --verify` | 对带构建清单的产物执行显式完整性校验 |

集成脚本不能默认读取真实用户扩展和会话。用户 JSON 的存在不替代集成测试要求的显式
`PI_LAUNCHER_BACKEND_PATH` 等输入。缺少前置条件就说明未运行，不虚报通过。
纯启动器维护不需要运行可选子代理测试，不要索取或复制用户的全部 agent 目录。

## 构建与发布

- 用户需要自行构建启动器时可以使用 `npm run dist`；AI 发布前的具体检查放在
  [releasing.md](releasing.md)，不是 README。
- 产物目录须为新目录；交付失败按错误中的恢复路径核对，不自动删除保留的完整产物或部分输出。
- 保留 Electron/Chromium/Node 等第三方许可，不因本项目 MIT 而移除依赖通知。
- 应用图标为 Pi 项目 logo（MIT，Copyright (c) 2025 Mario Zechner，透明背景、未修改），
  版权与来源见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)；`python scripts/generate-icon.py`
  仅用于从 `assets/icon.svg` 重建 PNG/ICO，需要 Pillow，输出确定可复现。
- `Build Windows` 仅手动触发：Windows runner 安装依赖、运行自包含检查、生成未签名 x64 NSIS 安装包，
  只上传 EXE 和 SHA-256 文件为 Actions 附件，保留 7 天。没有后端、个人配置或真实模型测试。
- 构建 job 保持只读权限；`--publish never` 禁止 electron-builder 隐式发布。
  仅在维护者手动勾选 `publish_release` 时，独立发布 job 才使用 `contents: write` 与内置 `GITHUB_TOKEN`。
  发布 job 检出相同 SHA，下载本次运行的附件，校验白名单和 SHA-256；不用个人 PAT 或模型凭据。
- 标签为 `v` 加 `package.json` 的版本号，指向被构建的 commit；完整分页检查包含草稿的 Release，
  已有标签或 Release 就停止，查询失败即停止，不复用或覆盖。安装包文件名固定为无空格 ASCII 格式，
  上传响应的实际文件名必须保持一致，防止 GitHub 重命名后校验清单失效。
  新建草稿后上传 EXE/校验文件，全部成功才公开；失败保留标签/草稿供人工检查，不自动删除或重试覆盖。
- 普通 push、PR、tag 不自动发布，也没有 npm publish；提交、推送与手动发布按用户授权分别执行。
  构建或发布成功都不是 Windows 界面与完整安装/卸载验收通过。

## 报告与文档维护

- 原始客户端的 Windows 使用基线见 [releasing.md](releasing.md#已有验证基线)。
  只描述明确得到的确认，不推断用户测试过全部新代码或所有流程。
- 区分：静态检查、自包含测试、模拟依赖布局、真实 npm 安装、Windows GUI 与安装包验证。
- 对 npm 包的公开源码或 tarball 检查不是 Windows 安装实测；Node fixture 通过也不是模型认证成功。
- 只记录任务相关结果；不把用户名、真实路径、代理账号、凭据、会话或工作日志写进公开文档。
- 用户配置指南说明字段与示例；README 只保留完成使用所需的步骤，避免重复详细表格。
