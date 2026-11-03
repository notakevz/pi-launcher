# Windows 构建与发布清单（AI 维护）

本文供 AI 和贡献者执行构建、测试与发布维护，入口见 [AI 维护说明](ai-maintenance.md)。
普通用户安装和使用请读 [README](../README.md)，不需要逐项执行此清单。

本文区分可复现的源码检查与实际 Windows 发布验收。不要把旧机器上的历史测试
记录、Node 单元测试或静态检查写成新安装包已经通过验收。

## 已有验证基线

- 原始客户端：本次公开整理前的版本，项目维护者已在 Windows
  上手动测试，并确认正常使用；具体 Windows 版本及逐项测试结果未另行提供。
- 公开准备改动：JSON 配置、通用默认值及容错逻辑已通过自包含 Node 单元测试，
  尚待 Windows 回归。不能用原版的成功测试替代这些新增改动的验证。
- 以下清单用于后续构建/发布，不表示原始客户端从未运行成功，也不表示所有项目已验收。

## 1. 公开源码前

- [ ] 确认 `LICENSE` 的 MIT 许可和作者署名，以及 package 元数据中的声明。
- [ ] 实际用户配置、凭据、日志、会话、后端构建、Electron 安装包未进入 Git。
- [ ] README 不含个人路径、代理账号密码、机器专属部署历史。
- [ ] `npm run test:unit` 通过；GitHub Actions 的 Windows/Linux 单元检查通过。
- [ ] 用户配置指南与 `config/launcher-defaults.json` 一致，README 的 npm/fork 路线均可按步骤操作。
- [ ] 检查 fork 兼容性；记录实际验收的后端 commit 和 Node/Windows 版本。

## 2. 准备 Windows 环境

使用 Windows 10/11 原生工具链、Node.js >=22.19、npm 和 Git。
不要用 WSL 构建后声称生成了已验证的 Windows 后端。

```powershell
npm ci
npm run test:unit
```

Electron 安装需要下载对应平台二进制。下载失败时检查终端代理、官方源和缓存，
不能关闭 TLS 校验或复制来源不明的二进制。启动器的用户 JSON 代理配置不代替
npm/Electron 安装时的终端网络配置。

复制 `config/launcher-config.example.json` 到
`%APPDATA%\Pi Web Launcher\launcher-config.json`，按实际情况填写。
首次构建前配置 `cwd`、网络等；`backendPath` 指向将要生成的运行目录。
已有真实配置时先人工比较，不覆盖它。

## 3. 构建后端

`config/backend-build.json` 保存通用构建参数。源码 checkout 必须干净，
默认目标 fork 与启动器为同级目录。升级先选择 commit，CLI 参数可覆盖构建配置。

```powershell
npm run build:source -- --source C:/src/pi-web --commit <完整40位SHA> --output release/backend-next
```

脚本在临时 worktree 中安装依赖、执行指定范围测试、typecheck、lint 和生产构建，
生成运行目录与 `source-release.json`。不覆盖已有输出，不自动拉取源码。
跨盘输出会使用目标盘暂存；交付失败会报告保留产物的位置，可能同时留下部分输出目录。
不要直接使用部分输出，也不要自动覆盖或删除它；先核对恢复路径，再选择新的输出目录重试。
构建交付完成前，不要让启动器指向新目录。
默认的 windows-core 测试只是选定的核心用例，不等于全量上游认证。

将用户 JSON 的 `backendPath` 指向该产物，执行：

```powershell
npm run backend:check
npm run backend:check -- --verify
```

`--verify` 是显式完整性检查，不属于正常应用启动流程。

## 4. 集成验收

测试应使用临时用户数据目录及独立端口，不修改真实会话或接管正式服务。
集成测试故意不隐式读取个人后端目录；即使用户 JSON 已配置，也须显式设置下面的变量。
确认端口空闲后执行；真实模型调用必须先取得用户许可。

```powershell
$env:PI_WEB_LAUNCHER_BACKEND_PATH = 'C:/pi-web/backend-next'
npm run test:integration
npm run test:source-web
npm run test:loading
```

如果父终端设置了 `ELECTRON_RUN_AS_NODE`，运行真实 Electron 测试前先移除此变量。
测试显式指定的后端必须与将要发布/推荐的后端一致；不要只测旧产物。

- [ ] 首次配置、缺配置、错误路径和错误 JSON 的提示明确。
- [ ] 没有代理时直连；显式代理、禁用代理和本地绕过符合配置。
- [ ] 桌面窗口显示实际 Pi Web 页面；托盘显示正确后端身份。
- [ ] 关闭窗口隐藏，再次启动唤回，无第二个常驻实例。
- [ ] 外部健康服务可复用，退出不停止它。
- [ ] 占用端口、启动超时、后端退出可诊断，不结束无关进程。
- [ ] 从开始菜单启动、退出重开后 JSON 配置仍生效。
- [ ] 退出清理及升级/回退不会迁移、清空凭据和会话。

### 可选子代理扩展测试

