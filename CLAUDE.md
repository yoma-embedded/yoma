# CLAUDE.md

给 Claude Code 在本仓库工作时的说明。`README.md`(中文)是面向用户的权威文档。
`packages/app/AGENTS.md` 和 `packages/desktop/AGENTS.md` 是包级规则,必须遵守。

## 这是什么

Yoma 是一个面向**嵌入式调试**的 agent 平台,一棵树上两半:

- **内核**(`packages/{ai,agent,coding-agent}`)—— agent 循环、会话树、压缩、技能,
  以及嵌入式工具组(烧录 / 日志 / gdb / 网表 / 数据手册 / STM32 配置)。
- **桌面端**(`packages/{desktop,app,kernel,ui,session-ui,util,bench}`)——
  Electron 外壳 + SolidJS UI,fork 自 opencode 的前端;`bench` 是无人值守调试台。

**2026-08 之前这是两个仓库**(`my-pi` 和 `yoma-desktop`,兄弟目录 + alias 接缝)。
合并的决定性理由是**它们从来不独立发布**:打包时 esbuild 把内核源码整个 inline 进
`out/main/kernel.js`,用户装的 app 里没有"内核这个包",只有一个把两边融在一起的产物。
仓库该按发布节奏切分,而这两半的发布节奏不是相近 —— 是同一个。

分开时代付出的代价(现在都没了):路径映射要维护 4 份、`bun use-mypi` 切检出、
"半切"(app 跑新代码而 typecheck 验旧检出,两边全绿却说的不是同一件事)、
以及**跨仓库的静默断裂** —— 一天之内撞过三次,其中"凭据路径 + 格式变了"那次
类型系统根本抓不到,表现是用户配了 key 而内核静默读不到。

## 内核接缝:为什么还留着 alias

内核现在就是本仓的 workspace 包,裸说明符已经能靠 bun 解析。但**打包期仍然要显式别名**:

- electron-vite 默认外部化 node_modules 里的东西,而内核必须被 **inline**:
  它只发 raw TypeScript(`exports` 指向 `src/*.ts`,内部大量 `./x.ts` 后缀说明符),
  外部化后 Node 的 strip-only 加载器报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
  **无 flag 可关**;还有 TS 参数属性(`gdb.ts`、`acp/agent.ts`)会直接
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。inline 时这两样一起消失。
- 别名指的是**真实路径**而不是 node_modules 里的软链,这是有意的:走软链时
  TypeScript 会把同一个 `ProviderStreams` 当成两个类型(private 字段让它们名义上
  不兼容),typecheck 直接红。踩过。
- `coding-agent` 的 `exports` 里**没有** `/system-prompt`、`/models`、`/resources`
  这三个深引用,它们只靠别名可达。改成 workspace 解析之前必须先补 exports。

映射仍存在 **四份**(被工具链逼的,`packages/kernel/src/mypi-alias.test.ts` 钉住):

| 位置 | 谁用 |
|---|---|
| `tsconfig.mypi.json` 的 `paths` | typecheck(tsgo),被 kernel/desktop 继承 —— **位置的真源** |
| `packages/kernel/tsconfig.json` 里 **内联** 的同一份 | `bun test` —— bun 不跟随数组形式的 `extends` |
| `packages/bench/tsconfig.json` 里同样的内联副本 | bench 直接跑源码,同理 |
| `packages/kernel/mypi.ts` 的 `MY_PI_ALIASES` | 打包期(electron-vite / esbuild),根目录从第一份反推 |

两个细节:paths 的值必须是**相对路径**(`./packages/...`),写成 `packages/...` 会
`TS5090`;pi-ai 的 path 必须指向 **`dist/index.js` 而不是 `.d.ts`**,bun 会照着它真去加载。

## 仓库结构

Bun workspace,`packages/` 下 7 个包:

| 包 | 名字 | 职责 |
|---|---|---|
| `desktop` | `@yoma-desktop/desktop` | Electron 外壳:main/preload/renderer、内核进程、打包、自动更新 |
| `app` | `@yoma-desktop/app` | SolidJS UI —— 一个**库**,两个宿主(web + desktop);页面、路由、状态、i18n |
| `kernel` | `@yoma-desktop/kernel` | **内核接缝**:浏览器安全的视图模型/协议/客户端 + Node 侧 host |
| `ui` | `@yoma-desktop/ui` | 领域无关的基础组件(Kobalte)、OKLCH 主题引擎、图标 |
| `session-ui` | `@yoma-desktop/session-ui` | transcript 渲染:消息、工具卡片、流式 markdown、Pierre diff |
| `util` | `@yoma-desktop/util` | 纯函数小工具 |
| `bench` | `@yoma-desktop/bench` | **无人值守调试台**:job 交给内核跑到底,判据自验,产出分支与报告 |

