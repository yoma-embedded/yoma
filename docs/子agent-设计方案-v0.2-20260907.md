# 子 agent 设计方案 v0.2(照 Claude Code 形态,并行优先;2026-09-07)

取代 v0.1(2026-09-06)。v0.1 的"现状分析"(§1)仍然成立,这里只压缩保留;设计部分整体重写:
**目标从"能委派"改成"和 Claude Code 一样:主 agent 一条消息派十几个子 agent 分头干,前台/后台都行,后台完成自动叫醒主 agent"。**

参照物:`D:\MyCode\claude-code-sourcemap\restored-src\src\`(Claude Code 2.1.88 还原源码)+
`D:\MyCode\yoma\doc\claude-code-subagent-架构分析.zh-CN.md`(另一会话的分析)。下文 "CC" = Claude Code。

worktree:`D:\MyCode\yoma\yoma-pi-subagent`(分支 `subagent`,自 develop d1e7825)。

## 0. 结论

1. **CC 的核心形态 yoma 已经具备大半,而且有两处比 CC 更顺手。** CC 说"子 agent = 递归调同一个 `query()` + 一份逐字段裁剪的
   `ToolUseContext`",裁剪表是它全部技术含量;yoma 里每个会话本来就是独立的 `NodeExecutionEnv` + `Session` + `AgentHarness` +
   `SessionProjection`,工具是 env 的闭包,**没有需要裁剪的共享 context**——共享的只剩 `models` 注册表和进程级硬件全局态。
   CC 的"转后台要重跑 runAgent"在 yoma 里不需要:子 harness 从第一秒就是独立的,转后台只是换 abort 源和结果去向。
2. **CC 的四层机制照搬**:agent 定义(md + frontmatter,按名覆盖)/ `agent` 普通工具(并发安全,同轮扇出)/
   前台-后台-中途转后台的任务状态机 / 后台结果以 user-role 的 `<task-notification>` 消息回注主循环,主循环忙则在下一次模型调用前插入、
   闲则被叫醒开新一轮。外加 `task_output` / `task_stop` / `send_message` 三个配套工具。
3. **内核 `packages/agent` 要动三处小地方**(v0.1 说的"几乎不动"作废,但都是十几行):`prompt()/steer()` 接受现成的 AgentMessage
   (通知要以 custom 角色进会话,不能伪装成用户打的字)、`maxTurns`(接到循环已有的 `shouldStopAfterTurn`)、导出 `parseFrontmatter`。
4. **yoma 特有的一条硬约束不能照搬 CC**:CC 的"异步白名单"是因为后台 agent 弹不了权限框;yoma 没有权限,对应的约束是**硬件互斥**
   ——flash/log/gdb/la/scope 是进程级全局态,十几个 agent 同时碰板子必撞。所以子 agent 默认拿不到硬件类工具,主 agent 是板子的唯一持有者。

## 1. 现状(压缩自 v0.1 §1)

- 内核没有 agent 身份。persona 是 `packages/coding-agent/src/core/system-prompt.ts:111` 的字面量;工具固定 14 个
  (`core/tools/index.ts:259-291`);模型按会话选(`model_change` 条目);权限系统 2026-08-10 删除;会话是平的,视图 `Session` 无 `parentID`。
- 两个宿主各装配一遍 harness:桌面端 `packages/kernel/src/host/session-manager.ts:466-581`(`ensureOpen`),
  Zed 的 `packages/coding-agent/src/acp/agent.ts:403-472`(`setupSession`)。
- 现成但没人用的机制:`BuildSystemPromptOptions.customPrompt / appendSystemPrompt`;会话头 `parentSession` + `metadata`
  (`jsonl-storage.ts:14-22`);`JsonlSessionRepo.fork()`;harness 的 `steer / followUp / nextTurn` 三条队列
  (`agent-harness.ts:769-784`);循环的并行工具执行(`agent-loop.ts:498-562`)与 `shouldStopAfterTurn`(`types.ts:213`,harness 没接)。
- 投影器不投 `tool_execution_update`(`session-manager.ts:656-657` 只处理 `tool_execution_start`),父卡片上看不到工具内的进度。

## 2. 目标:CC 能力清单,做哪些

| CC 能力 | v1 | 说明 |
|---|---|---|
| md 定义的 agent(frontmatter 全字段,按名覆盖,内建 + 用户 + 项目) | 做 | §4 |
| `Agent` 普通工具,同一条消息里派 N 个并行 | 做 | §5.1;循环已支持扇出 |
| 前台(阻塞)/ 后台(立即返回)/ 中途转后台 | 做 | §6 |
| 后台完成 → `<task-notification>` user-role 消息回注,主循环闲则被叫醒 | 做 | §6.4 |
| `TaskOutput`(block/timeout)/ `TaskStop` / `SendMessage`(运行中排队、停了续跑) | 做 | §5.2 |
| 工具池按 agent 重装配 + 硬黑名单 | 做 | §5.3 |
| `maxTurns` | 做 | 内核小改 |
| 上下文裁剪:只读 agent 不灌项目上下文文件、子 agent 默认关思考 | 做 | profile 字段 |
| 模型继承 / 覆盖(env > 调用参数 > 定义 > inherit) | 做 | §4.3 |
| 技能预加载(frontmatter `skills`) | 做 | 一行:`formatSkillInvocation` 拼进首轮 |
| 子 agent 的 transcript 落盘、output_file、进度 | 做 | 子会话 JSONL 天然就是 |
| fork(继承父上下文、cache 对齐) | 后续 | `JsonlSessionRepo.fork()` 是现成原语,P5 |
| `isolation: worktree` | 后续 | 固件工程多 agent 并行改代码时才需要,P5 |
| agent 私有记忆目录(`memory`)、SubagentStart/Stop hooks、私有 MCP、Perfetto | 不做 | yoma 无 hooks/MCP 体系 |
| teammate(tmux 多进程)、coordinator、remote | 不做 | 分析报告也不建议抄 |
| 子 agent 再派子 agent | 不做 | CC 对外部用户同样禁止(`ALL_AGENT_DISALLOWED_TOOLS` 含 Agent) |

## 3. 机制映射表:CC → yoma

| CC 机制(出处) | yoma 落点 | 状态 |
|---|---|---|
| 子 agent = 递归调同一个 `query()`(`runAgent.ts:236`) | 子会话自己的 `AgentHarness.prompt()` 跑同一个 `runAgentLoop`,不写第二个循环 | 已有 |
| `createSubagentContext` 逐字段裁剪(`forkedAgent.ts:345`) | 每会话独立 env/session/harness/projection,工具闭包在 env 上;要做的只有 abort 挂接(同步挂父工具的 signal,异步独立)和任务注册表放在根(`SessionManager`) | 已有 + 小改 |
| `Agent` 是普通工具,`isConcurrencySafe: true`(`AgentTool.tsx`) | `agent` 是普通 `ToolDefinition`,`executionMode: "parallel"`;循环的 `executeToolCallsParallel` 负责同轮扇出、按源序回填 | 新建工具 / 扇出已有 |
| AgentDefinition:md frontmatter,六层按名覆盖(`loadAgentsDir.ts:193`) | `AgentProfile`:内建 < `~/.yoma/agents` < `<cwd>` 向上到 home 每层的 `.yoma/agents`;无 `name` 的 md 静默跳过;非法字段记 diagnostics 不拒载 | 新建 |
| 工具池重装配,不继承父的(`AgentTool.tsx` workerTools) | `assembleHarness(entry, profile)` 从全集按 profile 重筛,父的限制不传染 | 新建 |
| `ALL_AGENT_DISALLOWED_TOOLS` 硬黑名单 + `ASYNC_AGENT_ALLOWED_TOOLS` 白名单(`constants/tools.ts:36`) | 硬黑名单 `{agent, task_output, task_stop, send_message}`(防递归);**硬件类** `{flash, log, gdb, la, scope}` 默认不给任何子 agent(yoma 没有权限层,这是"异步白名单"的对应物) | 新建 |
| `runAgent` 生成器逐条 yield;sidechain transcript 增量落盘;output_file 软链到 transcript(`runAgent.ts` §7.4) | 子 harness `subscribe()` 事件流 + 子会话 JSONL 追加写;`output_file` = 子会话文件路径 | 已有 |
| 同步:`Promise.race([iterator.next(), backgroundPromise])`,2 s 后显示"可转后台"(`AgentTool.tsx:867`) | `TaskManager.runSync`:`Promise.race([task.done, task.backgrounded])`,race promise 每任务建一次;转后台不重启子 agent,只换 abort 源 + 结果改走通知 | 新建 |
| 异步生命周期:先 `completeAsyncAgent` 再做会 hang 的收尾(`agentToolUtils.ts:508`,gh-20236) | `runTask`:状态先落 → 提结果/usage → 入通知;`task_output(block)` 只看状态 | 新建(照抄顺序) |
| `<task-notification>` XML 以 user-role 消息进统一命令队列;主线程只 drain 无 agentId 的;子 agent 只 drain 给自己的(`query.ts:1569`) | 通知 = `custom` 消息(`customType: "task-notification"`,`convertToLlm` 投成 user 角色,`messages.ts:132-140`);父忙 → `harness.steer()`(下一次模型调用前插入);父闲 → 宿主起新一轮;子会话永远收不到用户 prompt | 新建 + 内核小改 |
| 主循环闲时自动提交队列(`REPL.tsx` `useQueueProcessor`) | `SessionManager.deliverNotifications(parentID)`:idle 即起轮,busy 即 steer,compacting/重试退避中先攒着、回到 idle 时冲 | 新建 |
| `TaskOutput {task_id, block=true, timeout=30000}`(`TaskOutputTool.tsx`) | `task_output` 同 schema;`result` 取内存里的最后一条 assistant 文本,不是整份 transcript | 新建 |
| `TaskStop` + `notified` 原子去重(`LocalAgentTask.tsx:197`) | `task_stop` → `abort(child)`;`notified` 标志防"停了又完成"双通知;被停也带部分结果 | 新建 |
| `SendMessage`:运行中 → 排队到"下个工具轮";停了 / 已淘汰 → 从 transcript 续跑(`SendMessageTool.ts:800`,`resumeAgent.ts`) | `send_message`:运行中 → 子 `harness.steer()`(yoma 的 steer 语义正好就是"下个工具轮");停了 → `ensureOpen(child)` + 后台 `runTurn`,agent 类型从会话头 `metadata.agent` 找回 | 新建 |
| `finalizeAgentTool`:最后一条 assistant 的 text,没有就回溯;空结果占位句;`agentId + <usage>` 尾巴,one-shot(Explore/Plan)省尾巴(`agentToolUtils.ts:276`) | 同款;profile `oneShot: true` 省尾巴 | 新建 |
| `maxTurns` → `query()` 吐 `max_turns_reached` 后返回 | `AgentHarnessOptions.maxTurns` → `createLoopConfig` 接 `shouldStopAfterTurn`;`TaskResult.status = "max_turns"` | 内核小改 |
| `omitClaudeMd`(Explore/Plan 不灌 CLAUDE.md,省 5–15 Gtok/周)、不灌 gitStatus、子 agent `thinkingConfig: disabled` | `profile.omitContextFiles` 跳过 `loadContextFiles`;yoma 提示词本无 gitStatus;子 agent `thinkingLevel` 默认 `off` | 新建字段 |
| 模型:`CLAUDE_CODE_SUBAGENT_MODEL` > 调用参数 > 定义 > `inherit`(`utils/model/agent.ts`) | `YOMA_SUBAGENT_MODEL` > `agent` 入参 `model` > `profile.model` > 继承父会话当前 model;目标 provider 没配 key 就回落继承并发 `kernel.error`,不让派生失败 | 新建 |
| 动态 agent 列表进工具描述曾占全机队 10.2% cache_creation,改走 attachment(`prompt.ts`) | 列表进 `agent` 的 description;yoma 工具集是会话级快照,会话内不变,不会中途 bust;不做 attachment 通道 | 已有前提 |
| 技能预加载:每个 skill 变一条 isMeta user 消息(§7.3) | `profile.skills` → `formatSkillInvocation(skill)` 拼进首轮消息 | 新建(小) |
| finally 清理:MCP/hooks/文件缓存/todos/后台 shell(§7.5) | 子会话 abort → `NodeExecutionEnv` 杀进程树;yoma 无后台 bash、无 todos;完成后 harness 交给 LRU | 已有 |
| 工具描述里的"Don't peek / Don't race / 写 prompt 像给刚进门的同事交底 / 别把理解外包"(`prompt.ts`) | 逐条翻进 `agent` 的 description 与 promptGuidelines | 新建(文案) |

## 4. 数据模型:AgentProfile

新文件 `packages/coding-agent/src/core/agents.ts`。

```ts
export interface AgentProfile {
  name: string;                 // = subagent_type 的取值;小写字母/数字/连字符
  description: string;          // CC 的 whenToUse,拼进 agent 工具描述
  tools?: string[];             // 白名单;undefined / ["*"] = 全给;支持 "agent(a,b)" 限定可派生类型
  disallowedTools?: string[];   // 黑名单,优先于白名单
  model?: string;               // "inherit"(默认)| "provider/model-id"
  thinkingLevel?: ThinkingLevel;// CC 的 effort;子 agent 缺省 "off"
  maxTurns?: number;            // 缺省不限(CC 同款)
  background?: boolean;         // true = 每次派生都后台
  omitContextFiles?: boolean;   // CC 的 omitClaudeMd
  skills?: string[];            // 预加载技能名
  initialPrompt?: string;       // 拼在首轮 user 消息前
  prompt: string;               // 系统提示词正文(md 的 body)
  oneShot?: boolean;            // 省 usage 尾巴(CC 的 ONE_SHOT_BUILTIN_AGENT_TYPES)
  source: "builtin" | "user" | "project";
  filePath?: string;
}
```

### 4.1 系统提示词:整段替换,不是追加

CC 的子 agent 系统提示 = agent 自己的 `getSystemPrompt()`(不是主 agent 的正文 + 一段角色),再由外层拼上 env 细节。
yoma 照做:`buildSystemPrompt({ customPrompt: profile.prompt, ...collectToolPromptData(selectedTools), cwd, contextFiles, skills })`
——`customPrompt` 只替换正文,收尾四段(工具清单 / 项目上下文 / 技能 / cwd)仍由 `buildSystemPrompt` 统一拼(`system-prompt.ts:64-66` 的注释正是为此留的)。
主 agent(`yoma`)不设 `prompt`,走默认正文,行为逐字节不变。

### 4.2 来源、发现、覆盖

- 内建(代码)< 用户 `~/.yoma/agents/*.md` < 项目:从 cwd **向上到 home 逐层**的 `<dir>/.yoma/agents/*.md`,外层先、内层后。
  同名后者覆盖前者(项目里放一个 `name: explore` 就顶掉内建的,CC 同款)。
- 解析复用 `packages/agent/src/harness/skills.ts` 的 `parseFrontmatter`(导出即可)。没有 `name` 的 md **静默跳过**(目录里常有说明文档);
  字段非法记 diagnostics 后忽略该字段,不拒载整个 agent(CC:`parseAgentFromMarkdown` 同策略)。
- 注意:yoma 的技能发现刻意**不沿祖先目录找**(`resources.ts:78-84`)。agent 这里照 CC 沿祖先找,两者暂时不一致,实施时二选一定下来。
- `.yoma/.gitignore` 是黑名单式(`ensureYomaDir`),`agents/` 不在黑名单里就随项目提交;实施前核对。

### 4.3 内建 agent

| name | 工具 | 模型 / 思考 | 提示词要点 |
|---|---|---|---|
| `yoma`(主) | 全部 + `agent` 四件 | 会话选择 | 今天的正文,不变 |
| `general` | `*` 减黑名单减硬件类 | inherit / off | CC `general-purpose`:完整完成任务,报告只给要点;别造文件、别主动写文档 |
| `explore` | read / bash / examples / toolchain / netlist / datasheet | inherit / off;`omitContextFiles`;`oneShot` | CC `Explore` 的只读提示词改写:禁止一切写操作(含重定向、临时文件);bash 只做 ls/rg/git log/cat;按调用方指定的彻底程度搜;报告直接作为回复 |
| `datasheet` | datasheet / read / examples | inherit / off;`oneShot` | yoma 特有:查手册取证,回带页码/章节引用的事实与原文摘录,不做推断 |

CC 的 `Plan` 依赖它的 plan mode,yoma 没有,不做;`general` 是缺省 `subagent_type`。

### 4.4 模型解析

`YOMA_SUBAGENT_MODEL` 环境变量 > `agent` 入参 `model` > `profile.model` > `inherit`。
`inherit` = 父会话 harness 当前的 `getModel()`(用户在对话框里切过就跟着切,CC issue #30815 的教训)。
指定的模型在 `models` 注册表里找不到(provider 没配 key)→ 回落 `inherit` + 一条 `kernel.error`,派生照常。
思考档位:`profile.thinkingLevel ?? "off"`,再经 `clampThinkingLevel` 钳到模型支持的表。

## 5. 工具

四个工具都在 `packages/coding-agent/src/core/tools/`,形状是普通 `ToolDefinition`;它们不知道怎么开会话,
依赖宿主注入的一个接口:

```ts
export interface TaskHost {
  agents(): AgentProfile[];                                   // 可派生的 profile(mode 过滤后)
  spawn(req: SpawnRequest, signal?: AbortSignal): Promise<SpawnOutcome>;
  output(taskID: string, block: boolean, timeoutMs: number, signal?: AbortSignal): Promise<TaskOutputView | null>;
  stop(taskID: string): Promise<boolean>;
  send(to: string, message: string): Promise<"queued" | "resumed" | "not_found">;
}
```

宿主(`SessionManager`)实现它;ACP 适配器以后也可以。`createAgentTools(host, opts)` 一次装出四件。

### 5.1 `agent`

- 入参:`description`(3–5 词)、`prompt`、`subagent_type?`(缺省 `general`)、`model?`(`provider/id`)、`run_in_background?`。
  不做 `name / team_name / isolation / cwd`。
- `executionMode: "parallel"`。
- 描述文案照 CC `prompt.ts` 翻译并按嵌入式场景改例子,结构保持:可用 agent 列表(带工具)→ 何时不用(读一个已知路径、找一个 class、
  两三个文件内的搜索都别派)→ 使用须知(3–5 词描述;**尽量一条消息并行派多个**;结果用户看不见,要自己转述;后台会自动通知,
  **别 sleep、别轮询**;前台用于"下一步依赖它的结果",后台用于"真有独立的活可以同时干";续跑用 `send_message`;
  每次派生都是白纸,任务书要完整;说清楚要它写代码还是只研究)→ 写 prompt(像给刚进门的聪明同事交底:目标与原因、已排除什么、
  周边背景、要短回复就说;**别把理解外包**:不许写"根据你的发现修掉它",要写清路径、行号、改什么)→
  后台专属两条(**Don't peek**:结果里的 output_file 别去 read/tail;**Don't race**:通知是以后某一轮以 user 消息形态到达的,不是你写的,
  用户中途追问就报状态不编结果)→ 两个嵌入式例子(并行派三个 explore 分头查 clock 树 / DMA 配置 / 中断向量;后台派 datasheet 取证同时继续改代码)。
- 返回:
  - 前台完成 → `content` = 子 agent 最后一条 assistant 的 text 块(没有就往前找;都没有则 `(Subagent completed but returned no output.)`)
    + 尾巴 `agentId: <id> (use send_message with to: '<id>' to continue this agent)\n<usage>total_tokens/tool_uses/duration_ms</usage>`;
    `oneShot` 的 profile 省尾巴。`details` = `{ taskID, agent, status, turns, toolUses, usage, durationMs, outputFile }`。
  - 后台 / 转后台 → `{ status: "async_launched", task_id, output_file, description }`。
  - 被停 / 失败 → `isError: true` + 部分结果。

### 5.2 `task_output` / `task_stop` / `send_message`

- `task_output { task_id, block = true, timeout = 30000 (≤ 600000) }` → `{ retrieval_status: success|timeout|not_ready, task: { task_id, status, description, prompt, result, output } }`。
  `result` 来自内存里的最后一条 assistant 文本;`output` 在没有 result 时给子会话文件路径。轮询 100 ms 看状态,尊重 abort。
- `task_stop { task_id }` → 已停/已完成时是 no-op;运行中 → abort 子会话,状态 `killed`,带部分结果入通知(后台)或作为工具错误(前台)。
- `send_message { to, message }`:`to` 是 task_id(= 子会话 id)。运行中 → 子 `harness.steer(message)`,回 "Message queued for delivery to X at its next tool round";
  已停/已完成/已被 LRU 淘汰 → `ensureOpen(child)` + 后台 `runTurn(child, message)`,完成走通知;找不到 → 报错。

### 5.3 工具池装配:`resolveAgentTools(all, profile, isAsync)`

```
全集
 ├─① 硬黑名单(profile 无权覆盖):agent / task_output / task_stop / send_message   ← 防递归
 ├─② 硬件类(默认对所有子 agent 关闭):flash / log / gdb / la / scope             ← 硬件互斥,见 §9
 ├─③ profile.disallowedTools
 └─④ profile.tools 白名单(undefined / ["*"] = 全给);解析 "agent(a,b)" → allowedAgentTypes
```

主 agent(`yoma`)不过①②。`isAsync` 在 yoma 里不再改变工具集(CC 那条是权限框问题),保留参数以便将来区分。

## 6. 宿主:TaskManager

新文件 `packages/kernel/src/host/tasks.ts`,被 `SessionManager` 持有;实现 `TaskHost`。

### 6.1 状态

```ts
interface TaskState {
  id: string;                    // = 子会话 id
  parentID: string; toolCallID: string;
  agent: string; description: string; prompt: string;
  status: "pending" | "running" | "completed" | "failed" | "killed" | "max_turns";
  backgrounded: boolean;         // 结果走通知而不是 tool_result
  abort: AbortController;        // 后台任务自己的;前台期间由父工具 signal 转发
  done: Promise<TaskResult>;     // runTurn 的 promise
  backgrounded$: { promise, resolve };   // 转后台信号,每任务建一次(CC:race promise 不能在循环里反复建)
  startedAt: number; endedAt?: number;
  result?: TaskResult;           // { text, turns, toolUses, usage, durationMs }
  notified: boolean;             // 原子去重
}
```

### 6.2 spawn

1. 解析 profile(`agents()` 快照来自父会话打开时那份,与 CC 的 `agentDefinitions` 继承一致);`allowedAgentTypes` / 未知类型分别报
   "denied / not found. Available agents: …"。
2. 建子会话:`repo.create({ cwd: parent.cwd, parentSessionPath: parent.meta.path, metadata: { agent, parent: { sessionID, toolCallID }, description } })`,
   标题 = description;`Entry.parentID / agent` 落上;发 `session.created`(视图带 `parentID`、`agent`、`task`)。
3. `assembleHarness(child, profile, { inherit: parent })`(§4.1、§4.4、§5.3);技能预加载与 `initialPrompt` 拼进首轮消息。
4. 并发上限:`maxConcurrentTasks`(默认 12,`YOMA_MAX_CONCURRENT_TASKS`)之外的排 `pending`,前一个结束再放行;对模型仍然是"已派生"。
5. `task.done = runTurn(child, prompt)`(v0.1 §3.4 第 4 步的抽取:一轮 + 自动重试 + 溢出压缩)。`maxTurns` 由 harness 执行。
6. 前台:工具 `await Promise.race([task.done, task.backgrounded$.promise])`;父工具 signal 的 abort 转发给 `task.abort`。
   后台:立即返回 `async_launched`;`task.abort` 不挂父;父会话按停止**不会**杀后台任务(CC:"survive ESC, killed explicitly")。
7. `done` 落地(无论前后台):**先**改 `status` → 再提结果与 usage → 前台走工具返回,后台/转后台走 §6.4 的通知。

### 6.3 中途转后台

UI 在父会话的 agent 卡片上按"转后台"(或 `autoBackgroundMs` 到点):`task.backgrounded = true`,解除父工具 signal → `task.abort` 的转发,
`backgrounded$.resolve()` 让工具立即返回 `async_launched`。子 agent 本身不感知,继续跑。
CC 在这一步要 `agentIterator.return()` 再用异步版 context 重新 `runAgent`,yoma 不需要——子 harness 从头就是独立的。

### 6.4 通知投递:`deliverNotifications(parentID)`

通知消息 = `{ role: "custom", customType: "task-notification", display: true, content: <XML>, details: { taskID, status, usage } }`,
XML 与 CC 逐字段同形:`<task-notification><task-id/><tool-use-id/><output-file/><status/><summary/><result/><usage/></task-notification>`。
`convertToLlm` 把它投成 user 角色(`messages.ts:132-140`)——这就是 CC 说的"看起来像用户消息但不是"。

投递规则(父会话为单位,`pending: Map<parentID, Message[]>`):

- 父 harness 相位是 `turn` → `harness.steer(message)`,在当前工具批结束、下一次模型调用之前插入;父会话的 steering 模式设为 `all`,
  多条通知一次全插(桌面端从不用 steer 传用户输入,`prompt()` 是先中断再重发,所以改这个模式没有副作用)。
- 父会话 `idle` 且没有 `retryPending` → 宿主起新一轮:`runTurn(parent, [所有 pending 通知])`(CC 的 `useQueueProcessor`:查询结束且队列非空就提交)。
- 父会话在 `compacting` / 重试退避中 → 先攒着,`project()` 看到状态回到 idle 时冲一次。
- 父会话被 LRU 淘汰(没有 harness)→ `ensureOpen(parent)` 再走上面。
- `notified` 原子去重;`task_stop` 已通知过的,正常完成时不再通知。

子会话**永远不接用户 prompt**:`session.prompt(childID)` 拒绝,`data._tag = "SubagentSessionError"`;续跑只经 `send_message`。

### 6.5 清理与生命周期

- 子会话完成后 harness 保留(可回放、可续跑),交给现有 LRU;运行中的是 busy 不会被淘汰。父会话闲着被淘汰也没关系,投递前 `ensureOpen`。
- app 退出 = 内核进程退出,所有任务一起死;子会话 JSONL 留在磁盘,重启后 `send_message` 能从 transcript 续跑(CC 同款)。
- 删除父会话级联删子会话。

## 7. 内核 `packages/agent` 的三处小改

1. `AgentHarness.prompt(input: string | AgentMessage, options?)`、`steer(input: string | AgentMessage)`:
   `executeTurn` 里 `messages = [typeof input === "string" ? createUserMessage(input, images) : input]`;`before_agent_start` 的 `prompt` 字段给文本。
   用途:通知以 `custom` 角色进会话树,UI 能区分,`convertToLlm` 又能投成 user。
2. `AgentHarnessOptions.maxTurns?: number`:`createLoopConfig` 里加 `shouldStopAfterTurn: () => ++turns >= maxTurns`
   (循环早就支持,`agent-loop.ts:239-249`);`prompt()` 照常返回最后一条 assistant,宿主按计数判 `max_turns`。
3. `harness/skills.ts` 导出 `parseFrontmatter`。

## 8. 协议与 UI

- `types.ts`:`Session` 加 `parentID?`、`agent?`、`task?: { status, description }`;`TOOL_NAMES` 加 `agent / task_output / task_stop / send_message`;
  `ToolDetailsMap` 加四份 details;`SubagentSessionError`。
- `protocol.ts`:`session.create` 加 `agent?`;新增 `agent.list`、`task.list`、`task.stop`、`task.background`;新增事件 `task.updated { task }`
  (任务面板与卡片状态都靠它,不复用 `session.status`——子会话的 busy/idle 与任务的 pending/killed 不是一回事)。
- 投影器:`project()` 处理 `tool_execution_update`,把 `partialResult.details` 写进卡片 `state.metadata`——
  `agent` 工具的 `onUpdate` 每逢子 agent 一次工具调用就推一份 `{ turns, toolUses, lastTool }`,父卡片上就有 CC 那种"N tool uses · 最近: bash"。
- session-ui:`agent-tool.tsx` 卡片(agent 名、description、状态、进度、按钮:打开子会话 / 转后台 / 停止);`task-notification` 的 custom 消息
  投成一个专门的 part 样式(不是普通气泡);侧边栏按 `parentID` 嵌套,子会话页只读并显示"子 agent 会话不能直接对话";任务面板列全部后台任务。

## 9. 并发与资源(十几个 agent 同时跑时会碰到的)

- **硬件类工具**:probe 租约 / gdb 会话表 / log 采集是模块级全局(`session-manager.ts:6-9` 注释,实测撞过 `0xe00002c5`)。
  子 agent 默认拿不到 §5.3 ②那五个;要放开需要 profile `hardware: true` + 进程级资源互斥(按探针/串口 key),P5。
- **文件写入**:`withFileMutationQueue` 是模块级、按规范路径串行(`file-mutation-queue.ts:13`),十几个 agent 改不同文件互不影响,
  改同一文件排队——但语义冲突挡不住,这正是 CC 用 worktree 隔离的场景,P5。
- **provider 限流**:十几路并发流打同一家;每轮的自动重试(3 次指数退避)已在 `runTurn` 里;`maxConcurrentTasks` 是主闸。
- **LRU**:`MAX_LIVE_SESSIONS = 8` 只淘汰 idle 的,运行中的子会话是 busy 不受影响;父闲着被淘汰也能重开投递。建议顺手提到 32。
- **事件风暴**:十几个子会话同时流 delta,`StreamSink` 16 ms 合并挡得住,但 renderer 的 store 会把所有子会话的消息都留在内存
  (CC 用 `retain` 只在 UI 看着时留)。v1 接受;v1.5 加 `session.watch/unwatch`,宿主只给"被看着的"会话转发 `message.*`,
  没被看着的只发状态——投影快照在宿主里,打开时 `session.messages` 补全,不丢。
- **子进程**:每个子 agent 的 bash 各自起进程,abort 各自杀树;`getShellEnv` 钉的 UTF-8 环境对子会话同样生效。
- **cache**:子 agent 与父的系统提示不同,不共享前缀缓存(DeepSeek 的上下文缓存亦然);fork 型才共享,P5。

## 10. 决策(相对 v0.1 的变化)

| # | 事项 | v0.2 结论 |
|---|---|---|
| 1 | 并行 | **默认并行**(CC 的 `isConcurrencySafe`),上限 12 可配 |
| 2 | 子 agent 碰硬件 | 默认不能;`hardware: true` + 互斥锁留 P5 |
| 3 | 轮数上限 | 默认不限(CC 同款),profile 可设;用户随时停 |
| 4 | 子会话直接对话 | 不能;续跑走 `send_message`(CC 同款) |
| 5 | 费用归属 | 通知与工具结果带 usage;会话级汇总后议 |
| 6 | agent 文件位置 | `.yoma/agents/`,cwd 向上到 home 逐层(CC 同款);技能发现要不要同步改成沿祖先找,一并定 |
| 7 | 工具名 | `agent` + `subagent_type`(CC 同名);配套 `task_output / task_stop / send_message` |
| 8 | 子 agent 思考档 | 默认 `off`(CC 同款);profile 可开;`explore/datasheet` 用 off |
| 9 | 缺省 subagent_type | `general`(CC 同款) |

## 11. 分期与验证

每期独立可合,`bun typecheck --force` 9/9 常绿。

**P1 coding-agent**:`core/agents.ts`(类型、内建四份、发现/合并、`resolveAgentTools`)+ `core/tools/{agent,task-output,task-stop,send-message}.ts`
+ `createAgentTools(host)`。测试用假 `TaskHost`:agent 列表与描述、黑名单/硬件类/白名单/`agent(a,b)`、前台/后台/被停三种结果映射、
`oneShot` 省尾巴、空结果占位、`task_output` 的 block/timeout、`send_message` 三分支。
验证:`bun --cwd packages/coding-agent test test/agents.test.ts test/agent-tools.test.ts`。

**P2 内核 packages/agent**:§7 三处 + 测试(`prompt(AgentMessage)` 进树的是 custom 条目且 LLM 侧是 user;`maxTurns` 到点 `agent_end`)。
验证:`bun test packages/agent`(注意 `nodejs-env.test.ts` 的杀进程树用例在 Windows 上本来就 flaky)。

**P3 kernel host**:`tasks.ts` + `SessionManager` 改造(`assembleHarness` / `runTurn` 抽取、`Entry.parentID/agent`、按元数据装配、级联删、子会话拒 prompt、
steering 模式、通知投递、`tool_execution_update` 投影)。`host.test.ts`(faux provider)场景:
(a) 一条消息派 3 个 `explore` 并行,3 个 `session.created` 带 parentID,父卡片 3 张 completed,父最后一条 assistant 出现;
(b) `run_in_background` → 父本轮立即结束 idle → 子完成后父被叫醒新一轮,通知消息在父会话里是 custom 条目;
(c) 父忙时子完成 → 通知经 steer 插入,父不多起一轮;
(d) `task_stop` → 子 idle、通知 status killed、带部分结果、不重复通知;
(e) `send_message` 到运行中的子 → 子 transcript 出现该 user 消息;到已完成的子 → 续跑并再通知;
(f) `maxTurns: 2` → status max_turns;
(g) `maxConcurrentTasks: 2` 派 3 个 → 第三个 pending 直到有人完成;
(h) 重开子会话工具集 = profile 的子集。
faux provider 的响应队列是进程内共享的:并行子 agent 的消费顺序不确定,**并行场景的子 steps 必须彼此相同**(三个一样的 text),父的 steps 排在前后。

**P4 协议 + UI**:§8。验证:kernel / session-ui / app 三个包的单测;`bun --cwd packages/desktop smoke`(工具数 14 → 18,CLAUDE.md 同步);
`e2e:ipc`;worktree 里跑 e2e 先做 Electron 二进制 junction(记忆 `user-worktree-electron-junction`)。

**P5(后续)**:fork 型子 agent(`JsonlSessionRepo.fork` + CC 的占位 tool_result 对齐)、`isolation: worktree`、`hardware: true` + 资源互斥、
`session.watch` retain 门、ACP 注入 `TaskHost`、agent 记忆目录。

## 12. 改动清单

| 包 | 文件 | 改动 |
|---|---|---|
| agent | `src/harness/agent-harness.ts`、`harness/types.ts` | `prompt/steer` 收 AgentMessage;`maxTurns` → `shouldStopAfterTurn` |
| agent | `src/harness/skills.ts` | 导出 `parseFrontmatter` |
| agent | `test/harness/agent-harness.test.ts` | 两条新用例 |
| coding-agent | `src/core/agents.ts`(新) | AgentProfile、内建、发现/合并、resolveAgentTools |
| coding-agent | `src/core/tools/{agent,task-output,task-stop,send-message}.ts`(新)、`tools/index.ts`、`src/index.ts` | 四件工具与 `createAgentTools`;不进 `createCodingToolDefinitions`(要注入 host) |
| coding-agent | `test/agents.test.ts`、`test/agent-tools.test.ts`(新) | |
| kernel | `src/host/tasks.ts`(新) | TaskManager:状态机、spawn、race、通知投递、send/stop/output |
| kernel | `src/host/session-manager.ts` | assembleHarness / runTurn 抽取;Entry 字段;元数据装配;steering 模式;级联删;拒 prompt;`tool_execution_update` 投影 |
| kernel | `src/host/index.ts`、`src/protocol.ts`、`src/types.ts`、`src/host/details-check.ts` | 新 RPC / 事件 / 视图字段 / details |
| kernel | `src/host/host.test.ts`、`tool-names.test.ts` | §11 P3 的八个场景 |
| session-ui | `src/components/agent-tool.tsx`(新)+ story、通知 part、渲染表 | |
| app | 侧边栏嵌套、子会话只读、任务面板、i18n | |
| desktop | smoke 脚本、`CLAUDE.md` 命令表 | 工具数 |

## 13. 风险与坑

- **steer 在 idle 时抛 `invalid_state`**(`agent-harness.ts:769-770`):投递前必须先看相位,重试退避期间 harness 是 idle 而会话状态是 busy,
  这就是 §6.4 要攒着等 idle 的原因。
- **父会话的 `prompt()` 会先 abort 当前轮**(`session-manager.ts:768-772`):用户在父会话里输入时,正在前台跑的子 agent 会随父工具 signal 一起被杀——
  这是 CC 的同款语义(ESC 杀同步子 agent);后台任务不受影响。UI 上要让用户看得出"再发消息会中断前台子 agent"。
- **通知触发的新一轮没有用户消息 id**:`project()` 里 `message_start` 的 user 分支靠 `pendingUserID` 复用 renderer 铸的 id;宿主自起的一轮没有,走投影器自铸 id 即可,但要确认 renderer 侧不会把这条当"乐观插入未匹配"。
- **faux provider 共享队列**:见 §11 P3。
- **`TOOL_NAMES` 闸门**、**smoke 工具计数**、**contextBridge 剥 Error**、**内核无 HMR**、**`.yoma/.gitignore` 黑名单**:同 v0.1 §7。
- **CC 的 cache 教训在 yoma 的形态**:agent 列表只在会话打开时算一次,会话内 `agent` 工具描述不变;将来加"热重载 agent 定义"时不要动已开会话的工具描述。
- **十几个子会话的 JSONL 同时追加写**:每会话一个文件、各自 `appendFile`,没有共享写;`sessions/--<cwd>--/` 目录会很快堆满,`session.list` 的头行读取是 O(文件数),后续考虑按 `parentID` 折叠时顺手做懒加载。
