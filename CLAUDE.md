# CLAUDE.md

给 Claude Code 在本仓库工作时的说明。`README.md`(中文)是面向用户的权威文档。
`packages/app/AGENTS.md` 和 `packages/desktop/AGENTS.md` 是包级规则,必须遵守。

## 这是什么

Yoma Desktop 是一个 Electron 桌面端,UI 用 SolidJS。它 **fork 自 opencode 的前端**,
但后端内核已经换成 **`../my-pi`** —— 不再是 opencode,也不再是 `../yoma`。

唯一的兄弟仓依赖是 **`../my-pi` 的源码**。本仓库不需要任何兄弟仓的 **构建产物**
(历史上依赖过 `../yoma/publish/server`,已拆除)。

## 内核接缝:my-pi 走 alias,不进 install graph

这是全仓最容易搞错的一件事,原因写在 `packages/kernel/mypi.ts` 顶部:

- my-pi 内部用 `workspace:*` 互相引用 → 声明成 `file:`/`link:` 依赖会让 `bun install` 直接失败;
- my-pi 只发 raw TypeScript(`exports` 指向 `src/*.ts`,内部 153 处 `./x.ts` 后缀说明符)
  → 真装进 node_modules 后,Node 的 strip-only 加载器报
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,**无 flag 可关**;
- 它还有 TS 参数属性(`gdb.ts:485`、`acp/agent.ts:209`)→ strip-only 模式直接
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。

所以走 **alias**:构建期 esbuild 把 my-pi 源码整个 inline 进 `out/main/kernel.js`
(参数属性和 `.ts` 说明符在这一步一起消失),typecheck 期由 tsconfig 的 `paths` 走同一组映射。
**my-pi 一个字节都不用改**,而且它一旦挪文件是编译期硬失败,不是运行时惊喜。

这张映射存在 **三份**(被工具链逼的,`packages/kernel/src/mypi-alias.test.ts` 把它们钉在一起):

| 位置 | 谁用 |
|---|---|
| `packages/kernel/mypi.ts` 的 `MY_PI_ALIASES` | 打包期(electron-vite / esbuild) |
| `tsconfig.mypi.json` 的 `paths` | typecheck(tsgo),被 kernel/desktop 继承 |
| `packages/kernel/tsconfig.json` 里 **内联** 的同一份 | `bun test` —— bun 不跟随数组形式的 `extends` |

pi-ai 的 path 必须指向 **`dist/index.js` 而不是 `.d.ts`**:bun 会照着 paths 真去加载那个文件。

## 仓库结构

Bun workspace,`packages/` 下 5 个包:

| 包 | 名字 | 职责 |
|---|---|---|
| `desktop` | `@yoma-desktop/desktop` | Electron 外壳:main/preload/renderer、内核进程、打包、自动更新 |
| `app` | `@yoma-desktop/app` | SolidJS UI —— 一个**库**,两个宿主(web + desktop);页面、路由、状态、i18n |
| `kernel` | `@yoma-desktop/kernel` | **内核接缝**:浏览器安全的视图模型/协议/客户端 + Node 侧 host |
| `ui` | `@yoma-desktop/ui` | 领域无关的基础组件(Kobalte)、OKLCH 主题引擎、图标 |
| `session-ui` | `@yoma-desktop/session-ui` | transcript 渲染:消息、工具卡片、流式 markdown、Pierre diff |
| `util` | `@yoma-desktop/util` | 纯函数小工具 |

分层单向:`ui`(叶) → `session-ui` → `app` → `desktop`;`kernel` 被 `app` 和 `desktop` 消费。

`packages/kernel` 的两个入口边界必须守住:

- `.`(`src/index.ts`)—— **浏览器安全**,不 import my-pi、不 import `node:*`。
  视图模型里的工具 details 是从 my-pi **结构化复制** 的,不是 import 的。
- `./host`(`src/host/`)—— 只跑在 utilityProcess 里,碰内核、碰文件系统。

复制的漂移由 `src/host/details-check.ts` 在编译期兜住(my-pi 改名/删字段/改类型 → 编译失败)。
**断言必须写成约束式 `Expect<T extends true>`** —— 写成 `const _: Check = true as never`
是一个不会响的闸门(`never` 可赋给任何类型,实测踩过)。

## 命令

