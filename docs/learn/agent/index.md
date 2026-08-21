# packages/agent/src/index.ts

> **档位** B(分段) · **行数** 130(注释前 49,独立核验补注释后又 +6) · **包** `@yoma/my-pi`
> **上游** [全景篇](../00-内核全景.md) §2.2 · **索引** [README](../README.md)

## 1. 一句话

这是 `@yoma/my-pi` 包的主入口 barrel —— 一份纯 re-export 清单,没有任何自己的逻辑,决定了「从包根 `import { ... } from "@yoma/my-pi"` 能拿到什么」。

## 2. 它在全景里的位置

这个文件本身不出现在全景篇 §4 的 48 步生命周期里 —— 它不跑逻辑,是**编译期/打包期**的一道门,不是运行期的一跳。但它决定了链路上几乎每一跳「从哪里 import」:全景篇 §0 分层图里画的 `AgentHarness`(步骤②)、`Session`(步骤③)、`runAgentLoop`(步骤④)、`convertToLlm`(步骤⑤)、`compact()`(步骤⑫附近的自动压缩)全部经这个文件从包根导出。

三类消费方:

1. **`packages/agent/src/node.ts`**(4 行)—— 本包自己的 Node 专用入口,`export * from "./index.ts"` 转发这个文件的全部导出,再多导出一个 `NodeExecutionEnv`。两个入口对应 `package.json` 的 `"."` 和 `"./node"` 两个 exports 条目。
2. **`packages/coding-agent`** —— 工具集需要 `AgentTool`、`AgentContext` 等类型时从包根 import。
3. **`packages/kernel/src/host/*`**(桌面端 host)—— 全景篇 §6 讲到的自动压缩(`host/compaction.ts`)、模型目录等,直接 `import { ... } from "@yoma/my-pi"`,这个文件是它们唯一能看到的入口形状。

如果这个文件不存在(或漏导出了什么),后果不是运行时报错,而是**编译期**在消费方那里报「找不到这个导出」—— 这也是为什么它值得单独理解:它是本包对外承诺的"公开 API 表面"本身。

一个需要特别记住的反直觉点(已用 grep 核实):`packages/agent/src/harness/compaction/compaction.ts` 内部定义的 `CompactionDetails` / `CompactionResult` / `CutPointResult` / `ContextUsageEstimate` 这些类型**不在这个文件的白名单里**,所以从包根 `import { CompactionResult } from "@yoma/my-pi"` 是拿不到的 —— 要用只能深引用 `@yoma/my-pi/harness/compaction/compaction.ts`。这不是失误,是源码写成了具名清单而不是 `export *` 的直接结果;但源码注释给的"因为同名冲突"这条**理由**已用 tsgo 实测证伪(见 §3、§5),拿不到是真的,原因不是那个。

## 3. 文件结构总览

| 节 | 行号 | 内容 |
|---|---|---|
| 头部块注释 | L1–L18 | 文件职责、分节索引、「浏览器安全」声明 |
| §1 | L20–L33 | 裸循环三件套:`agent.ts`(Agent 类)/ `agent-loop.ts`(状态机)/ `types.ts`(契约类型) |
| §2 | L35–L40 | Harness 主体:`harness/agent-harness.ts` 整个星号导出 |
| §3 | L42–L85 | Compaction 白名单导出:`branch-summarization.ts` + `compaction.ts`,均为具名清单而非 `export *` |
| §4 | L87–L124 | 会话树、消息投影、技能与工具:`messages.ts` / `prompt-templates.ts` / `session/*`(6 个文件)/ `skills.ts` / `system-prompt.ts` / `harness/types.ts` / `utils/{shell-output,truncate}.ts` |
| §5 | L126–L130 | Node 专用出口预留:`proxy.ts` 尚不存在,注释掉不导出 |

> 行号是**独立核验后**的当前值——初稿写文档时源码注释还没加完,后续在源码里修正了几处错误说法(§3 的「同名冲突」归因、§4 的 `append*` 计数、`truncateHead` 调用方),每次都往对应的星号导出上方插了新注释行,§3/§4/§5 因此比初稿多出几行,行号整体下移。

