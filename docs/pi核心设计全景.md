# pi Agent Core 设计全景

> 写给正在手写复刻 pi 内核的你。这份文档回答两个问题：**整体是怎么设计的**、**为什么这么设计**——让你在任何一个文件里迷路时，都能找到自己在地图上的位置。
> 行号均指参考仓库 `pi-minimal`。日期：2026-07-21。

---

## 0. 一句话 + 一张图

**pi 是一台"回调注入式"的 headless agent 引擎**：核心是一个纯函数循环，其余一切——状态、持久化、工具、提示词、UI——要么是注入的回调，要么是可选的外壳。这是 HANDBOOK 里的原话："和 opencode 的 Effect+事件溯源+SQLite 完全相反的极简路线"。

```
┌───────────────────────────────────────────────────────────┐
│ 你的产品（CLI / TUI / 嵌入式应用）                          │
│ 负责注入：工具、系统提示词、权限、重试策略、UI 订阅者         │
├───────────────────────────────────────────────────────────┤
│ AgentHarness（可选电池层）src/harness/  ~5k 行              │
│ 会话树持久化 · compaction · skills · 相位机 · turn 快照     │
├───────────────────────────────────────────────────────────┤
│ Agent（薄状态壳）src/agent.ts  581 行                       │
│ state = reduce(events) · steer/followUp 队列 · abort       │
├───────────────────────────────────────────────────────────┤
│ runAgentLoop（纯函数内核）src/agent-loop.ts  798 行 ★       │
│ 双层 while：流式响应 ⇄ 工具批执行；发射 AgentEvent           │
├───────────────────────────────────────────────────────────┤
│ ai 包（统一 LLM 流式客户端）packages/ai/                    │
│ StreamFn 契约（永不 throw）· 12 种流事件 · EventStream      │
├───────────────────────────────────────────────────────────┤
│ provider wire 协议（anthropic / openai 的 SSE 解析）        │
└───────────────────────────────────────────────────────────┘
```

记住两条流动方向，整个系统就不会迷路：

> **消息向下投影**（`convertToLlm` 把富词汇表压成 LLM 能懂的三种角色），
> **事件向上冒泡**（两层嵌套的 EventStream 把流事件包装成 loop 事件），
> **错误永远以数据的形式在这两条路上旅行，从不以异常的形式横穿边界。**

---

## 1. 五个类型撑起整个心智模型

如果只记五个类型，记这五个（都值得先读，`types.ts` 是 HANDBOOK 说的"先读这个"）：

### ① `Message` — 电线上的词汇（ai/src/types.ts:405）

```ts
type Message = UserMessage | AssistantMessage | ToolResultMessage;

// 内容块是原子：
// TextContent | ThinkingContent | ImageContent | ToolCall（都带 type 判别字段）

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";  // ← 关键
  errorMessage?: string;      // stopReason 为 error/aborted 时的错误说明
  usage: Usage;               // token 用量 + 客户端计算的成本
  api; provider; model;       // 每条响应都盖了来源戳
}
```

**最重要的一点：assistant 消息同时是成功值和错误值。** 请求失败不抛异常，而是变成一条 `stopReason: "error"` 的 assistant 消息进入 transcript。

### ② `EventStream<T, R>` — 流的载体（ai/src/utils/event-stream.ts，全文 88 行，逐行读）

推挤队列 + 等待消费者的异步迭代器，支持**两种消费方式**：`for await` 逐事件消费（做流式 UI），或 `await stream.result()` 只拿最终结果——同一个对象，两个入口。`AssistantMessageEventStream = EventStream<AssistantMessageEvent, AssistantMessage>`。

**这个模式递归复用**：loop 自己也被包成 `EventStream<AgentEvent, AgentMessage[]>`（agent-loop.ts:151-156），`agent_end` 即完成事件——上下两层形状完全一致。

### ③ `AgentMessage` — 应用层的词汇（agent/src/types.ts:314）