分层单向:`ui`(叶) → `session-ui` → `app` → `desktop`;`kernel` 被 `app`、`desktop`
和 `bench` 消费(`bench` 是 host 的**第二个宿主**,不经 Electron)。

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
| `bun typecheck` | turbo 跑全部 7 个包 —— **必须常绿 7/7** |
| `bun lint` | oxlint |
| `bun --cwd packages/desktop smoke` | 内核冒烟:对 **构建产物** 验证 10 个工具 + 5 个引擎二进制 |
| `bun --cwd packages/desktop e2e:ipc` | 生产路径:真 utilityProcess + 真 MessagePort + 真协议帧(不开窗口) |
| `bun --cwd packages/desktop e2e:renderer` | 最后一跳:真窗口 + 真 preload + **真 contextBridge**(含 mailbox 桥三条) |
| `bun --cwd packages/desktop smoke:mailbox` | 调试台冒烟:Electron RUN_AS_NODE 对打包产物跑完整**本机演练**(假模型,零 key 零硬件) |
| `bun --cwd packages/desktop e2e:mailbox` | main 托管端到端:真 kernel.js 的 `mailbox.setActive` 往返 + 假守护喂 `@@event` + 停止杀树 + 锁冲突人话 |
| `bun packages/bench/src/cli.ts check <job.json>` | 校验任务书 + 本机内核装配 |
| `bun packages/bench/src/cli.ts mailbox sim <job.json> --project <工程目录>` | 信箱闭环单机模拟(`init`/`runner`/`mother`/`status` 是生产形态的四个子命令;工程目录是本机事实,任务书里没有) |

后三个是 CI 里唯一能挡住"my-pi 一次重构悄悄搞死桌面端"的东西 —— 我们是把它整个 inline
进 bundle 的,内核的改动可以在我们这边零编译错误地把 app 弄坏,直到用户点下去才发现。

`e2e:renderer` 单独存在是因为 **contextBridge 是一道序列化边界**,而它的失效是运行时行为:
typecheck 全绿、单测全绿、`e2e:ipc` 全绿,照样可以在这一跳把结构化错误剥成一句话
(见"会咬人的地方")。只有真起一个窗口、让值真的穿过去才看得见。

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
- **失败也不能用 Error 过 contextBridge**,只能用普通对象 —— 见"会咬人的地方"。
- **attach 必须挂在 `did-finish-load` 上**,不能只在建窗时调一次。每次 reload
  renderer 的端口都会失效,不重新牵线就是一个哑通道 —— 不报错,表现为"点什么都没反应"。
- **请求可能早于端口到达**(provider 树一挂载就拉数据,而 `kernel-port` 是一条 IPC 消息)。
  preload 里排队,不 reject —— 直接 reject 的那一版是启动即崩,而且随机。

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

### 我们补的、内核只给了机制的四件事

> **没有权限系统。**2026-08-10 起整套权限保护(内核权限门、bench 三档策略与角色边界、
> 桌面弹窗 UI、探针互斥锁)全部删除 —— 这是产品决定,不是遗漏。agent 想调什么工具就
> 调什么工具,不问不拦。约束 agent 能做什么靠的是**它手上有什么**:工位端没有项目
> 检出,不把脚本送过去它就跑不了(见"信箱闭环")。代价一并写在这:同机的交互会话与
> 调试台任务可以同时抢探针,实测会撞 `0xe00002c5`。

- **自动压缩**(`host/compaction.ts`)。内核只提供 `compact()`,什么时候压是应用层的事。
  两个 guard 一个不能少:没有真实 usage 数据时不猜(否则新会话一开口就被压)、
  刚压完不重压(否则一路压到没东西可压)。
- **轮级自动重试**(`host/retry.ts`)。内核把 provider 失败当**数据**(stopReason:"error"
  的 assistant 消息),重不重试是应用层的事;`harness.retryLastTurn()` 是机制。
  3 次 / 2s 起指数退避,与 my-pi 的 ACP 适配器同一组参数 —— 那边有自己的一份,
  我们不 import 它(会把整个 ACP 与 `@agentclientprotocol/sdk` 拖进 bundle),
  但**数值必须抄一致**,否则会变成"Zed 里能自愈、桌面端不能"这种极难归因的差异。
  重试期间 **idle 必须压住**(`entry.retryPending`):退避窗口里漏出 idle,bench 会
  当真去跑判据,而 agent 正要重试,两边同时动板子。
- **模型目录**(`SessionManager.providers()`)。`thinkingLevels` 必须走 pi-ai 的
  `getSupportedThinkingLevels(model)` 去问,编错的后果是档位能选但发不出去。