## 4. 逐节讲解

### 头部与 §1:裸循环三件套(L1–L33)

`L20–L25`
```ts
// ── §1 裸循环三件套:Agent 类 / agent-loop 状态机 / 全部契约类型 ──────────
// Core Agent
// Agent 类:runAgentLoop 的有状态包装(队列/订阅/单飞行守卫)。
// 全景篇 §2.2 指出它在本仓没有生产调用方——桌面端与 ACP 都直接用更重的
// AgentHarness——留在这里是因为它是「裸 loop 该怎么被包起来」的参考实现。
export * from "./agent.ts";
```

三个 `export *`,分别导出 `agent.ts`(有状态的 `Agent` 类包装)、`agent-loop.ts`(全景篇 §1 强调的「整套代码里唯一的状态机」`runAgentLoop`)、`types.ts`(`AgentContext` / `AgentMessage` / `AgentTool` / `AgentEvent` / `AgentLoopConfig` / `StreamFn` 等零逻辑契约类型)。`Agent` 类值得单独说一句:全景篇 §2.2 明确指出它在本仓**没有生产调用方**——桌面端和 ACP 都直接用更重的 `AgentHarness`,`Agent` 现在只是「裸 loop 该怎么被有状态地包起来」的参考实现,与 `agent.test.ts` 的被测对象。改它不影响桌面端,但对照着读能理解 harness 每一样状态管理(队列、单飞行守卫、事件折算回状态)的一个更简单原型。

### §2:Harness 主体(L35–L40)

`L35–L40`
```ts
// ── §2 Harness 主体:会话外壳 ─────────────────────────────────────────
// Harness / proxy — remaining commented modules are still empty stubs.
// Re-enable when those modules are implemented.
// AgentHarness:相位机(idle/turn/compaction/branch_summary/retry)、
// turn 快照冻结、挂起写入队列、事件三路分发,全景篇 §4 步骤②③⑧的落点。
export * from "./harness/agent-harness.ts";
```

只有一行真正的导出。`AgentHarness` 是全景篇 §4 图里步骤②③⑧的落点:相位机(`idle`/`turn`/`compaction`/`branch_summary`/`retry`)、turn 快照冻结、挂起写入队列、事件三路分发,全部在这一个类里。这一节的原始注释里那句 "remaining commented modules are still empty stubs" 呼应的正是 §5 那行被注释掉的 `proxy.ts` 导出。

### §3:Compaction 白名单导出(L42–L85)

`L58–L65`
```ts
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
```

这是全文件里唯一两处不用 `export *` 的地方。源码注释(L43–L44,文件里原有的一句)给出的理由:`compaction` 模块内部定义了与 `harness/types.ts` 同名的类型,`export *` 遇到同名冲突时 TypeScript/ES 模块的行为是**静默剔除该名字**(不是编译错误),比报错更危险。

**这条理由本身已用 tsgo 实测证伪。** 把 `branch-summarization.ts` 和 `compaction.ts` 临时整体换成 `export *`,与本文件其余全部星号导出模块放在一起跑 `tsgo --noEmit --strict`(项目实际用的检查器和配置):`CompactionResult`、`CompactionDetails`、`CutPointResult`、`ContextUsageEstimate`、`GenerateBranchSummaryOptions` 全都能从聚合出口正常 `import` 到,没有任何一个被剔除。用 `comm` 逐一比对了 `compaction.ts`/`branch-summarization.ts` 导出的全部标识符(类型 + 值)与本文件其余每一个星号导出模块的导出标识符,交集是空集——当前代码里这两个模块与barrel 里其它任何模块之间**不存在**同名冲突。

"`export *` 遇同名冲突会静默剔除"这条 ES 模块规则本身是真的(下面自测题 1 的答案依然成立),但它不是**这份白名单存在的原因**——现在真正让 `CompactionResult` 这类类型拿不到的,单纯是白名单没把它们列进去,不是"列了会撞车"。这条理由更像是历史遗留的注释(或者防御性的预留),已经和当前代码状态对不上号了。