```ts
interface CustomAgentMessages {}   // 故意为空，应用用"声明合并"扩展它
type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

没人扩展时它就等于 `Message`；harness 合并进 4 个自定义角色（bashExecution、custom、branchSummary、compactionSummary）后全局变宽。自定义角色**存在于 transcript 但永远不上电线**——`convertToLlm` 在 LLM 边界把它们投影成 user 消息或过滤掉。

### ④ `AgentLoopConfig` — 循环的全部人格（agent/src/types.ts:140-282）

循环能做什么、不能做什么，全部写在这个接口里，**每个成员都是注入的函数**：

```ts
interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model<any>;
  convertToLlm: (msgs: AgentMessage[]) => Message[];   // 词汇表投影（LLM 边界）
  transformContext?;        // 投影前的上下文改写（compaction 挂这）
  getApiKey?;               // 过期 token 的续期缝
  getSteeringMessages?;     // 中途插话队列（每轮工具后轮询）
  getFollowUpMessages?;     // 续命队列（快停下来时才轮询）
  prepareNextTurn?;         // 轮间换 context/model/thinking（harness 的 save point 骑在这上面）
  shouldStopAfterTurn?;     // 优雅停止
  beforeToolCall? / afterToolCall?;   // 工具前后钩子（权限系统未来挂这）
  toolExecution?: "sequential" | "parallel";
}
```

几乎每个回调的文档注释都重复同一句契约："**must not throw or reject**"——类型系统表达不了的行为契约，靠约定强制执行。

### ⑤ `AgentEvent` — UI 订阅的词汇（agent/src/types.ts:415-430）

10 种变体，四个生命周期层级：

```
运行级   agent_start / agent_end{messages}
轮级     turn_start / turn_end{message, toolResults}
消息级   message_start / message_update{assistantMessageEvent} / message_end
工具级   tool_execution_start / update / end
```

`message_update` 里**原样内嵌**底层的流事件（不翻译，直接携带）。UI 就按这个事件序列写——HANDBOOK 原话。

---

## 2. 数据如何流动

### 向下：消息 → LLM（每轮一次）

```
AgentMessage[]（transcript，可能含自定义角色）
   │ transformContext()      改写上下文（可选；compaction 在此生效）
   │ convertToLlm()          投影：自定义角色 → user 消息 / 过滤    ← 唯一的 LLM 边界
   ▼
Message[] → Context{systemPrompt, messages, tools} → streamFn(model, ctx, opts)
```

位置：agent-loop.ts:295-320。`streamFn` 就是 `models.streamSimple`——靠**结构化类型**直接满足 `StreamFn` 形状，没有适配器类、没有注册表（pi-minimal 甚至删掉了上游的全局 compat 注册表，streamFn 必须显式注入——这是本仓库与上游唯一的行为差异）。

### 向上：SSE → 事件 → 状态

```
wire SSE 字节流
   │ provider 适配器解析，维护一个可变的 partial AssistantMessage
   ▼
AssistantMessageEvent ×12（start · text/thinking/toolcall 各 start/delta/end · done · error）
   │ 每个事件都携带完整的 partial 快照——消费者永远不用自己拼 delta
   ▼ loop 的 for-await（agent-loop.ts:325-369）
AgentEvent ×10（start→message_start；9 种内容事件→message_update；done/error→message_end）
   │ emit = 直接调用 Agent.processEvents（不是队列！agent.ts:407-414）
   ▼