- **默认思考档位**(`src/thinking.ts` + `KernelHostOptions.defaultThinkingLevel`)。
  my-pi 没人指定档位时落到 `"off"`(`agent-harness.ts:214`),而 `"off"` 会把
  `reasoning` 整个从请求里摘掉(同文件 `:429`)—— 对 reasoning 模型这就是**最强的
  那一档默认关掉,且没有任何地方提示**。这是注入位而不是常量,因为两个宿主的答案
  不一样:**桌面端不传**(档位是模型对话框里的现场选择,经 `setModel` 下发),
  **bench 传**(无人值守,没人看着那个开关)。实测代价:2026-08-11 的信箱闭环,
  工位端跑 deepseek-v4-pro(支持 high/max)5 轮、107 条 assistant 消息,
  reasoning token **0**,平均每条输出 146 token —— 一步一句话一个工具调用,
  从不停下来想;同机交互式会话选 max 时同一家的更弱模型反而 4 倍的思考量。
  档位由 `pickThinkingLevel` 按模型实际支持的表落定,所以给一个模型没有的档位是
  安全的。它与 pi-ai 的 `clampThinkingLevel` **必须同解**(renderer 只拿得到
  `ModelInfo.thinkingLevels` 字符串数组而不是 `Model`,所以另写了一份),
  这道闸门在 `thinking.test.ts` 里直接拿真 pi-ai 对答案。
  另:`setModel` 换模型之后**必须重钳当前档位** —— 构造期那次是按 `ensureModels()`
  的默认模型算的,而调用方紧接着要换成任务书钉的那个。
- **调试台的默认模型**(`bench/src/job.ts` 的 `DEFAULT_MODEL`,`parseJob` 里落定)。
  任务书不写模型时,两端都跑 `deepseek/deepseek-v4-flash`,档位 `max`
  (`DEFAULT_THINKING_LEVEL` 因此从 `high` 提到 `max`:Flash 的单价只有 V4 Pro 的
  三分之一,省下的换成想得更狠;想得不够的代价是多跑一轮,比 token 贵得多)。
  **不落定的话它是看不见的**:两侧各自回落到内核的"本机第一个有凭据的 provider 的
  默认模型",可以是两家不同的模型,而信箱里没有一处记着这回事。落定在 `parseJob`
  是因为入箱的 `job.json` 本来就是"归一化后的 spec"(`init.ts`),工位端读到的于是
  是答案本身而不是它那台机器的猜测。只填一半的 model **整个**落回默认,不猜另一半。
  代价一并写在这:机器上没有 deepseek 凭据时,第一轮会硬报 `未知模型 deepseek/…`
  —— 这是有意的,任务书里写 `model` 或配 key 就好;`yoma-bench check` 会把落定后的
  两端模型印出来。faux 演练(`smoke:mailbox` / `sim`)例外:注入了 `resolveModels`
  时 `turn.ts` 不下发模型,否则演练会撞上"注册表里只有假模型"。

项目上下文与技能走 my-pi 的 `core/resources.ts`(`loadContextFiles` / `discoverSkills`),
不重写:"从哪些目录找"是内核那边的产品决策,抄一份的结果是"Zed 读得到项目的 AGENTS.md、
桌面端读不到"。全局目录默认 `~/.my-pi`,与 ACP 同一份,于是同一份技能两处都生效;
`configDir` 可注入,**测试必须传它**(否则读的是开发机真实的 `~/.my-pi`,结果取决于
跑测试的人装了什么技能)。快照式:建会话时读一次,改了技能文件重开会话即生效。

模型凭据走 my-pi 的 `resolveModel(configDir)` → `<configDir>/auth.json`,默认
`~/.my-pi/auth.json` —— **2026-08 起不再跟 pi 共用 `~/.pi/agent/auth.json`**,my-pi
那次把凭据独立了出去,同时把 `resolveModel` 改成必须显式收目录(在我们这边是编译期
硬失败,alias 接缝的设计目的正是如此)。配过 Zed(my-pi 的 ACP)的机器仍然零配置开跑。

两个必须记住的点:

- **格式带判别字段**:条目是 `{"deepseek":{"type":"api_key","key":"sk-…"}}`,少了
  `type` 会被 pi-ai 的 `resolveProviderAuth` 静默忽略(表现是"我明明配了 key 却说没配")。
  所以写入端直接用 my-pi 导出的 `FileCredentialStore`,不自己拼 JSON。
- **迁移只在没注入 configDir 时做**(`host/auth.ts` 的 `migrateLegacyPiAuth`):
  注入的调用方(测试、隔离跑的 bench)显然是在隔离,不该反手去读真实 HOME 的老凭据
  —— 否则隔离是假的,还会把用户真实的 key 复制进临时目录(实测踩过)。
  迁移幂等、不删旧文件(用户可能还在用 pi 命令行)。

`configDir` 一处管三样:凭据、技能、上下文文件,与 my-pi ACP 的 `CONFIG_DIR` 同义。
provider 目录在无 key 时来自 `CONFIGURABLE_PROVIDERS`(my-pi `PROVIDERS` 表的结构化
复制,防漂移测试在 `host/auth.test.ts`)。

### 调试台(`packages/bench`)

host 的**第二个宿主**:`createKernelHost()` 是纯 Node 装配(零 Electron 依赖),
bench 直接 import 它跑无人值守任务,于是投影器、自动压缩、工具装配、会话协议全部白得。
`sessionsRoot` 默认指向 desktop 的 userData —— 跑完在桌面端直接回放。