`branch-summarization.ts` 只白名单导出了 6 个符号(3 个类型 + 3 个函数),`GenerateBranchSummaryOptions` 这类没进清单的类型同样拿不到。

`L72–L85`
```ts
export {
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
```

`compact()` 是压缩算法本体;已核实的调用点是 `harness/agent-harness.ts` 里 `AgentHarness.compact()`(相位机的一条 idle-only 侧枝)。`estimateContextTokens` / `shouldCompact` / `DEFAULT_COMPACTION_SETTINGS` 是「要不要压」的纯函数与默认阈值 —— 桌面端 `packages/kernel/src/host/compaction.ts` 的 `shouldAutoCompact()` 正是拿这三个纯函数编出的决策逻辑,判完之后再单独调一次 `harness.compact()` 真正执行(两次调用,不是一次)。

**没进清单、因此从包根拿不到的类型**(已用 grep 核实存在于 `compaction.ts` 但未出现在 L72–85 的名单里):`CompactionDetails`、`CompactionResult`、`ContextUsageEstimate`、`CutPointResult`。

### §4:会话树、消息投影、技能与工具(L87–L124)

这一节体量最大,按职责分四组读:

**LLM 边界与提示词**(`L88–L93`)
```ts
// messages.ts:四个自定义消息角色(bashExecution/custom/branchSummary/
// compactionSummary)的注册处 + convertToLlm——全景篇 §1 强调的「唯一 LLM
// 边界」,AgentMessage 降维成 pi-ai Message 只在这一处发生。
export * from "./harness/messages.ts";
// 技能 / promptFromTemplate 用到的模板类型,与 harness/skills.ts 配套。
export * from "./harness/prompt-templates.ts";
```
`messages.ts` 是全景篇 §1 强调的「只有一个 LLM 边界」的落点:四个自定义消息角色(`bashExecution` / `custom` / `branchSummary` / `compactionSummary`)在这里注册,`convertToLlm()` 把 `AgentMessage`(内部形状)降维成 pi-ai 的 `Message`(能发给模型的形状),是唯一的转换点。`prompt-templates.ts` 是 `promptFromTemplate` 用到的模板类型,与 `harness/skills.ts` 配套。

**会话树的两套实现**(`L94–L102`)
```ts
// jsonl-repo / jsonl-storage 是磁盘上的真实现(一行 header + 一行一条目的
// 追加日志);memory-repo / memory-storage 是同接口的纯内存实现,不依赖
// Node fs——本包 test/ 下的单测和「没有 FileSystem 的环境(浏览器)」用它
// 替换,二者共享 SessionRepo / SessionStorage 接口(定义在下面的
// harness/types.ts)。生产路径(桌面端 / ACP)走的始终是 jsonl 那一对。
export * from "./harness/session/jsonl-repo.ts";
export * from "./harness/session/jsonl-storage.ts";
export * from "./harness/session/memory-repo.ts";
export * from "./harness/session/memory-storage.ts";
```
`jsonl-repo.ts` / `jsonl-storage.ts` 是磁盘上的真实现(一行 header + 一行一条目的追加日志,永不改写);`memory-repo.ts` / `memory-storage.ts` 是同接口(`SessionRepo` / `SessionStorage`,定义在 `harness/types.ts`)的纯内存实现,不依赖 `node:fs`。已读过两个文件的头部注释:它们的消费方是本包 `test/` 下的单测,以及「没有 `FileSystem` 的环境(浏览器)」——生产路径(桌面端 / ACP)走的始终是 jsonl 那一对。

