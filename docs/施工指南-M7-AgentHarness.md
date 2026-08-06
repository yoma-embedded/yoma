# M7 施工指南:AgentHarness

> **✅ 已完工(2026-07-25)**:Step 1–10 全部落地,17 个 harness 参考测试 + 20 个 compaction 测试全绿(合计 142 pass)。
> `example/04` 已毕业:import 从 pi-minimal 改回 `@yoma/my-pi/node`,`@ts-nocheck` 与 tsconfig exclude 均已删除,三个场景跑在自己的实现上。
> Step 10 连带把 M8(compaction 三文件)一起做了 —— 因为 `compact()`/`navigateTree()` 对它是运行时硬依赖。
> **2026-08-06 增补**:P0 三件落地 —— M9 技能发现(loadSkills + `/skill:` 命令)、AGENTS.md 上下文文件、轮级自动重试(内核 `retryLastTurn()` + ACP 层策略)。现状见文末盘点表。
> **下一站不再是里程碑表,而是真实负载**:见文末"M7 之后"。
>
> 本指南基于对 pi-minimal `agent-harness.ts`(1029 行)的逐行侦察,所有依赖结论都经过对 import 块的逐条 grep 验证。行号均指 pi-minimal。日期:2026-07-24。

---

## 0. 全景:M7 在造什么

一句话:**给 runAgentLoop 套一层"会持久化、可打断、并发安全"的驾驶舱**。harness 没有自己的循环——它只是 runAgentLoop 的一个高级调用者(agent-harness.ts:565-572 直接调 `runAgentLoop`),把四类状态严格分开,再用一组注入回调把它们接到 loop 上。

一个此前没强调的事实:**AgentHarness 完全不使用 Agent 类**。你的 agent.ts 是给"不要电池"用户的薄壳;harness 是与它平行的另一位 loop 调用者。两者共享的只有 runAgentLoop 和类型。

四类状态(agent-harness.md 全文都在讲它们怎么分离):

| 状态 | 代码落点 | 谁能改 | 何时生效 |
|---|---|---|---|
| harness 配置 | 私有字段 `model/thinkingLevel/tools/activeToolNames/resources/streamOptions/systemPrompt` | setter 随时改 | **下一次快照**(下一轮) |
| turn 快照 | `AgentHarnessTurnState`,`createTurnState()`(:314-346)产出 | 没人——冻结 | 本轮请求只读它 |
| session | `this.session`(你 M5 建的 Session 门面) | 只有 append*/moveTo | 落盘即历史 |
| 挂起写入 | `pendingSessionWrites: PendingSessionWrite[]`(:168) | 忙时的 setter 入队 | save point 时 FIFO 刷入 |

## 1. 依赖真相(逐条 grep 验证)

| 模块 | harness 依赖? | 对施工的影响 |
|---|---|---|
| repos(jsonl-repo/memory-repo) | ❌ 零 import,`Session` 类型来自 session/session.ts | **M5 Step 5 继续推迟**,M7 用不上 |
| Shell/exec 实现 | ❌ `ExecutionEnv` 是 type-only import;`env` 全文只有两处:L184 存字段、L327 透传给 systemPrompt 回调 | 你的 FS-only NodeExecutionEnv 够用;只需在 types.ts **补接口声明**(Shell/ExecutionEnv),不用实现 exec |
| compaction 两文件 | ⚠️ **运行时硬依赖**:`compact()` 调 prepareCompaction/compact/DEFAULT_COMPACTION_SETTINGS,`navigateTree()` 调 collectEntriesForBranchSummary/generateBranchSummary | 但这两个方法是**自包含侧枝**(各自的 phase、各自的 finally),放到最后一步;之前先建空骨架让编译通过 |
| skills.ts / prompt-templates.ts | ⚠️ 各只用一个函数:`formatSkillInvocation`(**4 行**)、`formatPromptTemplateInvocation`(**3 行**) | 只移植这两个格式化函数;~600 行的发现机制(loadSkills 等)留给 M9 |
| messages.ts 的 convertToLlm | ✅ 你已实现 | 原样透传给 loop(:407) |
| system-prompt / truncate / shell-output / proxy | ❌ 不 import | 与 M7 无关 |

## 2. Step 0:补类型(~540 行,harness/types.ts)