两条不变式,动这个包之前先读:

1. **一轮一个子进程**(`turn-entry.ts`)。my-pi 的探针租约/gdb 会话表/log 采集器都是
   模块级全局,进程边界 = 免费且可靠的清理,下一轮不会撞上"探针被占着"。
   子进程协议是单向的:输入一个 JSON 文件、输出一个 JSON 文件、stdout 是进度。
2. **代码不裁决任何东西**。跑几轮、花多少、算不算做完,全归模型 —— 没有轮数/token/
   墙钟上限。代码只在"决定 JSON 连着两次读不出来"时终局(记 `by:"policy"`),
   那不是裁决,是没法把它的话变成动作。要提前收工就在桌面端按停止。

**yoma 在用户项目里只有一个落脚点:`<工程>/.my-pi/`**(2026-08-11 起;从前是 `.bench/`
与 `.my-pi/` 两个目录、两份 .gitignore、两套相反策略):

```
<工程>/.my-pi/
  .gitignore                     ensureYomaDir 写的那一份(黑名单,含忽略自己)
  gdb/  logs/  flash-state.json  工具运行产物
  bench/
    mailbox.template.json        项目配置,**要提交**
    turns/  mailbox-sim/         调试台运行产物
```

它必须自带 `.gitignore`,否则运行产物被 `git add -A` 卷进提交(实测:信箱闭环首跑,
17 个改动文件里 16 个是 `.my-pi/gdb/*.mi`);`.gitignore` 还要**忽略它自己**,否则
工作树永远不干净,而研发端每轮开局都要求树干净(实测被自己挡死过)。
`ensureYomaDir` **会升级自己写过的旧版**(认第一行的 `# yoma` 标志)—— 从前是"文件
不存在才写",于是老仓库停在旧规则上,合并之后 `bench/turns/` 会照旧漏进版本库。
用户手写的 .gitignore 一律不动。

工程根从模板路径反推时**往上找 `.git`,不数目录层数**(`mailbox.ts` 的
`inferProjectDir`)。写死 `dirname×2` 的那一版在模板深一层之后会把工程根推成
`<工程>/.my-pi`,而且不报错 —— 症状是"agent 说它看不到代码"。
`result.text` 只收 **assistant** 消息的非 synthetic text part(用户消息的 part 也是
text part,不过滤的话提示词会原样出现在终报的"根因分析"里)。

### 信箱闭环(`bench/src/mailbox/`)

跨机器多轮调试,唯一通道是一个 git 仓库(信箱)。两侧都是 yoma 内核跑的 agent。

**分工**:角色字符串是 `mother`/`runner` ——

- **mother = 研发端**:有工程检出与构建环境。读证据 → 改代码 → 构建 → 把产物当
  **附件**塞进本轮 → 用大白话写指令。它在项目仓上开分支、每轮提交、终局推交付分支。
  碰不到硬件(板子根本不在这台机器上)。进程内跑,不需要子进程。
- **runner = 工位端**:板子在这儿,而且**只有板子**。领指令与附件 → 自己决定怎么
  上板 → 复现观察 → 把看到的现象回填。

分工的依据是**手上有什么**:改代码要工具链和完整检出,那在研发机;上板要探针,那在工位机。

**工位端没有项目代码**(2026-08-10 起)。它的工作目录是一个一次性目录,住在信箱克隆的
**兄弟位置**(不能在克隆里 —— `pullReset` 的 `clean -fd` 会把附件删掉),内容全部来自
附件。于是这一侧不需要 git、不需要构建工具链、不需要"工作树干净"这套纪律。

两条由此而来的硬性话术要求(落在 `mailbox/prompts.ts`):

1. **上下文由研发端补全**。工位端读不到源码,所以"这个地址是什么变量""这一版改了
   什么""该盯哪个符号"必须写进指令。研发端的角色提示词专门交代了这一段。
2. **附件是工位端拿到任何东西的唯一通道** —— 固件、诊断脚本、参考数据都走它。
   要给 agent 加工具,就是往 `artifacts` 里多列一个文件,不需要改协议。
   反方向那条是**回传**(2026-08-12 起):工位端工作目录下的 `outbox/`,丢进去的东西
   被收进本轮 `back/`,再落到研发机的 `.my-pi/back/<轮次>/`,路径每轮列进提示词。
   上行**不设"声明"这一步** —— 工位端是唯一挨着板子的一侧,给它加一个"必须写出可解析
   结构"的契约等于在最不该失败的地方多一个解析失败模式;扫目录是确定性动作,不经模型。
   收过的移进 `outbox/.sent/<轮次>/`(留底 + 不重传);超限**跳过不报错**并记进
   `backSkipped`(拦住上行等于把整轮结果一起毙掉),单轮默认 16MB。
