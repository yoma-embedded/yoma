# Yoma

面向**嵌入式调试**的 agent：内核（烧录 / 日志 / gdb / 网表 / 数据手册 / STM32 配置）和桌面端在同一棵树上。

它不是 [opencode](https://github.com/anomalyco/opencode) 的客户端，也不再需要旁边再克隆一个后端仓库。界面从 opencode 桌面端分叉而来，内核源自 [pi](https://github.com/earendil-works/pi) 的嵌入式方向。打开应用后，renderer 通过 MessagePort 跟本机内核进程说话，没有 HTTP 服务端。

## 它解决什么

板子在桌上时：烧录、看 log、gdb、查原理图和手册、改固件再烧。  
两台机器时：研发机有代码和工具链，工位机只有板子；中间用一个 git 仓库当信箱。

它**不是** Cursor / Claude 的替代品。写这个仓库本身、问概念、贴一段 log 去想，继续用那些工具。

**使用前：**这是一个能烧录、能 gdb、能在你机器上跑命令的 agent，没有权限确认。只在你信任的本机上用。信箱闭环还没在当前协议下用真板子跑过，标 experimental。细节见 `SECURITY.md`。

## 快速开始

```bash
bun install          # 需要 Bun 1.3.14（见根 package.json 的 packageManager）
bun dev:desktop      # 开发模式；改内核源码没有热更新，要重启这次命令
```

第一次会下载 Electron。启动后在设置里配 **DeepSeek 或 Kimi** 的 API key。

凭据写在 `~/.yoma/auth.json`，条目必须带 `"type": "api_key"`，少了这个字段会被静默忽略（看起来像没配）。

没有内置免费模型。没有板子也能开会话聊天；网表 / STM32 配置这类工具需要引擎（`bun engines/build.ts`，或安装包里已经打好的那份）。烧录与调试走你机器上已有的探针工具链——装好 **J-Link 软件或 OpenOCD**（含各自的驱动）即可，Yoma 不再内置探针栈。

## 常用命令

| 命令 | 作用 |
|---|---|
| `bun dev:desktop` | 开发模式（界面有热更新，**内核没有**） |
| `bun build:desktop` | 生产构建 → `packages/desktop/out/` |
| `bun package:win` / `:mac` / `:linux` | 打安装包 |
| `bun typecheck` | 全部包的类型检查 |
| `bun test` | 单测 |
| `bun --cwd packages/desktop smoke` | 对构建产物做内核冒烟 |

## 现在还没有的（避免按界面去找）

- **应用内终端（PTY）**：菜单和设置里若还残留「终端」，那是旧界面，不能用。串口采集走的是日志工具，不是这个开关。
- **数据手册**：需要自建 `YOMA_DATASHEET_SERVER`，没配就查不了，不是装完就能搜芯片手册。
- **远程 OpenCode 服务器 / 免费 Zen 模型 / `opencode` CLI**：都不是这个产品。

更细的架构、信箱协议和会踩的坑见 `CLAUDE.md`。怎么跑测试见 `CONTRIBUTING.md`。例程库施工说明见 `docs/施工指南-例程库.md`。

## 许可

MIT。第三方来源见 `NOTICE`：桌面端继承自 [opencode](https://github.com/anomalyco/opencode)；`packages/ai` 来自 [pi](https://github.com/earendil-works/pi)。