Agent 状态归约（同步）→ 按订阅顺序 await 每个 listener
```

**流式的"替换尾部"模式**（迷路高发区，值得单独记）：`start` 事件时把 partial **push 进** `context.messages`；每个 delta 事件用新 partial **覆盖最后一项**（`messages[len-1] = event.partial`）；`done` 时换成 `await response.result()` 的最终消息。所以循环的 context 尾部在流式期间永远恰好有一个进行中的 partial，done 时原子换掉。

### 错误即数据，三种编码

1. **消息里**：`stopReason: "error"|"aborted"` + `errorMessage`——失败的轮就是一条普通 transcript 条目。
2. **流协议里**：`error` 是第 12 种事件，`result()` **resolve**（不是 reject）出错误消息。
3. **harness 里**：`Result<T,E> = {ok:true,value} | {ok:false,error}`（harness/types.ts:6），全部文件系统操作返回它。

**唯一被允许 throw 的地方**：`AgentTool.execute`（types.ts:381 文档明确要求"失败就 throw"）——循环是接球手，把 throw 转成 `isError: true` 的 ToolResultMessage。规则：**throw 只允许出现在有唯一接球者的地方；一切跨包边界的错误都以数据传递。** 就算 loop 机器本身炸了，`Agent.runWithLifecycle` 的 catch 也会**合成**一条错误 assistant 消息并补发完整的 `message_start → message_end → turn_end → agent_end` 尾巴（agent.ts:500-516）——事件契约是"全的"，订阅者永远看到完整序列。

---

## 3. 一次 prompt 的一生（两轮对话）

`agent.prompt("北京天气怎么样?")`，模型第一轮返回 toolCall，第二轮返回文本：

**A. 进门（Agent）**：并发保护（有 activeRun 就 throw，中途输入必须走 `steer()`/`followUp()`）→ 字符串规范化成 UserMessage → `runWithLifecycle` 建 AbortController、设 `isStreaming=true` → **快照** context（浅拷贝消息数组）和 config（闭包捕获两个队列的 drain）→ 调 `runAgentLoop`，把 `processEvents` 直接当 emit 传进去。

**B. 循环（agent-loop.ts:161-281）**——骨架伪代码，值得抄在手边：

```
runLoop(context, newMessages, config, signal, emit):
  pending = getSteeringMessages()                # 空闲期打的字，开跑先注入
  outer: while true:                             # 外层 = followUp 续命循环
    hasMoreToolCalls = true
    inner: while hasMoreToolCalls or pending:    # 内层 = 工具/插话循环
      emit turn_start（首轮跳过，L181）
      注入 pending 消息（emit message_start/end；进 context 和 newMessages）
      msg = streamAssistantResponse(...)         # 唯一的 LLM 边界
      if msg.stopReason in {error, aborted}:     # ← 错误出口（L202-206）
        emit turn_end; emit agent_end; return
      toolCalls = msg.content 里的 toolCall 块
      hasMoreToolCalls = false
      if toolCalls:
        batch = stopReason=="length" ? 整批失败不执行   # ← 截断出口（L216-220）
                                     : executeToolCalls()
        hasMoreToolCalls = not batch.terminate   # terminate 需全票（L590-592）
        结果进 context 和 newMessages
      emit turn_end(msg, toolResults)
      prepareNextTurn(...) 可换 context/model     # ← harness save point（L238-251）
      if shouldStopAfterTurn(...): agent_end; return
      pending = getSteeringMessages()            # 每轮的插话注入点（L265）
    followUps = getFollowUpMessages()            # 快停下来才轮询（L269）
    if followUps: pending = followUps; continue outer   # 续命
    break
  emit agent_end(newMessages)                    # 自然出口（L280）