3. **工具链清单是唯一的例外,它走自己那条路**:研发端每轮下发时把
   `<工程>/.my-pi/toolchain.json` 原样复制进信箱根(`store.ts` 的
   `syncToolchainManifest`,幂等),工位端读出来经 `TurnInput.toolchainManifestText`
   灌进内核,并钉死 `toolchainSide: "runner"`。不这么做的话工位端那侧
   `resolveToolchain` 找不到清单、**静默返回空**,于是它对"缺什么、按什么方法装"
   一无所知 —— 表现是 agent 撞一个 `ModuleNotFoundError` 再把它当成"脚本坏了"
   报回去,研发端拿到一条误导性证据。side 必须传:那台机器上只有板子,核 cmake /
   arm-gcc 会一路报 MISSING,盖住真正缺的那条。清单是提交进库、零绝对路径的项目
   配置,所以复制它是安全的 —— 两台机器读同一份声明,各自对着**自己的**账本
   (`<configDir>/toolchains.json`)和 `toolchain.local.json` 解析。

- **协议里不预设"怎么把新固件弄上板"**:附件 + 一句人话就是全部机制。换成 OTA 或
  远端 CI 产物时,变的只是指令里那句话和工位端手上的脚本 —— 不用改协议。
  代价是"它可能忘了烧却接着测" —— 挡它的是研发端把**自证**写进指令(让工位端报出的
  数字本身能说明版本,比如读构建指纹),不是协议。
- **状态由文件存在性推断,不落状态文件**:零轮次 → `kickoff`(等研发端开第一轮,
  init 不再写死"只复现取证");instruction 有而 result 无 → 等工位端;裁决是
  `await-human` 而 `human-ack.json` 没来 → 挂起等人;result 有 → 等研发端;
  `verdict.json` 出现 → 终局。工位端的 result.json **最后写**(回传件 `back/*` 与
  自述全文 `bench-report.md` 都在它之前),研发端的 decision + 下轮 instruction +
  附件 + patch **同一次提交**。
- **人工动作有自己的状态**(2026-08-12 起):`await-human` 不是终局,是"这一轮到此为止,
  等人去板子边上动手"。接电源、换负载、动机械不是任何 agent 能做的;没有这个值时,
  研发端唯一能表达"我在等人"的方式是再下发一轮"请转达……"——实测一次真任务 5 轮里
  3 轮是这么空转掉的。挂起期间**两侧都不跑轮**;回执 `rounds/NNN/human-ack.json`
  一落地,状态自己滑回"等研发端裁决"(没有别的唤醒机制),挂起那次分析的花费结转进
  重裁的 decision。回执**两台机器都写得了**(桌面端进度页两个按钮 / CLI 的
  `mailbox ack`),用**自己一个克隆**写,绝不碰守护那两个。开局轮不接受 `await-human`
  ——那一刻挂起没有地方落。
- **pull 是 `fetch + reset --hard + clean -fd`**,工作树永远等于远端已推真相 ——
  崩溃写了一半的文件在下次轮询自动消失,协议退回"重跑本步",没有恢复逻辑可写错。
  两侧的本地状态(会话指针、token 计数)住在自带 `.gitignore` 的目录里,clean 不删
  被 ignore 的文件,这是它们的护身符。
- **裁决全归模型**。研发端给 `continue` / `done` / `fail` / `await-human`,包括什么时候停 —— 没有
  轮数/token/墙钟上限,也没有独立判据机制。"通过"就是研发端读完工位端自述之后的判断,
  "够了"也是。代价是它可能一直 `continue`:提前收工靠桌面端的停止按钮。
  唯一的例外是单机模拟(`mailbox sim`)有一个 60 分钟的看门狗 —— 那是演练台要在 CI 里
  收敛,不是产品预算。
- **交付 push 在研发端**(代码在它那儿),而且必须在"刚写下 verdict"那一步就做 ——
  守护循环见到 done 就返回退出,留到下一轮等于永远不做(测试逮住过)。
- **任务书里不许有绝对路径**:它要在两台机器上被读。研发端的工程目录由本机配置提供
  (`resolveWorkspace(job, localDir)`;桌面端是配置页的"工程目录",CLI 是 `--project`),
  `serializeMailboxJob` 会主动摘掉 `repo.directory`。工位端根本不需要这个配置。
- 附件落在工位端工作目录的**根**,`result.incoming` 里是纯文件名。
  **不清空**:某轮没带附件不代表旧固件失效,板上跑的还是它。
- **工位端自述进提示词时头尾都留**(头 6000 + 尾 14000 字,`prompts.ts` 的 `clipEnds`):
  汇总行、RESULT、结论永远在末尾,只截头部正好砍掉最该看的那半(实测一次五轮任务里
  每一轮都超过当时 4000 字的上限,首轮丢掉 44%)。全文另存 `bench-report.md` 并落到
  研发机,提示词给路径 —— 细节让它自己去读,不进会话历史一轮轮累积。
