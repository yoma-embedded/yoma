# Yoma Desktop

Yoma 的桌面端应用。它是从 [opencode](https://github.com/anomalyco/opencode) 的前端**分叉并解耦**出来的、独立演进的 Electron 应用：界面完全归我们自己维护，后端（opencode 服务端 / 内核）则以**版本化产物**的形式被消费，从而可以持续合并官方更新。

- **前端仓库**（本仓库）：`yoma-embedded/yoma-desktop` —— 我们自己的产品，界面和壳
- **后端仓库**（分叉 opencode）：`yoma-embedded/opencode` —— 追踪官方上游，构建出服务端产物供本仓库使用

---

## 目录

- [这是什么](#这是什么)
- [架构](#架构)
- [目录结构](#目录结构)
- [它如何连接后端](#它如何连接后端)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [常用命令](#常用命令)
- [开发说明](#开发说明)
- [打包与发布](#打包与发布)
- [与后端的关系 / 升级工作流](#与后端的关系--升级工作流)
- [故障排查](#故障排查)

---

## 这是什么

opencode 是一个「无头服务端 + 多客户端」架构的 AI 编码 agent：服务端是一个 HTTP 服务，各种客户端（终端、桌面、IDE 插件）都是它的客户端。

**Yoma Desktop 就是这样一个客户端**——一个 Electron 桌面应用，它把 opencode 的服务端**内嵌进自己进程里**运行，界面用 SolidJS 编写。我们对它做了两件关键的事：

1. **解耦**：前端不再依赖 opencode 的内部包（`@opencode-ai/core` 等），只通过 **SDK（API 契约）** 和 **服务端产物包** 两个清晰的接缝与后端交互。
2. **独立仓库**：前端在本仓库自由演进，后端在另一个仓库追踪官方，二者通过版本化产物连接（详见[与后端的关系](#与后端的关系--升级工作流)）。

---

## 架构

```
┌────────────────────── Electron 桌面 (packages/desktop) ──────────────────────┐
│  main 进程                                                                    │
│   ├─ fork 一个 utilityProcess（“sidecar”）                                    │
│   │    └─ import "virtual:opencode-server" → @yoma-desktop/opencode-server    │
│   │         Server.listen(127.0.0.1:<随机端口>, Basic 认证)  ← 你改过的后端    │
│   └─ 通过 IPC 把 { url, username, password } 交给 renderer                    │
│                                                                               │
│  renderer = @yoma-desktop/app（SolidJS 界面）                                 │
│   └─ createOpencodeClient({ baseUrl }) ── HTTP ──▶ 上面的 sidecar             │
│        （@opencode-ai/sdk = 类型化 API 客户端 / 契约）                         │
└───────────────────────────────────────────────────────────────────────────┘
      ▲ 服务端产物由【后端仓库】构建： opencode/publish/build-server.ts
```

要点：
- **后端不是外挂的 exe**，而是被编译成一个 Node bundle（`node.js`），在 Electron 的 utility 进程里**在进程内**运行。
- 界面**不写死后端地址**，由 main 进程在启动时选好本地端口 + 随机密码，通过 IPC 交给界面。
- 开发时 renderer 由 vite 提供热更新；生产时通过自定义的 `oc://` 协议加载打包好的界面。**注意：热更新不覆盖内嵌的服务端**（见[开发说明](#开发说明)）。

---

## 目录结构

这是一个 Bun workspace（monorepo），`packages/` 下有 6 个包：

| 包 | 名称 | 作用 |
|---|---|---|
| `packages/desktop` | `@yoma-desktop/desktop` | Electron 壳：main/preload/renderer、打包、自动更新、品牌 |
| `packages/app` | `@yoma-desktop/app` | SolidJS 应用主体：页面、会话、状态、i18n |
| `packages/ui` | `@yoma-desktop/ui` | 共享组件库、主题、图标、字体、favicon 资源 |
| `packages/session-ui` | `@yoma-desktop/session-ui` | 会话 / 消息渲染相关组件 |
| `packages/sdk` | `@opencode-ai/sdk` | **API 契约**：类型化 HTTP 客户端。从后端同步而来，保留原名 |
| `packages/util` | `@yoma-desktop/util` | 少量纯工具函数（encode/path/binary/array/retry），从 opencode core vendor 而来 |

> 为什么 `sdk` 仍叫 `@opencode-ai/sdk`？它是从后端 OpenAPI 生成的客户端、是前后端的**契约**，保留原名能让「从后端同步」更简单，也让边界一目了然：代码里凡是 `@opencode-ai/*` 的，就只剩这个 SDK。

---

## 它如何连接后端

前端对后端的依赖只有**两个接触点**：

1. **`@opencode-ai/sdk`**（workspace 成员）—— 界面通过它发 HTTP 请求。它是从后端 `packages/sdk/js` 同步过来的一份快照，由前端决定何时升级（= 你「钉住」API 版本）。
2. **`@yoma-desktop/opencode-server`**（`file:` 依赖）—— 内嵌运行的服务端 bundle。声明在 `packages/desktop/package.json`：
   ```
   "@yoma-desktop/opencode-server": "file:../../../opencode/publish/server"
   ```
   它指向**后端仓库**里 `publish/server/` 目录下的构建产物。`packages/desktop/electron.vite.config.ts` 里把 `virtual:opencode-server` 解析到这个包。

> 因为是 `file:` 路径依赖，**后端仓库必须作为本仓库的同级目录存在**（见下）。

---

## 环境要求

- **Bun 1.3.14**（`package.json` 里 `packageManager` 已锁定；建议用同一版本）
- **后端仓库**克隆在**同级目录**，且服务端产物已构建（见[快速开始](#快速开始)）
- 目录布局必须是这样（两个仓库并排，名字分别是 `opencode` 和 `yoma-desktop`）：
  ```
  <某个父目录>/
  ├── opencode/        ← 后端 fork（yoma-embedded/opencode）
  └── yoma-desktop/    ← 本仓库
  ```
- **Windows 用户**：后端仓库用到了 git 符号链接，克隆前需先启用符号链接支持（一次性）：
  1. 打开 Windows「设置 → 隐私和安全性 → 开发者选项 → 开发者模式」
  2. `git config --global core.symlinks true`

  > 本前端仓库**不需要**开发者模式（内部用的是真实文件，不是符号链接），只有后端仓库需要。

---

## 快速开始

### 1) 克隆两个仓库（并排放）

```bash
# Windows 用户先做一次：开发者模式 + git config --global core.symlinks true
git clone git@github.com:yoma-embedded/opencode.git
git clone git@github.com:yoma-embedded/yoma-desktop.git
```

### 2) 构建后端的服务端产物

```bash
cd opencode
bun install
bun publish/build-server.ts    # 生成 publish/server/node.js（+ *.wasm）
```

### 3) 安装并运行前端

```bash
cd ../yoma-desktop
bun install
bun dev:desktop                # 启动桌面应用（带界面热更新）
```

第一次会下载 Electron 二进制（~200MB）。启动后会弹出 Yoma 桌面窗口。

---

## 常用命令

在**前端根目录**执行：

| 命令 | 作用 |
|---|---|
| `bun dev:desktop` | 开发模式运行桌面应用（renderer 热更新） |
| `bun build:desktop` | 生产构建（electron-vite build，产物在 `packages/desktop/out/`） |
| `bun package:win` | 打 Windows 安装包（electron-builder，产物在 `packages/desktop/dist/`） |
| `bun package:mac` / `bun package:linux` | 打 macOS / Linux 包 |
| `bun typecheck` | 全部包类型检查（turbo，6 个包） |
| `bun lint` | oxlint |
| `bun dev:web` | 只跑网页版界面（需另外单独跑一个后端 `opencode serve`，见下） |

> `dev:web`：网页版在 dev 下通过环境变量 `VITE_OPENCODE_SERVER_HOST` / `VITE_OPENCODE_SERVER_PORT`（默认 `localhost:4096`）连后端。所以要先在后端仓库跑 `bun run --conditions=browser ./packages/opencode/src/index.ts serve --port 4096`（并设 `OPENCODE_SERVER_PASSWORD`），再 `bun dev:web`。日常开发桌面端用 `bun dev:desktop` 即可，不需要这步。

---

## 开发说明

- **改界面**：`bun dev:desktop` 下改 `packages/{app,ui,session-ui}` 的代码有热更新，直接生效。
- **改后端 / 内核**：内嵌的服务端 bundle **只在启动时构建一次、没有热更新**。改了后端代码后，需要：
  1. 在**后端仓库**重建产物：`cd opencode && bun publish/build-server.ts`
  2. 在**前端仓库**刷新 `file:` 依赖：`bun install`
  3. **重启** `bun dev:desktop`

  > 想要后端有快速热重载的开发循环，可以在后端单独跑 `opencode serve`，再让桌面端连它（改 `packages/desktop/src/main/index.ts` 里解析后端 URL 的那段，或用应用内「添加服务器」）。这属于进阶用法。

- **类型检查**：`bun typecheck` 应保持 6/6 全绿。

---

## 打包与发布

品牌 / 打包配置在 `packages/desktop/electron-builder.config.ts`：

- **appId**：`com.yoma.desktop`（dev/beta 各有后缀）
- **产品名**：Yoma
- **深链协议**：`yoma://`
- **图标**：`packages/desktop/icons/{dev,beta,prod}/`（当前是占位「Y」图标，可替换）
- **自动更新源**：GitHub Releases，已配置为 `yoma-embedded/yoma-desktop`（beta 渠道用 `yoma-embedded/yoma-desktop-beta`）。owner 可用环境变量 `YOMA_GH_OWNER` 覆盖

> ⚠️ 自动更新要能工作，发布用的仓库需**存在且能被应用读取**：electron-updater 的 GitHub provider 默认读**公开** Release。所以若 `yoma-embedded/yoma-desktop` 是私有仓库，自动更新会拿不到（需改用公开的发布仓库、或自建更新服务器）。用 beta 渠道前，先建好 `yoma-desktop-beta` 仓库。

### 出一个 mac 安装包（已实测跑通）

```bash
# 0) 前提：在 my-pi 仓库跑过 bun engines/build.ts。
#    package 脚本会先跑 scripts/stage-engines.ts：校验 + 把 engines 实体化到
#    .engines-stage/（空目录 / 悬空软链直接失败，不会打出静默的坏包）。
OPENCODE_CHANNEL=prod bun build:desktop
OPENCODE_CHANNEL=prod bun --cwd packages/desktop package:mac
# 产物：packages/desktop/dist/yoma-mac-arm64.dmg（分发用）
#      + yoma-mac-arm64.zip / *.blockmap / latest-mac.yml（自动更新要上传的三件）
```

- **签名/公证**：机器上没有 Apple 公证凭据时自动出**未公证包**——照常能用，但接收者第一次打开要
  右键 →「打开」（Gatekeeper）。配齐 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`
  （或 `APPLE_KEYCHAIN_PROFILE`），且钥匙串里有 **Developer ID Application** 证书，同一条命令
  自动升级为完整签名 + 公证，用户双击即开。
- **发布一个版本**（手动）：GitHub 建好公开仓后
  `gh release create vX.Y.Z dist/yoma-mac-arm64.dmg dist/yoma-mac-arm64.zip dist/yoma-mac-arm64.zip.blockmap dist/latest-mac.yml`。
  已装用户的 app 每 10 分钟查一次更新，菜单里也能手动查。发布前记得抬
  `packages/desktop/package.json` 的 `version`。
- **已知限制**：engines 里的 Python 三件套（board_ir / connections / controller_map）目前是
  venv 脚本，装到别的电脑上必坏（打包时会有响亮警告），要等 my-pi 的 `engines/build.ts`
  产出自包含产物；Windows / Linux 包同理需要对应平台的引擎产物，目前只有 mac-arm64。

### Windows 包：现状与路线

壳的构建已实测跑通：`bun package:win` 在 mac 上就能出 NSIS 安装器（`dist/yoma-win-x64.exe`），
不需要 Windows 机器。`stage-engines.ts` 按魔数校验引擎平台——当前 engines 全是 mac-arm64 的，
所以它会**直接拒绝**打 Windows 包。这是对的：壳能装上，硬件引擎全是坏的。

真正缺的两样：

1. **my-pi 为 Windows 构建 engines**：`probe-rs.exe` / `stm32kernel.exe`（Rust，官方支持 Windows）
   + Python 三件套的自包含 exe。内核本身已是 Windows-aware（`engines.ts` 按 `${name}.exe` 找引擎、
   进程树清理用 `taskkill`），引擎产物就位后前端零改动。
2. ~~一台 Windows 机器做验证~~ **已验证**（2026-08-03，预览包在真实 Windows x64 上：
   安装、配 key、真对话全通 —— 内核 JS 在 Windows 上没有平台问题；烧录冒烟等引擎就位后补）。
   预览包挂在 Release `v0.1.0-win-preview.1`（硬件工具坏，其余可用）。

引擎缺位时的逃生口：`YOMA_ALLOW_FOREIGN_ENGINES=1` 强行出包，仅用于验证安装器流程本身，
**不能分发**。另外两点：无签名 exe 会被 SmartScreen 拦（「更多信息 → 仍要运行」），要消除
得买 Windows 代码签名证书；CI 签名脚本位 `script/sign-windows.ps1` 目前不存在，上
GitHub Actions 打 win 包时要补上或摘除该钩子。

Linux：`bun package:linux`（AppImage/deb/rpm 配置已在，引擎产物同样未就位）。渠道用环境变量
`OPENCODE_CHANNEL`（`dev` / `beta` / `prod`）控制。

---

## 与后端的关系 / 升级工作流

- **后端仓库** `yoma-embedded/opencode` 追踪官方 opencode（`upstream` remote），并通过 `publish/` 构建出 `@yoma-desktop/opencode-server` 产物 + 提供 `@opencode-ai/sdk` 契约。
- **前端仓库**（本仓库）冻结自己的界面演进，只在需要时**主动**采纳后端/API 的变更。

当你想采纳后端的官方更新时：

```bash
# 后端仓库
cd opencode
git fetch upstream && git checkout dev && git merge upstream/dev   # 拉官方更新
git checkout main && git merge dev                                 # 合进你的工作分支
bun install && bun publish/build-server.ts                         # 重建服务端产物

# 若 API 有变化，把新 SDK 同步进前端（契约）
cp -r packages/sdk/js/src ../yoma-desktop/packages/sdk/

# 前端仓库
cd ../yoma-desktop
bun install && bun typecheck    # 类型检查会精确标出所有需要适配的调用处，逐个修
```

> SDK 是「减震器」：后端 API 变了，重新生成的 SDK 类型会让前端在编译时报错，红线指到哪就改哪。建议**钉住一个后端版本、按需成批升级**，不要追每个 commit。

---

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| `Error: Electron uninstall` | Electron 二进制没下载。跑 `node node_modules/.bun/electron@*/node_modules/electron/install.js`，或重新 `bun install`。 |
| 启动时报 `virtual:opencode-server` 找不到 / 没有 `node.js` | 后端产物没构建。到后端仓库跑 `bun publish/build-server.ts`，再回前端 `bun install`。 |
| `bun install` 失败，提示找不到 `../../../opencode/publish/server` | 后端仓库没放在同级目录，或目录名不对。确保 `opencode` 和 `yoma-desktop` 并排、名字正确。 |
| 时间线报 `getLogicalScrollOffset is not a function` | 缺 `@tanstack/virtual-core` 补丁（已随仓库带上，正常 `bun install` 会应用）。 |
| 界面是中文/其它语言 | opencode 自带 18 种语言，按系统语言自动选择。可在 应用内 Settings → General 切换。 |
| `bun typecheck` 报 `custom-elements.d.ts` 之类 `TS1128` | 这是**后端仓库**在 Windows 上没启用符号链接导致的，见[环境要求](#环境要求)（开发者模式 + `core.symlinks`）。本前端仓库不会有此问题。 |

---

## 许可

MIT（继承自 opencode）。opencode 版权与许可声明见 `LICENSE`。