紧接着(`L103–L109`):
```ts
// 两套 repo 共用的小工具 + fork 的 before/at 取材规则。
export * from "./harness/session/repo-utils.ts";
// Session 类:会话树门面,buildContext() 是全景篇 §4 步骤③的投影入口,
// 9 个 append* 方法是磁盘写入的唯一路径(session.ts 自己的注释也写作「九个」)。
export * from "./harness/session/session.ts";
// 手写 UUIDv7 生成器只具名导出 uuidv7 本身,内部的单调 sequence 状态不导出。
export { uuidv7 } from "./harness/session/uuid.ts";
```
`repo-utils.ts` 是两套 repo 共用的小工具 + fork 的 before/at 取材规则。`session.ts` 导出 `Session` 类 —— 会话树门面,`buildContext()` 是全景篇 §4 步骤③的投影入口,9 个 `append*` 方法是磁盘写入的唯一路径(`appendMessage`/`appendThinkingLevelChange`/`appendModelChange`/`appendActiveToolsChange`/`appendCompaction`/`appendCustomEntry`/`appendCustomMessageEntry`/`appendLabel`/`appendSessionName`;私有的 `appendTypedEntry` 是它们共用的收口,不算在内)。`uuid.ts` 只具名导出 `uuidv7` 这一个函数,内部的单调 sequence 状态刻意不对外暴露。

**技能与提示词**(`L110–L115`)
```ts
// AGENTS.md / SKILL.md 发现与解析,coding-agent 的两个宿主都靠它读技能。
export * from "./harness/skills.ts";
// formatSkillsForSystemPrompt:只管把技能列表格式化成 <available_skills>
// 这一个 XML 区块;完整系统提示词(身份/工具清单/守则)是 coding-agent 的
// buildSystemPrompt 的事,见该文件头注释。
export * from "./harness/system-prompt.ts";
```
`skills.ts` 管技能的发现(目录递归 + frontmatter 解析)与解析。`system-prompt.ts` 的 `formatSkillsForSystemPrompt` 只做一件窄的事 —— 把技能列表格式化成系统提示词里的 `<available_skills>` XML 区块;完整的系统提示词(身份/工具清单/守则)是 `coding-agent` 的 `buildSystemPrompt` 的事,读它的文件头注释可以确认这条分工。

**契约总仓与输出治理**(`L116–L124`)
```ts
// harness 层契约总仓:Result 约定、ExecutionEnv、11 种会话树条目、
// Storage/Repo 家族、19 种事件与返回值契约,全部在这一个文件里。
export * from "./harness/types.ts";
// 全景篇 §4 步骤⑩提到的输出治理:executeShellWithCapture 把子进程输出
// 收口成结构化结果。
export * from "./harness/utils/shell-output.ts";
// truncateHead / truncateTail:字符串太长时怎么砍。shell-output.ts 只用 truncateTail
// 做尾部截断;truncateHead 的调用方是 coding-agent 的 read 工具(按行数上限读文件时)。
export * from "./harness/utils/truncate.ts";
```
`harness/types.ts` 是 harness 层的契约总仓:`Result` 约定、`ExecutionEnv`、11 种会话树条目、`Storage`/`Repo` 家族、19 种事件与返回值契约。`shell-output.ts` 是全景篇 §4 步骤⑩提到的输出治理(`executeShellWithCapture`);`truncate.ts` 提供 `truncateHead`/`truncateTail` 两个函数,但 `shell-output.ts` 自己只用 `truncateTail` 做尾部截断(已用 grep 核实)—— `truncateHead` 的调用方是 `packages/coding-agent` 的 read 工具,不是这个文件里的任何一个 barrel 出口。

### §5:Node 专用出口预留(L126–L130)

`L126–L130`
```ts
// ── §5 Node 专用出口预留 ──────────────────────────────────────────────
// 已核实:./proxy.ts 这个文件当前在 src/ 下根本不存在,不是"存在但内容为空"的
// stub——呼应 §2 顶部那句「remaining commented modules are still empty
// stubs」,先把这行留成注释占位,等 proxy.ts 真的被建出来再打开。
// export * from "./proxy.ts";
```
已用 `find` 核实:`packages/agent/src/proxy.ts` 目前根本不存在(不是"文件存在但是空文件"),这行注释是给未来功能预留的占位符。

## 5. 会咬人的地方