`scripts/test-subagent-*.mjs` 验证的是外部扩展，而不是启动器能力。
这些文件和角色定义不随本项目交付，不能默认从真实 home 中隐式加载。
显式指定测试扩展和角色目录，缺失时不要宣称通过；纯启动器发布可以不运行。
这些扩展是可信可执行代码，只能使用已审查且版本匹配的实现。

```powershell
$env:PI_WEB_LAUNCHER_BACKEND_PATH = 'C:/pi-web/backend-next'
$env:PI_WEB_LAUNCHER_SUBAGENT_PATH = 'C:/test-fixtures/subagent' # 包含 policy.ts、index.ts
$env:PI_WEB_LAUNCHER_AGENTS_PATH = 'C:/test-fixtures/agents' # 四角色 Markdown
npm run test:subagent
```

目前本项目不交付这套外部扩展，不能只克隆启动器就声称完成子代理验收。
验证时记录外部实现的版本和来源；启动器的日常使用不依赖这套测试。

## 5. 生成并验证安装包

```powershell
npm run dist
npm run test:packaged
```

打包只包含 Electron 入口、配置默认值和静态资源，不包含后端或用户配置。

- [ ] 在 Windows 上实际安装、启动、关闭隐藏、唤回、退出。
- [ ] 确认缺少 Node/后端时的错误提示，不以开发机有依赖代替验收。
- [ ] 名称统一为 Pi Web Launcher，EXE/快捷方式/窗口/托盘/启动页没有其他产品名。
- [ ] 应用 ID、默认数据目录、新环境变量前缀与配置指南一致，不搜索或迁移其他目录。
- [ ] 安装路径含空格时可用，用户配置不因重装丢失。
- [ ] 安装包不含 credentials、sessions、日志、后端产物或个人配置。
- [ ] 发布说明写明版本、平台、后端兼容性和未验项目。
- [ ] 为发布文件生成 SHA-256；未签名时说明可能触发 SmartScreen。

## 6. GitHub Actions 手动打包与可选发布

`.github/workflows/build-windows.yml` 显示为 **Build Windows**，只接受 `workflow_dispatch`。
普通 push、PR、tag 不触发打包或发布，也没有 npm publish 工作流。
有仓库写权限的维护者在 **Run workflow** 选择 `main`；`publish_release` 勾选项默认关闭。

### 仅打包（默认）

- 构建 job 只有 `contents: read`，检出本次运行的固定 SHA，不跟随移动的分支头。
- 使用 Windows runner、Node 22 和锁文件 `npm ci`，先运行自包含单测及语法检查。
- 执行 `npm run dist -- --x64 --publish never`，不构建或安装外置 Pi Web 后端。
  NSIS 安装包使用无空格 ASCII 文件名，如 `pi-web-launcher-0.0.1-x64-setup.exe`，产品显示名不变。
- 仅上传 `dist/*.exe` 与 `dist/SHA256SUMS.txt` 为 `pi-web-launcher-windows-x64` 附件，保留 7 天。
  不上传整个工作区、依赖、用户配置、后端、调试输出或 `win-unpacked`。
- 不配置模型凭据、个人代理或签名证书；产物为未签名安装包。
- 不在 CI 中调用真实模型或连接用户服务，不能替代第 4、5 节的实际运行验收。

### 勾选发布到 Release

勾选 **Publish to GitHub Release (create version tag)** 后，只有构建成功才执行独立发布 job：

1. 使用 Ubuntu runner，只有该 job 申请 `contents: write`，使用内置 `GITHUB_TOKEN`，不需要个人 PAT。
   仓库或组织策略若拒绝写权限，发布会失败；不要绕过权限限制。
2. 检出与构建相同的 SHA，下载**本次运行**的附件；不重新打包，也不通过维护者电脑中转。
   发布脚本拒绝白名单以外的文件、符号链接及可能被 GitHub 改写的文件名，并核对 EXE 与 SHA-256 清单。
3. 从该 commit 的 `package.json` 读取版本，生成如 `v0.0.1` 的标签。
   完整分页检查所有 Release（包括草稿），已有同名标签（即使指向相同 commit）或 Release 时停止。
   查询失败不当作不存在，不覆盖、不复用。
4. 原子创建指向该 SHA 的标签，再创建草稿 Release，上传 EXE 和校验文件。
   每个上传响应的文件名须与校验清单一致，全部成功才公开发布。
   版本中的 prerelease 标记会对应 GitHub 的预发布状态。
5. 发布任务的摘要给出 Release 链接。公开 Release 的附件不受 Actions 的 7 天期限限制。

同一仓库的发布 job 串行执行，标签创建仍以 GitHub 的原子检查为准。
若创建标签后发生上传或发布失败，标签/草稿可能保留；先人工检查，不自动删除或覆盖后重跑。
使用新版本重新发布，或另行获得维护者批准后再处理未完成的标签/草稿。

查看真实运行日志和附件状态后才能报告“打包/发布成功”；提交工作流不是已产出 EXE，
发布成功也不能替代第 4、5 节的 Windows 实际运行验收。
