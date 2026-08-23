# 上游关系:`packages/coding-agent` ← pi `packages/coding-agent`

> 2026-08-21 对标核实的结论。

## 基线

- 上游仓:`git@github.com:earendil-works/pi.git`(本机检出 `D:\toy\pi`)。
- **基线提交:`f8f75544b63c5910568b2a0f667da858e4a11147`(2026-07-13)**,不是 `v0.80.6`。

## 这个包的性质:**产品,永久 fork**

- 41 个上游从未有的文件:嵌入式工具组(netlist / datasheet / stm32config / flash / log / gdb / gdb-mi /
  serial / engines / examples / toolchain)、`core/toolchain/`、`core/examples/`、ACP 适配器(上游全仓
  grep `agentclientprotocol` 零命中)。
- 从基线保留的 10 个文件(`core/tools/{read,bash,edit,write,edit-diff,path-utils,file-mutation-queue,index}.ts`、
  `core/system-prompt.ts`、`core/resources.ts`)全部重写过:四件套手工剥掉 TUI 渲染器,接到内核**早已存在**的
  `ExecutionEnv` / `executeShellWithCapture` 上(这两样 0.80.6 就有,不是 yoma 发明的)。
- 删掉了上游的 153 个文件:TUI / CLI / `modes/{interactive,rpc,...}` / `extensions/` / `core/agent-session.ts` /
  `core/sdk.ts` / http-dispatcher。**压缩、重试、默认思考档位的策略层就在被删的 `AgentSession` 里**,
  yoma 在 `kernel/src/host/{compaction,retry,session-manager}.ts` 重建了只服务桌面端的最小子集 ——
  要找上游参照(比如溢出压缩策略)去 `D:\toy\pi\packages\coding-agent\src\core\agent-session.ts`,
  不要被"内核只给了机制"这句话误导成上游没有。
- `src/acp/models.ts` **同时是桌面端、bench、Zed 三个消费方的模型目录来源**(经 `@yoma/coding-agent/models`
  深引用别名可达)。目录本身来自 pi-ai 的 `builtinProviders()`(2026-08-23 起,从前是两家的手写表);这个文件
  只管凭证(`FileCredentialStore`)、选择(`YOMA_*` / settings.json)和"一个 key 就能用"的过滤
  (`configurableProviders()`)。动它要验三条路。

## 与上游工具层的关系:不跟 `agent/src/harness/tools/`

上游在 2026-07-21/22(`37eb243d2`、`e32c1491b`)把 read/bash/edit/write **复制**了一份到
`packages/agent/src/harness/tools/`(ExecutionEnv 形态,零 TUI)。它看起来和 yoma 的四件套同构,但:

- 它是**第二副本**:上游 coding-agent 生产路径仍用自己那份 TUI 版(`core/tools/`,多出 grep/ls/find),
  headless 那份的唯一消费者是 agent 包自己的测试;两份已分叉,同一个 bug 修两遍(`ca21c1686`),
  多数工具改进落在 TUI 那份(12 vs 3 个提交)。
- 签名不同:上游 headless 工具是 `AgentHarnessTool`,`execute` 的第 5 个参数传 `{ env }`;yoma 是 `AgentTool`
  (4 参数),env 在工厂期闭包进去。换过去要改 yoma 全部 20 个工具 + 重改过的 `agent-harness.ts`。
- **上游 CI 零 Windows 岗**。yoma 的 `path-utils.ts` 比上游多出的 42 行正是 msys 路径转换;read/bash 的
  Windows 分支也是 yoma 自己修的。换成上游版 = 拿一段从未在 Windows 上跑过的代码换掉专门为 Windows 修过的。
- 按共有行数算,yoma 的四件套与 0.80.6 祖本的重叠**高于**与上游 headless 版(diff 行数随目标文件变短而机械变小,
  不能当收敛度)。

唯一值得单独跟踪的是内核的 `harness/utils/shell-output.ts`(与上游 HEAD 只差 28 行)。

## 待接的三件(各自独立)

| 优先 | 事项 | 出处 | 状态 |
|---|---|---|---|
| P0 | `DEEPSEEK_COMPAT` 加 `maxTokensField:"max_tokens"` —— 2026-08-21 实测 DeepSeek **静默忽略** `max_completion_tokens`,于是压缩/分支摘要请求对 DeepSeek 没有输出上限 | 上游 `c185d4123` 在 pi-ai 侧修;yoma 在 compat 侧兜 | **已修** |
| P3 | `prepareEditArguments` 补一个分支:`edits` 是 JSON 字符串且 parse 出**单个对象**时包成 `[parsed]`。裸的单个 edit 对象今天就能跑(pi-ai 的 TypeBox `Value.Convert` 会把对象强转成一元数组),失败也是可自愈的 isError tool result,不是崩 | `ca21c1686` | **已修** |
| P3 | `skillDirsOf()` 加 `~/.agents/skills`(跨 harness 的标准全局位置,Claude Code 看得到、yoma 看不到)。这个函数是有意简化过的(不沿祖先目录找 `.agents/skills`),加之前一并决定沿不沿祖先找 | 上游 `resource-loader.ts` | **已加**(不沿祖先目录找,维持原简化) |
| P2 | strict tool schema / constrained sampling:对 gdb / log / toolchain / examples 这类 action 枚举型工具是参数编错的根治手段。上游自己锁在 `PI_EXPERIMENTAL=1` 后面;`strict:"prefer"` 不支持时静默降级;`MOONSHOT_COMPAT.supportsStrictMode=false` 的 moonshot 侧拿不到;**必须连 pi-ai 的 `normalizeOptionalNulls` 一起移植** | `24bace27c` + `7915cdac6` | pi-ai 0.84.2 已自带 `constrainedSampling` 与 `normalizeOptionalNulls`,只差在工具定义上开关;先在 deepseek 上实测再默认开 |

## 不做

- 不接上游扩展系统 / pi packages 分发 / `registerProvider` + `models.json`(coding-agent 的 `ModelRuntime`
  那一层):嵌入式工具组是产品内置,不需要第三方分发;pi-ai 的静态内建目录已经覆盖全部 40 家,
  叠加 settings + 远程目录 + 扩展 provider 换来的只是自定义 baseUrl 与离线目录更新,不值 2000 行。
- 不接上游 RPC(`--mode rpc` JSONL)/ 新 `packages/protocol`:yoma 的 renderer↔内核协议见 `packages/kernel`。
- 不迁到 `createAgentSession()` SDK:它 0.80.6 就有,当初不用是因为它拖着 3469 行 `AgentSession`
  + 八个值级 import pi-tui 的工具文件;"用 SDK"对 yoma 的真实成本是移植并长期维护那份 fork 差异,不是 bundle 体积。