- 单机模拟(`mailbox sim`)起 **两个真子进程 + 各自的克隆 + 本地裸仓**,与生产的
  差别只有远端 URL(`--remote` 换私有 GitHub 仓即是跨机器形态)。

**产品形态(2026-08-08 起,P1–P3 已进桌面端;协议见 `docs/信箱闭环-协议与双机部署.md`)**:

- 引擎打包成两个纯 node 产物(`out/main/mailbox-host.mjs` 五角色一个入口 +
  `mailbox-turn-entry.mjs`,esbuild 见 `desktop/scripts/build-mailbox.ts`);
  守护 stdout 上的 `@@event {json}` 行是唯一事件通道。
- 桌面 main 托管守护(`main/mailbox-controller.ts` 纯逻辑 + `main/mailbox.ts` 接线;
  child_process.spawn + RUN_AS_NODE,**不用 utilityProcess.fork** —— 它的 kill 没有
  信号可选,POSIX 优雅停机依赖 SIGTERM 链);renderer 走 `window.api.mailbox`,
  app 页面在 `/bench`(四分区:配置/任务/进度/终报)。
- **配置页的"工程目录"只有研发端角色要填**(`mailbox-controller` 的开跑守卫按角色
  分):工位端没有项目检出。
- **信箱克隆落在 `<configDir>/mailbox/clones/<远端+分支哈希>/<角色>`**(configDir 默认
  `~/.my-pi`,与凭据/技能/上下文同一个目录),**不在 Electron 的 userData 里**
  (2026-08-11 搬的)。理由是单实例锁:`.yoma-lock/<role>.pid` 住在**克隆目录里面**,
  锁的是"这个物理目录"而不是"这个信箱" —— 桌面端在 userData、CLI 让你自己指路径,
  两边落在不同目录时两把锁互不知情,同一个信箱同一个角色能被跑起来两个守护,同时推
  同一个远端、同时抢同一块板子(实测撞过:CLI 跑 mother 的同时桌面端也能启动)。
  位置只有**一份实现**:`bench/src/mailbox/paths.ts`,CLI 与桌面端都用它。
  该文件必须保持**叶子模块**(只依赖 `node:crypto`/`node:os`/`node:path`)并经 bench 的
  `./mailbox/paths` 深引用导出 —— desktop 的 main 要 import 它,而 bench 在 desktop 的
  devDependencies 里,`externalizeDeps` 不碰它,走主入口等于把整个内核 inline 进
  `out/main/index.js`(实测走叶子模块只涨 373 字节)。它与内核 `myPiConfigDir()` 的漂移
  由 `paths.test.ts` 的断言兜住。
  **会话(sessions)不跟着搬**,仍在 userData —— 它是给桌面端回放看的,不是跨进程共享的
  agent 状态。
- **退出 app 必须带走守护树**(`stopSidecars` → `mailboxMain.stopAll`):任务在飞时
  Cmd+Q 或自动更新 relaunch,守护与 turn 孙进程会变成**还在烧录/gdb 的孤儿**。
  先 SIGTERM 让守护自己转杀孙进程,宽限后硬杀。`runner.ts` 的 `activeTurnChildren`
  是这条杀树链的中间一环 —— 漏掉就是 `probe-rs attach` 攥着探针不放,而报错长得和
  "没插板子"一模一样。
- 浏览器侧类型是 kernel 的 `mailbox-view.ts`(结构化复制,View 后缀),漂移由
  bench 的 `mailbox/view-check.ts` 约束式断言兜住 —— 与工具 details 同一套纪律。

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

- **contextBridge 会把 Error 剥成一句话。** Electron 在 world 之间重建 Error 时只保留
  `message` 和 `stack`,自定义属性和 `cause` **全丢**(实测 `getOwnPropertyNames` 只剩
  `["stack","message"]`)。所以 preload 的内核请求失败时 reject 的是 **普通对象**
  `{ message, stack, data }`,不是 Error —— 包成 Error 就等于把 `data` 扔进黑洞。
  实机代价:host 标好的 `data._tag = "SessionNotFoundError"` 蒸发,前端把"上个版本残留的
  标签页"当成致命错误,整个 app 崩到错误页。这一跳由 `e2e:renderer` 钉住,**类型系统永远
  抓不到**。
- **engines 目录必须显式传**,别依赖 my-pi 的 `enginesDir()` 向上查找 —— 它只认
  "名字叫 engines 且存在",会高高兴兴找到一个没有 `bin/` 的空壳,然后报
  "去跑 `bun engines/build.ts`",让你以为是没编译。合库后 `engines/` 就是仓内真目录
  (三个 submodule + build.ts),不再是软链。