```

**C. 工具批执行是三段式**（agent-loop.ts:497-562，并行路径）：

1. **预检（按源顺序串行）**：emit `tool_execution_start` → 查工具 → 校验参数 → `beforeToolCall` 钩子（可 block）。
2. **执行（并发）**：`Promise.all` 跑所有 thunk，`tool.execute` throw → 错误结果；`tool_execution_end` 按**完成顺序**发。
3. **落账（按源顺序）**：ToolResultMessage 按 assistant 消息里的**源顺序**发 `message_start/end`——**事件顺序反映真实并发，transcript 顺序保持确定性**。这是文档写明的契约（types.ts:33-40）。

**D. 完整事件序列**（两轮，k=工具参数 delta 数，m=文本 delta 数）：

```
agent_start → turn_start
→ message_start/end（user）
→ message_start（assistant partial）→ message_update ×(k+2) → message_end（stopReason:"toolUse"）
→ tool_execution_start → tool_execution_end
→ message_start/end（toolResult）
→ turn_end
→ turn_start
→ message_start → message_update ×(m+2) → message_end（stopReason:"stop"）
→ turn_end → agent_end
```

最终 `agent.state.messages` = [user, assistant(toolCall), toolResult, assistant(text)]。

**E. 运行的六种结局**：① 自然停止；② 流错误/中止（stopReason error/aborted，L202 出口）；③ 工具期间 abort（本轮补完，下一轮流返回 aborted）；④ loop 机器 throw（runWithLifecycle 合成错误尾巴）；⑤ shouldStopAfterTurn；⑥ terminate 全票批。**每条路的最后一个事件都是 agent_end**——这就是"错误全整性"（error totality）。

---

## 4. 状态归属与单写者规则

| 状态 | 谁拥有 | 谁写 |
|---|---|---|
| `_state.messages`（transcript） | Agent | **只有 `processEvents` 在 `message_end` 时 push**（agent.ts:545） |
| `isStreaming`/`streamingMessage`/`pendingToolCalls` | Agent | processEvents 逐事件归约 |
| `currentContext.messages`（循环的分叉副本） | loop（每次运行） | 循环原地改：注入、push partial、替换尾部、追加工具结果 |
| 进行中的 partial 消息 | provider 适配器 | 适配器逐 SSE 事件改；loop 只读 |
| steering / followUp 队列 | Agent | `steer()`/`followUp()` 随时入队；只有 loop 的注入点 drain |

三条不变式：(a) **processEvents 是运行期间 Agent 状态的唯一归约者**——loop 从不碰 `_state`；两份 transcript 因为"loop 每追加一条就 emit 一条 message_end"而保持一致（共享消息对象，数组各自独立）。(b) loop 的 context 是分叉——运行中外部改 `agent.state.messages` 不影响进行中的运行。(c) 事件管线**严格串行**：loop 在所有 listener settle 之前不会前进（listener 就是背压机制）；但 provider→loop 的 EventStream **无背压**（无限缓冲）。

---

## 5. Harness 层：纯函数管不了"时间"

loop 是纯函数——它管不了**过去**（进程重启前发生了什么）、**将来**（运行中改的配置何时生效）、**同时**（两个操作并发会怎样）。harness 的每个机制都在回答其中一个问题，而且是同一招反复用：**把隐式的可变共享状态，换成显式的、有序的、只追加的记录。**

| 问题 | 天真做法会怎么坏 | harness 机制 |
|---|---|---|
| 持久化 | 消息在 JS 数组里，进程退出全丢 | **会话树**：每次 message_end 先落盘再通知订阅者（:489-492） |
| 并发操作 | 两个 prompt 交错写一份 transcript；用锁则钩子里 `await waitForIdle()` 直接死锁 | **相位机**：`idle/turn/compaction/branch_summary/retry`，结构性操作在第一个 await 前同步设相位，忙时直接抛 `busy`（拒绝而非排队） |
| 运行中改配置 | `setModel` 立即生效 → 半途换 API、成本记账错乱、session 条目顺序错位 | **turn 快照**：setter 立即改 harness 配置，但进行中的请求用它自己的冻结快照；**下一轮**才生效 |
| 配置何时切换 | 随机时机 | **save point**：`prepareNextTurn` 回调 = 刷挂起写入 + 建新快照 + 给 loop 换 `{context, model, thinkingLevel}`——中途 setModel 在同一次运行的下一次请求生效 |
| 忙时写 session | 直接写 → parentId 指错、树交错 | **挂起写入队列**：忙时的写请求排队（故意不含 id/parentId/timestamp——flush 时才分配），在 save point / agent_end / 失败清理时 FIFO 刷入 |
| 上下文溢出 | 融合进 loop 自动截数组 → 摘要 LLM 调用失败时 transcript 半截 | **compaction = 纯函数管线** + 手动触发：`shouldCompact → findCutPoint → compact`，失败于落盘前则一切如旧（原条目从不被改） |
| 历史导航/重试 | 线性 list 只能截断，被放弃的尝试消失 | **树**：每条目带 `{id(UUIDv7), parentId}`，`navigateTree` 移动 leaf 即分叉；**连光标都是持久条目**（`setLeafId` 追加一条 leaf 条目，重开文件重放即恢复位置） |

细节要点：

- **会话树条目类型**：`message`、`model_change`、`thinking_level_change`、`active_tools_change`、`compaction`、`branch_summary`、`custom`、`custom_message`、`label`、`leaf`。存储就是一行一个 JSON 的 JSONL 追加日志，树完全活在 parentId 链接里。
- **`buildContext()` 投影**（session.ts:37-135）：取 leaf→root 路径；配置状态（模型/thinking/激活工具）从**完整路径**推导（compaction 压掉的区域里的 model_change 依然生效）；消息投影则应用**最后一个** compaction 条目——`firstKeptEntryId` 之前的一切在投影里消失，被摘要（作为 user 消息）替代，**树本身分毫未动**。
- **compaction 只在轮边界切**（`findCutPoint`，compare 文档说"值得原样抄"）——绝不切在 toolResult 前面，provider 永远不会看到孤儿工具结果。
- **harness 是同一个纯 loop 的高级调用者**：它没有自己的循环，只是给 `runAgentLoop` 喂了一套精心构造的回调（convertToLlm 来自 messages.ts、prepareNextTurn 做 save point、before/afterToolCall 桥接钩子、streamFn 包一层 provider-request 钩子链）。理解了 §4 的 loop，harness 只是"另一个 caller"。
- **三份设计文档故意未实现**：`durable-harness.md`（崩溃恢复——诚实地叫"半持久"，因为工具实现是运行时 JS 无法序列化）、`hooks.md`（类型化 reducer 钩子系统）、`observability.md`（厂商中立 trace 契约，订阅者必须纯被动）。读作路线图，别在 src 里找。

---

## 6. 十二条设计决策（哲学速查）

1. **纯函数 loop + 薄状态壳**——最值得精读的文件是 agent-loop.ts；其上一切可替换（harness 甚至不依赖 Agent，直接调 runAgentLoop）。
2. **一切构造注入**——无全局注册表、无内置工具/权限/系统提示词；"全构造注入、不 fork 能改一切"。
3. **provider 永不 throw**——错误编码为 stopReason 随流返回；streamFn 真 throw 也有 runWithLifecycle 兜底合成完整事件尾巴。内核**没有重试**，官方挂载点：`agent_end` 后查 `isRetryableAssistantError()` → `agent.continue()`。
4. **消息是纯 JSON 数据**——持久化 = `JSON.stringify(agent.state.messages)`，恢复 = 赋回去再 `continue()`。
5. **事件驱动：state = reduce(events)**——一条事件流同时服务 UI、持久化、观测；事件顺序是文档化契约。
6. **会话是追加式树，不是线性日志**——换模型、压缩、分支摘要、光标移动都是树条目。
7. **自定义消息角色靠声明合并**——进 transcript 不进 LLM，convertToLlm 是唯一投影点。
8. **compaction 只切轮边界**——机制（怎么切）内核给，策略（何时切）产品定。
9. **相位机而非锁**——忙时确定性拒绝，可重入安全。
10. **steer/followUp 是有明确注入点的队列**——内层循环=工具+插话，外层=followUp 续命；不用杀掉重跑来改方向。
11. **保守的工具语义（是设计不是 bug）**——length 截断整批拒执行（salvage 解析的 JSON"校验能过但被截断"）；事件按完成序、transcript 按源序；terminate 需全票。
12. **刻意的洞是规格**——无 CLI、无工具、无权限、无重试、无 eval；HANDBOOK §⑥ 给出每个洞的取材地图（权限抄 mini-cc 的 106 行权限引擎，工具/重试/自动压缩抄上游 coding-agent）。"高级功能全是用公开 API 写的扩展"。

---

## 7. TS 惯用法速查（本仓库实际用到的）

**① 判别联合 + switch 收窄**——整个系统的地基。每个联合都有唯一的字符串字面量判别字段（消息用 `role`，内容块和事件用 `type`）：

```ts
switch (event.type) {
  case "start":  event.partial          // TS 已收窄，访问 payload 零断言
  case "done": case "error": { await response.result(); }
}
```

**② 用 Extract / 索引访问派生类型，而不是重复声明**：

```ts
type AgentToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
// done 事件只能携带成功原因——类型系统强制协议：
{ type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse"> }
```

**③ 泛型类 `EventStream<T, R = T>`**——事件类型和结果类型独立变化；完成语义也是注入的函数（`isComplete`/`extractResult`）。消费端是一个实现 `AsyncIterable<T>` 的 async generator：先排空缓冲 → done 则结束 → 否则把自己的 resolve 塞进 waiting 数组"停车"等生产者叫醒。

**④ 函数类型做依赖注入**——不用接口/类，用函数类型别名（StreamFn、convertToLlm、getSteeringMessages…）。每个缝都能用一个 lambda mock 掉，loop 保持纯编排。

**⑤ 接口声明合并做可扩展词汇表**：

```ts
// agent 包：export interface CustomAgentMessages {}   // 空
// harness 包：
declare module "../types.ts" {
  interface CustomAgentMessages { bashExecution: BashExecutionMessage; /* … */ }
}
// keyof 空接口 = never → AgentMessage 优雅退化为 Message；合并后全局变宽
```

**⑥ 结构化类型即插件机制**——全代码库没有一个 `implements`。整个模块导出 `stream`/`streamSimple` 就满足 `ProviderStreams`；`models.streamSimple` 天然满足 `StreamFn`。开放字符串联合的技巧：`type Api = KnownApi | (string & {})` ——接受任意字符串但保住已知字面量的自动补全。

**⑦ typebox 的 `Static<T>`**——运行时 JSON Schema 和编译期参数类型出自同一份声明：`execute(id, params: Static<TParameters>, …)`。

**⑧ 类型谓词过滤**：`.filter((m): m is Message => m !== undefined)` 把 `(Message|undefined)[]` 收窄成 `Message[]`。

**⑨ 浅不可变约定**——`readonly` 字段 + `ReadonlySet`；tools/messages 用 getter/setter 对做防御性拷贝；emit 时 `{...partialMessage}` 浅拷贝防 listener 改 loop 状态。是约定不是强制。

**⑩ 明确赋值断言**：`private resolveFinalResult!: (r: R) => void`——在 `new Promise` 执行器里同步赋值，但 TS 证明不了，用 `!` 告诉它。

---

## 8. 如何读代码不迷路

**方法论（HANDBOOK 开篇）："问代码，不读代码"**——平时只碰两个文件，其余出问题再按图索骥：

| 时机 | 打开 |
|---|---|
| 任何"这个类型是什么"的瞬间 | `agent/src/types.ts`（**先读这个**） |
| 想懂循环本身 | `agent/src/agent-loop.ts`（**全项目最值得精读**，唯一的 LLM 边界在 `streamAssistantResponse`） |
| 写 UI | 只看 §1-⑤ 的事件序列契约，"UI 就按这个写" |
| 写测试 | `ai/src/providers/faux.ts`（"离线测试全靠它"） |
| 好奇加 provider 的成本 | providers 目录（每个 15-20 行工厂函数） |
| harness 出问题 | 先读 `docs/agent-harness.md`（它是 spec），再看代码 |

**信任分层**（很重要）：`HANDBOOK.md` 和 `.dev/SPEC.md` 是事实核查过的中文 ground truth；`packages/*/README.md` 是冻结的上游文档，还在讲已删除的功能——**永远引用前者**。"文档会撒谎，代码不会"。

**学习路径**（compare 文档）：① 自己手写裸循环（你正在做的）→ 拿 pi 的 agent-loop.ts 当"我漏了什么"清单；② 从 pi-minimal 学无聊的可靠性（错误全整性、相位机、追加式持久化）；③ eval harness——两个仓库都没有，"这正是你要自己做出差异化的地方"；④ 在 pi 内核上搭产品。

---

## 9. 你（my-pi）在这张地图上的位置

- 你已手写完成 **§3 的整个循环**（agent-loop.ts 711 行：双层 while、三段式工具执行、并行/串行、length 截断路径）和 **§4 的 Agent 壳**（485 行）——即 M1–M4。
- 已知差距对应本文的：§3-B 的 `prepareNextTurn` / `shouldStopAfterTurn`（你声明了没调用——harness 的 save point 机制以后要骑在前者上）、§3-E 的结局 ③（你的 abort 提前退出改变了 transcript 尾部形状）。
- 尚未开始的是 **§5 整层**（M5 会话树 → M7 harness → M8 compaction）和 **§8 提到的测试面**（faux provider + mock streamFn）。
- 行动顺序见另一份文档《进度评估与评测调试指南.md》。

**最后再念一遍咒语**：消息向下投影，事件向上冒泡，错误永远是数据；state = reduce(events)；一切皆注入；隐式共享状态换成显式追加记录。迷路时回到这句话，找你所在的层。