| 命令 | 作用 |
|---|---|
| `bun dev:desktop` | 开发模式(renderer 有 HMR;**内核进程没有**) |
| `bun build:desktop` | 生产构建 → `packages/desktop/out/` |
| `bun package:mac` / `:win` / `:linux` | electron-builder 安装包 |
| `bun typecheck` | turbo 跑全部 6 个包 —— **必须常绿 6/6** |
| `bun lint` | oxlint |
| `bun --cwd packages/desktop smoke` | 内核冒烟:对 **构建产物** 验证 11 个工具 + 5 个引擎二进制 |
| `bun --cwd packages/desktop e2e:ipc` | 生产路径:真 utilityProcess + 真 MessagePort + 真协议帧 |

后两个是 CI 里唯一能挡住"my-pi 一次重构悄悄搞死桌面端"的东西 —— 我们是把它整个 inline
进 bundle 的,内核的改动可以在我们这边零编译错误地把 app 弄坏,直到用户点下去才发现。

### 测试

- `bun --cwd packages/app test src`(bunfig 自动 preload happydom)
- `bun --cwd packages/kernel test` —— 投影器不变式、事件流、权限门、自动压缩、端到端 host
- `bun --cwd packages/session-ui test src`、`bun --cwd packages/ui test src`

## 架构

### 数据面:renderer ↔ 内核

没有 HTTP、没有端口、没有密码、没有 CORS、没有 SSE。

```
renderer  --window.api.kernel-->  preload(MessagePort 留在这一侧)
                                        |
                                   MessageChannelMain
                                        |
main/kernel.ts (只牵线,不在数据通路上)  --> utilityProcess: out/main/kernel.js
                                                          = kernel/src/host + my-pi(inline)
```

- **只 fork 一个内核进程。** my-pi 的 probe 租约(`claimProbe`/`releaseProbe`)、gdb session 表、
  log capture 都是 **模块级全局**,分片 fork 会让两个进程各自以为自己独占探针。
- **MessagePort 不能过 contextBridge**,所以端口留在 preload world,只暴露
  `{request, subscribe, reattach}`(形状就是 `KernelTransport`)。
- **attach 必须挂在 `did-finish-load` 上**,不能只在建窗时调一次。每次 reload
  renderer 的端口都会失效,不重新牵线就是一个哑通道 —— 不报错,表现为"点什么都没反应"。

### 投影器:my-pi 的模型 → 前端认得的形状

`packages/kernel/src/host/projector.ts`。三条不变式,违反时全部 **静默**:

1. **live 与 replay 共用同一个 `applyMessage()`。** 快照始终从 `partial.content` 重算,
   delta 只是叠在上面的增量,于是"累积 delta 是快照的严格前缀"天然成立。
   my-pi 自己的 ACP 适配器在这里分了叉(`pipeHarnessToAcp` / `replayUpdatesOf`),
   代价是 datasheet 图片只在重放时可见。
2. **id 自己铸,而且确定。** 内核的 `generateEntryId()` 是 `uuidv7().slice(-8)` ——
   取的是 **随机尾部**,不可排序;而前端每个集合都用 `Binary.search` 按 id 字符串序维护。
   投影器从(消息序号, 时间戳)确定性铸 id,并对时钟回拨做严格递增钳制。
3. **发射顺序**:父 `message.updated` 早于它的任何 part;`part.updated` 早于该 part 的 delta。
   reducer 会静默丢弃孤儿 part 和未知 part 的 delta。

### 内核事件只能用 `subscribe()`

`my-pi/packages/agent/src/harness/agent-harness.ts:230-248` 的 `emitOwn` 和 `emitAny`
**字节相同**,都只遍历订阅者桶。所以这十个 `on()` 类型 **永远不会触发**:
`save_point` / `settled` / `abort` / `session_compact` / `model_update` / `tools_update` /
`queue_update` / `after_provider_response` / `session_tree` / `thinking_level_update`。

只有走 `emitHook` 的是活的:`tool_call` / `tool_result` / `context` / `before_agent_start` /
`session_before_compact` / `session_before_tree` / `before_provider_request` / `before_provider_payload`。

### harness 的三个行为

1. 一个 harness = 一个 session = 一个在飞轮次。phase 非 idle 时 `prompt()` **同步抛** busy,不排队。
2. `abort()` 之后 phase 不会立刻清 —— 必须 `await abort(); await waitForIdle()`。
3. `prompt()` 在 abort 后是 **resolve 而不是 reject**(中断是数据不是异常),
   要区分"取消"和"完成"只能自己拿 AbortController。

