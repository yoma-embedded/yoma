/**
 * 包主入口 barrel(浏览器安全):@yoma/my-pi 的公开 API 全部从这里 re-export。
 * 在「一次 prompt 的完整链路」上,它是宿主(桌面端 host / ACP 适配器 / bench)
 * 拿到 AgentHarness、runAgentLoop、Session 等构件的唯一正门 —— 全景篇 §0 分层图里
 * 「packages/agent = 怎么循环着干活」这一层对外露出的边界,对应全景篇 §2.2。
 * 对应学习文档:docs/learn/agent/index.md
 *
 * 分节索引:
 *   §1 裸循环三件套 —— Agent 类 / agent-loop 状态机 / 全部契约类型(types.ts)
 *   §2 Harness 主体 —— AgentHarness(相位机、turn 快照、事件分发、compact/navigateTree)
 *   §3 Compaction 白名单导出 —— 分支摘要 + 上下文压缩,具名清单避免歧义星号导出
 *   §4 会话树、消息投影、技能与工具 —— session/*、messages.ts、skills.ts 等
 *   §5 Node 专用出口预留 —— proxy.ts 目前是空桩,注释掉不导出
 *
 * 本文件全程不碰 node:fs / child_process,因此可以被浏览器打包安全 import;
 * 真正碰文件系统的 NodeExecutionEnv 单独放在 ./node.ts,那个文件转发本文件的
 * 全部导出、再多导出这一个符号,两个入口分别对应 package.json 的 "." 和 "./node"。
 */

// ── §1 裸循环三件套:Agent 类 / agent-loop 状态机 / 全部契约类型 ──────────
// Core Agent
// Agent 类:runAgentLoop 的有状态包装(队列/订阅/单飞行守卫)。
// 全景篇 §2.2 指出它在本仓没有生产调用方——桌面端与 ACP 都直接用更重的
// AgentHarness——留在这里是因为它是「裸 loop 该怎么被包起来」的参考实现。
export * from "./agent.ts";
// Loop functions
// runAgentLoop / runAgentLoopContinue 等:整套代码里唯一的状态机,
// 全景篇 §4 步骤④。harness 自己没有循环,全靠这里的双层 while 驱动多轮。
export * from "./agent-loop.ts";
// Types
// AgentContext / AgentMessage / AgentTool / AgentEvent / AgentLoopConfig /
// StreamFn 等零逻辑的契约类型,是本包与 coding-agent、与 harness 之间的接口。
export * from "./types.ts";

// ── §2 Harness 主体:会话外壳 ─────────────────────────────────────────
// Harness / proxy — remaining commented modules are still empty stubs.
// Re-enable when those modules are implemented.
// AgentHarness:相位机(idle/turn/compaction/branch_summary/retry)、
// turn 快照冻结、挂起写入队列、事件三路分发,全景篇 §4 步骤②③⑧的落点。
export * from "./harness/agent-harness.ts";

// ── §3 Compaction 白名单导出:避免歧义星号导出 ───────────────────────
// 只导出具名清单:compaction 模块内部还定义了与 harness/types.ts 同名的类型,
// 用 export * 会产生歧义星号导出。
// 效果(已用 grep 核实):CompactionDetails / CompactionResult / CutPointResult /
// ContextUsageEstimate 等类型只在 compaction.ts 内部 export,不在下面的白名单
// 里,于是从包根 import 不到——要用只能深引用
// "@yoma/my-pi/harness/compaction/compaction.ts"。branch-summarization.ts 这边
// 同理,只白名单导出了 6 个符号,GenerateBranchSummaryOptions 等其余类型同样
// 拿不到。见文档 §5。
// 上面 L43-44 给的理由(同名冲突→歧义星号导出)已用 tsgo 实测证伪:把这两个模块临时
// 整体换成 export *,与本文件其余全部星号导出模块一起跑 `tsgo --noEmit --strict`,
// CompactionResult 等名字照样能从聚合出口 import 到——逐一比对过全部导出标识符
// (类型 + 值),这两个模块与其余模块之间眼下没有任何一个同名冲突。真正挡住这些类型
// 的不是"撞名被静默剔除",单纯是这份白名单没列它们。
// branch-summarization.ts 的白名单:切分支(fork/navigateTree)时把旧分支
// 压成一段摘要用到的类型与函数,配合 harness/types.ts 的 BranchSummaryEntry。
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
// compaction.ts 的白名单:上下文压缩算法本体。compact() 被
// harness/agent-harness.ts 的 AgentHarness.compact()(相位机里 idle-only 的
// 一条侧枝,已核实调用点)直接调用;estimateContextTokens / shouldCompact /
// DEFAULT_COMPACTION_SETTINGS 是判断「要不要压」的纯函数 + 默认阈值,桌面端
// host/compaction.ts 的 shouldAutoCompact() 就是拿这三个纯函数编出来的,
// 判完再另外调一次 harness.compact() 真正执行。
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