参考 harness/types.ts(838 行)还缺的段落:`Skill`(:46)、`PromptTemplate`(:60)、`AgentHarnessResources`(:70)、`AgentHarnessStreamOptions`(+Patch,:81/:99)、`AgentHarnessErrorCode/Error`(:207)、`ShellExecOptions/Shell/ExecutionEnv`(:305-332,ExecutionEnv = FileSystem + Shell 的接口并集)、`CompactionError/BranchSummaryError`、`AgentHarnessPhase`(:494)、`PendingSessionWrite`(:496)、`AgentHarnessOwnEvent/Event/EventResultMap`(:636-726)、`AgentHarnessPromptOptions`(:728)、`AgentHarnessOptions`(:800)。**跳过 SessionRepo 家族(:469)**——那是 Step 5 的。

`PendingSessionWrite` 一句话:**就是"还没分配 id/parentId/timestamp 三件套的树条目"**(`Omit<SessionTreeEntry, ...>` 的变体联合)。排队的是条目的"意图",flush 时重放对应的 `session.append*` 才获得三件套——这和 M5 "Session 分配 id、storage 只追加"是同一条纪律。

## 3. 施工顺序(每步都有独立验收)

参考实现的内部结构支持这样切(顺序经侦察确认可编译、可测):

1. **两个格式化函数**:`formatSkillInvocation` + `formatPromptTemplateInvocation` 连同 Skill/PromptTemplate 类型 → 移植 `resource-formatting.test.ts`(2 测试,24 行)。**当天第一个绿测试。**
2. **构造 + 纯 helper + getters**:构造校验(重名工具/资源)、模块级 helper(createUserMessage/cloneStreamOptions/applyStreamOptionsPatch)、全部 get* 方法。零 Session 依赖可测。
3. **idle 态 setters**:`setModel/setThinkingLevel/setTools/setActiveTools/...` → 走 `session.append*` + 发对应 own-event。拿 InMemorySessionStorage 验证条目真的落树。
4. **挂起写入队列**:忙时 setter 入队;`flushPendingSessionWrites()`(:462-486)——注意语义:**peek 队头 → await 写入成功 → 才 shift**,失败的写留在队头,队列不会烂在半路。
5. **turn 快照**:`createTurnState()`(:314-346,systemPrompt 支持字符串或异步回调)+ `createContext()`(:348-357,slice 防御拷贝)。
6. **最小 prompt() 路径**(M7 的心脏):`createLoopConfig`(:399-448)+ `createStreamFn`(:359-385)+ `handleAgentEvent`。相位:`prompt()` 开头同步查 `phase!=="idle"` 即抛 busy(:609),成功路径在 `agent_end` 分支里归位 idle(:509),失败路径在 catch 里归位。**turn_end 分支的顺序值得背下来**(:494-506):先 emit 给订阅者(错误暂存不吞)→ flush 挂起写入 → 再抛订阅者的错 → 都没错才发 `save_point{hadPendingMutations}`。订阅者炸了也不丢写。
7. **hooks 双轨**:`on()`(类型化 hook,返回值能改行为:tool 拦截/context 改写/streamOptions 补丁)vs `subscribe()`(通配 listener,纯观察)。同一张 handlers 表,两种语义。
8. **三条队列**:`steer()/followUp()`(要求 phase!=="idle" 才有意义)、`nextTurn()`(无相位约束)、`drainQueuedMessages`(hook 抛错时 unshift 回滚)。
9. **失败路径 + abort**:合成失败 AssistantMessage 走同一条事件管线;`abort()` 清 steer/followUp 队列但**保留 nextTurn 队列和挂起写入**;`waitForIdle()`。
10. **compact() + navigateTree()(= M8 的门)**:需要先建 `compaction/compaction.ts`(753)+ `compaction/utils.ts`(144)+ `branch-summarization.ts`(261)。建议 M7 主体验收后与 M8 一起做——移植测试时先 skip 涉及这两个方法的用例。

**验收**:`agent-harness.test.ts`(13 测试,607 行)+ `agent-harness-stream.test.ts`(4 测试,213 行),全部跑在 faux provider 上,零 API 费。

## 4. loop 侧的对接点(你已备好的插座)