- **【与「空桩」措辞容易误解】** 原始行内注释 "remaining commented modules are still empty stubs" 读起来像是说 `proxy.ts` 已经作为一个空文件存在,实际用 `find packages/agent/src -iname "proxy*"` 核实过 —— 这个路径当前完全不存在。改代码前如果想"顺手把 proxy.ts 建出来再打开导出",要知道现在连空壳都没有。
- **【类型从包根拿不到,是有意为之而不是遗漏】** L42–L85(§3)。`CompactionDetails` / `CompactionResult` / `CutPointResult` / `ContextUsageEstimate`、以及 `branch-summarization.ts` 里没进白名单的类型(如 `GenerateBranchSummaryOptions`),都无法通过 `import { X } from "@yoma/my-pi"` 拿到。需要它们时只能深引用具体文件路径。这个约束容易在写新代码时踩到「明明这个类型存在,为什么 import 不到」的坑。
- **`export *` 遇同名冲突是静默剔除,不是编译报错** —— 这条 ES 模块规则本身是真的,自测题 1 演示的就是它。但**它不是** §3 那两处具名导出的实际成因:源码 L43–L44 的注释这么写,却已用 tsgo 实测证伪——当前 `compaction.ts`/`branch-summarization.ts` 与 barrel 里其余任何模块之间都不存在同名标识符,把它们换成 `export *` 一样能把 `CompactionResult` 等类型正常导出。看到某个 barrel 文件用具名清单而不是 `export *`,不能想当然套用"一定是在防同名冲突"这个理由,得去核实真有没有撞名。
- **两处 `compact()` / `harness.compact()` 容易搞混。** L72–L85 白名单导出的 `compact` 是 `compaction.ts` 里的算法函数;`AgentHarness` 类上还有一个同名方法 `compact()`,后者是相位机的 idle-only 方法,内部调用前者。名字相同但不是同一个东西,读调用链时注意区分。
- **独立核验时改正过的三处**:① `session.ts` 的 `append*` 方法是 **9 个**不是 10 个(源码 §4 处曾写错,`session.ts` 自己的注释写的是「九个」,已用 grep 逐个点名核对);② `shell-output.ts` 只用 `truncateTail` 一个函数做尾部截断,`truncateHead` 的调用方其实是 `packages/coding-agent` 的 read 工具,不是这个文件里星号导出的任何模块;③ 上面这条「同名冲突导致静默剔除」的因果关系已证伪,见上文。除这三处外,本文件是纯 barrel,逻辑面很薄,其余核实过的细节(白名单类型缺口本身确实存在、`proxy.ts` 不存在、`compact()` 调用点、19 种事件、11 种会话树条目)均已验证无误。

## 6. 与它相邻的文件

| 关系 | 文件 | 说明 |
|---|---|---|
| 它 import(全部是 `export * from` / 具名 `export {} from`,不产生自己的逻辑) | `agent.ts`、`agent-loop.ts`、`types.ts`、`harness/agent-harness.ts`、`harness/compaction/branch-summarization.ts`、`harness/compaction/compaction.ts`、`harness/messages.ts`、`harness/prompt-templates.ts`、`harness/session/{jsonl-repo,jsonl-storage,memory-repo,memory-storage,repo-utils,session,uuid}.ts`、`harness/skills.ts`、`harness/system-prompt.ts`、`harness/types.ts`、`harness/utils/{shell-output,truncate}.ts` | 本文件是这 18 个模块的唯一星号/具名聚合点 |
| import 它 | `packages/agent/src/node.ts` | `export * from "./index.ts"` 转发全部导出,再加 `NodeExecutionEnv` |
| import 它(跨包) | `packages/coding-agent/src/*`、`packages/kernel/src/host/*` | 经 `@yoma/my-pi` 裸说明符消费包根导出的类型与函数 |
| 未导出、刻意不出现在这里 | `packages/agent/src/harness/env/nodejs.ts`(`NodeExecutionEnv`) | 碰 `node:fs`/`child_process`,只从 `./node.ts` 走,保证本文件浏览器安全 |

