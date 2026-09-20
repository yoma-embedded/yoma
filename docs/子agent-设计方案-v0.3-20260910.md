# 子 agent 设计方案 v0.3(v2 内核版;2026-09-10)

**取代 v0.2**(`docs/子agent-设计方案-v0.2-20260907.md`,基于 v1 内核)。目标不变——和 Claude Code 一样:**主 agent 一条消息派十几个子 agent 分头干,前台/后台都行,后台完成自动叫醒主 agent。** 变的是落点:内核从 v1(`packages/agent-legacy`)换成上游 v2 AgentHarness(`packages/agent`)。

参照物:`D:\MyCode\claude-code-sourcemap\restored-src\src\`(Claude Code 2.1.88 还原源码)+ `D:\MyCode\yoma\doc\claude-code-subagent-架构分析.zh-CN.md`。下文 "CC" = Claude Code;v2 源码路径相对 `packages/agent/src/`,行号以仓库里的副本(= 上游 `b2602be77`)为准。v2 背景与学习路线见 `D:\MyCode\yoma\yoma-pi-learn\docs\learn\01-v2与pico学习计划-20260910.md`。

**前提(2026-09-10 核实)**

- 分支 `yoma-v2`(ben,7 个提交,未合 develop):`packages/agent` = 上游 `b2602be77` 的 v2 core,90 个源文件逐字节一致,由 `upstream-lock.json` 锁定——**源码不可改,也不可往里加文件**(`npm run upstream:check` 会失败,见 `UPSTREAM.md`);`packages/agent-legacy` = v1,kernel 切换后删除;**kernel 尚未切换**,coding-agent / kernel 仍接 v1。
- 工具链是 npm + Vitest,要求 Node ≥ 22.19、npm ≥ 11。
- 本方案的 P3(宿主)建在 ben 切换后的 v2 host 上;P0 原型与 P1 不依赖切换,可以先做。
- 旧的 `subagent` 分支(停在 `d1e7825`,无提交)作废,从 `yoma-v2` 重开。

## 0. 结论(相对 v0.2)

1. **CC 的四层机制照搬,不变**:agent 定义(md + frontmatter,按名覆盖)/ `agent` 普通工具(并发、同轮扇出)/ 前台-后台-中途转后台的任务状态机 / 后台结果以 `<task-notification>` 回注主循环;外加 `task_output` / `task_stop` / `send_message` 三个配套工具。
2. **内核零改动**。v0.2 §7 的三处小改全部作废:`prompt/steer` 接收 AgentMessage——v2 原生支持;`maxTurns`——在宿主用 hook 实现(§6.6);导出 `parseFrontmatter`——在 coding-agent 自己解析(§4.2)。
3. **子 agent = 独立子会话 + 独立 v2 harness**(每个子会话只用一条 lane `main`),不做成父会话里的另一条 lane(理由 §3.1)。
4. **v2 让宿主变简单**:通知走持久化的 `steer` + 空 `prompt([])` 唤醒,不再需要内存待投递表和相位判断;自动重试、溢出压缩是内建的,不再需要 v0.2 的 `runTurn` 抽取;父的中止经工具的 `context.abortSignal` 自然传进来。
5. **v2 带来的新义务**:重启后子会话里没跑完的 operation 必须处理(本方案一律 abort),否则那条 lane 永远 busy;`harness.close()` 不是中止,LRU 只能关空闲的。
6. **yoma 特有的硬约束不变**:硬件互斥——flash / log / gdb / la / scope 是进程级全局态,十几个 agent 同时碰板子必撞。子 agent 默认拿不到硬件类工具,主 agent 是板子的唯一持有者。

## 1. v2 基线

对象模型:`SessionRepo`(`JsonlSessionRepo`)→ `Session` → `AgentHarness.create({ session, models, model, … }, ctx)` → `harness.lane("main", ctx)` → `lane.prompt / steer / abort / watch …`。每个异步方法的最后一个参数是 `Context`(无取消需求时传 `BACKGROUND_CONTEXT`);错误作为 `Result` 返回,不抛。

本方案直接用到的 v2 能力:

| 能力 | 出处 |
|---|---|
| `lane.prompt(text \| AgentMessage \| AgentMessage[])`;`steer / followUp / nextRun(string \| AgentMessage)`;`abort / resume / getResult / findEntries / inspectExecution / watch` | `harness/agent-harness.ts:538-580` |
| `AgentHarnessOptions`:`systemPrompt`、`tools`、`activeToolNames`、`model`、`thinkingLevel`、`toolContext`、`retry`、`compaction`、`steeringMode`、`toolExecution`(默认 parallel) | `harness/agent-harness.ts:518-536` |
| `AgentHarness.create` 返回 `{ harness, open }` | `harness/agent-harness.ts:614-622` |
| custom 消息 `{ role: "custom", customType, content, display, details, timestamp }`;`createCustomMessage` 从包入口导出;默认投成 user 角色 | `harness/messages.ts:31`、`:107`、`:137`;`index.ts:74` |
| 工具 `AgentHarnessTool`:`execute(toolCallId, params, onUpdate, toolContext, invocation, context)` | `harness/types.ts:108` |
| 工具 `replay?: "never" \| "safe"`:只有存储与当前声明都是 safe 才重跑;不写 = 不重跑 | `types.ts:403`、`harness/runtime/drive/tools.ts:527` |
| 工具的 `context.abortSignal` 接在 drive 的效果闸上,父被中止时触发 | `harness/execution/tools.ts:134-136` |
| 收件箱里有排队的会话内容时,空 `prompt([])` 合法(否则 `InvalidMessage`) | `harness/runtime/lane.ts:615` |
| `repo.create({ cwd, id?, parentSessionId? })`;会话头只有 id / cwd / createdAt / parentSessionId;`repo.list()` 返回的元数据带 `parentSessionId`、`path` | `harness/session/types.ts:556`、`harness/session/jsonl/types.ts:7-35` |
| 会话级值:`value<T>(namespace, key)` + `session.setValue / getValue`,从 `@earendil-works/pi-agent-core/harness/session` 导入 | `harness/session/values.ts:98`、`harness/session/types.ts:547` |
| hooks:`before_request`(带 `step`、`attempt`,首次尝试 attempt = 1)、`after_tool`(结果可带 `terminate`)、`before_tool`(可 `block: { reason, terminate }`);调用参数都带 `lane`、`runId` | `harness/agent-harness.ts:430-510`;`harness/runtime/drive/boundary.ts:71` |
| 事件:`turn_start`、`tool_update`、`run_end`、`queue_update`;`lane.watch()` 快照 + `reduceLaneSnapshot` | `harness/agent-harness.ts:255-373` |
| `formatSkillInvocation` 从包入口导出(`parseFrontmatter` 没导出) | `harness/skills.ts`、`index.ts:79` |

v2 **没有**的:`maxTurns`;会话头 metadata;`watchSession`(桩,`SliceNotImplemented`);v1 形状 `AgentTool`(4 参数)到 `AgentHarnessTool` 的适配器。

## 2. 目标:CC 能力清单,做哪些

| CC 能力 | 本期 | 说明 |
|---|---|---|
| md 定义的 agent(frontmatter 全字段,按名覆盖,内建 + 用户 + 项目) | 做 | §4 |
| `Agent` 普通工具,同一条消息里派 N 个并行 | 做 | §5.1;v2 默认并行执行同一批工具 |
| 前台(阻塞)/ 后台(立即返回)/ 中途转后台 | 做 | §6 |
| 后台完成 → `<task-notification>` 回注,主循环闲则被叫醒 | 做 | §6.4 |
| `TaskOutput`(block/timeout)/ `TaskStop` / `SendMessage`(运行中排队、停了续跑) | 做 | §5.2 |
| 工具池按 agent 重装配 + 硬黑名单 | 做 | §5.3 |
| `maxTurns` | 做 | 宿主 hook,§6.6 |
| 上下文裁剪:只读 agent 不灌项目上下文文件、子 agent 默认关思考 | 做 | profile 字段 |
| 模型继承 / 覆盖(env > 调用参数 > 定义 > inherit) | 做 | §4.4 |
| 技能预加载(frontmatter `skills`) | 做 | `formatSkillInvocation` 拼进首轮 |
| 子 agent 的 transcript 落盘、output_file、进度 | 做 | 子会话 JSONL 天然就是;进度走 `tool_update` |
| fork(继承父上下文、cache 对齐) | 后续 | `repo.fork` 是现成原语,P5 |
| `isolation: worktree` | 后续 | 固件工程多 agent 并行改代码时才需要,P5 |
| agent 私有记忆目录、SubagentStart/Stop hooks、私有 MCP、Perfetto | 不做 | |
| teammate(tmux 多进程)、coordinator、remote | 不做 | |
| 子 agent 再派子 agent | 不做 | CC 对外部用户同样禁止 |

## 3. 机制映射:CC → yoma(v2)

| CC 机制(出处) | yoma 落点(v2) | 状态 |
|---|---|---|
| 子 agent = 递归调同一个 `query()`(`runAgent.ts:236`) | 子会话自己的 v2 harness 跑 `lane.prompt()`,同一套 v2 运行时,不写第二个循环 | 已有 |
| `createSubagentContext` 逐字段裁剪(`forkedAgent.ts:345`) | 每个子会话独立的 env / session / harness,工具是 env 的闭包;要做的只有中止挂接(前台监听父工具的 `context.abortSignal`,后台独立)和任务注册表放在根(`SessionManager`) | 已有 + 小改 |
| `Agent` 是普通工具,`isConcurrencySafe: true`(`AgentTool.tsx`) | `agent` 是 `AgentHarnessTool`,`executionMode: "parallel"`;v2 并行执行同一批调用、结果按调用顺序落位(规范 §3.8) | 新建 / 扇出已有 |
| AgentDefinition:md frontmatter,按名覆盖(`loadAgentsDir.ts:193`) | `AgentProfile`;frontmatter 在 coding-agent 自己解析 | 新建 |
| 工具池重装配,不继承父的(`AgentTool.tsx` workerTools) | 按 profile 从全集重筛,作为子 harness 的 `tools` / `activeToolNames` | 新建 |
| `ALL_AGENT_DISALLOWED_TOOLS` 硬黑名单 + `ASYNC_AGENT_ALLOWED_TOOLS` 白名单(`constants/tools.ts:36`) | 硬黑名单防递归;硬件类默认不给任何子 agent(yoma 没有权限层,这是"异步白名单"的对应物) | 新建 |
| `runAgent` 逐条 yield;sidechain transcript 增量落盘;output_file | 子 lane `watch()` 的事件流;子会话 JSONL 由 v2 逐事务写入;`output_file` = 子会话文件路径(`JsonlSessionMetadata.path`) | 已有 |
| 同步:`Promise.race([iterator.next(), backgroundPromise])`(`AgentTool.tsx:867`) | `TaskManager` 的 `Promise.race([task.done, task.backgrounded$.promise])`,race promise 每个任务只建一次;转后台不重启子 agent | 新建 |
| 异步生命周期:先 `completeAsyncAgent` 再做会 hang 的收尾(`agentToolUtils.ts:508`) | 状态先落 → 提结果与 usage → 入通知 | 新建(照抄顺序) |
| `<task-notification>` 以 user-role 消息进统一命令队列(`query.ts:1569`);主循环闲时自动提交(`useQueueProcessor`) | 通知 = custom 消息(`customType: "task-notification"`,v2 默认投成 user 角色);`parentLane.steer()` 持久入队;父空闲则 `parentLane.prompt([])` 唤醒;父在跑则下一个边界自动取走 | 新建(比 v0.2 简单) |
| `TaskOutput {task_id, block=true, timeout=30000}`(`TaskOutputTool.tsx`) | `task_output` 同 schema;`result` 取子会话最后一条 assistant 文本 | 新建 |
| `TaskStop` + `notified` 原子去重(`LocalAgentTask.tsx:197`) | `task_stop` → `childLane.abort()`;`notified` 标志防双通知 | 新建 |
| `SendMessage`:运行中排队、停了从 transcript 续跑(`SendMessageTool.ts:800`) | 运行中 → `childLane.steer()`;已结束 → `childLane.prompt(message)`(harness 被淘汰就先 ensureOpen) | 新建 |
| `finalizeAgentTool`:最后一条 assistant 的 text、空结果占位句、`agentId + <usage>` 尾巴(`agentToolUtils.ts:276`) | 同款;profile `oneShot: true` 省尾巴 | 新建 |
| `maxTurns` → `max_turns_reached` | 宿主 hook 计轮,第 N 轮的工具执行完就结束运行(§6.6) | 新建(不改内核) |
| `omitClaudeMd`、不灌 gitStatus、子 agent 关思考 | `profile.omitContextFiles`;子 agent `thinkingLevel` 默认 `off` | 新建字段 |
| 模型:env > 调用参数 > 定义 > `inherit`(`utils/model/agent.ts`) | `YOMA_SUBAGENT_MODEL` > `agent` 入参 > `profile.model` > 继承父会话当前模型(§4.4) | 新建 |
| 动态 agent 列表进工具描述 | 列表进 `agent` 的 description;工具集是会话级快照,会话内不变 | 已有前提 |
| 技能预加载:每个 skill 变一条 isMeta user 消息 | `profile.skills` → `formatSkillInvocation(skill)` 拼进首轮消息 | 新建(小) |
| finally 清理:后台 shell 等 | 子会话中止 → v2 `NodeExecutionEnv` 杀进程树;完成后 harness 交给 LRU | 已有 |
| 工具描述里的"Don't peek / Don't race / 像给刚进门的同事交底 / 别把理解外包" | 逐条翻进 `agent` 的 description | 新建(文案) |

### 3.1 为什么是独立子会话,不是父会话里的 lane

v2 的设计初衷里提过"子 agent 可以用父会话的另一条 lane",但对 yoma 独立子会话更合适:

- **贴合现有模型**:桌面端是"一个会话一个 harness",v0.2 本来就把子 agent 设计成带父指针的子会话;侧边栏嵌套、打开子会话只读这些 UI 不用重想。
- **每个 profile 的提示词和工具集直接是 harness 选项**:lane 共享同一个 harness 的 `systemPrompt`(签名 `(toolContext, context)`,拿不到 lane 名),按 lane 区分只能靠 `transform_context` hook 改写;工具注册表也是 harness 级的。
- **写入不挤一条线**:同一个会话的所有写入走一条单写者队列、写同一个文件。十几个子 agent 做成 lane,就是十几路流式片段挤进同一个 JSONL,而 JSONL 不回收死字节(规范 §1.7,J1 未实现)。独立子会话各写各的文件。
- **fork 型子 agent(P5)照样能做**:`repo.fork(source, { scope: "branch", branch: "main", entryId })`。

## 4. 数据模型:AgentProfile

新文件 `packages/coding-agent/src/core/agents.ts`。

```ts
export interface AgentProfile {
  name: string;                 // = subagent_type 的取值;小写字母/数字/连字符
  description: string;          // CC 的 whenToUse,拼进 agent 工具描述
  tools?: string[];             // 白名单;undefined / ["*"] = 全给;支持 "agent(a,b)" 限定可派生类型
  disallowedTools?: string[];   // 黑名单,优先于白名单
  model?: string;               // "inherit"(默认)| "provider/model-id"
  thinkingLevel?: ThinkingLevel;// 子 agent 缺省 "off"
  maxTurns?: number;            // 缺省不限
  background?: boolean;         // true = 每次派生都后台
  omitContextFiles?: boolean;   // CC 的 omitClaudeMd
  skills?: string[];            // 预加载技能名
  initialPrompt?: string;       // 拼在首轮 user 消息前
  prompt: string;               // 系统提示词正文(md 的 body)
  oneShot?: boolean;            // 省 usage 尾巴
  source: "builtin" | "user" | "project";
  filePath?: string;
}
```

### 4.1 系统提示词:整段替换,不是追加

子 harness 的 `systemPrompt` 选项直接给 `(toolContext, ctx) => buildSystemPrompt({ customPrompt: profile.prompt, ...collectToolPromptData(selectedTools), cwd, contextFiles, skills })`——`customPrompt` 只替换正文,收尾四段(工具清单 / 项目上下文 / 技能 / cwd)仍由 `buildSystemPrompt` 统一拼。主 agent(`yoma`)不设 `prompt`,行为不变。`buildSystemPrompt` 是 coding-agent 自己的代码,host 切换时若签名变化,跟着 ben 的改动调整。

### 4.2 来源、发现、覆盖

- 内建(代码)< 用户 `~/.yoma/agents/*.md` < 项目:从 cwd **向上到 home 逐层**的 `<dir>/.yoma/agents/*.md`,外层先、内层后。同名后者覆盖前者(CC 同款)。
- **frontmatter 在 coding-agent 自己解析**:v2 的 `parseFrontmatter` 是 `harness/skills.ts` 里的私有函数,core 又不能改。写一个十几行的 `parseAgentFile()`:切出首部两个 `---` 之间的块,用 `yaml` 解析;没有 `name` 的 md 静默跳过;字段非法记 diagnostics 后忽略该字段,不拒载整个 agent。
- yoma 的技能发现刻意**不沿祖先目录找**(coding-agent `resources.ts`),agent 发现照 CC 沿祖先找——两者暂时不一致,实施时二选一定下来。
- `.yoma/.gitignore` 是黑名单式,`agents/` 不在黑名单里就随项目提交;实施前核对。

### 4.3 内建 agent

| name | 工具 | 模型 / 思考 | 提示词要点 |
|---|---|---|---|
| `yoma`(主) | 全部 + `agent` 四件 | 会话选择 | 今天的正文,不变 |
| `general` | `*` 减黑名单减硬件类 | inherit / off | CC `general-purpose`:完整完成任务,报告只给要点;别造文件、别主动写文档 |
| `explore` | read / bash / examples / toolchain / netlist / datasheet | inherit / off;`omitContextFiles`;`oneShot` | CC `Explore` 的只读提示词改写:禁止一切写操作(含重定向、临时文件);bash 只做 ls / rg / git log / cat;按调用方指定的彻底程度搜;报告直接作为回复 |
| `datasheet` | datasheet / read / examples | inherit / off;`oneShot` | yoma 特有:查手册取证,回带页码/章节引用的事实与原文摘录,不做推断 |

CC 的 `Plan` 依赖它的 plan mode,yoma 没有,不做;`general` 是缺省 `subagent_type`。

### 4.4 模型解析

`YOMA_SUBAGENT_MODEL` 环境变量 > `agent` 入参 `model` > `profile.model` > `inherit`。`inherit` = 父会话 lane 当前的 `getModel(ctx)`(用户在对话框里切过就跟着切)。指定的模型在 `models` 里找不到(provider 没配 key)→ 回落 `inherit` + 一条 `kernel.error`,派生照常。思考档位 `profile.thinkingLevel ?? "off"`,再钳到模型支持的档位。结果作为子 harness 的 `model` / `thinkingLevel` 种子选项。

### 4.5 子会话元数据(新)

v2 的会话头没有 metadata 字段(v0.2 放在 v1 会话头的 `metadata` 里)。拆成两处:

- **会话头**:`repo.create({ cwd: parent.cwd, parentSessionId: parent.id }, ctx)`——`repo.list()` 不用打开会话就能拿到父子关系,侧边栏嵌套够用。
- **会话级值**:`const SUBAGENT_META = value<SubagentMeta>("yoma.subagent")`,建会话后 `session.setValue(SUBAGENT_META, { agent, parentSessionId, toolCallId, description, background, notified }, ctx)`。会话名 = description(`harness.setName`)。

`notified` 放进会话值,是为了重启后能判断"这个子 agent 的结果有没有通知过父"(P5 补发用)。

## 5. 工具

四个工具在 `packages/coding-agent/src/core/tools/`,**直接写成 v2 原生的 `AgentHarnessTool`**——它们只会跑在 v2 上,不必经过旧工具的适配层。它们不知道怎么开会话,依赖宿主注入的接口:

```ts
export interface TaskHost {
  agents(): AgentProfile[];                                   // 可派生的 profile(mode 过滤后)
  spawn(req: SpawnRequest, signal?: AbortSignal): Promise<SpawnOutcome>;
  output(taskID: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<TaskOutputView | null>;
  stop(taskID: string): Promise<boolean>;
  send(to: string, message: string): Promise<"queued" | "resumed" | "not_found">;
}
```

宿主(`SessionManager`)实现它;`createAgentTools(host, opts)` 一次装出四件(闭包注入,不走 harness 的 `toolContext`)。四件都**不写 `replay`**(= 不重跑,§6.5)。

### 5.1 `agent`

- 入参:`description`(3–5 词)、`prompt`、`subagent_type?`(缺省 `general`)、`model?`(`provider/id`)、`run_in_background?`。不做 `name / team_name / isolation / cwd`。
- `executionMode: "parallel"`;v2 默认并行执行同一批调用、结果按调用顺序落位,同一条消息派 N 个自然成立。
- 描述文案照 CC `prompt.ts` 翻译并按嵌入式场景改例子,结构保持:可用 agent 列表(带工具)→ 何时不用(读一个已知路径、找一个 class、两三个文件内的搜索都别派)→ 使用须知(3–5 词描述;**尽量一条消息并行派多个**;结果用户看不见,要自己转述;后台会自动通知,**别 sleep、别轮询**;前台用于"下一步依赖它的结果",后台用于"真有独立的活可以同时干";续跑用 `send_message`;每次派生都是白纸,任务书要完整;说清楚要它写代码还是只研究)→ 写 prompt(像给刚进门的聪明同事交底;**别把理解外包**:要写清路径、行号、改什么)→ 后台专属两条(**Don't peek**:output_file 别去 read/tail;**Don't race**:通知是以后某一轮以 user 消息形态到达的,用户中途追问就报状态不编结果)→ 两个嵌入式例子(并行派三个 explore 分头查 clock 树 / DMA 配置 / 中断向量;后台派 datasheet 取证同时继续改代码)。
- **中止挂接**:前台时把 `context.abortSignal`(父被中止时触发)转成 `host.stop(taskID)`;转后台后解除。
- **进度**:子 agent 每做一次工具调用,调 `onUpdate({ content, details: { turns, toolUses, lastTool } })`——在父 lane 上就是一条 `tool_update` 事件,父卡片显示"N tool uses · 最近: bash"。
- 返回:
  - 前台完成 → `content` = 子 agent 最后一条 assistant 的 text 块(没有就往前找;都没有则 `(Subagent completed but returned no output.)`)+ 尾巴 `agentId: <id> (use send_message with to: '<id>' to continue this agent)\n<usage>total_tokens/tool_uses/duration_ms</usage>`;`oneShot` 的 profile 省尾巴。`details` = `{ taskID, agent, status, turns, toolUses, usage, durationMs, outputFile }`。
  - 后台 / 转后台 → `{ status: "async_launched", task_id, output_file, description }`。
  - 被停 / 失败 → `isError: true` + 部分结果。

### 5.2 `task_output` / `task_stop` / `send_message`

- `task_output { task_id, block = true, timeout = 30000 (≤ 600000) }` → `{ retrieval_status: success|timeout|not_ready, task: { task_id, status, description, prompt, result, output } }`。`result` 取子会话最后一条 assistant 文本(内存缓存;没有时 `childLane.findEntries({ type: "message", order: "newestFirst", limit }, ctx)` 往回找);`output` 在没有 result 时给子会话文件路径。尊重 abort。
- `task_stop { task_id }` → 已停 / 已完成时是 no-op;运行中 → `childLane.abort(ctx)`,状态 `killed`,带部分结果入通知(后台)或作为工具错误(前台)。
- `send_message { to, message }`:`to` 是 task_id(= 子会话 id)。运行中 → `childLane.steer(message)`,回 "Message queued for delivery to X at its next tool round";已结束 → `childLane.prompt(message)` 后台续跑(harness 被 LRU 关了先 ensureOpen),完成走通知;找不到 → 报错。

### 5.3 工具池装配:`resolveAgentTools(all, profile, isAsync)`

```
全集
 ├─① 硬黑名单(profile 无权覆盖):agent / task_output / task_stop / send_message   ← 防递归
 ├─② 硬件类(默认对所有子 agent 关闭):flash / log / gdb / la / scope             ← 硬件互斥,见 §9
 ├─③ profile.disallowedTools
 └─④ profile.tools 白名单(undefined / ["*"] = 全给);解析 "agent(a,b)" → allowedAgentTypes
```

结果作为子 harness 的 `tools` 与 `activeToolNames`——硬件类**根本不注册**进子 harness,不只是不激活。主 agent(`yoma`)不过 ①②。`isAsync` 在 yoma 里不改变工具集,保留参数以便将来区分。

## 6. 宿主:TaskManager(v2 版)

新文件 `packages/kernel/src/host/tasks.ts`,被 `SessionManager` 持有,实现 `TaskHost`。

### 6.1 状态

```ts
interface TaskState {
  id: string;                    // = 子会话 id
  parentID: string; toolCallID: string;
  agent: string; description: string; prompt: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "max_turns";
  backgrounded: boolean;         // 结果走通知而不是 tool_result
  done: Promise<TaskResult>;     // 子 lane 这一轮运行的 promise
  backgrounded$: { promise, resolve };   // 转后台信号,每任务建一次
  startedAt: number; endedAt?: number;
  result?: TaskResult;           // { text, turns, toolUses, usage, durationMs }
  notified: boolean;             // 原子去重;同时写进子会话的 yoma.subagent 值
}
```

v0.2 的 `abort: AbortController` 去掉:中止统一走 `childLane.abort(ctx)`(持久化的中止),前台期间由父工具的 `context.abortSignal` 触发。

### 6.2 spawn

1. 解析 profile(`agents()` 快照来自父会话打开时那份);`allowedAgentTypes` / 未知类型分别报 "denied / not found. Available agents: …"。
2. **建子会话**:`repo.create({ cwd: parent.cwd, parentSessionId: parent.id }, ctx)` → 写 `yoma.subagent` 会话值(§4.5)→ 会话名 = description → 发 `session.created`(视图带 `parentID`、`agent`、`task`)。
3. **装配子 harness**:`AgentHarness.create({ session, models, model, thinkingLevel, tools, activeToolNames, systemPrompt, toolContext, retry, compaction }, ctx)` → `harness.lane("main", ctx)` → `lane.watch(ctx)` 接投影器 → 注册 maxTurns 的 hooks(§6.6)。技能预加载与 `initialPrompt` 拼进首轮消息。
4. 并发上限:`maxConcurrentTasks`(默认 12,`YOMA_MAX_CONCURRENT_TASKS`),超出的排 `pending`,前一个结束再放行;对模型仍然是"已派生"。
5. `task.done = childLane.prompt(firstMessage, ctx)`,把 `RunResult` 映射成 `TaskResult`:`completed` → completed(命中 maxTurns 则 max_turns);`aborted` → killed;`failed` → failed。自动重试与溢出压缩由子 harness 的 `retry` / `compaction` 选项内建完成。
6. 前台:`agent` 工具 `await Promise.race([task.done, task.backgrounded$.promise])`;父工具的 `context.abortSignal` 触发 → `childLane.abort(ctx)`。后台:立即返回 `async_launched`,不挂父的中止;父会话按停止**不会**杀后台任务(CC:"survive ESC, killed explicitly")。
7. `done` 落地(无论前后台):**先**改 `status` → 再提结果与 usage → 前台走工具返回,后台 / 转后台走 §6.4 的通知。

### 6.3 中途转后台

UI 在父会话的 agent 卡片上按"转后台"(或 `autoBackgroundMs` 到点):`task.backgrounded = true`,解除父工具 `abortSignal` → 子中止的转发,`backgrounded$.resolve()` 让工具立即返回 `async_launched`。子 agent 本身不感知,继续跑。

### 6.4 通知投递(v2 版)

通知消息:`createCustomMessage("task-notification", xml, true, { taskID, status, usage }, Date.now())`。XML 与 CC 逐字段同形:`<task-notification><task-id/><tool-use-id/><output-file/><status/><summary/><result/><usage/></task-notification>`。v2 默认把 custom 消息投成 user 角色——这就是 CC 说的"看起来像用户消息但不是"。宿主如果自定义 `toProviderMessages`,要保留这条转换。

投递(每个父会话一个串行队列,防同一父会话并发投递):

1. 父会话的 harness 没开(被 LRU 关了)→ 先 `ensureOpen(parent)`。
2. `await parentLane.steer(message, undefined, ctx)`——v2 的 steer 空闲时也接受,内容写进父会话文件(pending entry + 收件箱),内核崩了也不丢。
3. 父 lane 空闲(`inspectExecution(ctx)` 的 `current === null`)→ `parentLane.prompt([], ctx)` 唤醒:收件箱里有排队的会话内容时空 prompt 合法,受理时取走通知。返回 `LaneBusy` 说明父已经在跑,正在跑的运行会在下一个边界取走这条 steer,不用处理。
4. 兜底:宿主监听父 lane 的 `run_end`,若快照 `queues` 非空且 lane 空闲 → `prompt([])`(覆盖"steer 恰好在运行最后一个边界之后到达"的情况)。
5. 父会话 `setSteeringMode("all", ctx)`(harness 级),多条通知在同一个边界一次插入。桌面端不用 steer 传用户输入,改这个模式没有副作用(v1 host 如此;host 切换后与 ben 确认)。
6. `notified` 原子去重:`task_stop` 已通知过的,正常完成时不再通知。

与 v0.2 的差别:不再需要内存 `pending: Map` 和按相位分三种情况——"父在压缩 / 重试退避中先攒着"由 v2 自动处理(这些时候 lane 仍在 operation 中,steer 在下一个边界被取走;独立压缩结束后,便利方法会自动续跑排队内容);v0.2 §13 "idle 时 steer 抛 invalid_state" 这条风险消失。

**已知缺口**:子 agent 完成 → 通知写进父会话之间内核崩溃,这条通知会丢(子会话结果还在)。修复路径(P5):启动时扫描已结束且 `notified = false` 的子会话,补发。

子会话**永远不接用户 prompt**:`session.prompt(childID)` 拒绝,`data._tag = "SubagentSessionError"`;续跑只经 `send_message`。

### 6.5 重启、关闭与生命周期(v2 新增)

- **子会话里没跑完的 operation**:`AgentHarness.create` 返回的 `open` 里会有它。v0.3 策略:打开子会话时对 `open` 里的 operation 一律 `lane.abort(ctx)`,任务状态记 `killed`——语义同 v0.2"应用退出,任务一起死";之后可 `send_message` 续跑。不处理的话那条 lane 一直 busy,`prompt` 永远得到 `LaneBusy`。
- **父会话里前台 `agent` 调用**:工具没声明 `replay`(= 不重跑),父 operation 恢复时这个调用得到一条"被中断"的合成错误结果,父继续跑;子会话按上一条处理。
- **以后(P5)**:`agent` 工具改 `replay: "safe"`,派生时 `invocation.setMemo("child", childSessionId)`;重启后重放时读 memo 找到子会话,`resume()` 重新挂接(pico `run` 子 agent 的恢复语义)。
- **LRU**:`harness.close()` 是受控崩溃,不中止任何东西;只关空闲会话,运行中的子会话不淘汰。父闲着被淘汰没关系,投递前 `ensureOpen`。`MAX_LIVE_SESSIONS` 建议从 8 提到 32。
- **级联删除**:删父会话时,按 `parentSessionId` 从 `repo.list()` 找出子会话 → 关掉它们的 harness → `repo.delete(meta)`(v2 拒绝删除打开着的会话)。

### 6.6 maxTurns(宿主实现,不改内核)

在子 harness 上注册(`max` = profile 的 `maxTurns`):

```ts
const turns = new Map<string, number>(); // runId → 已开始的 assistant 轮数
harness.hooks.on("before_request", (e) => {
  if (e.step === "assistant" && e.attempt === 1) turns.set(e.runId, (turns.get(e.runId) ?? 0) + 1);
  return undefined;
});
harness.hooks.on("after_tool", (e) => ((turns.get(e.runId) ?? 0) >= max ? { terminate: true } : undefined));
harness.hooks.on("before_tool", (e) =>
  (turns.get(e.runId) ?? 0) > max ? { block: { reason: "max turns reached", terminate: true } } : undefined,
);
```

- 语义:第 N 轮的工具执行完后不再请求模型,运行以 `completed` 结束——与 v1 `shouldStopAfterTurn` 一致;宿主据计数把任务状态记为 `max_turns`。
- v2 的规则是本批**每个**调用都带 `terminate` 才停(规范 §3.8)。被别的 hook 拦下的调用或未知工具不经过 `after_tool`,所以加 `before_tool` 兜底:万一进了第 N+1 轮,直接全部拦下并终止。
- `attempt` 从 1 开始(`harness/runtime/drive/boundary.ts:71`),重试的 attempt ≥ 2,不重复计数。

## 7. 内核 `packages/agent`:零改动

| v0.2 §7 | v0.3 |
|---|---|
| ① `prompt()/steer()` 接受 AgentMessage | v2 原生支持(`harness/agent-harness.ts:550-564`) |
| ② `maxTurns` → `shouldStopAfterTurn` | 宿主 hook(§6.6) |
| ③ 导出 `parseFrontmatter` | coding-agent 自己解析(§4.2) |

core 由 `upstream-lock.json` 锁定。以后确实需要改 core,先按 `UPSTREAM.md` 建立自有补丁流程,不在本方案范围。

## 8. 协议与 UI

- `types.ts`:`Session` 加 `parentID?`、`agent?`、`task?: { status, description }`;`TOOL_NAMES` 加 `agent / task_output / task_stop / send_message`;`ToolDetailsMap` 加四份 details;`SubagentSessionError`。
- `protocol.ts`:`session.create` 加 `agent?`;新增 `agent.list`、`task.list`、`task.stop`、`task.background`;新增事件 `task.updated { task }`(任务面板与卡片状态都靠它,不复用 `session.status`——子会话的 busy/idle 与任务的 pending/killed 不是一回事)。
- 投影器(ben 切换后的 v2 版):
  - 处理 `tool_update`——`agent` 工具的进度靠它;v2 快照里 `operation.runningTools[].result` 就是最新进度;
  - `task-notification` 的 custom 消息投成专门的 part(不是普通气泡);
  - 宿主自起的一轮(通知唤醒)没有 renderer 铸的用户消息 id,要确认新投影器不会把它当成"乐观插入未匹配"。
- session-ui:`agent-tool.tsx` 卡片(agent 名、description、状态、进度、按钮:打开子会话 / 转后台 / 停止);通知 part 样式;侧边栏按 `parentSessionId` 嵌套;子会话页只读并显示"子 agent 会话不能直接对话";任务面板列全部后台任务。

## 9. 并发与资源(十几个 agent 同时跑时会碰到的)

- **硬件类工具**:probe 租约 / gdb 会话表 / log 采集是模块级全局(实测撞过 `0xe00002c5`)。子 agent 默认拿不到 §5.3 ②那五个;要放开需要 profile `hardware: true` + 进程级资源互斥(按探针 / 串口 key),P5。
- **文件写入**:`withFileMutationQueue` 按规范路径串行,十几个 agent 改不同文件互不影响,改同一文件排队——但语义冲突挡不住,这正是 CC 用 worktree 隔离的场景,P5。
- **provider 限流**:十几路并发流打同一家;每个子 harness 的 `retry` 内建指数退避;`maxConcurrentTasks` 是主闸。
- **单写者**:每个会话一条写队列;子会话各自一个文件,子 agent 之间不抢写。
- **存储增长(新)**:v2 的 JSONL 不回收死字节——流式片段(每个流事件一行)、工具 checkpoint 都留在文件里。十几个子 agent 并行时,总磁盘占用涨得快。存储后端(JSONL / SQLite)随 host 切换和 ben 一起定;SQLite 后端用 `node:sqlite`、要求 Node ≥ 22.19,需确认 Electron 42 自带的 Node 版本(`ELECTRON_RUN_AS_NODE=1 npx electron -p process.versions.node`),且该包尚未 vendor。
- **事件风暴**:十几个子会话同时流 delta,renderer 的 store 会把所有子会话的消息都留在内存。v1.5 加 `session.watch/unwatch`,宿主只给"被看着的"会话转发消息事件,没被看着的只发状态。
- **子进程**:每个子 agent 的 bash 各自起进程,中止各自杀树(v2 `NodeExecutionEnv`)。
- **cache**:子 agent 与父的系统提示不同,不共享前缀缓存;fork 型才共享,P5。

## 10. 决策

| # | 事项 | v0.3 结论 | 相对 v0.2 |
|---|---|---|---|
| 1 | 并行 | 默认并行,上限 12 可配 | 不变 |
| 2 | 子 agent 碰硬件 | 默认不能;`hardware: true` + 互斥锁留 P5 | 不变 |
| 3 | 轮数上限 | 默认不限,profile 可设;宿主 hook 实现 | 实现方式变 |
| 4 | 子会话直接对话 | 不能;续跑走 `send_message` | 不变 |
| 5 | 费用归属 | 通知与工具结果带 usage;会话级汇总后议 | 不变 |
| 6 | agent 文件位置 | `.yoma/agents/`,cwd 向上到 home 逐层;技能发现要不要同步改,一并定 | 不变 |
| 7 | 工具名 | `agent` + `subagent_type`;配套 `task_output / task_stop / send_message` | 不变 |
| 8 | 子 agent 思考档 | 默认 `off`;profile 可开 | 不变 |
| 9 | 缺省 subagent_type | `general` | 不变 |
| 10 | 子 agent 的承载 | 独立子会话 + 独立 v2 harness | 新 |
| 11 | 内核改动 | 零 | 新 |
| 12 | 通知投递 | 持久化 steer + 空 prompt 唤醒 + `run_end` 兜底 | 新 |
| 13 | 重启 | 子会话里没跑完的 operation 一律 abort;`agent` 工具不重跑 | 新 |
| 14 | 工具写法 | v2 原生 `AgentHarnessTool` | 新 |
| 15 | 子会话元数据 | 会话头 `parentSessionId` + 会话值 `yoma.subagent` | 新 |

## 11. 要和 ben 对齐的事项

1. **分工与先后**:P3 建在 host 切换之后;切换何时合入。
2. **host 形态**:是否仍是"一个会话一个 harness"、`SessionRepo` 谁持有、`ensureOpen` / LRU 在 v2 下怎么实现——本方案 §6 按"一个会话一个 harness"写。
3. **现有 20 个工具的迁移方式**(适配器,还是改写成 `AgentHarnessTool`)——四个新工具已是 v2 原生,不受影响;coding-agent 需要依赖 `@earendil-works/pi-agent-core`。
4. **重试 / 压缩**:用 v2 内建,还是保留 `host/retry.ts`、`host/compaction.ts`——子 agent 默认用内建。
5. **启动时 `open` 的处理**:主会话 resume 还是 abort;子会话按本方案一律 abort。
6. **新投影器**:`tool_update`、custom 消息 part、宿主自起一轮的消息 id。
7. **父会话发新消息时会不会先中止当前轮**(v1 host 的行为):若保留,前台子 agent 会随父一起被中止(CC 同款:ESC 杀同步子 agent),UI 要让用户看得出"再发消息会中断前台子 agent"。
8. **存储后端**(§9)。
9. (与子 agent 无关,但同在切换里)旧会话导入:v1 做过树导航的会话有 `leaf` 行,v2 导入器会报 `Unsupported legacy v3 record type`(`harness/session/jsonl/legacy-v3.ts:186`);旧会话头的 metadata 不保留;第一次写入就原地改成 format 4,旧内核读不了。本机 2026-09-10 的 20 个旧会话(正式版 11 + 开发版 9)都是 v3 头、都没有 `leaf` 行。

## 12. 分期与验证

环境:Node ≥ 22.19、npm ≥ 11;`npm test` = `vitest run`,单文件 `npx vitest run <路径>`;类型检查 `npm run typecheck`。

**P0 原型(不等 ben,约 1 天)**:新文件 `packages/kernel/src/host/subagent-spike.test.ts`(给 kernel 加 `"@earendil-works/pi-agent-core": "*"` 依赖),faux 模型,不接桌面端,验证 v2 上的机制:

- (a) 父工具里 `repo.create` + `AgentHarness.create` + `childLane.prompt()`,拿到最后一条 assistant 文本;
- (b) 后台:子完成后 `parentLane.steer(custom 通知)` + `prompt([])` 唤醒,父会话出现 custom 条目,LLM 侧是 user 角色;
- (c) 父 `abort` → 前台子 agent 经 `context.abortSignal` 被中止;
- (d) `send_message` 运行中 / 已结束两个分支;`task_stop`;
- (e) maxTurns:`max = 2` 时第 2 轮的工具执行完即结束,状态可判为 max_turns;
- (f) 关掉子会话的 harness(`close`)再重开:`open` 里有那条 operation,`abort` 后 lane 恢复可用。

注意:每个 harness 用自己的 `createModels()` + `fauxProvider()`(v0.2 说的"faux 共享队列"问题随之消失);**不要放在 `packages/agent/` 下**(锁定目录)。原型的结论写回本文档;P3 时转成正式测试或删除。

**P1 coding-agent(不等 ben)**:`core/agents.ts`(类型、内建四份、发现/合并、frontmatter 解析、`resolveAgentTools`)+ `core/tools/{agent,task-output,task-stop,send-message}.ts` + `createAgentTools(host)`。测试用假 `TaskHost`:agent 列表与描述、黑名单/硬件类/白名单/`agent(a,b)`、前台/后台/被停三种结果映射、`oneShot` 省尾巴、空结果占位、`task_output` 的 block/timeout、`send_message` 三个分支、前台时 `context.abortSignal` 的转发。验证:`npx vitest run packages/coding-agent/test/agents.test.ts packages/coding-agent/test/agent-tools.test.ts` + `npm run typecheck`。

**P2 内核**:取消(零改动)。

**P3 kernel host(ben 的 host 切换合入后)**:`tasks.ts` + `SessionManager` 改造(§6)。`host.test.ts`(faux)场景:

- (a) 一条消息派 3 个 `explore` 并行,3 个 `session.created` 带 parentID,父卡片 3 张 completed,父最后一条 assistant 出现;
- (b) `run_in_background` → 父本轮立即结束 idle → 子完成后父被叫醒新一轮,通知在父会话里是 custom 条目;
- (c) 父忙时子完成 → 通知经 steer 在下一个边界插入,父不多起一轮;
- (d) `task_stop` → 通知 status killed、带部分结果、不重复通知;
- (e) `send_message` 到运行中的子 → 子 transcript 出现该消息;到已完成的子 → 续跑并再通知;
- (f) `maxTurns: 2` → status max_turns;
- (g) `maxConcurrentTasks: 2` 派 3 个 → 第三个 pending,直到有人完成;
- (h) 重开子会话,工具集 = profile 的子集且不含硬件类;
- (i) 模拟内核重启:前台子 agent 跑到一半,关掉全部 harness 再打开 → 父拿到"被中断"的工具结果,子会话的 operation 被 abort,状态 killed;
- (j) 通知已 steer 进父会话、还没被取走时重启 → 重开父会话后通知仍在收件箱,唤醒后被消费。

faux:每个 harness 一份 provider,并行子 agent 的回复互不干扰。

**P4 协议 + UI**:§8。验证:kernel / session-ui / app 单测;桌面端冒烟与 e2e(按 `yoma-v2` 的 `CLAUDE.md` 命令表,工具数 +4,`CLAUDE.md` 同步);worktree 里跑 e2e 前先确认 Electron 二进制可用。

**P5(后续)**:fork 型子 agent(`repo.fork`)、`isolation: worktree`、`hardware: true` + 资源互斥、`agent` 工具 `replay: "safe"` + memo 重新挂接、启动时补发未通知的结果、`session.watch` retain 门、agent 记忆目录。

## 13. 改动清单

| 包 | 文件 | 改动 |
|---|---|---|
| agent(v2 core) | — | **不改** |
| coding-agent | `src/core/agents.ts`(新) | AgentProfile、内建、发现/合并、frontmatter 解析、`resolveAgentTools` |
| coding-agent | `src/core/tools/{agent,task-output,task-stop,send-message}.ts`(新)、`tools/index.ts`、`src/index.ts` | 四件工具(`AgentHarnessTool`)与 `createAgentTools`;不进默认工具集(要注入 host) |
| coding-agent | `package.json` | 依赖 `@earendil-works/pi-agent-core`(若 ben 切换时还没加) |
| coding-agent | `test/agents.test.ts`、`test/agent-tools.test.ts`(新) | |
| kernel | `package.json`、`src/host/subagent-spike.test.ts`(P0,新;P3 时转正或删) | |
| kernel | `src/host/tasks.ts`(新) | TaskManager:状态机、spawn、race、通知投递、send/stop/output、重启处理、maxTurns hooks |
| kernel | `src/host/session-manager.ts` | 子 harness 装配、子会话元数据、steering 模式、级联删、拒 prompt、`open` 处理 |
| kernel | `src/host/index.ts`、`src/protocol.ts`、`src/types.ts`、`src/host/details-check.ts` | 新 RPC / 事件 / 视图字段 / details |
| kernel | `src/host/host.test.ts`、`tool-names.test.ts` | P3 的十个场景 |
| session-ui | `src/components/agent-tool.tsx`(新)+ story、通知 part、渲染表 | |
| app | 侧边栏嵌套、子会话只读、任务面板、i18n | |
| desktop | 冒烟脚本、`CLAUDE.md` 命令表 | 工具数 +4 |

## 14. 风险与坑

- **没处理的 `open`** → 那条 lane 永远 `LaneBusy`。
- **`close()` ≠ 中止**:LRU 关掉一个 busy 的 harness,operation 会一直开着,等下次打开时出现在 `open` 里。
- **唤醒撞上 `LaneBusy`** 是正常情况,不要当错误上报。
- **通知丢失窗口**:子完成到通知写入父会话之间内核崩溃(§6.4)。
- **锁定目录**:原型、测试、注释副本都不要放进 `packages/{agent,ai,chord,telemetry}`,`upstream:check` 会失败。
- **JSONL 增长**(§9)。
- **host 切换带来的未知**:通知唤醒的新一轮与投影器的消息 id、父会话输入是否先中止当前轮(§11 第 6、7 条)。
- **上游演进**:v2 的运行时将来会被 pico 替换。本方案所有逻辑放在 coding-agent / kernel,只依赖 v2 的公开接口(`agent-harness.ts` 的 AgentHarness / AgentLane、hooks、events、`SessionRepo`),不碰 `runtime/` 内部,换底座时迁移面最小。pico 的 subagent 工具(run / spawn / send / status / wait / stop)与 job 完成时的 notice entry 和本方案同构,到时可对照。
- **沿用 v0.2 的坑**:`TOOL_NAMES` 闸门、冒烟工具计数、contextBridge 剥 Error、内核进程无 HMR、`.yoma/.gitignore` 黑名单;agent 列表只在会话打开时算一次(将来热重载 agent 定义时,别动已开会话的工具描述,否则 bust cache);十几个子会话的 JSONL 让 `session.list` 变慢(O(文件数)),按 `parentSessionId` 折叠时顺手做懒加载。