### 我们补的、内核没有的三件事

- **权限门**(`host/permission.ts`)。内核没有权限系统,它自己的 ACP 适配器也从不注册
  `tool_call` 钩子 —— 也就是说在 Zed 里 `flash download` 是无人值守直接擦片的。
  内核对这个钩子 **没有任何超时**,所以三个兜底一个都不能少:超时自动拒绝、
  abort 时拒绝该会话全部未决、renderer 重连时重推未决请求。
- **自动压缩**(`host/compaction.ts`)。内核只提供 `compact()`,什么时候压是应用层的事。
  两个 guard 一个不能少:没有真实 usage 数据时不猜(否则新会话一开口就被压)、
  刚压完不重压(否则一路压到没东西可压)。
- **模型目录**(`SessionManager.providers()`)。`thinkingLevels` 必须走 pi-ai 的
  `getSupportedThinkingLevels(model)` 去问,编错的后果是档位能选但发不出去。

模型凭据复用 my-pi 的 `resolveModel()` → `~/.pi/agent/auth.json`,也就是配 pi/Zed 时
已经填好的那份。桌面端零配置就能开跑。

## 约定与规矩

- **绝不重启 app 或内核进程**(`packages/app/AGENTS.md`)。优先级:稳定 > 简单 > 性能。
  动 session/timeline 代码前先记录生产基准。
- **SolidJS:一律用 `createStore`,不要堆 `createSignal`。**
- 属性驱动 CSS(`data-component` / `data-variant`),**不写 CSS-in-JS、不用工具类 props**。
- 依赖版本钉在根 `workspaces.catalog`,包里写字面量 `"catalog:"`。
- 用 **`tsgo`**(`@typescript/native-preview`)而不是 `tsc`。新包必须有 `typecheck` 脚本。
- turbo 的 `typecheck` 有 `dependsOn: ["^typecheck"]` —— 没有它,改了 kernel 的类型,
  依赖它的包会拿到过期缓存命中,typecheck 变成 **假绿**。验证时用 `--force`。
- Prettier 配置内联在根 `package.json`(`semi:false, printWidth:120`)。

## 会咬人的地方

- **engines 目录必须显式传**,别依赖 my-pi 的 `enginesDir()` 向上查找 —— 它只认
  "名字叫 engines 且存在",会高高兴兴找到一个没有 `bin/` 的空壳,然后报
  "去跑 `bun engines/build.ts`",让你以为是没编译。仓库根的 `engines` 是指向
  `../my-pi/engines` 的软链。
- **打包前必须先在 my-pi 仓库跑过 `bun engines/build.ts`**。`engines/bin` 与 `engines/data`
  里全是软链,electron-builder 会 dereference —— 没构建过就打出一个空目录,
  **而且不报错**,只在用户第一次点烧录时才炸。
- **内核没有 HMR。** 改了 my-pi 之后必须重启 `bun dev:desktop`。
- **这是一个 fork**:很多存储键/标题/appId 还写着 `opencode`(localStorage `opencode.*`、
  运行时 app id `ai.opencode.desktop` vs bundle id `com.yoma.desktop`)——
  这个不一致是刻意的(为了 userData 连续性),别盲目"修正"。
- `@tanstack/virtual-core` 的 patch 是承重的,没有它 timeline 会抛
  `getLogicalScrollOffset is not a function`。

## 已知的未完成项

- `ServerConnection` / `ServerKey` 这套概念还散在 app 的路由与标签页里(现在只是空壳,
  `serverReady` 用占位值立刻 resolve)。清除它是独立一件事。
- **终端(PTY)没有实现** —— my-pi 的 `NodeExecutionEnv.exec` 是一次性 spawn,不是伪终端。
  相关设置行现在是退化状态而不是造假。
- **应用内凭据界面没有做** —— `auth.set`/`auth.remove` 明确抛错并指向
  `~/.pi/agent/auth.json`,而不是假装成功后让用户对着一个不生效的表单困惑。
- 每轮的 diff 汇总留空了。要做的话应该从 `edit`/`write` 工具的 `details.patch` 合成,
  而不是找回 opencode 的文件快照(内核没有快照)。
- i18n 仍有 19 个 locale;非中英的那些和内核无关,可以另行瘦身。