## 7. 自测题

<details><summary>1. 如果把 §3 里 `branch-summarization.ts` 的具名导出改成 `export * from "./harness/compaction/branch-summarization.ts";`,会立刻报编译错误吗?</summary>

不会报错——这条本身是对的:`export *` 遇到真撞名的导出时,TypeScript/ES 模块规范的处理方式是**静默地把这个名字从聚合导出里剔除**,不是编译错误。

但要注意:这一步在**当前代码**里换了也不会丢任何名字。已用 tsgo 实测过(把这两个模块临时换成 `export *` 后跑 `tsgo --noEmit --strict`,并逐一比对导出标识符列表),`branch-summarization.ts` 与本文件其余星号导出的模块之间眼下没有一个同名冲突,所以换掉之后 `GenerateBranchSummaryOptions` 等原本拿不到的类型反而会变得能从包根拿到——不是"会报错",也不是"会静默丢东西",而是"会多导出几个之前故意没给的名字"。源码 L43–L44 那句"因为同名冲突"是这份白名单**写着的**理由,但不是它**现在**成立的理由。

</details>

<details><summary>2. `import { CompactionResult } from "@yoma/my-pi"` 能成功吗?为什么?</summary>

不能。`CompactionResult` 是 `harness/compaction/compaction.ts` 内部 `export interface CompactionResult` 定义的类型,但 L72–L85 的具名白名单里没有它。要拿到它必须深引用 `@yoma/my-pi/harness/compaction/compaction.ts`(或者等价的相对路径,视消费方的模块解析设置而定)。

这一点和"为什么"要分开看:拿不到是**事实**(白名单里确实没列这个名字)。但"为什么没列"如果答成"因为它和 `harness/types.ts` 撞名,`export *` 会静默剔除它",那是错的——已实测这个名字和 barrel 里任何其它模块都不撞名,白名单单纯就是没把它写进去而已。

</details>

<details><summary>3. `packages/kernel/src/host/compaction.ts` 的自动压缩逻辑里,`shouldAutoCompact()` 判断"该压了"之后,是谁真正执行压缩?</summary>

不是 `shouldAutoCompact()` 自己调用 `compact()` 那个纯函数。已核实的调用链是:`session-manager.ts` 先调 `shouldAutoCompact()`(用到 `estimateContextTokens`/`shouldCompact`/`DEFAULT_COMPACTION_SETTINGS` 三个从 `@yoma/my-pi` 拿到的纯函数)拿到决策,决策为真之后再单独调用 `entry.harness.compact()` —— 也就是 `AgentHarness` 类上那个 idle-only 的方法,由它在内部调用 `compaction.ts` 里同名的 `compact()` 函数完成真正的压缩。是两次独立的调用,不是一次。

</details>

<details><summary>4. `Agent` 类(`agent.ts`,§1 导出)在本仓库有生产环境的调用方吗?删掉它会不会影响桌面端?</summary>

没有生产调用方。全景篇 §2.2 明确指出桌面端与 ACP 适配器都直接使用更重的 `AgentHarness`,`Agent` 类现在的角色是「裸 loop 该怎么被有状态地包起来」的参考实现,以及 `agent.test.ts` 的被测对象。删掉或大改它不会影响桌面端的运行路径,但会失去一个理解 harness 内部状态管理(队列、单飞行守卫、事件折算回状态)的简化对照样本。

</details>

<details><summary>5. 如果新建了 `packages/agent/src/proxy.ts` 并给它写好了实现,是不是只要打开 §5 那行注释就完事了?</summary>

打开注释导出(`export * from "./proxy.ts";`)是必要步骤,但还要检查这个新模块会不会与已经被 `export *` 出去的其它模块(尤其是 `harness/types.ts`,它是整个 barrel 里类型最多、最容易撞名的一个)产生同名冲突——如果撞了名,按 §3 的经验,正确做法是把 `proxy.ts` 也换成具名清单导出,而不是继续用 `export *`,否则会静默丢失某个导出而不自知。

</details>