- `prepareNextTurn` 你在 commit 35a188a 已接进 loop——harness 的实现(:435-444)正好插上:**flush 挂起写入 → createTurnState → setTurnState(更新闭包)→ 返回 {context, model, thinkingLevel}**。
- **harness 不传 `shouldStopAfterTurn`**(grep 证实全文无此字段)——loop 走默认停止逻辑。
- `streamFn` 不在 AgentLoopConfig 里,是 `createStreamFn` 单独造、作为第 5 个参数传给 runAgentLoop:快照 streamOptions → `before_provider_request` hook 打补丁 → `models.streamSimple(...)`,onPayload/onResponse 接 `before_provider_payload` / `after_provider_response` hook。

## 5. 重读 agent-harness.md 的钥匙

按这个顺序读:四个 **State model** 小节 → **Operation phases** → **Turn execution** → **Save points** → **Abort** → **Compaction and tree navigation** → **Hooks**;`Planned session facade` / `Ultimate lifecycle goal` / `todo` 三节当路线图读,**别在代码里找它们**。

六个易混淆点,一句话拆弹:

1. **harness 配置 / turn 快照 / phase** 回答三个不同问题:"下一次快照会看到什么"(随时可改)/"这一轮请求看到什么"(冻结)/"现在能不能开新的结构性操作"(状态机标签)。setter 改第一个、永不碰第二个、与第三个无关。
2. **save point 不是存档回放功能**——它就是 turn_end 时"flush + 重建快照 + 喂回同一次 runAgentLoop"的那个瞬间,是 setModel/steer 中途生效的机制,不是新 API。
3. **on() vs subscribe()**:前者的返回值会被消费(能改行为),后者纯观察(返回值被忽略)。
4. **PendingSessionWrite 看着像事件类型,其实就是没有三件套的条目**——故意与持久条目同形,flush 才能直接重放 append*。
5. **"Planned session facade" 一节描述的 HarnessSession 在代码里不存在**——hook 今天只拿到事件载荷,没有 session 句柄。
6. **compact()/navigateTree() 不走挂起写入队列**——它们是 idle-only 结构性操作,直接写持久 session(moveTo/appendCompaction),finally 里归位相位。

## 6. M7 之后

里程碑表到这里基本走完了(M1–M8 + M9 的资源格式化部分)。**剩下的东西不该再按表推进,而该由真实失败来排优先级。**

已完成盘点(2026-08-06 刷新):

| 里程碑 | 状态 |
|---|---|
| M1–M4 循环 + Agent 壳 | ✅ |
| M5 会话树 | ✅ 含 Step 5 repos(ACP session/load 靠它做历史找回) |
| M6 FileSystem + Shell·exec | ✅(exec/truncate/shell-output 随 bash 工具落地,d15c5c6) |
| M7 AgentHarness | ✅(后补 `retryLastTurn()`:`retry` 相位启用,摘尾部失败消息 → runAgentLoopContinue) |
| M8 Compaction | ✅(ACP 层每轮后自动压缩,带 stale-usage 防线) |
| M9 Skills/模板 | 技能 ✅(loadSkills 移植 + `.agents/skills`/`~/.my-pi/skills` 发现 + `/skill:` 命令,2026-08-06)/ **模板发现 ❌** |
| 上下文文件 | ✅ AGENTS.md/CLAUDE.md 全局 + 祖先链 + override 语义(coding-agent/src/core/resources.ts) |
| 轮级自动重试 | ✅ 策略在 ACP 层(3 次、2s 指数退避、溢出与不可重试错误除外),机制在内核 |

**仍然缺的**(都不阻塞,等真用到再补):

- **M9 模板发现**:`loadPromptTemplates` —— 替换函数(`$1`/`$@`/`${@:N:L}`)与 `promptFromTemplate()` 都已就位,只差磁盘发现 + ACP 命令登记,照抄 skills 的接法即可。`test/harness/prompt-templates.test.ts` 与 `system-prompt.test.ts` 两个占位文件也留给它。
- `proxy.ts`(367 行):只有"后端代理鉴权"这种部署形态才需要。

**下一步建议:造一个自己每天用的 CLI agent。** 五个真工具(read/write/edit/bash/grep)+ REPL + 会话落 `~/.my-pi/sessions/` + 接真模型。它会在几小时内把上面这些"缺的东西"按真实优先级排好序 —— 比如你会立刻发现 truncate 比 repos 急迫得多。详细理由见对话记录里的三条路(dogfooding → 差分测试 → 评测套件)。
