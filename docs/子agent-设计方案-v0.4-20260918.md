# 子 agent 设计方案 v0.4(v2 落地版;2026-09-18)

**取代 v0.3**(`docs/子agent-设计方案-v0.3-20260910.md`,本分支 `9fc92c1`)与 v0.2(`docs/子agent-设计方案-v0.2-20260907.md`,v1 内核)。目标不变:**和 Claude Code 一样 —— 主 agent 一条消息派十几个子 agent 分头干,前台 / 后台都行,后台完成自动叫醒主 agent。**

**原则**:能照 CC 做的一律照做 —— 机制、字段名、内建 agent 名、工具结果的原话、提示词的结构;只在 yoma 的架构或产品约束逼出来的地方偏离,每一处都列在 §11,附理由。

参照物:`D:\MyCode\claude-code-sourcemap\restored-src\src\`(CC 2.1.88 还原源码,下文写作 `CC:<路径>:<行>`)+ `D:\MyCode\yoma\doc\claude-code-subagent-架构分析.zh-CN.md`(下文"分析 §N")。yoma 代码以 develop `5135792` 为准(v0.3.1 + ben 两个测试提交;pi 上游 `ceea48f` / 0.85.1);上游路径相对 `packages/agent/src/`,kernel 路径相对 `packages/kernel/src/`。

**前提(2026-09-18 核实)**

- v2 已在 develop 上(ben 自 09-09 起的 84 个提交,本机 09-18 快进拉取):kernel 直接接 `@earendil-works/pi-agent-core`;`packages/{agent,ai,chord,telemetry}` 是上游的哈希锁定拷贝(`upstream-lock.json` + `npm run upstream:check`),**一个字都不能改,也不能往里加文件**;`@yoma/coding-agent` 已并入 kernel(`host/`、`host/domain/`);工具按 `host/tools/<名>/{contract,session}.ts` 样板重写完毕(连同发动机自带的 read / bash / edit / write 共 17 个);前端单内核。
- v0.3 依赖的三个上游文件 `harness/agent-harness.ts`、`harness/messages.ts`、`harness/runtime/lane.ts` 从 v0.3 核实时的 `b2602be77` 到现在的 `ceea48f` **逐字未变**(这段上游只动了重试退避上限、按行读文件、会话 fork 存储)。v0.3 的接口判断整体有效,行号按当前树重核在 §1。
- 旧 `subagent` 分支与工作区已作废并删除。未提交的 `agent-harness.ts` 改动(让 v1 的 prompt / steer 收 AgentMessage)在 v2 原生支持,且那个目录锁定;v0.2 稿 §14「v1 实施补充」里在 v2 上仍成立的两条并入本文(§6.7 LRU 钉住、§12 场景测试先行)。
- 环境:npm + Vitest,Node ≥ 22.19、npm ≥ 11(本机 nvm 24.19.0 / npm 11.17)。本分支从 develop `5135792` 开出,`npm ci` 后 `npm run typecheck` 11/11 + 根全绿;`npm run test:windows` 3219 例 1 失败(`test/tools-la.test.ts` 的"collect 等着时会话被关"用例,本机复跑 3 次 1 过 2 挂,同一提交 CI 绿 —— Windows 上 taskkill 异步的老问题,与本方案无关)。

## 0. 相对 v0.3 变了什么(结论先行)

1. **落点**:coding-agent 已并入 kernel,新代码三处全在 kernel —— `host/domain/agents/`(定义、内建、加载、工具池裁剪、`TaskHost` 接口)、`host/tools/{agent,task_output,task_stop,send_message}/`(四个工具,照工具样板)、`host/tasks.ts`(TaskManager)。边界规则 2(`host/tools/**` 碰不到 session-manager)决定了工具只拿注入的 `TaskHost` 接口(§5.4)。
2. **通知投递按 v2 实测语义重写,更简单**:一轮要结束时,`finishRunBoundary` 在**同一次提交**里重排收件箱,有 steer 就不结束、接着跑(`harness/runtime/drive/boundary.ts:164-259`),运行内没有竞态窗口。宿主只补一条路:父会话空闲而收件箱非空时,起一轮(`accept({ kind: "prompt", prompt: [] })` + drive)。`steeringMode` 缺省已是 `"all"`,不用设;`before_run_end` 钩子不用。(§6.4)
3. **宿主的每一轮走 `accept` + `drive`**(与现有 `SessionManager.prompt()` 同一条路),不走 `lane.prompt`:RPC 立刻返回、重试退避是一段连续的 busy、失败走 `fail()`。子会话的运行、通知唤醒父会话、`send_message` 续跑,都复用这一条(§6.8)。
4. **内建 agent 改用 CC 原名**:`general-purpose`(缺省)、`Explore`,外加 yoma 特有的 `datasheet`;提示词逐段对照 CC 原文改写(§4.4)。模型对 CC 的 agent 名有先验,用原名不花钱。
5. **子 agent 的系统提示词**:CC 是"agent 正文 + 四条 Notes + env"(`CC:constants/prompts.ts:760`)。yoma 照做,并**补一段"可用工具 + 工具守则"**—— yoma 的工具守则写在系统提示词里(契约的 `guidelines`),`buildSystemPrompt` 的 `customPrompt` 会把它连同正文一起换掉,datasheet、netlist 这些工具的守则就丢了(§4.2)。
6. **确认门冒泡**:前台子 agent 触发确认(bash / powershell 起探针程序、toolchain install)时,询问显示在**父会话**的确认条上,标明是哪个子 agent;后台子 agent 直接拒(CC 的 `shouldAvoidPermissionPrompts`,分析 §6)。(§6.5)
7. **无人值守宿主关后台**:bench 与信箱工位端没人看屏幕、按 idle 判一轮结束,后台子 agent 会让"idle"说谎 —— 照 CC 的 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`,`run_in_background` 从 schema 里摘掉,一律前台(§9)。
8. **LRU 钉住**:宿主的淘汰规则仍是"idle 的超过 8 个就关最久没碰的"(`host/session-manager.ts:81,1484-1490`),排队中 / 运行中的子会话必须钉住 —— v0.2 §14 的那一条在 v2 上照样成立(§6.7)。
9. **CC 2.1.88 的几条事实**已核对并各自取舍(§10、§11):`TaskOutput` 标了 DEPRECATED(推荐 Read `output_file`),它和 `TaskStop` 都是 deferred 工具;`SendMessage` 对外部用户要开 agent teams 才有;自动转后台缺省关(开了是 120 秒);`TaskStop` 停掉 agent 任务时**不压通知**,被停的 agent 仍带部分结果发 `killed` 通知(`CC:tasks/stopTask.ts:65-68`,只有 bash 任务压)—— 与 v0.3 的写法一致,这次核实了出处。
10. **子会话不进侧边栏**:CC 不把子 agent 当一等会话。侧边栏与首页只走 `isRootVisibleSession`(`app/src/pages/layout/helpers.ts:26`),加一条"没有 parentID"即可;子会话从卡片与任务面板打开(§7)。v0.3 的"侧边栏嵌套"作废。
11. **通知投影成一轮的起点**:通知对模型是 user 角色,对界面分组也该是。投影器现在把 custom 消息投成 synthetic assistant 文本,唤醒后的回复会被归进上一个用户轮;改为投成带 `synthetic` 标记的 user 消息 + 专用 part(§7)。
12. **用户输入改成排队(用户 2026-09-18 定,照 CC)**:往忙着的会话发消息不再先中断当前轮,而是 `steer` 进收件箱,在下一个工具轮次边界插入;只有停止键 / Esc 才中断。停止时 v2 会把排着的用户消息与通知一起摘掉,CC 的做法是用户消息退回输入框、通知留下自动处理(`popAllEditable`)—— 这一段本期暂缓(用户定),是已知缺口。这改的是宿主对**所有**会话的行为,不只子 agent;前台子 agent 因此不会再被"父会话来了新消息"误杀(§6.9)。

## 1. v2 基线(2026-09-18 核实)

对象模型:`JsonlSessionRepo` → `Session` → `AgentHarness.create({ session, models, model, tools, … }, ctx)` → `{ harness, open }` → `harness.lane("main", ctx)` → `AgentLane`。错误作为 `Result` 返回,不抛。

**上游(锁定,只用公开接口)**

| 能力 | 出处 |
|---|---|
| `lane.accept(OperationRequest)` 只落盘;`lane.drive({ operationId, waitForRetry, pollDeferred })` 才执行 | `harness/agent-harness.ts:546-547` |
| `OperationRequest` 的 prompt 可以是 `string`,也可以是 `AgentMessage \| AgentMessage[]` | `:111-117` |
| `lane.steer / followUp / nextRun(string \| AgentMessage)` → `QueueResult { entryId }`,持久化(pending entry) | `:562-564` |
| `lane.requestAbort(opId)`、`abort()`、`waitForIdle()`、`runWhenIdle(cb)`、`inspectExecution()`、`findEntries(scan)`、`appendCustomEntry()` | `:541-572` |
| `AgentHarnessOptions`:`tools`、`activeToolNames`、`toolContext`(可为函数)、`systemPrompt`(可为函数)、`model`、`thinkingLevel`、`retry`、`compaction`、`steeringMode`、`toolExecution`、`toProviderMessages` | `:518-536` |
| 缺省值:`steeringMode "all"`、`followUpMode "all"`、`toolExecution "parallel"`(同一批工具调用并行;工具上的 `executionMode` 不读) | `harness/runtime/harness.ts:66-68` |
| `AgentHarness.create` 返回 `{ harness, open: OpenOperation[] }` | `:614-622` |
| hooks:`before_run`、`before_run_end`(只能回一段 `followUp` 字符串)、`before_request`(带 `step`、`attempt`,首次为 1)、`before_tool`(可 `block: { reason, terminate }`)、`after_tool`(可 `terminate`)…;调用参数都带 `lane`、`runId` | `:430-510` |
| 事件:`run_start`、`run_end`(`completed \| aborted \| failed`)、`turn_start`、`tool_start / tool_update / tool_end`、`queue_update`(当前收件箱)、`entry_added`、`usage`… | `:255-373` |
| 工具:`execute(toolCallId, params, onUpdate, toolContext, invocation, context)`;`context.abortSignal` 在父被中止时触发;`invocation.getMemo / setMemo` 是重放用的持久备忘 | `harness/types.ts:96-122` |
| custom 消息 `{ role: "custom", customType, content, display, details, timestamp }`、`createCustomMessage()`;`convertToLlm` 把它投成 **user** 角色 | `harness/messages.ts:31,107,137` |
| `repo.create({ cwd, id?, parentSessionId? })`;`parentSessionId` 写在文件头,`repo.list()` 不开会话就拿得到 | `harness/session/types.ts:557-560`;`harness/session/jsonl/repo.ts:29,81` |
| 会话级值 `value<T>(ns, key)` + `session.setValue / getValue`(包入口导出) | `harness/session/values.ts:98`;`index.ts:78` |
| `formatSkillInvocation(skill)` 导出;`parseFrontmatter` **不导出**(`yaml` 只是 agent 包自己的依赖) | `harness/skills.ts:39` |

**收件箱语义**(§6.4 的根据):

- 一轮要结束时,`finishRunBoundary` 先跑 `before_run_end`,再在**同一次 `continueOperation` 提交**里调 `planBoundaryInbox(…, followUpWhenNoTrigger = true)`:收件箱里有 steer(或 followUp)就写进 transcript、这一轮**接着跑**;没有才写 `run_end`(`harness/runtime/drive/boundary.ts:79-148,164-259`)。所以"steer 恰好在最后一个边界之后到达"只可能发生在结束提交**之后**,那时它安静地躺在收件箱里。
- lane 空闲时 `steer` 照样入队。下一次 `accept` 把收件箱里排着的一并收进新一轮,插在本次 prompt 之前;`accept({ kind: "prompt", prompt: [] })` 在收件箱非空时合法,空时返回 `InvalidMessage(reason: "empty")`、无副作用(`harness/runtime/lane.ts:588-626`)。
- **`requestAbort` 会把收件箱里的 steer / followUp 一并摘下**,作为返回值(`AbortRequestResult.steer / followUp`)交回调用方(`harness/runtime/lane.ts:1043-1085`)。不接住的话,停止键会把排着的用户消息与通知一起丢掉 —— §6.4、§6.9 都要接。
- `lane.cancelQueued(entryId)` 撤回一条还没被取走的排队项,回 `cancelled / already_consumed / not_found`(`harness/agent-harness.ts:565`)。

v2 **没有**:`maxTurns`;会话头 metadata(只有 `parentSessionId`);`watchSession`(桩)。

**宿主(`host/session-manager.ts`)现状,本方案依赖的行为**

| 事实 | 位置 |
|---|---|
| 一个会话一个 `Entry`:harness + lane `main` + 投影器 + **本会话自己的一份工具实例**(闭包;log / la / gdb 的状态住在里面) | `:192-245`、`:712-896` |
| 每轮 = `accept` + 不 await 的 `drive({ waitForRetry, pollDeferred })`,失败走 `fail()` | `:1346-1371` |
| **用户在忙的会话里发新消息 = 先 `stop()` 当前轮**(不排队)—— 本方案改成排队,§6.9 | `:1277` |
| 重开会话时,上个进程没跑完的操作一律 `abort`(硬件安全),在订阅之前做 | `:824-838` |
| LRU:只淘汰 `idle` 的,超过 `MAX_LIVE_SESSIONS = 8` 就关最久没碰的;每次 `openEntry` 末尾都会跑一遍 | `:81`、`:894`、`:1484-1490` |
| `closeEntry`:stop → 摘确认钩子 → `harness.close()` → 工具 `dispose()` → 执行环境 cleanup | `:1503-1534` |
| 确认台:`before_tool` 钩子,只在 `confirmTools`(桌面端)时挂;问不问由契约的 `confirm(input)` 决定 | `:872-874`、`:1190-1228` |
| 工具装配 `createAgentTools()` → `createRegisteredTools()`;`TOOL_NAMES` 是唯一真源,三处逐字同序比 | `:140-170`;`host/tools/index.ts:50-70`;`types.ts:256-287` |
| 边界规则 2:`host/domain/**` 与 `host/tools/**` 往外只许拿 `host/models.ts`、`host/datasheet-server.ts` | `host/boundary.test.ts:6-7` |
| 系统提示词:`customPrompt` 只换正文,"Available tools / Tool-specific rules"只在默认正文里 | `host/system-prompt.ts:56-115` |
| 投影器:custom 消息 → synthetic **assistant** 文本(`display: false` 不渲染),不动 `turnParentID` | `host/projector.ts:382-428` |
| 上下文文件沿祖先链找;技能只找 `~/.agents/skills`、`~/.yoma/skills`、`<cwd>/.agents/skills`,不沿祖先 | `host/resources.ts:44-100` |
| app 的侧边栏与首页只走 `isRootVisibleSession`;opencode 的 `parentID / lineage / openParent` 已删,删除点都留了注释 | `app/src/pages/layout/helpers.ts:26`;`app/src/context/server-session.ts:8,862`;`app/src/pages/session/composer/session-composer-region-controller.ts:27` |

## 2. CC 能力清单与本期范围

| CC 能力(出处) | 本期 | 说明 |
|---|---|---|
| md 定义的 agent,frontmatter 字段,按名覆盖(分析 §2) | 做 | §4;CC 的 plugin / flag / policy 三层 yoma 没有 |
| `Agent` 是普通工具,一条消息派 N 个并行(分析 §1.1、§3) | 做 | v2 同一批并行;上限 §8 |
| 同步 / 后台 / 中途转后台(分析 §8) | 做 | §6.3 |
| 自动转后台(`CC:tools/AgentTool/AgentTool.tsx:72-77`,缺省关,开了 120 s) | 做,缺省关 | 同 CC |
| `<task-notification>` 回注,主循环闲则自动起一轮(分析 §9.3) | 做 | §6.4 |
| `TaskOutput`(block / timeout)、`TaskStop` | 做 | CC 2.1.88 两个都是 deferred,TaskOutput 标 DEPRECATED;取舍见 §10 #14 |
| `SendMessage`:运行中排队、停了续跑(分析 §11) | 做 | CC 对外部用户要开 agent teams;yoma 缺省开(§10 #15) |
| 工具池重新装配 + 硬黑名单(分析 §5) | 做 | §5.3 |
| `maxTurns` | 做 | 宿主 hook,§6.6 |
| 只读 agent 不灌 CLAUDE.md、子 agent 关思考、一次性 agent 省尾巴、空结果占位句(分析 §7.2、§9) | 做 | profile 字段,§4 |
| 模型解析 env > 入参 > 定义 > inherit(分析 §7.6) | 做 | §4.5 |
| skills 预加载 | 做 | §4.2 |
| `output_file` / 落盘即进度(分析 §7.4) | 做 | 宿主写一份可读日志,不指向 v2 的 JSONL(§6.4) |
| 前台子 agent 能问、后台不问(分析 §8.4) | 做 | yoma 只有确认门,§6.5 |
| 穷举清理(分析 §7.5、§14.1) | 做 | §6.7 的登记表 |
| fork 型子 agent(分析 §10) | P5 | `repo.fork` 现成;难点是拿到父会话已渲染的系统提示词原字节 |
| `isolation: worktree`(分析 §12) | P5 | 固件工程多个 agent 同时改代码时才需要 |
| agent 记忆目录、SubagentStart / Stop hooks、agent 私有 MCP、`requiredMcpServers` | 不做 | yoma 没有 hooks 系统,没有 MCP |
| 子 agent 再派子 agent | 不做 | CC 对外部用户同样禁止 |
| teammate / coordinator / remote / KAIROS | 不做 | |
| agent 列表挪进消息(`agent_listing_delta`,分析 §3.2) | 不做 | yoma 的 agent 列表是会话打开时的快照,会话内不变,不存在 CC 那 10.2% cache_creation 的问题 |

## 3. 机制映射:CC → yoma(v2)

| CC 机制(出处) | yoma 落点 | 状态 |
|---|---|---|
| 子 agent = 递归调同一个 `query()`(分析 §1、§7) | 子会话自己的 v2 harness,宿主照主会话的路 `accept + drive`;同一套运行时,不写第二个循环 | 已有 |
| `createSubagentContext` 逐字段裁剪(分析 §6) | 每个子会话一套独立的 Entry(harness / session / 执行环境 / 工具实例 / 投影器);要做的只有中止挂接(前台跟父、后台独立)和进程级的任务注册表(`TaskManager`) | 已有 + 小改 |
| `Agent` 是普通工具,`isConcurrencySafe`(分析 §3.3) | `agent` 是普通 `AgentHarnessTool`;v2 同一批并行,结果按调用顺序落位 | 新建 / 并行已有 |
| AgentDefinition、md frontmatter、按名覆盖(分析 §2) | `AgentProfile`(`host/domain/agents/`),frontmatter 自己解析 | 新建 |
| 工具池从全集重新装配(分析 §5.1) | 子会话照常 `createAgentTools()` 装一整份(自己的闭包),再按 profile 裁 | 新建 |
| `ALL_AGENT_DISALLOWED_TOOLS` / `ASYNC_AGENT_ALLOWED_TOOLS`(`CC:constants/tools.ts:36,55`) | 硬黑名单防递归;硬件类对所有子 agent 关;"后台不能问"改由确认门实现(§6.5) | 新建 |
| sidechain transcript 增量落盘(分析 §7.4) | 子会话的 JSONL 天然就是 | 已有 |
| `output_file` = transcript 的软链 | 宿主写 `<系统临时目录>/yoma/<父会话>/tasks/<任务>.output` 可读日志(v2 的 JSONL 有流式帧,读不了) | 新建 |
| 同步 `Promise.race([iterator.next(), backgroundPromise])`,race promise 只建一次(分析 §8.1) | `Promise.race([task.done, task.backgrounded])`,每个任务各建一次 | 新建 |
| 中途转后台要重跑 `runAgent`,换成异步版 context(分析 §8.3) | 只解除中止挂接,子会话不停、不重跑 | 新建(更简单) |
| 先改状态,再做会 hang 的收尾(`agentToolUtils.ts:508`,gh-20236) | 状态落定 → 提结果与 usage → 前台交工具结果 / 后台入通知 | 新建(照抄顺序) |
| 通知以 user 角色进统一命令队列,主线程闲时自动提交(分析 §9.3、§11) | custom 消息 `steer` 进父会话收件箱(持久化),父空闲时宿主起一轮 | 新建 |
| `notified` 原子去重(`CC:tasks/LocalAgentTask/LocalAgentTask.tsx:197`) | 同名字段,同语义 | 新建 |
| `finalizeAgentTool`:最后一条 assistant 的 text、空结果占位句、`agentId + <usage>` 尾巴、一次性 agent 省尾巴(分析 §9.1、§9.2) | 同款,原话照抄(§5.1) | 新建 |
| `maxTurns` → `max_turns_reached` | 宿主 hook 计轮(§6.6) | 新建 |
| `omitClaudeMd`、子 agent `thinkingConfig: disabled` | `omitContextFiles`;`thinkingLevel` 缺省 `off` | 新建 |
| 模型 env > 入参 > 定义 > inherit | `YOMA_SUBAGENT_MODEL` > 入参 > profile > 父会话当前模型 | 新建 |
| 技能预加载:每个 skill 一条 isMeta user 消息 | 首轮 prompt 数组里先放 `formatSkillInvocation()` 生成的 user 消息 | 新建 |
| finally 清理清单(分析 §7.5) | §6.7 的"每任务副作用登记表" | 新建 |
| 工具描述里的教学段(分析 §3、§10) | `agent` 的描述逐段照 `CC:tools/AgentTool/prompt.ts` 改写(§5.1) | 新建(文案) |

### 3.1 为什么是独立子会话,不是父会话里的另一条 lane

v0.3 §3.1 的理由不变,v2 落地后更站得住:

- 桌面宿主就是"一个会话一个 harness 一条 lane `main`"(`session-manager.ts` 文件头)。子 agent 做成子会话,打开 / 关闭 / 淘汰 / 重放 / 投影全部复用。
- profile 的系统提示词和工具集直接是 harness 选项;同一个 harness 的各条 lane 共用 `systemPrompt` 与工具注册表。
- 每个子会话一个 JSONL,不和父会话挤一条写队列。
- **工具实例天然隔离**:log / la / gdb 的状态活在"每会话一份"的工具闭包里,做成 lane 就成了父子共用一份。

## 4. 数据模型:AgentProfile

### 4.1 字段

新文件 `host/domain/agents/profile.ts`。frontmatter 键名照 CC(`name`、`description`、`tools`、`disallowedTools`、`model`、`maxTurns`、`background`、`skills`、`initialPrompt`、`color`)。

```ts
export interface AgentProfile {
  name: string                  // CC agentType;= subagent_type 的取值
  description: string           // CC whenToUse;拼进 agent 工具的描述
  prompt: string                // md 正文 = 子 agent 系统提示词的正文
  tools?: string[]              // 白名单;undefined / ["*"] = 全集(过完硬黑名单与硬件层)
  disallowedTools?: string[]    // 黑名单,优先于白名单
  model?: string                // "inherit"(缺省)| "<provider>/<modelId>"
  thinkingLevel?: ThinkingLevel // 缺省 "off"(CC:普通子 agent 关思考);frontmatter 键 thinking
  maxTurns?: number
  background?: boolean          // true = 每次派生都后台
  omitContextFiles?: boolean    // CC omitClaudeMd;内建 Explore 为 true,md 里不开放
  skills?: string[]
  initialPrompt?: string        // 拼在首轮 user 消息之前
  oneShot?: boolean             // CC ONE_SHOT_BUILTIN_AGENT_TYPES;内建 Explore / datasheet 为 true,md 里不开放
  color?: string
  source: "built-in" | "user" | "project"
  filePath?: string
}
```

CC 有、yoma 不收的键:`permissionMode`(没有权限系统)、`isolation`(P5)、`memory`、`mcpServers`、`requiredMcpServers`、`hooks`、`effort`(用 `thinking`)、`criticalSystemReminder_EXPERIMENTAL`。见到就记一条诊断、忽略该键,不拒载整个 agent(CC 同款:`loadAgentsDir.ts:541` 非法值记日志后忽略)。

### 4.2 系统提示词与首轮消息

子 harness 的 `systemPrompt` 是函数(同主会话,每轮重算)。拼法对照 CC 的 `runAgent` + `enhanceSystemPromptWithEnvDetails`(`CC:constants/prompts.ts:760`):

```
profile.prompt                                   ← CC:agent 的 getSystemPrompt()
Notes(四条,CC 原文)                            ← 只用绝对路径;最终报告给相关文件的绝对路径、只在逐字要紧时贴代码;不用 emoji;工具调用前不用冒号
Available tools + Tool-specific rules            ← yoma 独有:守则在系统提示词里,不带就丢
宿主追加段(如 STM32 不可用那一句)               ← 同主会话
<project_context>(omitContextFiles 时不给)      ← CC:omitClaudeMd
技能清单(工具里有 read 才给)
env:cwd / 平台 / 日期 / 模型                     ← CC computeEnvInfo
```

实现:`buildSystemPrompt` 加一个 `agentPrompt` 选项。给了它,就用"agentPrompt + Notes + 工具清单 + 守则"替掉 Yoma 的主正文;后面几段仍走**唯一**那一份(`system-prompt.ts:51-54` 的注释写了为什么只能有一份)。不复用 `customPrompt`:它会连守则一起换掉。主 agent 不走 profile,它的系统提示词一个字节都不变。

首轮消息(一次 `accept`):`[...profile.skills.map(s => user(formatSkillInvocation(s))), user(initialPrompt ? initialPrompt + "\n\n" + prompt : prompt)]`。找不到的技能记诊断、跳过。

### 4.3 来源、发现、覆盖

- 内建(代码)< 用户 `<configDir>/agents/*.md`(即 `~/.yoma/agents`)< 项目:从 cwd **向上到文件系统根**逐层的 `<dir>/.yoma/agents/*.md`,外层先、内层后,同名后者覆盖前者(CC `markdownConfigLoader.ts:297` 同款;与上下文文件的祖先链同解,`resources.ts:44-81`)。技能不沿祖先找,两边不一致 —— 先照 CC,技能要不要跟上另议。
- 解析:切出首部两个 `---` 之间的块,用 `yaml` 解析(kernel 的 package.json 加 `"yaml": "2.9.0"`,与 agent 包同一个钉子;上游的 `parseFrontmatter` 不导出)。没有 `name` 的 md **静默跳过**(目录里常有说明文档);字段非法记诊断(`kernel.error`,同技能诊断)后忽略该字段。
- **快照式**:会话打开时读一次(与技能、上下文文件同),agent 列表在会话内不变,所以 `agent` 的工具描述在会话内字节稳定。改了 md 重开会话生效。
- `.yoma/.gitignore` 是黑名单,不含 `agents/`,所以 `.yoma/agents/*.md` 随项目提交 —— 与 CC 的 `.claude/agents/` 一致,正是想要的。

### 4.4 内建 agent

| name | 工具 | 模型 / 思考 | 其他 | 提示词(对照 CC 原文改写) |
|---|---|---|---|---|
| `general-purpose` | `*`(过完硬黑名单与硬件层) | inherit / off | 缺省 subagent_type | `CC:tools/AgentTool/built-in/generalPurposeAgent.ts`:SHARED_PREFIX("完整完成任务,不镀金也不半途而废")+"完成后给简洁报告,调用方会转述给用户"+ SHARED_GUIDELINES(先广后窄、换多种搜法、彻查;非必要不建文件;不主动写文档) |
| `Explore` | `disallowedTools: [edit, write, toolchain, stm32config]` | inherit / off | `omitContextFiles`、`oneShot` | `CC:…/exploreAgent.ts`:READ-ONLY 条款(禁止建 / 改 / 删 / 移文件、临时文件、重定向与 heredoc、任何改系统状态的命令)+ 用 grep / find / ls / read + bash / powershell 只做只读操作 + 按调用方给的彻底程度(quick / medium / very thorough)+ 尽量并行工具调用 + 报告直接作为回复 |
| `datasheet` | `[datasheet, read, grep, find, ls]` | inherit / off | `oneShot` | yoma 特有:查手册取证,回带页码 / 章节的事实与原文摘录,不做推断;没查到就说没查到 |

- `Explore` 在 CC 里对外部用户用 `haiku`(快、便宜)。yoma 多 provider、没有档位别名,缺省 inherit;想省钱的项目放一份 `.yoma/agents/Explore.md` 写上 `model`(同名覆盖)。"快模型"设置留到 P5。
- `Explore` 多禁 `toolchain`(install / set 改机器状态)与 `stm32config`(`generate` 往工程里写代码):CC 的 Explore 只禁 Edit / Write / NotebookEdit,因为它别的写入都走 Bash,由提示词挡住;这两个工具的写入不走 bash,提示词挡不住。
- CC 的 `Plan` 依赖 plan mode;`statusline-setup`、`claude-code-guide`、`verification` 是 CC 专属。都不做。

### 4.5 模型与思考

`YOMA_SUBAGENT_MODEL` > `agent` 入参 `model`(`provider/modelId`)> `profile.model` > `inherit`。`inherit` = 父 lane 当前的 `getModel()`(用户在对话框里切过就跟着切)。指定的模型在注册表里找不到(provider 没配 key)→ 回落 inherit,加一条 `kernel.error`,派生照常。CC 的"同档位别名复用父模型串"、Bedrock 区前缀继承(分析 §7.6)在 yoma 没有对应物。

思考 = `profile.thinkingLevel ?? "off"`,再过 `clampThinkingLevel(model, …)`(同 `setModel`,`session-manager.ts:565-566`)。结果与模型一起作为子 harness 的种子。缺省关思考是照 CC:

- `CC:tools/AgentTool/runAgent.ts:681-684`:普通子 agent 一律 `thinkingConfig: { type: 'disabled' }`,注释原话 "For regular sub-agents, disable thinking to control output token costs";只有 fork 型子 agent 继承父的思考配置(为了请求前缀逐字节相同、吃 prompt cache)。
- CC 里 agent 定义**没有**打开思考的字段;另有一个 `effort`(推理力度)可以覆盖,不写就继承父会话的(`runAgent.ts:481-485`)。yoma 的 frontmatter `thinking` 是这两者合一的扩展:不写 = CC 的缺省(关),写了就按它开。
- yoma 要多留意的一点:CC 跑的是 Claude,关思考时照样能在正文里边想边做;yoma 常跑 DeepSeek 这类推理模型,`off` 会把请求里的 `reasoning` 整个摘掉。信箱闭环 2026-08-11 的实测是 deepseek-v4-pro 在 `off` 下 5 轮 107 条消息推理 token 为 0、一步一句话(`CLAUDE.md`「默认思考档位」)。只读查找类的 `Explore` / `datasheet` 关思考问题不大;`general-purpose` 做多步任务时如果明显变浅,就给它的 profile 写 `thinking`(或项目里放一份同名 md 覆盖)—— P2 的场景测试之外,P3 用真模型各跑一次对比。

### 4.6 子会话元数据

- 会话头:`repo.create({ cwd: parent.cwd, parentSessionId: parent.id }, ctx)`,`repo.list()` 不开会话就知道父子关系。
- 会话级值:`const SUBAGENT_META = value<SubagentMeta>("yoma", "subagent")`,建好会话后写 `{ agent, parentSessionId, toolCallId, description, background, createdAt, notified }`。CC 的 `writeAgentMetadata` 存 agentType,是为了续跑时路由回正确的 agent 类型(`send_message` 不带 subagent_type),这里同理。
- 会话名 = description(`harness.setName`)。
- 视图:`Session` 加 `parentID?`、`agent?`(§7)。

## 5. 工具

四个工具,照工具样板一个工具一个目录:`host/tools/{agent,task_output,task_stop,send_message}/{contract.ts,session.ts}`。`TOOL_NAMES` 末尾追加 `"agent", "task_output", "task_stop", "send_message"`;装配面与契约总表同名同序(`tool-names.test.ts`);desktop 冒烟、kernel-smoke、bench check 三处跟着 +4。

**恒定登记**(同 powershell 的"全平台恒定登记"):装配面永远装出这四件;没有注入 `TaskHost` 的宿主(自检那条路)execute 时报"这个宿主不支持子 agent";子会话里由 §5.3 的硬黑名单裁掉。契约都没有 `confirm`(CC:Agent 工具 `isReadOnly: true`,权限检查下放给子 agent 自己调的工具,分析 §3.3)。

### 5.1 `agent`

**参数**(typebox;描述照 CC):

| 参数 | 说明 |
|---|---|
| `description` | "A short (3-5 word) description of the task" |
| `prompt` | "The task for the agent to perform" |
| `subagent_type?` | 缺省 `general-purpose` |
| `model?` | `provider/modelId`,覆盖 profile |
| `run_in_background?` | "Set to true to run this agent in the background. You will be notified when it completes."(`CC:…/AgentTool.tsx:87`)。宿主关后台时**从 schema 里摘掉**(`Type.Omit`,CC 同款,分析 §3.1) |

**描述**:契约里放静态部分,`session.ts` 装配时把本会话的 agent 列表拼进去(同 stm32config 在 session.ts 里追加覆盖范围)。结构逐段照 `CC:tools/AgentTool/prompt.ts` 的非 fork 版:

1. 开头:"Launch a new agent to handle complex, multi-step tasks autonomously. … Each agent type has specific capabilities and tools available to it."
2. "Available agent types and the tools they have access to:" + 每个 agent 一行 `- <name>: <description> (Tools: <…>)`(`getToolsDescription` 同算法:白名单减黑名单 / "All tools except …" / "All tools")。
3. "When using the agent tool, specify a subagent_type … If omitted, the general-purpose agent is used."
4. When NOT to use:读一个已知路径用 read;找一个符号定义用 grep;两三个文件以内的搜索用 read;与 agent 描述无关的任务。
5. Usage notes(CC 原条目):3–5 词描述;**能并行就一条消息里多个工具调用**;结果用户看不见,要自己转述;后台会自动通知,**do NOT sleep, poll, or proactively check on its progress**;前台用于"下一步依赖它的结果",后台用于"真有独立的活要同时干";续跑用 `send_message`,每次 agent 调用都是一张白纸,任务书要写完整;agent 的输出一般可信;说清楚要它写代码还是只做研究;描述里写了 proactively 的 agent 要主动用;用户说"并行"就必须一条消息里放多个调用。关后台的宿主,后台相关的两条不出现(同 CC)。
6. yoma 追加两条:"Sub-agents cannot use hardware tools (flash, log, la, scope, gdb); keep board operations in your own turns."、"A sub-agent that needs the user to confirm a probe command or an install cannot ask while in the background — it reports back instead."
7. **Don't peek / Don't race**:CC 写在 fork 段里,道理对后台 agent 一样成立 —— 除非用户要求看进度,别去 read `output_file`;发出去之后你对结果一无所知,通知会在以后某一轮以 user 消息到达,用户中途追问就报状态、不编结果。
8. **Writing the prompt**(CC 原文):像给刚进门的聪明同事交底 —— 说清目标和原因、已经排除了什么,给足上下文让它自己判断;要短就明说"200 字以内";查找给确切命令,调查给问题本身;**Never delegate understanding**:别写"根据你的发现把 bug 修掉",要写出路径、行号、改什么。
9. 两个嵌入式例子:一条消息里并行派三个 `Explore`,分头查时钟树 / DMA 配置 / 中断向量;后台派 `datasheet` 取证,同时自己继续改代码。

**结果**(原话照 `CC:…/AgentTool.tsx:1320-1383`,`SendMessage` 换成 `send_message`):

- 前台完成:子 agent 最后一条 assistant 的 text 块(没有就往前找带 text 的;都没有则 `(Subagent completed but returned no output.)`)+ 尾巴 ``agentId: <id> (use send_message with to: '<id>' to continue this agent)\n<usage>total_tokens: N\ntool_uses: N\nduration_ms: N</usage>``;`oneShot` 的 profile 省掉尾巴。
- 后台 / 转后台(`async_launched`):"Async agent launched successfully.\nagentId: <id> (internal ID - do not mention to user. Use send_message with to: '<id>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes."。父有 read 或 bash 时接 "Do not duplicate this agent's work — avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.\noutput_file: <path>\nIf asked, you can check progress before completion by using read or bash tail on the output file.",否则接 "Briefly tell the user what you launched and end your response. Do not generate any other text — agent results will arrive in a subsequent message."
- 前台被停 / 失败:`isError`,正文带部分结果(`extractPartialResult` 同算法)与原因。
- `details`(只放能 JSON 往返的):`{ taskID, agent, description, status, background, turns, toolUses, lastTool, usage, durationMs, outputFile }`,卡片与重放都靠它。

**进度**:子 agent 每开一轮、每结束一个工具,调一次 `onUpdate({ content, details })`;在父 lane 上就是一条 `tool_update`,经现有的 `ToolProgressThrottle` 上卡片(`session-manager.ts:1056-1059,1120-1128`)。

**中止挂接**:前台时把父的 `context.abortSignal` 接到 `host.stop(taskID)`(CC:同步子 agent 共享父的 abortController,按 ESC 一起死);转后台时解除。不声明 `replay`(= 重启后不重跑,§6.7)。

### 5.2 `task_output` / `task_stop` / `send_message`

- `task_output { task_id, block = true, timeout = 30000(0–600000)}`(`CC:tools/TaskOutputTool/TaskOutputTool.tsx:31-33`)→ `{ retrieval_status: success | timeout | not_ready, task: { task_id, task_type: "local_agent", status, description, prompt, result?, error? } }`。block 时等 `task.done` 或超时,尊重 abort;`result` 取自内存,任务已从注册表淘汰时,从子会话 `findEntries({ order: "newestFirst" })` 取最后一条 assistant 文本。描述用 CC 弃用前的那一版(原因见 §10 #14)。
- `task_stop { task_id }`(`CC:tools/TaskStopTool/TaskStopTool.ts`)→ `{ message: "Successfully stopped task: <id> (<description>)", task_id, task_type }`。运行中 → `stop`,状态 `killed`,**照常发 `killed` 通知并带部分结果**(`CC:tasks/stopTask.ts:65-68`:agent 任务不压通知,只有 bash 任务压);前台任务被停,则作为那次 `agent` 调用的错误结果。已经结束 → 报错 "Task <id> is not running (status: …)"(CC 的 stopTask 同样要求任务在运行)。
- `send_message { to, message, summary? }`(`CC:tools/SendMessageTool/SendMessageTool.ts:66-86`;`summary` 是给界面的 5–10 词预览)。`to` = 任务 id(= 子会话 id):
  - 运行中 → 子 lane `steer(user(message))` → "Message queued for delivery to <to> at its next tool round."(`:818`)
  - 已结束 / 被停 → 子会话后台续跑(harness 被淘汰了就先 ensureOpen;`accept(prompt)` + drive),完成后再通知 → "Agent \"<to>\" was stopped (<status>); resumed it in the background with your message. You'll be notified when it finishes. Output: <output_file>"(`:834`)。续跑一律后台(CC 同款);关后台的宿主里改为前台续跑,结果直接作为工具结果返回。
  - 找不到 → 错误。

### 5.3 工具池装配:`resolveAgentTools(all, profile)`

```
子会话照常 createAgentTools() 装出的一整份(子会话自己的闭包)
 ├─① 硬黑名单(profile 无权覆盖):agent / task_output / task_stop / send_message   ← CC ALL_AGENT_DISALLOWED_TOOLS(防递归;TaskStop 需要主线程的任务状态)
 ├─② 硬件类(对所有子 agent 关闭):flash / log / la / scope / gdb                 ← 进程级独占设备(探针租约、全局单例采集库);与 CC 挡 Tungsten 同一个理由
 ├─③ profile.disallowedTools
 ├─④ profile.tools 白名单(undefined / ["*"] = 全给)
 └─⑤ 宿主现有的可用性裁剪(stm32config 看本机资源)                              ← session-manager.ts:779-781
```

结果同时作为子 harness 的 `tools` 与 `activeToolNames`:被裁掉的**根本不注册**,不只是不激活。主 agent 不过 ①②。

CC 有 `ASYNC_AGENT_ALLOWED_TOOLS` 白名单,是因为后台 agent 弹不了权限框;yoma 没有权限系统,对应的做法是"后台子 agent 的确认一律拒"(§6.5),不再单列白名单。CC 的 `Agent(a,b)` 语法(限定可派的类型)只在"主线程本身跑在某个 agent 定义上"时有意义,yoma 的主 agent 不走 profile,不做。

### 5.4 `TaskHost` 与装配

边界规则 2 不许工具碰 session-manager,所以四个工具只认一个注入的接口。接口放在工具间 `host/domain/agents/task-host.ts`,四个工具和宿主都够得着:

```ts
export interface TaskHost {
  profiles(): readonly AgentProfile[]            // 本会话打开时的快照
  backgroundAllowed(): boolean
  spawn(req: SpawnRequest, call: { toolCallId: string; signal: AbortSignal; onProgress(p: TaskProgress): void }): Promise<SpawnOutcome>
  output(taskID: string, opts: { block: boolean; timeoutMs: number; signal: AbortSignal }): Promise<TaskOutputView | undefined>
  stop(taskID: string): Promise<StopOutcome>
  send(to: string, message: string): Promise<SendOutcome>
}
```

`createRegisteredTools({ …, agents?: { host: TaskHost } })`。`SessionManager` 给**主会话**注入一个绑定了父会话 id 的门面(`TaskManager.hostFor(parentID)`),子会话不注入。

## 6. 宿主:TaskManager

新文件 `host/tasks.ts`,进程级单例,由 `SessionManager` 持有。它不直接碰 harness 的细节,只通过一个窄接口使用 SessionManager(开子会话、跑一轮、中止、投递、钉住)。这是 v0.2 §14.3"v1 专属调用只准出现在一个文件"在 v2 上的版本,好处是 TaskManager 能用假端口单测。

### 6.1 状态

```ts
interface TaskState {
  id: string                         // = 子会话 id(CC agentId)
  parentID: string; toolCallID: string
  agent: string; description: string; prompt: string
  status: "pending" | "running" | "completed" | "failed" | "killed"
  maxTurnsReached?: boolean          // CC 的 max_turns 算 completed 的一种
  background: boolean                // 结果走通知而不是工具结果
  startedAt: number; endedAt?: number
  turns: number; toolUses: number; lastTool?: string; usage: Usage
  result?: string; error?: string
  notified: boolean                  // 原子去重;同时写回子会话的 yoma/subagent 值
  done: Deferred<TaskOutcome>        // 本次运行结束
  backgrounded: Deferred<void>       // 转后台信号,每个任务建一次(CC:race promise 在循环外只建一次)
  outputFile: string                 // <os.tmpdir()>/yoma/<parentID>/tasks/<id>.output(CC:<项目临时目录>/<会话>/tasks/<id>.output)
}
```

终态任务留在注册表里,直到父会话被 dispose;之后 `send_message` / `task_output` 从子会话本身取(CC:任务从内存淘汰后从磁盘 transcript 恢复,分析 §11)。

### 6.2 spawn

1. 解析 profile(快照来自父会话打开时);找不到 → "Agent type '<x>' not found. Available agents: a, b, c"(CC 原话)。
2. `background = (run_in_background || profile.background) && backgroundAllowed`(CC 的 `shouldRunAsync`,分析 §4.4)。
3. 建子会话:`repo.create({ cwd, parentSessionId })` → 写 `yoma/subagent` 值 → 会话名 = description → 发 `session.created`(视图带 `parentID`、`agent`)。
4. 开子 Entry:走 `openEntry` 的子会话分支(§6.8)—— 按 profile 装工具、系统提示词、模型与思考,挂 maxTurns 钩子和确认钩子;**钉住**(§6.7)。
5. 并发闸:运行中的任务数 ≥ `maxConcurrentAgents`(§8)时排 `pending`,前面的结束再放行;对模型来说它已经"派出去了"。
6. 首轮:`accept({ kind: "prompt", prompt: firstMessages })` + `drive({ waitForRetry, pollDeferred })`;订阅子会话事件,累计 `turns / toolUses / lastTool / usage`,调 `onProgress`,追写 `output_file`。
7. 落定(子 lane 的 `run_end` / drive 结果):**先**改 `status`(`completed` / `failed` / `killed`,命中 maxTurns 记 `maxTurnsReached`)→ 再提结果与 usage(`finalize`,§5.1)→ 前台交工具结果,后台 / 转后台走 §6.4。顺序照 CC(gh-20236:`TaskOutput(block)` 要立刻解锁,会 hang 的点缀不许挡在状态转换前面)。

### 6.3 前台 / 后台 / 转后台 / 自动转后台

- **前台**:`agent` 工具 `await Promise.race([task.done, task.backgrounded])`。父被中止(停止键 / Esc)→ `context.abortSignal` → 子任务 `killed`,工具以错误结果返回并带部分结果。CC 同款:同步子 agent 随 ESC 一起死。用户往父会话发新消息**不**中止它:消息排队(§6.9),等这次 `agent` 调用所在的工具轮次结束、父模型下一次请求之前才插进去 —— 子 agent 自己永远看不到用户的消息(CC 同款,分析 §11)。等不及就按卡片上的"转后台",父这一轮立刻往下走、先看到排着的消息。
- **后台**:立即返回 `async_launched`,不挂父的中止。父按停止、父发新消息都**不**影响它(CC:"background agents should survive when the user presses ESC",分析 §6)。只有 `task_stop`、界面上的停止、父会话被删、应用退出能停它。
- **中途转后台**:卡片上的"转后台"按钮(`task.background` RPC)→ `task.background = true`、解除中止挂接、`backgrounded.resolve()` → 工具立刻返回 `async_launched`。子会话**不停、不重跑**(CC 要重跑 `runAgent`,换成异步版 context,分析 §8.3;yoma 的子 agent 本来就是独立会话,没有要换的东西)。转后台时子 agent 若正挂着一条确认,按 §6.5 取消。
- **自动转后台**:`YOMA_AUTO_BACKGROUND_MS`,缺省 0 = 关(CC 缺省关,开了是 120 000);大于 0 时,前台任务到点自动走上一条。

### 6.4 通知投递

**消息**:`createCustomMessage("task-notification", xml, true, { taskID, agent, description, status, usage }, Date.now())`。XML 与 CC 逐字段同形(`CC:tasks/LocalAgentTask/LocalAgentTask.tsx:197-260`):

```xml
<task-notification>
<task-id>{taskID}</task-id>
<tool-use-id>{toolCallID}</tool-use-id>
<output-file>{outputFile}</output-file>
<status>completed|failed|killed</status>
<summary>Agent "{description}" completed | Agent "{description}" failed: {error} | Agent "{description}" was stopped</summary>
<result>{最终文本;被停时是部分结果}</result>
<usage><total_tokens>N</total_tokens><tool_uses>N</tool_uses><duration_ms>N</duration_ms></usage>
</task-notification>
```

**投递**(每个父会话一条串行队列):

1. 原子地检查并置 `notified`;已经置过就不发(CC 同款)。
2. `ensureOpen(parent)`(父可能被 LRU 关掉了)。
3. `parentLane.steer(message)`:持久化进收件箱,从这一刻起内核崩了也不会丢。
4. `wake(parent)`:父空闲(没有在飞操作)→ `accept({ kind: "prompt", prompt: [] })` + drive,与用户发消息同一条路,只是少一条用户消息。回 `LaneBusy` = 父已经在跑,它会在下一个边界或结束边界取走通知,不是错误;回 `InvalidMessage(empty)` = 已经被取走了,也不是错误。
5. 父的 `run_end`:若 `queue_update` 记下的收件箱仍非空,再 `wake` 一次(覆盖"steer 落在结束提交之后"的情况)。

为什么这样就够:运行内由 `finishRunBoundary` 保证(§1 收件箱语义),运行外由第 4、5 步保证;最坏情况只是多一次 `wake`,拿到 `InvalidMessage(empty)`。通知和排队的用户消息(§6.9)走的是同一个收件箱、同一条"父空闲且收件箱非空 → 起一轮"的规矩,按到达顺序被取走。不用 `before_run_end`:它只能回一段 `followUp` 字符串,变成普通 user 消息,界面就分不出哪条是通知了。

**停止键会把通知一起摘下来**(`requestAbort` 的返回值,§1)。**本期不处理**(用户 2026-09-18 定,与 §6.9 的用户消息同一个坑):按停止时排在父会话收件箱里的通知会丢,子会话里的结果还在,模型可以用 `task_output` 取。以后要补的做法:宿主接住里面 `customType = "task-notification"` 的那几条,等 lane 回到空闲后重新 `steer` 并 `wake` —— 照 CC,通知"留在队列里稍后自动处理"(`CC:utils/messageQueueManager.ts` 的 `popAllEditable` 注释:"Notification modes (task-notification) are left in the queue to be auto-processed later")。

**output_file**:宿主给每个任务追写一份纯文本进度日志(每轮的 assistant 文本、每个工具一行 `→ bash: <摘要>`、最终结果)。CC 让 `output_file` 软链到 transcript JSONL(分析 §7.4);v2 的 JSONL 每个流事件一行,读它等于读噪音,所以另写一份。

**已知缺口**:子 agent 落定之后、第 3 步写进父会话之前内核崩了,这条通知会丢(子会话里的结果还在)。修法(P5):启动时扫 `yoma/subagent` 值里 `notified = false` 且已结束的子会话,补发。

**子会话不接用户 prompt**:`session.prompt(childID)` 拒绝,`data._tag = "SubagentSessionError"`;续跑只能经 `send_message`(CC:子 agent 永远看不到用户的 prompt 流,分析 §11)。

### 6.5 确认门冒泡

CC:同步子 agent 能弹权限框(显示在主界面),后台的 `shouldAvoidPermissionPrompts: true` 直接拒(分析 §6、§8.4)。yoma 没有权限系统,但有确认门(契约的 `confirm`、bash / powershell / log 的探针命令门、toolchain install):

- 子会话同样挂 `before_tool` 确认钩子(只在 `confirmTools` 的宿主)。
- **前台**:询问照常进确认台,但**显示在父会话**(`ToolConfirmView.sessionID` = 父会话 id,另带 `agent`、`taskID`),确认条上写"子 agent「<description>」想运行 …"。取消仍按子会话算(子会话被停 / 关时 `desk.cancel` 要撤掉它)—— `ConfirmDesk` 要把"显示在哪个会话"与"属于哪个会话"拆成两个键。
- **后台**:钩子立即 `block`,不进确认台。理由原样进模型:"Background sub-agents cannot ask the user for confirmation, so <tool>: <summary> did not run. Report back that it needs to run and let the main agent ask." + 现有的 noBypass 句(`session-manager.ts:1219-1220`)。
- 挂着确认时被转后台 → 取消那条询问,模型收到的理由写明"moved to background before approval"。

### 6.6 maxTurns(宿主 hook,不改内核)

同 v0.3 §6.6,钩子名和参数已对着 `agent-harness.ts:430-500` 核过:`before_request` 在 `step === "assistant" && attempt === 1` 时按 `runId` 计轮;`after_tool` 在轮数 ≥ max 时回 `terminate: true`;`before_tool` 在轮数 > max 时 `block: { reason: "max turns reached", terminate: true }` 兜底(被拦下的调用不经过 `after_tool`)。语义同 CC:第 N 轮的工具跑完就不再请求模型,运行以 `completed` 结束,任务记 `maxTurnsReached`,结果照常取最后一段文本(可能落到空结果占位句)。"同一批**每个**调用都带 terminate 才停"这一条在 P0 实测确认。

### 6.7 生命周期与清理

**LRU 钉住**(v0.2 §14.1 第 3 条在 v2 上照样成立):`evictIdle` 按 `status === "idle"` 选淘汰对象,而刚开好还没 `accept` 的子会话、排队中的子会话、两轮之间的子会话都是 idle。一条消息派 12 个,活会话就有 13 个以上,每次 `openEntry` 末尾的 `evictIdle()`(`session-manager.ts:894`)都可能把兄弟子会话关掉。修法:任务处于 `pending / running` 期间钉住它的子 Entry,`evictIdle` 跳过钉住的;父会话不钉(投递前会 `ensureOpen`)。TaskManager 不跨 await 缓存 lane 引用,一律现取。

**各种结局**:

| 事件 | 前台任务 | 后台任务 |
|---|---|---|
| 父按停止 / Esc | 随父的中止 `killed` | 不受影响 |
| 父发新消息 | 不受影响;消息排队,这次 `agent` 调用结束后父才看到(§6.9) | 不受影响 |
| 父被 LRU 关(只会发生在父 idle 时) | 不存在(父 idle 时没有前台任务) | 不受影响;通知来时重开父 |
| 父会话被删 | 先停掉全部任务,再按 `parentSessionId` 删子会话,逐个发 `session.deleted` | 同左 |
| 应用退出(`disposeAll`) | 全部中止 | 全部中止 |
| 内核重启 | 父的在飞操作被 `openEntry` abort,`agent` 调用得到"被中断"的结果(不声明 `replay` = 不重跑);子会话同样被 abort | 注册表在内存里,任务丢失,子会话留着;P5 补发 |

**每任务副作用登记表**(CC finally 清单的对应物,分析 §7.5、§14.1。写进代码注释,每加一项就在清理函数里加一行):

| 占用 | 在哪 | 谁收 |
|---|---|---|
| 子会话 Entry 的钉住 | `entry.pinned` | 落定 |
| 并发槽位 | TaskManager | 落定(放行下一个 pending) |
| 父工具 `abortSignal` 的监听 | 前台 | 落定 / 转后台 |
| 自动转后台计时器 | 前台 | 落定 / 转后台 |
| 子会话事件订阅(进度、日志) | TaskManager | 落定 |
| 挂着的确认 | ConfirmDesk | 子会话停 / 关、转后台 |
| `output_file` 句柄 | TaskManager | 落定 |
| 子会话的 harness / 工具实例 / 执行环境 | Entry | 现有的 `closeEntry`(淘汰或删除时) |
| 父会话收件箱里还没消费的通知 | 父 JSONL | 父的下一轮(持久化,不用收) |

### 6.8 SessionManager 要改的

- `Entry` 加 `parentID?`、`profile?`、`pinned?`、`queued?`(`queue_update` 记下的收件箱)。
- `openEntry(entry)`:子会话分支(`entry.profile` 有值)—— `createAgentTools()` 照常装一整份 → `resolveAgentTools` 裁 → 子会话的系统提示词(§4.2)→ 模型与思考种子(§4.5)→ maxTurns 钩子 → 确认钩子(前台冒泡 / 后台拒)。主会话分支给工具注入 `TaskHost` 门面。
- 把 `prompt()` 里"accept + drive + fail 处理"抽成 `runOperation(entry, request)`,`prompt()`、`wake()`、子任务、`send_message` 续跑共用。
- `prompt()` 拒绝子会话;忙时改为排队(§6.9);`evictIdle` 跳过钉住的;`delete()` 级联;`list()` / `toView()` 带出 `parentID`、`agent`。
- (暂缓)`stop()` 接住 `requestAbort` 摘下来的排队项:用户消息交回调用方(退回输入框),通知重新排队并 wake(§6.4、§6.9)。本期不做。
- `subscribe()`:`queue_update` → `entry.queued`,并向界面发 `session.queue`;`run_end` → 通知 TaskManager(父会话:收件箱非空就 wake;子会话:任务落定)。

### 6.9 用户输入排队(照 CC;用户 2026-09-18 定)

CC:模型在跑的时候,用户敲的消息进队列,在下一个工具轮次结束、下一次请求之前插进去;按 ESC 才中断;队列里的用户消息可以按 ↑ / ESC 拉回输入框改(`CC:utils/messageQueueManager.ts` 的 `popAllEditable`、`CC:components/PromptInput/PromptInput.tsx:1951`)。v2 的 steer 就是这个语义,而且更硬:排队项持久化,一轮要结束时在同一次提交里被取走(§1)。

- **`prompt()` 在忙时**(有在飞操作):不再 `stop()`。图片照常压缩,然后 `lane.steer(userMessage, images)`,返回 `{ messageID, queued: true }`。会话状态不变(仍是 busy)。
- **不做乐观插入**:排队的消息还不在 transcript 里,界面把它画在输入框上方的"排队中"一栏(数据来自 `session.queue` 事件,即收件箱里 user 角色的排队项);被取走时它随 `message_end` 进 transcript,落在真实的位置(当前工具轮次的结果之后)。所以 `pendingUserID` 只给"空闲时直接发"的那条用。
- **改一条排着的消息**:点"排队中"里的那一条或按 ↑ → `session.cancelQueued { sessionID, entryId }`(`lane.cancelQueued`)→ 撤回成功就把原文与图片还给输入框;`already_consumed` 说明它刚被取走,提示一句即可。
- **停止键 / Esc(暂缓,用户 2026-09-18 定:"这个坑记下了,先不管")**:`requestAbort` 会把排队项摘下来作为返回值交回(§1),本期**不接**,停止时排着的用户消息与通知会丢 —— 已知缺口,记在 §14。以后要补的做法照 CC:user 角色的原样交回(`session.abort` 的结果带 `returned: [{ text, images }]`),界面拼回输入框(CC `popAllEditable`:排队文本在前、原输入在后);`task-notification` 重新排队并 wake(§6.4);手动压缩(`compact()` 会先 stop)走同一段处理。
- **竞态**:判断"忙"与 `steer` 之间这一轮恰好结束 → 排队项躺在空闲 lane 的收件箱里 → 被 `run_end` 那条"收件箱非空就 wake"接住,和通知是同一条路。准备期(压缩图片、`Entry.preparing`)里又来一条 → `prompt()` 按会话串行,后来的那条等前一条 accept 完再判断忙闲。
- **不受影响的宿主**:bench 与信箱只在空闲时发 prompt。
- 这是对**所有**会话的行为改变,不依赖子 agent,可以在 P2 里先单独做、单独测。

## 7. 协议与 UI

- `types.ts`:`Session` 加 `parentID?`、`agent?`;新增 `TaskView { id, parentID, agent, description, status, background, startedAt, endedAt?, turns, toolUses, lastTool?, usage?, outputFile }`;`TOOL_NAMES` +4;`ToolConfirmView` 加 `agent?`、`taskID?`;新增 Part `TaskNotificationPart { type: "task", taskID, agent, description, status, summary, result?, usage? }`(占 opencode 当年 `subtask` part 的位置,文件头"subtask —— 没有子代理"那行注释一并改掉);`UserMessage` 加 `synthetic?`;新增 `SubagentSessionError`。
- `protocol.ts`:新增 RPC `agent.list { directory }`(界面列出可用的 agent)、`task.list { sessionID }`、`task.stop { taskID }`、`task.background { taskID }`;新增事件 `task.updated { task }`。任务面板和卡片的状态都靠它;子会话的 busy / idle 与任务的 pending / killed 不是一回事,不复用 `session.status`。排队(§6.9):`session.prompt` 的结果加 `queued?`;`session.abort` 的结果加 `returned?: Array<{ text, images? }>`;新增 RPC `session.cancelQueued { sessionID, entryId }`;新增事件 `session.queue { sessionID, items: Array<{ entryId, text, images? }> }`。
- 投影器:`task-notification` 的 custom 消息投成**带 `synthetic` 的 user 消息** + `TaskNotificationPart`,并把 `turnParentID` 设成它。这样唤醒后的那轮回复归在通知下面,而不是挂到上一个用户轮(现在的 `applySynthetic` 把它投成 assistant,且不动 `turnParentID`,`projector.ts:382-428`)。live 与重放走同一个函数(投影器第一条不变式)。宿主起的一轮没有 renderer 铸的用户消息 id,`pendingUserID` 为空,不会被当成"乐观插入没对上"。
- session-ui:新增 `agent-tool.tsx` 卡片,登记进 `message-part.tsx` 的工具表(与 flash 那一行同一处)。折叠态一行:agent 名 · description · 状态灯 · "N tool uses · 最近: bash · 12s";展开态:prompt、最近几步、结果(markdown);按钮:打开子会话 / 转后台 / 停止。`task` part 渲染成一行状态 + 可展开的结果。details 认不出就回落 `GenericTool`(旧会话)。
- app:
  - `isRootVisibleSession` 加一条 `!session.parentID`,子会话不进侧边栏和首页;
  - 子会话页:只读 transcript + 顶部条(父会话链接、agent、状态、停止按钮),不渲染输入框;
  - 状态栏(`console/session-status-bar.tsx`)加一格"子 agent N",点开是本会话的任务列表(状态、耗时、打开、停止),对应 CC 的任务面板;
  - 确认条显示 `agent` 前缀;
  - 输入框(§6.9):忙时发送不再先停(`submit.ts` / `prompt-input.tsx` 里 working 时的分支),`queued: true` 时不做乐观插入;输入框上方加"排队中"一栏(点一条或按 ↑ 撤回来改);停止之后把 `returned` 拼回输入框;空输入时按钮仍是"停止"、Esc 仍是中断(现状即 CC 同款);
  - i18n 中英两份同时加(有 parity 测试;缺键会渲染成 `undefined`)。
- desktop:冒烟与 e2e 的工具数 +4;`CLAUDE.md` 的工具清单与"工具样板"一段同步更新。

## 8. 并发与资源

- **并发上限**:`maxConcurrentAgents` 缺省 10(CC 的 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 缺省 10,分析 §1.1),`YOMA_MAX_CONCURRENT_AGENTS` 可调;超出的排 `pending`。v0.3 是 12,改成与 CC 一致。
- **硬件**:见 §5.3 ②;另有 bash / powershell 的探针命令门(§6.5)。
- **文件写入**:没有隔离,多个 agent 改同一个文件会互相覆盖 —— 与 CC 不开 `isolation` 时一样;worktree 隔离留 P5。
- **provider 限流**:每个子 harness 都有内建重试;`resolveModel` 的流空闲看门狗(`host/stream-guard.ts`)照样生效。
- **存储**:每个子 agent 一个 JSONL,v2 不回收流式帧,磁盘涨得快;删父会话时级联删子会话,其余清理策略另议。
- **事件量**:十几个子会话同时流式输出,message 事件照常发给 renderer。P3 实测 renderer 内存;扛不住再加"只给被看着的会话转发 message 事件"。
- **子进程**:每个子会话一套自己的执行环境,由 `closeEntry` 收。
- **prompt cache**:子 agent 的系统提示词与父不同,不共享前缀;fork 型才共享(P5)。

## 9. 无人值守宿主(bench / 信箱)

- `SessionManagerOptions.subagents?: { background?: boolean }`,缺省 `true`。bench 与信箱工位端传 `{ background: false }`:`run_in_background` 从 schema 和描述里摘掉,profile 的 `background` 不生效,一律前台(CC:`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`)。
- 理由:bench 判一轮结束靠 idle 静默,后台子 agent 在跑的时候父会话是 idle,这个判据就说谎了;而且 bench 一轮一个子进程,轮结束子进程退出,后台任务本来也活不下来。
- 这两个宿主不传 `confirmTools`,不存在冒泡问题。
- bench 的 `check` 和信箱都走 `TOOL_NAMES`,+4 自动跟上。

## 10. 决策

| # | 事项 | v0.4 结论 | 相对 v0.3 |
|---|---|---|---|
| 1 | 并行上限 | 10,可配 | 12 → 10(与 CC 一致) |
| 2 | 子 agent 碰硬件 | 不能;`hardware: true` + 互斥锁留到 P5 | 不变 |
| 3 | 轮数上限 | profile 可设;宿主 hook 实现 | 不变 |
| 4 | 子会话直接对话 | 不能;续跑走 `send_message` | 不变 |
| 5 | 费用归属 | 工具结果与通知带 usage;父会话的 cost 不含子 agent,汇总以后再议 | 不变 |
| 6 | agent 文件位置 | `~/.yoma/agents` + 从 cwd 向上逐层的 `.yoma/agents` | 不变 |
| 7 | 工具名 | `agent` + `subagent_type`;配套 `task_output / task_stop / send_message` | 不变 |
| 8 | 内建 agent 名 | CC 原名 `general-purpose`、`Explore`,外加 `datasheet` | 新 |
| 9 | 子 agent 思考档 | 缺省 off | 不变 |
| 10 | 承载 | 独立子会话 + 独立 v2 harness | 不变 |
| 11 | 内核改动 | 零 | 不变 |
| 12 | 通知投递 | steer + 父空闲时起一轮 + `run_end` 兜底;不设 steeringMode,不用 `before_run_end` | 简化 |
| 13 | 重启 | 在飞操作由宿主 abort(现状);`agent` 工具不重跑 | 不变 |
| 14 | `task_output` | 保留,用 CC 弃用前的描述。CC 2.1.88 把它标成 DEPRECATED、推荐 Read `output_file`,但 CC 的 `output_file` 就是 transcript;yoma 的 `output_file` 是派生日志,权威结果在内存和子会话里,`task_output` 取的正是权威那份。yoma 没有 deferred 工具机制,四个工具常驻(用户 09-18 确认) | 新 |
| 15 | `send_message` | 缺省开。CC 对外部用户要开 agent teams 才有,但 CC 自己的 Agent 描述也在教模型用它续跑;续跑是核心用例(用户 09-18 确认) | 新 |
| 16 | 自动转后台 | 缺省关,`YOMA_AUTO_BACKGROUND_MS` 打开(同 CC) | 新 |
| 17 | 子会话在侧边栏 | 不显示(CC 同款);从卡片和状态栏的任务面板打开(用户 09-18 确认) | 推翻"侧边栏嵌套" |
| 18 | 确认门 | 前台冒泡到父会话,后台直接拒 | 新 |
| 19 | 无人值守宿主 | 关后台 | 新 |
| 20 | `output_file` | 宿主写可读日志,放系统临时目录 | 新 |
| 21 | 用户往忙着的会话发新消息 | **排队,照 CC**(用户 09-18 定):steer 进收件箱、下一个工具轮次边界插入;停止键 / Esc 才中断;前台子 agent 不受影响。对所有会话生效(§6.9)。停止时排队项会被 v2 摘掉,接住它们(用户消息退回输入框、通知留下自动处理)本期暂缓 | 新(v0.3 §11 第 7 条的待定项落地) |

## 11. 与 CC 的差异(每条都有理由)

| CC | yoma | 理由 |
|---|---|---|
| 同进程递归 `query()` + 裁剪版 `ToolUseContext` | 同进程,但每个子 agent 是独立的子会话 + 独立 v2 harness | v2 的会话就是天然的隔离单元;CC 那张"字段共享 / 克隆 / 置空"表在这里变成"每个子会话自己一套" |
| 工具名 `Agent`(兼容 `Task`) | `agent` | yoma 工具名全小写 |
| 模型别名 opus / sonnet / haiku,Explore 用 haiku | `provider/modelId`,内建全部 inherit | 多 provider,没有档位别名 |
| agent 列表可以挪进消息(`agent_listing_delta`) | 列表写在工具描述里 | 会话级快照,会话内不变,不会打爆 cache |
| `TaskOutput` / `TaskStop` 是 deferred 工具,TaskOutput 标 DEPRECATED | 都常驻,保留 `task_output` | 没有 deferred 工具机制;`output_file` 是派生日志(§10 #14) |
| `SendMessage` 要开 agent teams | 缺省开 | §10 #15 |
| `output_file` 软链到 transcript JSONL | 宿主写可读日志 | v2 的 JSONL 每个流事件一行 |
| 权限系统:`permissionMode`、bubble、异步白名单 | 只有确认门:前台冒泡、后台拒;没有异步白名单 | yoma 没有权限系统(2026-08-10 的产品决定) |
| 中途转后台要重跑 `runAgent` | 只解除中止挂接 | 子 agent 本来就是独立会话 |
| 子 agent 系统提示词 = 正文 + Notes + env | 另加"可用工具 + 工具守则" | yoma 的守则写在系统提示词里,不在工具描述里 |
| 协作式并发调度,上限 10 | v2 同批并行 + TaskManager 上限 10 | — |
| 通知进进程内的命令队列 | 通知 steer 进父会话收件箱 | v2 收件箱是持久化的,内核崩了也不丢 |
| 内建 `Plan` / `statusline-setup` / `claude-code-guide` / `verification` | 不做;多一个 `datasheet` | 前者依赖 plan mode,后三个是 CC 专属 |
| Explore 只禁 Edit / Write / NotebookEdit | 另禁 `toolchain`、`stm32config` | 这两个工具的写入不走 bash,提示词挡不住 |
| plugin / flag / policy 三层 agent 来源 | 只有内建 / 用户 / 项目 | yoma 没有插件与策略层 |
| fork / worktree / memory / hooks / MCP / teammate / coordinator | 本期不做 | 见 §2 |

## 12. 分期与验证(场景测试先行)

环境:`npm test` = `vitest run`;单文件 `npx vitest run --project kernel <路径>`(kernel 有 `kernel` 与 `kernel-domain` 两个项目);`npm run typecheck`;Windows 全量 `npm run test:windows`。Windows 上的测试规矩照 `CLAUDE.md`「测试」一节:删临时目录用 `removeTempDir`,轮询等待接 `patient()`,真跑子进程的用例别吃缺省 5 秒。

**P0 原型(约 1 天)**:`host/subagent-spike.test.ts`(kernel 项目,faux 模型,每个 harness 一份 provider,不接桌面端),验证本方案依赖的 v2 行为:

- (a) `repo.create({ parentSessionId })` + 独立 harness + `accept` / `drive`,拿到最后一条 assistant 文本;`repo.list()` 带出 `parentSessionId`;
- (b) 父空闲时 `steer(custom)` → `accept({ prompt: [] })` → transcript 里是 custom 条目,模型侧是 user 角色;收件箱为空时得到 `InvalidMessage(empty)`;
- (c) 父在跑时 steer → 下一个边界取走;在最后一轮里 steer → 这一轮不结束、接着跑(`finishRunBoundary`);结束之后 steer → `run_end` 后收件箱非空,wake 成立;
- (d) 父 `requestAbort` → 父工具的 `context.abortSignal` 触发 → 子被停;
- (e) maxTurns 钩子,含同一批多个调用、只有部分带 terminate 的情形;
- (f) 带着在飞操作的子会话被关掉再打开 → `open` 里有它,abort 之后 lane 可用。

结论写回本文;P2 时转成正式测试或删掉。**不要放进 `packages/agent/`**(锁定目录)。

**P0 结果(2026-09-18,`packages/kernel/src/host/subagent-spike.test.ts`)**:11 个用例全过(c1 按"custom 通知 / 用户消息"各跑一次,另加 (g) 一条事实核对),连跑 5 次 5 次全绿,单次测试耗时约 0.6 s;变异验证 4/4 被抓(c2 不 steer、e1 上限改 3、e2 整批 terminate、d 不挂中止,各自对应的用例变红)。typecheck 11/11、oxlint 0 警告。本方案依赖的 v2 行为全部成立,设计不用改:

| # | 结论 |
|---|---|
| (a) | `repo.create({ parentSessionId })` 写进文件头,`repo.list()` 不开会话就带出 `parentSessionId`;子会话独立 harness 跑完一轮,`findEntries({ order: "newestFirst", type: "message" })` 取得到最后一条 assistant 文本 |
| (b) | 空闲时 `steer` 不起轮(`inspectExecution().current === null`);`accept({ prompt: [] })` 收走它,模型侧是 user 角色,transcript 是 `role: "custom"` 条目;收件箱空时错误为 `{ _tag: "InvalidMessage", reason: "empty" }` |
| (c1) | 父卡在一批工具里时 steer(custom 或用户消息)→ 这批结束后的下一次请求就带上,顺序是 `toolResult → user`,不多起一轮 —— §6.9 的排队就是这条 |
| (c2) | 模型正在生成最后一段回答时 steer → 这一轮接着跑、共 2 次请求、只有一个 `run_end`;在模型请求进行中调 `lane.steer` 不会死锁 |
| (c3) | `run_end` 之后 steer → lane 空闲,`queue_update` 带出 `{ kind: "steer", type: "message" }`;`accept({ prompt: [] })` 收走后 `queue_update` 变空 |
| (d) | 父 `requestAbort` → 父工具的 `context.abortSignal` 立刻触发 → 工具里 `requestAbort` 子 lane → 子的模型流收到中止,子、父两轮都以 `aborted` 落定,父没有第二次请求 |
| (e1) | maxTurns 钩子成立:max = 2 时第 2 轮的两个工具跑完就停,`completed`,最后一条是 `toolResult` |
| (e2) | 同一批只有部分调用带 `terminate` → 不停,照常请求下一轮(确认 v2 要求整批都带) |
| (f) | 只 accept 没 drive 就 `harness.close()`,重开后 `open` 里有这条 `{ lane: "main", kind: "run" }`,新 accept 回 `LaneBusy`;`lane.abort()` 之后照常可用 |
| (g) | 父卡在工具里时 steer 一条通知 + 一条用户消息,`requestAbort` 的返回值 `steer` 就是这两条(`["custom", "user"]`),之后收件箱为空 —— §14"停止键清空收件箱"的根,已钉成事实,本期不处理 |

**P1 定义与工具**(用假的 `TaskHost`):`host/domain/agents/*`(类型、内建三份、加载与覆盖、frontmatter、`resolveAgentTools`)+ 四个工具的契约与 session + `TOOL_NAMES` +4。测试:agent 列表与工具描述的渲染;硬黑名单 / 硬件层 / 黑白名单;后台关闭时 schema 里没有 `run_in_background`;前台 / 后台 / 被停三种结果的**逐字**文本;`oneShot` 省尾巴;空结果占位句;`task_output` 的 block / timeout;`send_message` 的三个分支;前台时 `abortSignal` 的转发。`boundary.test.ts`、`tool-names.test.ts`、`npm run typecheck` 全绿。

**P2 宿主**(**先写场景测试,再写实现** —— v0.2 §14 的四处缺口,全是"把设计场景放到现有代码上走一遍时序"才掉出来的,同类问题大概率还有):`host/tasks.ts` + §6.8 的 SessionManager 改动。`host.test.ts`(faux)场景:

- (a) 一条消息派 3 个 `Explore` 并行:3 个 `session.created` 带 parentID,父会话 3 张卡片 completed,父的最后一条 assistant 出现;
- (b) `run_in_background` → 父这一轮结束 idle → 子完成后父被叫醒起新一轮,通知在父会话里是 custom 条目,投影成 synthetic user + task part;
- (c) 父忙时子完成 → 通知在下一个边界插入,父不多起一轮;
- (d) `task_stop` → `killed` 通知带部分结果,只通知一次;
- (e) `send_message` 到运行中的子 → 子 transcript 出现该消息;到已结束的子 → 后台续跑并再通知一次;
- (f) `maxTurns: 2` → `maxTurnsReached`;
- (g) `maxConcurrentAgents: 2` 时派 3 个 → 第三个 pending,直到有一个结束;
- (h) 子会话的工具集 = profile 子集,没有硬件类,也没有四个 agent 工具;
- (i) 模拟重启:前台子 agent 跑到一半,关掉全部 harness 再打开 → 父拿到"被中断"的工具结果,子会话的操作被 abort;
- (j) 通知已 steer 进父会话、还没被取走时重启 → 重开父会话后通知仍在收件箱,wake 后被消费;
- (k) LRU:父 + 12 个子,运行中 / 排队中的子会话一个都没被淘汰;
- (l) 删父会话 → 子会话级联删除;
- (m) 确认:前台子 agent 的 bash 起探针程序 → 询问出现在父会话、带 agent;后台 → 直接 block,理由逐字核对;
- (n) 前台子 agent 在跑时用户往父会话发新消息 → 返回 `queued: true`,子 agent 照常跑完;父在这次 `agent` 调用结束后的下一次请求里看到这条消息,位置在工具结果之后;同时在跑的后台任务不受影响;
- (o) (暂缓,随 §6.9 停止键那一条一起做)排着一条用户消息和一条通知时按停止 → `session.abort` 的结果里交回那条用户消息的原文(与图片);通知被重新排队,lane 空闲后 wake、被消费;两者都没有丢;
- (p) 排队项恰好落在一轮的最后一个边界之后 → `run_end` 后收件箱非空 → wake 起新一轮;落在之前 → 这一轮不结束、接着跑(与 (c) 同一条规矩,换成用户消息再测一遍);
- (q) `session.cancelQueued` 撤回一条还没被取走的排队消息 → 原文交回、它不再进 transcript;已被取走的 → `already_consumed`。

**P3 协议 + 投影器 + UI**:按 §7 做;i18n 中英;desktop 冒烟与 e2e 工具数 +4;`e2e:paint` 覆盖卡片与子会话页;实测十几个子会话同时流式时 renderer 的内存(§8)。

**P4 无人值守宿主与文档**:bench / 信箱传 `background: false`;`CLAUDE.md` 加"子 agent"一节、更新工具清单;把结论回填本文。

**P5 以后**:fork 型子 agent、`isolation: worktree`、`hardware: true` + 设备互斥、`agent` 工具 `replay: "safe"` + `invocation.setMemo` 重启后重新挂接、启动时补发没通知的结果、只给被看着的会话转发 message 事件、"快模型"设置、父会话 cost 汇总。

## 13. 改动清单

| 包 | 文件 | 改动 |
|---|---|---|
| agent(上游,锁定) | — | **不改** |
| kernel | `host/domain/agents/{profile,builtin,load,select,task-host}.ts`(新) | 类型、内建三份、加载与覆盖、frontmatter、`resolveAgentTools`、`TaskHost` |
| kernel | `host/tools/{agent,task_output,task_stop,send_message}/{contract,session}.ts`(新);`host/tools/index.ts`、`host/tools/contracts.ts` | 四个工具;装配面与契约总表 +4 |
| kernel | `host/tasks.ts`(新) | TaskManager:状态机、spawn、并发闸、race、通知、`output_file`、stop / send / output、清理登记表 |
| kernel | `host/session-manager.ts` | 子会话分支、抽出 `runOperation`、`wake`、钉住、级联删、拒绝子会话 prompt、跟踪收件箱;忙时 prompt 改排队、`cancelQueued`(§6.9;`stop()` 接住被摘下的排队项暂缓) |
| kernel | `host/system-prompt.ts` | `agentPrompt` 选项(Notes + 工具守则 + env) |
| kernel | `host/confirm.ts` | 拆开"显示在哪个会话 / 属于哪个会话";加 `agent`、`taskID` |
| kernel | `host/projector.ts` | `task-notification` → synthetic user + task part,设 `turnParentID` |
| kernel | `host/index.ts`、`protocol.ts`、`types.ts` | RPC、事件、视图字段、`TOOL_NAMES` +4 |
| kernel | `package.json` | 加 `yaml: 2.9.0` |
| kernel | `host/subagent-spike.test.ts`(P0)、`host/host.test.ts`、`host/tool-names.test.ts`、`host/projector.test.ts`、`test/agents-*.test.ts` | |
| session-ui | `components/agent-tool.tsx`(新)、task part、`message-part.tsx` 登记 | |
| app | `pages/layout/helpers.ts`、子会话页、状态栏任务格、确认条、i18n 两份 | |
| app | `components/prompt-input.tsx`、`components/prompt-input/submit.ts`、输入框上方的"排队中"一栏 | 忙时发送改排队、不做乐观插入、撤回与停止后退回输入框(§6.9) |
| desktop | 冒烟 / e2e 的工具数 | +4 |
| bench | 宿主选项 `subagents: { background: false }` | |
| 根 | `CLAUDE.md` | 工具清单、子 agent 一节 |

## 14. 风险与坑

- **`open` 里的操作不处理,那条 lane 就永远 `LaneBusy`**:宿主 `openEntry` 已经一律 abort,子会话走同一条路就不会漏。
- **`close()` 不是中止**:LRU 关掉一个还在跑的 harness,操作会一直开着,下次打开时出现在 `open` 里 —— 所以运行中的子会话必须钉住(§6.7)。
- **wake 撞上 `LaneBusy`、`InvalidMessage(empty)` 都是正常情况**,不要当错误上报。
- **通知丢失窗口**:见 §6.4 的已知缺口。
- **锁定目录**:原型、测试、注释副本都不要放进 `packages/{agent,ai,chord,telemetry}`,`upstream:check` 会失败。
- **排队改的是所有会话的行为**(§6.9):上线后"忙时发消息"从"打断重来"变成"等这一轮的工具跑完再看到",要在发版说明里写一句;想打断要按停止或 Esc。
- **停止键会把收件箱清空(已知,本期不处理)**:`requestAbort` 摘下排队项作为返回值,宿主不接住,排着的用户消息和子 agent 的通知会在用户按停止的那一刻静默消失(§1、§6.4、§6.9)。用户 2026-09-18 知悉并决定先不管;补的做法写在 §6.9。
- **确认冒泡的边角**:转后台时挂着的询问、子会话被停时的撤销、用户切走父会话时确认条的去向。P2 场景 (m) 与 P3 的界面都要覆盖。
- **三处工具清单闸门**:`TOOL_NAMES`、desktop 冒烟、bench check;+4 漏掉一处,表现和"构建产物坏了"一模一样。
- **contextBridge 会剥掉 Error**:任务相关 RPC 的失败也要走普通对象(`CLAUDE.md`「会咬人的地方」第一条)。
- **内核没有 HMR**:改完宿主要重启 `npm run dev:desktop`。
- **i18n 缺键会渲染成 `undefined`**:新文案中英两份一起加。
- **Windows 上的杀进程测试**:子 agent 被停时,它的 bash 子进程由执行环境杀树;断言"已经死了"要按 `CLAUDE.md` 的真等待来写(本机 `tools-la` 那条偶发就是这一类)。
- **JSONL 增长与事件量**:见 §8。
- **上游演进**:v2 的运行时将来会被 pico 替换。本方案只依赖 `agent-harness.ts` 的公开接口(AgentHarness / AgentLane、hooks、events、SessionRepo、custom 消息),不碰 `runtime/` 内部;pico 的 subagent 工具(run / spawn / send / status / wait / stop)与 job 完成时的 notice entry 和本方案同构,到时可以对照。