// ── §4 会话树、消息投影、技能与工具 ───────────────────────────────────
// messages.ts:四个自定义消息角色(bashExecution/custom/branchSummary/
// compactionSummary)的注册处 + convertToLlm——全景篇 §1 强调的「唯一 LLM
// 边界」,AgentMessage 降维成 pi-ai Message 只在这一处发生。
export * from "./harness/messages.ts";
// 技能 / promptFromTemplate 用到的模板类型,与 harness/skills.ts 配套。
export * from "./harness/prompt-templates.ts";
// jsonl-repo / jsonl-storage 是磁盘上的真实现(一行 header + 一行一条目的
// 追加日志);memory-repo / memory-storage 是同接口的纯内存实现,不依赖
// Node fs——本包 test/ 下的单测和「没有 FileSystem 的环境(浏览器)」用它
// 替换,二者共享 SessionRepo / SessionStorage 接口(定义在下面的
// harness/types.ts)。生产路径(桌面端 / ACP)走的始终是 jsonl 那一对。
export * from "./harness/session/jsonl-repo.ts";
export * from "./harness/session/jsonl-storage.ts";
export * from "./harness/session/memory-repo.ts";
export * from "./harness/session/memory-storage.ts";
// 两套 repo 共用的小工具 + fork 的 before/at 取材规则。
export * from "./harness/session/repo-utils.ts";
// Session 类:会话树门面,buildContext() 是全景篇 §4 步骤③的投影入口,
// 9 个 append* 方法是磁盘写入的唯一路径(session.ts 自己的注释也写作「九个」)。
export * from "./harness/session/session.ts";
// 手写 UUIDv7 生成器只具名导出 uuidv7 本身,内部的单调 sequence 状态不导出。
export { uuidv7 } from "./harness/session/uuid.ts";
// AGENTS.md / SKILL.md 发现与解析,coding-agent 的两个宿主都靠它读技能。
export * from "./harness/skills.ts";
// formatSkillsForSystemPrompt:只管把技能列表格式化成 <available_skills>
// 这一个 XML 区块;完整系统提示词(身份/工具清单/守则)是 coding-agent 的
// buildSystemPrompt 的事,见该文件头注释。
export * from "./harness/system-prompt.ts";
// harness 层契约总仓:Result 约定、ExecutionEnv、11 种会话树条目、
// Storage/Repo 家族、19 种事件与返回值契约,全部在这一个文件里。
export * from "./harness/types.ts";
// 全景篇 §4 步骤⑩提到的输出治理:executeShellWithCapture 把子进程输出
// 收口成结构化结果。
export * from "./harness/utils/shell-output.ts";
// truncateHead / truncateTail:字符串太长时怎么砍。shell-output.ts 只用 truncateTail
// 做尾部截断;truncateHead 的调用方是 coding-agent 的 read 工具(按行数上限读文件时)。
export * from "./harness/utils/truncate.ts";

// ── §5 Node 专用出口预留 ──────────────────────────────────────────────
// 已核实:./proxy.ts 这个文件当前在 src/ 下根本不存在,不是"存在但内容为空"的
// stub——呼应 §2 顶部那句「remaining commented modules are still empty
// stubs」,先把这行留成注释占位,等 proxy.ts 真的被建出来再打开。
// export * from "./proxy.ts";