- **engines 有两个来源,`scripts/stage-engines.ts` 按目标平台自动选**:本地
  `engines/`(跑过 `bun engines/build.ts` 之后,仅当它满足目标平台)或**预编译 Release
  产物**(按 `packages/desktop/engines.lock.json` 钉住的 tag,用 `gh` 下载)。
  后者让"在 Mac 上打 Windows 包"第一次真正成立 —— 以前只能靠
  `YOMA_ALLOW_FOREIGN_ENGINES=1` 打出一个引擎全坏的包。
  优先级:`YOMA_ENGINES_DIR` > `YOMA_ENGINES_BUNDLE`(显式指一个压缩包,离线打包
  和验证用)> 满足平台的本地目录 > 下载。私有仓的 Release 要鉴权,但**下载发生在
  打包期**(手上有凭据的机器),终端用户拿到的是包里已经躺好的文件。
- **electron-builder 对 extraResources 里的软链原样保留、不 dereference**
  (实测:.app 里出现断链,签名阶段 stat ENOENT),所以 stage-engines 要**实体化**
  到 `.engines-stage/`,extraResources 只认暂存目录;预编译产物还会按 bundle 自带的
  `manifest.json` 逐个核 sha256(挡住"文件在但内容被截断")。
- **Python 三件套的 shebang 曾经是分发的死穴**:board_ir/connections/controller_map
  在开发期是 venv console script,第一行写死构建机绝对路径,拷到别人电脑必坏,
  而且报"找不到解释器",看起来像没编译。已由 my-pi 的 `bun engines/build.ts --dist`
  用 PyInstaller 冻结解决(那边的 CI 产出的就是冻结版);本地开发跑普通 `build.ts`
  仍是 console script,所以 stage-engines 的那条警告要留着。
- **逐 chunk `Buffer.toString()` 会劈断多字节 UTF-8**。守护的一条 `@@event` 行可以
  远超一个 pipe chunk(≤64KiB):终局快照带着几万字终报,中文 3 字节/字,轻松十几万
  字节。chunk 边界大概率落在字符中间,各自解码就是两个 U+FFFD —— 而 JSON 的结构
  字符全是 ASCII,`JSON.parse` 照样成功,**乱码静默进终报**。跨 chunk 的行拼接必须用
  `new TextDecoder()` + `{ stream: true }`(turn-entry 的 stdin 读法是对的样板)。
- **子进程默认不按 UTF-8 输出,中文 Windows 上尤其**。Python 在 stdout 不是终端时用
  `locale.getpreferredencoding()` 编码 —— 中文 Windows 上是 cp936(GBK),而我们按
  UTF-8 解管道。解出来的 U+FFFD **不可逆**(编回字节再按 GBK 读只得到"锟斤拷")。
  实测:双机首跑三条判据全过,证据却是
  `xTickCount@0x200002a8: 24920 -> 25665 (?=745) | ????????` —— 退出码不受影响,
  所以裁决是对的,坏掉的恰恰是这套系统的产品:证据,而且一声不吭。
  凡是要读中文输出的子进程,环境里钉死编码(`PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`)。
  **注意:2026-08-10 删掉判据层之后,我们这边已经没有强制它的落点了** —— 工位端 agent
  现在是自己经 bash/my-pi 跑脚本的,那条路上没有我们注入的环境。这个坑还在,只是防线
  没了;真撞上就在任务书里让脚本自己 `sys.stdout.reconfigure(encoding="utf-8")`。
  **它的测试不能写成"跑个打中文的脚本看花不花"** —— 开发机 locale 本来就是 UTF-8,
  那是一个永远不会响的闸门(实测确认)。
- **bun 的 `spawnSync`/`spawn` 省略 `env` 时不认运行时改过的 `process.env.PATH`**,
  它按进程启动那一刻的环境解析 argv[0](与 `os.homedir()` 同一类)。想让子进程看到
  当前环境就得显式传 `env`。实测:改了 PATH 之后不传 env,解析到的仍是旧 PATH 上那个
  可执行文件 —— 探测类代码会探到另一个程序,而结论看起来完全合理。
- **`detached` 起的读进程自己 open 一个 tty(串口/pty),SIGTERM 就杀不掉它**。
  `detached` 会 setsid,子进程于是是 session leader;session leader 打开 tty 且没带
  `O_NOCTTY`,那个 tty 就成了它的控制终端。实测(macOS,同一段代码两种写法各 4 次):
  `cat /dev/ttysNNN` 每次都是 `Ss+`、SIGTERM 后 >1500ms 仍活着、'exit' 事件永不到;
  `cat` 读继承来的 O_NOCTTY fd 每次都是 `Ss ??`、21ms 内退出。表现是 `log stop` 每次
  等满 5 秒再强杀,并如实报"设备可能还被占着"—— 于是每次停采都像出了硬件故障。
  所以串口这类源:**父进程开好 fd(O_NOCTTY)当 stdin 传下去,读进程不许自己 open**
  (`tools/serial.ts`)。bench 的 grader 有一份独立的采集管线,写 `command: "cat /dev/…"`
  会踩同一个坑。
- **串口的 termios 属于设备而不是 fd,最后一个 fd 一关就复位**。流传甚广的
  `stty … && cat …` 因此是错的:实测在 ST-Link VCP 上设完 921600、stty 一退出回读就是
  9600,而症状是整屏乱码 —— 看起来像固件坏了。配置用的 fd 必须活到读用的 fd 开好为止。
- **内核事件批处理的定时器是 unref 的,纯 node 下会把等事件的进程放空**。
  host/stream.ts 的 16ms 合并窗口刻意 unref(给 utilityProcess 退出让路),而 bench
  `runTurn` 的完成恰恰依赖那批事件送达 —— 进程没有别的 ref 句柄时(mother 的进程内
  分析轮),node 在事件冲出来之前判定事件循环已空,带着未决 await 直接退出
  (`unsettled top-level await`,实测:打包冒烟里 mother 走到"分析中"就消失)。
  bun 的存活语义不同,开发态永远暴露不了。修法是 runTurn 全程持一个 ref 的
  keepalive interval;任何"在纯 node 里等内核事件"的新代码都要记得这一条。
- **Bun 的 `os.homedir()` 在进程启动时定死**,运行时改 `process.env.HOME` 对它无效。
  想在测试里隔离 `~/.pi/agent/auth.json` 这类真实凭据文件,要么走函数的 dir 注入参数,
  要么起一个出生时就带干净 HOME 的子进程(见 `host/auth.test.ts`)。实测踩过:
  以为换了 HOME,实际把开发机真实的 auth.json 洗掉了。
- **打包 app 不能用"假 HOME"模拟新用户**(实测):Electron 主进程的 userData/crashpad
  走系统 API 拿真实家目录(不理 `$HOME`),而 macOS 钥匙串查找**跟着 `$HOME` 走** ——
  结果是数据落真实位置、钥匙串却"找不到",Chromium 初始化 safeStorage 时弹系统级
  "找不到钥匙串"对话框,app 几秒后安静退出。两边语义相反,假 HOME 两头都不干净。
  验证打包产物就用真实 HOME;无 key 首跑路径由 `host/auth.test.ts` 的子进程 e2e 覆盖。
- **内核没有 HMR。** 改了 my-pi 之后必须重启 `bun dev:desktop`。
- **这是一个 fork**:2026-08 起运行时身份已统一为 Yoma(`app.setName("Yoma")`、
  运行时 appId = bundle id = `com.yoma.desktop`、深链 `yoma://`),旧的
  `ai.opencode.desktop*` userData 弃在原地(当时明确决定旧数据不要,顺带消灭了
  跨签名钥匙串弹窗;tauri→electron 的 .dat 迁移一并摘除)。**内部名字仍是 opencode**:
  localStorage `opencode.*`、store 文件 `opencode.updater`、`OPENCODE_CHANNEL` 等
  env、工具链共享的 `~/.config/opencode/`、shiki 主题名 —— 这些是承重标识符,
  与品牌无关,别盲目"修正"。
- `@tanstack/virtual-core` 的 patch 是承重的,没有它 timeline 会抛
  `getLogicalScrollOffset is not a function`。

## 已知的未完成项

- **信箱调试台:2026-08-10 大幅简化之后还没上过真板子。** 这一版删掉了判据层、
  权限层与工位端的项目检出(见"信箱闭环"),`bun --cwd packages/desktop smoke:mailbox`
  与单机 `mailbox sim` 都过了,但**双机真跑一次是必须的**:研发端能不能把上下文
  写够、工位端在只有附件的目录里能不能干活,只有真跑才知道。同时补 Windows 侧
  (打包冒烟 + taskkill 杀树)。仓里已有 Windows 出包 CI
  (`.github/workflows/desktop-win.yml`);两台机器的上手步骤见
  `docs/调试台-Windows双机上手.md`(**需按这一版重写**)。

- `ServerConnection` / `ServerKey` 这套概念还散在 app 的路由与标签页里(现在只是空壳,
  `serverReady` 用占位值立刻 resolve)。清除它是独立一件事。
- **终端(PTY)没有实现** —— my-pi 的 `NodeExecutionEnv.exec` 是一次性 spawn,不是伪终端。
  相关设置行现在是退化状态而不是造假。
- **Python 引擎不可移植**(见"会咬人的地方"):打出的包里 board_ir/connections/
  controller_map 出了构建机就是坏的,等 my-pi 侧做自包含构建。
- **mac 签名/公证没配**:electron-builder 配置在没有 Apple 凭据时自动降级为
  未公证包(用户要右键打开);配齐 `APPLE_ID`+`APPLE_APP_SPECIFIC_PASSWORD`+
  `APPLE_TEAM_ID`(或 `APPLE_KEYCHAIN_PROFILE`)即自动恢复,无需改代码。
- 每轮的 diff 汇总留空了。要做的话应该从 `edit`/`write` 工具的 `details.patch` 合成,
  而不是找回 opencode 的文件快照(内核没有快照)。
- i18n 仍有 19 个 locale;非中英的那些和内核无关,可以另行瘦身。
