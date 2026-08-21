# Yoma 内核学习文档

这套文档把 Yoma 内核三个包(`packages/ai` / `packages/agent` / `packages/coding-agent`,共 **120 个源文件**)逐个讲清楚:每个文件干什么、为什么这么写、哪里会咬人。

## 怎么用

1. **第一次来,先读 [`00-内核全景.md`](./00-内核全景.md)。**
   它建立整体印象:三个包的关系、从「用户敲一句话」到「工具落地 + 结果落盘」的完整分层图、核心概念词典、一次完整请求的生命周期(编号时间线,每步注明 `文件:函数`)、跨包接线表、会咬人的地方、推荐阅读顺序。**不读它直接翻单文件文档,会有大量名词认不出来。**
2. **之后按需查单文件文档。** 下面的清单按包分表,列出了每个文件的行数、一句话职责、档位和文档链接。
3. **想先看图**,打开 [`内核结构图.html`](./内核结构图.html)(双击即可,离线自包含)。
   120 个文件按行数铺成一张 treemap,点任意一块看它依赖谁、谁依赖它;另有三包分层图、
   承重墙排行、一次 prompt 的执行顺序和可搜索的文件清单。图里的每条依赖边都是解析源码得到的,不是手画的。
4. **改代码之前**,务必先看全景篇 §6「会咬人的地方」里对应包的小节 —— 那里每一条都是已经踩过的坑。

> 三个包之外的宿主(`packages/kernel` 的桌面端 host、`packages/desktop`、`packages/bench`)不在本套文档范围内,但全景篇的接线表标出了内核与它们的每一处接缝。

## 档位说明

每个文件按它在主链上的位置分两档,决定单文件文档写到什么粒度:

| 档位 | 含义 | 文档粒度 |
|---|---|---|
| **A** | **主链** —— 「一次 prompt 从进入内核到产出结果」真正走过的代码路径,或定义核心契约的类型文件 | **逐行**。关键函数逐段讲实现,边界条件、失败路径、注释里的历史教训全部展开 |
| **B** | **外围** —— 与主链并行的另一套实现、独立领域的实现、纯数据表、样板小工具、离线运维工具 | **分段**。按职责分块讲清楚「它解决什么问题、接口长什么样、有哪些坑」,不逐行 |

判 B 不等于「不重要」。`memory-storage.ts` 是理解会话树语义的最佳入口、`faux.ts` 是零 key 演练的基础、`agent.ts` 是 harness 每样状态管理的简化原型 —— 它们只是不在「一次真实 prompt」的执行路径上。

**统计:A 档 72 个,B 档 48 个,合计 120 个。**

## 文件清单

链接命名规则:去掉 `packages/<pkg>/src/` 前缀,剩下的路径用下划线连接,扩展名换成 `.md`,放在以包名命名的子目录下。
例:`packages/agent/src/harness/session/session.ts` → `agent/harness_session_session.md`。

### `packages/agent` = `@yoma/my-pi` —— 循环、会话与上下文

> 24 个文件,A 档 17 / B 档 7。裸循环 + 会话外壳 + 会话树 + 上下文管理四个子系统。

| 文件路径 | 行数 | 一句话职责 | 档位 | 文档 |
|---|---:|---|:---:|---|
| `packages/agent/src/types.ts` | 430 | 整块内核的契约文件:AgentContext / AgentMessage / AgentTool / AgentEvent / AgentLoopConfig / StreamFn 的全部形状,零逻辑但每个字段注释就是行为规范 | A | [agent/types.md](./agent/types.md) |
| `packages/agent/src/agent-loop.ts` | 744 | agent 循环本体:四个入口 + runLoop 双层 while + 流式消费 + 串行/并行/length-失败三条工具执行路径 | A | [agent/agent-loop.md](./agent/agent-loop.md) |
| `packages/agent/src/agent.ts` | 520 | Agent 类:裸 loop 的有状态包装(队列/订阅/单飞行守卫)。本仓无生产调用方,是参考实现与单测对象 | B | [agent/agent.md](./agent/agent.md) |
| `packages/agent/src/index.ts` | 49 | 包主入口 barrel(浏览器安全);两个 compaction 模块用具名白名单导出 | B | [agent/index.md](./agent/index.md) |
| `packages/agent/src/node.ts` | 4 | Node 专用入口,转发 index.ts 并额外导出 NodeExecutionEnv | B | [agent/node.md](./agent/node.md) |
| `packages/agent/src/harness/agent-harness.ts` | 1155 | AgentHarness 全部实现:相位机、turn 快照、挂起写入队列、事件三路分发、四条 prompt 入口、compact/navigateTree 两条侧枝 | A | [agent/harness_agent-harness.md](./agent/harness_agent-harness.md) |
| `packages/agent/src/harness/types.ts` | 870 | harness 层契约总仓:Result 约定、ExecutionEnv、11 种会话树条目、Storage/Repo 家族、19 种事件与返回值契约 | A | [agent/harness_types.md](./agent/harness_types.md) |
| `packages/agent/src/harness/messages.ts` | 168 | 四个自定义消息角色的注册处(声明合并)+ convertToLlm —— 唯一的 LLM 边界 | A | [agent/harness_messages.md](./agent/harness_messages.md) |
| `packages/agent/src/harness/session/session.ts` | 351 | 会话树门面与上下文投影器:投影四函数 + Session 类的 10 个 append* 与 moveTo | A | [agent/harness_session_session.md](./agent/harness_session_session.md) |
| `packages/agent/src/harness/session/jsonl-storage.ts` | 319 | SessionStorage 的落盘实现:一行 header + 一行一条目的 JSONL 追加日志,open 时逐行重放恢复 leaf | A | [agent/harness_session_jsonl-storage.md](./agent/harness_session_jsonl-storage.md) |
| `packages/agent/src/harness/session/jsonl-repo.ts` | 183 | JSONL 会话仓库:create / open / list(只读 header)/ delete / fork,含 cwd 编码与目录布局 | A | [agent/harness_session_jsonl-repo.md](./agent/harness_session_jsonl-repo.md) |
| `packages/agent/src/harness/session/repo-utils.ts` | 53 | 两套 repo 共用的四个小工具 + fork 的 before/at 取材规则 + Result→throw 适配边界 | A | [agent/harness_session_repo-utils.md](./agent/harness_session_repo-utils.md) |
| `packages/agent/src/harness/session/uuid.ts` | 58 | 手写 UUIDv7 生成器(时间戳 + 单调 sequence + 随机尾);条目 id 只取随机尾 8 字符 | A | [agent/harness_session_uuid.md](./agent/harness_session_uuid.md) |
| `packages/agent/src/harness/session/memory-storage.ts` | 138 | SessionStorage 的内存实现,树的全部逻辑第一次成形(最适合先读) | B | [agent/harness_session_memory-storage.md](./agent/harness_session_memory-storage.md) |
| `packages/agent/src/harness/session/memory-repo.ts` | 54 | 内存会话仓库,与 jsonl-repo 语义一一对应 | B | [agent/harness_session_memory-repo.md](./agent/harness_session_memory-repo.md) |
| `packages/agent/src/harness/compaction/compaction.ts` | 759 | 压缩全部算法:token 估算三件套、阈值判断、切点搜索、摘要提示词与两次模型调用 | A | [agent/harness_compaction_compaction.md](./agent/harness_compaction_compaction.md) |
| `packages/agent/src/harness/compaction/utils.ts` | 140 | 压缩与分支摘要共用的纯函数:文件操作抽取、对话序列化 | A | [agent/harness_compaction_utils.md](./agent/harness_compaction_utils.md) |
| `packages/agent/src/harness/compaction/branch-summarization.ts` | 270 | 分支摘要:求 LCA 收集被抛下的分支,预算内从最新往回填 | B | [agent/harness_compaction_branch-summarization.md](./agent/harness_compaction_branch-summarization.md) |
| `packages/agent/src/harness/skills.ts` | 365 | 技能发现(递归目录、SKILL.md frontmatter、ignore 规则、符号链接)与调用格式化 | A | [agent/harness_skills.md](./agent/harness_skills.md) |
| `packages/agent/src/harness/system-prompt.ts` | 38 | 把 Skill[] 格式化成系统提示词里的 <available_skills> 区块 | A | [agent/harness_system-prompt.md](./agent/harness_system-prompt.md) |
| `packages/agent/src/harness/prompt-templates.ts` | 52 | 提示词模板的参数解析与 shell 风格占位符替换(磁盘加载器从未实现,当前不可达) | B | [agent/harness_prompt-templates.md](./agent/harness_prompt-templates.md) |
| `packages/agent/src/harness/env/nodejs.ts` | 699 | ExecutionEnv(FileSystem + Shell)在 Node/Bun 上的唯一实现:路径、文件、bash 发现、spawn、杀进程树、超时与中断 | A | [agent/harness_env_nodejs.md](./agent/harness_env_nodejs.md) |
| `packages/agent/src/harness/utils/shell-output.ts` | 219 | shell 输出捕获:流式回报进度、有界尾巴、超限旁落临时文件并回传路径 | A | [agent/harness_utils_shell-output.md](./agent/harness_utils_shell-output.md) |
| `packages/agent/src/harness/utils/truncate.ts` | 353 | 工具输出的共享截断:2000 行 / 50KB 双上限,truncateHead 留头、truncateTail 留尾 | A | [agent/harness_utils_truncate.md](./agent/harness_utils_truncate.md) |

### `packages/ai` = `@earendil-works/pi-ai` —— 契约层与协议层

> 46 个文件,A 档 20 / B 档 26。vendored 自上游 pi 项目并裁剪(pi-minimal)。

| 文件路径 | 行数 | 一句话职责 | 档位 | 文档 |
|---|---:|---|:---:|---|
| `packages/ai/src/types.ts` | 722 | 纯类型文件,零运行时:消息与 content part、Context/Tool、StreamOptions 与各家兼容位、AssistantMessageEvent、Usage/StopReason、Model/ModelCost | A | [ai/types.md](./ai/types.md) |
| `packages/ai/src/models.ts` | 452 | 模型注册表:Provider/Models/MutableModels 接口 + ModelsImpl + 两个工厂,以及计费、思考档位、鉴权合并与 provider 派发 | A | [ai/models.md](./ai/models.md) |
| `packages/ai/src/index.ts` | 41 | 包的门面 barrel,同时用注释钉住 pi-minimal 的裁剪范围(provider 与 api 改走深引用) | A | [ai/index.md](./ai/index.md) |
| `packages/ai/src/images-models.ts` | 267 | 文生图侧的注册表,与 models.ts 逐行对称;generateImages 是一次性 Promise 且自己 try/catch | B | [ai/images-models.md](./ai/images-models.md) |
| `packages/ai/src/session-resources.ts` | 24 | 全局清理钩子注册表(本仓零调用,上游留的口子) | B | [ai/session-resources.md](./ai/session-resources.md) |
| `packages/ai/src/api/openai-completions.ts` | 1302 | OpenAI Chat Completions 协议实现,也是本产品真正跑的那条路;含 8 种 thinking 参数格式与一整套兼容性矩阵 | A | [ai/api_openai-completions.md](./ai/api_openai-completions.md) |
| `packages/ai/src/api/anthropic-messages.ts` | 1311 | Anthropic Messages 协议实现:手写 SSE 解码、块索引管理、thinking 签名回放、四个 cache_control 断点、OAuth 隐身模式 | A | [ai/api_anthropic-messages.md](./ai/api_anthropic-messages.md) |
| `packages/ai/src/api/transform-messages.ts` | 223 | 三套协议共用的前置归一化:图片降级、跨模型 thinking 转文本、工具 id 规范化、丢弃失败轮、补孤儿工具结果 | A | [ai/api_transform-messages.md](./ai/api_transform-messages.md) |
| `packages/ai/src/api/lazy.ts` | 70 | lazyStream(同步返回流、背后异步准备,失败编码成 error 事件)与 lazyApi(把动态 import 包成 ProviderStreams) | A | [ai/api_lazy.md](./ai/api_lazy.md) |
| `packages/ai/src/api/simple-options.ts` | 77 | streamSimple 的公共参数计算:按上下文窗口夹 maxTokens、钳思考档位、算 thinking 预算 | A | [ai/api_simple-options.md](./ai/api_simple-options.md) |
| `packages/ai/src/api/openai-responses-shared.ts` | 592 | OpenAI Responses 协议的三大件:消息转换、工具转换、按 output_index 认领槽位的流处理 | B | [ai/api_openai-responses-shared.md](./ai/api_openai-responses-shared.md) |
| `packages/ai/src/api/openai-responses.ts` | 317 | OpenAI Responses API 的入口薄壳:客户端、buildParams、service_tier 计价,流处理委托给 shared | B | [ai/api_openai-responses.md](./ai/api_openai-responses.md) |
| `packages/ai/src/api/openai-completions.lazy.ts` | 4 | 把 openai-completions.ts 包成懒加载 ProviderStreams 工厂 | B | [ai/api_openai-completions.lazy.md](./ai/api_openai-completions.lazy.md) |
| `packages/ai/src/api/anthropic-messages.lazy.ts` | 4 | anthropic-messages.ts 的懒加载工厂 | B | [ai/api_anthropic-messages.lazy.md](./ai/api_anthropic-messages.lazy.md) |
| `packages/ai/src/api/openai-responses.lazy.ts` | 4 | openai-responses.ts 的懒加载工厂 | B | [ai/api_openai-responses.lazy.md](./ai/api_openai-responses.lazy.md) |
| `packages/ai/src/api/openai-prompt-cache.ts` | 8 | 把 prompt_cache_key 按 Unicode 码点截断到 64 个字符 | B | [ai/api_openai-prompt-cache.md](./ai/api_openai-prompt-cache.md) |
| `packages/ai/src/api/github-copilot-headers.ts` | 37 | GitHub Copilot 专用的动态请求头(X-Initiator / Openai-Intent / Vision-Request) | B | [ai/api_github-copilot-headers.md](./ai/api_github-copilot-headers.md) |
| `packages/ai/src/auth/types.ts` | 182 | 认证契约:Credential 判别联合、CredentialStore 读写接口、AuthContext/AuthResult、ApiKeyAuth/OAuthAuth/ProviderAuth | A | [ai/auth_types.md](./ai/auth_types.md) |
| `packages/ai/src/auth/context.ts` | 45 | AuthContext 的默认实现:env() 读 process.env、fileExists() 判文件(浏览器下均降级) | A | [ai/auth_context.md](./ai/auth_context.md) |
| `packages/ai/src/auth/credential-store.ts` | 47 | CredentialStore 的内存参考实现(生产走 coding-agent 的 FileCredentialStore) | B | [ai/auth_credential-store.md](./ai/auth_credential-store.md) |
| `packages/ai/src/auth/helpers.ts` | 46 | 两个构造器:envApiKeyAuth(存储优先、否则按序试环境变量)与 lazyOAuth(首次调用才动态 import) | A | [ai/auth_helpers.md](./ai/auth_helpers.md) |
| `packages/ai/src/auth/resolve.ts` | 141 | resolveProviderAuth 主函数:override > 存储凭据 > 环境变量;OAuth 分支实现双重检查锁刷新 | A | [ai/auth_resolve.md](./ai/auth_resolve.md) |
| `packages/ai/src/providers/anthropic.ts` | 20 | Anthropic provider 定义(id/baseUrl/auth/models/api 五元组) | A | [ai/providers_anthropic.md](./ai/providers_anthropic.md) |
| `packages/ai/src/providers/openai.ts` | 15 | OpenAI provider 定义,结构与 anthropic 对称但只有 apiKey 一种认证 | A | [ai/providers_openai.md](./ai/providers_openai.md) |
| `packages/ai/src/providers/faux.ts` | 538 | 假模型 provider:不发网络请求,把预先摆好的消息按速率切块模拟成流式事件(零 key 演练的基础) | B | [ai/providers_faux.md](./ai/providers_faux.md) |
| `packages/ai/src/providers/anthropic.models.ts` | 257 | Anthropic 模型目录,脚本自动生成的纯数据表 | B | [ai/providers_anthropic.models.md](./ai/providers_anthropic.models.md) |
| `packages/ai/src/providers/openai.models.ts` | 813 | OpenAI 模型目录,脚本自动生成的纯数据表 | B | [ai/providers_openai.models.md](./ai/providers_openai.models.md) |
| `packages/ai/src/utils/deferred-tools.ts` | 39 | 按“是否在对话历史里新出现且未被调用过”把工具表拆成 immediate / deferred 两组 | A | [ai/utils_deferred-tools.md](./ai/utils_deferred-tools.md) |
| `packages/ai/src/utils/diagnostics.ts` | 45 | 把任意抛出值规整成 DiagnosticErrorInfo 并追加到消息的 diagnostics 数组 | B | [ai/utils_diagnostics.md](./ai/utils_diagnostics.md) |
| `packages/ai/src/utils/error-body.ts` | 127 | 从各家 SDK 错误对象的不同字段里探测出统一的 {status, body, message},再拼成展示字符串 | B | [ai/utils_error-body.md](./ai/utils_error-body.md) |
| `packages/ai/src/utils/estimate.ts` | 143 | 上下文 token 估算:优先用最近一次真实 usage + 之后消息的字符估算,退化时整体估算 | A | [ai/utils_estimate.md](./ai/utils_estimate.md) |
| `packages/ai/src/utils/event-stream.ts` | 88 | 通用 EventStream(推拉合一异步队列)与 AssistantMessageEventStream 特化 —— 所有流式响应的基础 | A | [ai/utils_event-stream.md](./ai/utils_event-stream.md) |
| `packages/ai/src/utils/hash.ts` | 13 | 确定性 32 位双种子哈希,把长字符串压成短 base36 串 | B | [ai/utils_hash.md](./ai/utils_hash.md) |
| `packages/ai/src/utils/headers.ts` | 18 | Headers ↔ Record 的两个转换小工具(ProviderHeaders 的 null 表示删除某个头) | B | [ai/utils_headers.md](./ai/utils_headers.md) |
| `packages/ai/src/utils/json-parse.ts` | 124 | JSON 修补与容错解析:repairJson / parseJsonWithRepair / parseStreamingJson(流式增量参数用) | B | [ai/utils_json-parse.md](./ai/utils_json-parse.md) |
| `packages/ai/src/utils/overflow.ts` | 165 | 用按 provider 收集的正则判断一条错误消息是不是“上下文超限”,外加两类不报错的隐性溢出 | B | [ai/utils_overflow.md](./ai/utils_overflow.md) |
| `packages/ai/src/utils/provider-env.ts` | 52 | 按“显式覆盖 > process.env > /proc/self/environ”取环境变量(绕开 Bun 编译产物的已知 bug) | B | [ai/utils_provider-env.md](./ai/utils_provider-env.md) |
| `packages/ai/src/utils/retry.ts` | 101 | isRetryableAssistantError:先排除配额/账单类,再匹配过载/限流/网络/流截断;只分类不实现重试 | B | [ai/utils_retry.md](./ai/utils_retry.md) |
| `packages/ai/src/utils/sanitize-unicode.ts` | 25 | 删除未配对的 UTF-16 代理项(会导致部分 provider 序列化报错) | B | [ai/utils_sanitize-unicode.md](./ai/utils_sanitize-unicode.md) |
| `packages/ai/src/utils/typebox-helpers.ts` | 24 | StringEnum:生成 {type:"string", enum:[...]} 形式的 schema,绕开某些 provider 不支持 anyOf | B | [ai/utils_typebox-helpers.md](./ai/utils_typebox-helpers.md) |
| `packages/ai/src/utils/validation.ts` | 310 | validateToolArguments:TypeBox 编译校验 + 自制 JSON Schema 强制类型转换双保险 | A | [ai/utils_validation.md](./ai/utils_validation.md) |
| `packages/ai/src/utils/oauth/anthropic.ts` | 440 | Anthropic OAuth 完整实现:PKCE、本地回调服务器、token 交换与刷新;refresh/toAuth 在主链上 | A | [ai/utils_oauth_anthropic.md](./ai/utils_oauth_anthropic.md) |
| `packages/ai/src/utils/oauth/load.ts` | 16 | 用变量说明符动态加载 oauth/anthropic.ts,让打包器不能静态跟随进 Node-only 代码 | A | [ai/utils_oauth_load.md](./ai/utils_oauth_load.md) |
| `packages/ai/src/utils/oauth/oauth-page.ts` | 109 | OAuth 回调成功/失败的静态 HTML 落地页 | B | [ai/utils_oauth_oauth-page.md](./ai/utils_oauth_oauth-page.md) |
| `packages/ai/src/utils/oauth/pkce.ts` | 34 | 用 Web Crypto 生成 PKCE 的 verifier/challenge 一对 | B | [ai/utils_oauth_pkce.md](./ai/utils_oauth_pkce.md) |
| `packages/ai/src/utils/oauth/types.ts` | 79 | OAuth 子系统的类型定义(含一个标 @deprecated 的旧接口) | B | [ai/utils_oauth_types.md](./ai/utils_oauth_types.md) |

### `packages/coding-agent` = `@yoma/my-pi-coding-agent` —— 工具、提示词与宿主

> 50 个文件,A 档 35 / B 档 15。工具骨架 + 嵌入式六件套 + 项目理解与起步 + ACP 适配器。

| 文件路径 | 行数 | 一句话职责 | 档位 | 文档 |
|---|---:|---|:---:|---|
| `packages/coding-agent/src/index.ts` | 8 | 包主入口,纯 re-export 四个桶;刻意不导出 ACP(避免把协议 SDK 拖进桌面端产物) | B | [coding-agent/index.md](./coding-agent/index.md) |
| `packages/coding-agent/src/core/tools/types.ts` | 53 | 本包的工具形状 ToolDefinition(比 AgentTool 多两类提示词元数据)与 wrapToolDefinition | A | [coding-agent/core_tools_types.md](./coding-agent/core_tools_types.md) |
| `packages/coding-agent/src/core/tools/index.ts` | 263 | 工具集装配面:createCodingToolDefinitions 与 createEmbeddedToolDefinitions 两个工厂 | A | [coding-agent/core_tools_index.md](./coding-agent/core_tools_index.md) |
| `packages/coding-agent/src/core/tools/read.ts` | 110 | read 工具:按行读文本、1-indexed offset/limit、头部截断并追加可执行的续读提示 | A | [coding-agent/core_tools_read.md](./coding-agent/core_tools_read.md) |
| `packages/coding-agent/src/core/tools/write.ts` | 83 | write 工具:整文件创建或覆盖,details 带 created/oldContent/newContent 供画 diff | A | [coding-agent/core_tools_write.md](./coding-agent/core_tools_write.md) |
| `packages/coding-agent/src/core/tools/edit.ts` | 168 | edit 工具外壳:schema、四条使用守则、prepareArguments 兼容层、读改写与 patch 生成流程 | A | [coding-agent/core_tools_edit.md](./coding-agent/core_tools_edit.md) |
| `packages/coding-agent/src/core/tools/edit-diff.ts` | 370 | edit 的算法层:行尾/BOM、模糊匹配归一化、精确优先的 fuzzyFindText、批量应用与重叠检测、unified patch | A | [coding-agent/core_tools_edit-diff.md](./coding-agent/core_tools_edit-diff.md) |
| `packages/coding-agent/src/core/tools/bash.ts` | 198 | bash 工具:默认 120 秒超时、尾部截断 + 全量旁落、100ms 节流的流式回报、三种失败形态 | A | [coding-agent/core_tools_bash.md](./coding-agent/core_tools_bash.md) |
| `packages/coding-agent/src/core/tools/path-utils.ts` | 72 | 工具的路径解析:MSYS 路径翻译、绝对化、read 的 macOS 文件名变体重试 | A | [coding-agent/core_tools_path-utils.md](./coding-agent/core_tools_path-utils.md) |
| `packages/coding-agent/src/core/tools/file-mutation-queue.ts` | 68 | 同一文件修改的串行化(模块级每文件锁链)与持锁期间的中断检查 | A | [coding-agent/core_tools_file-mutation-queue.md](./coding-agent/core_tools_file-mutation-queue.md) |
| `packages/coding-agent/src/core/system-prompt.ts` | 165 | 系统提示词构建:从工具定义收出三段,拼出身份/原则/证据规则/工具清单 + 四段统一收尾 | A | [coding-agent/core_system-prompt.md](./coding-agent/core_system-prompt.md) |
| `packages/coding-agent/src/core/resources.ts` | 95 | 资源发现的应用层策略:上下文文件(全局 + 祖先链,双重去重)与技能目录(全局 + 项目) | A | [coding-agent/core_resources.md](./coding-agent/core_resources.md) |
| `packages/coding-agent/src/core/tools/engines.ts` | 535 | 嵌入式六件套共用的辅助层:引擎定位、探针租约(进程内 + 文件锁)、runEngine、killTree、输出预算 | A | [coding-agent/core_tools_engines.md](./coding-agent/core_tools_engines.md) |
| `packages/coding-agent/src/core/tools/flash.ts` | 185 | 探针独占执行器:模型自带烧录 argv,工具只管租约、超时杀树、ELF sha256 记进 flash-state.json | A | [coding-agent/core_tools_flash.md](./coding-agent/core_tools_flash.md) |
| `packages/coding-agent/src/core/tools/gdb-mi.ts` | 724 | gdb 的纯函数层:MI3 分帧与解析、Cortex-M 寄存器语义与异常入栈帧解码、帧渲染与截断 | A | [coding-agent/core_tools_gdb-mi.md](./coding-agent/core_tools_gdb-mi.md) |
| `packages/coding-agent/src/core/tools/gdb.ts` | 1961 | 把一个活的 gdb 会话接进 agent 循环:六个动作、GdbSession 状态机、server 拉起、eval 闸门、故障现场分析 | A | [coding-agent/core_tools_gdb.md](./coding-agent/core_tools_gdb.md) |
| `packages/coding-agent/src/core/tools/log.ts` | 1155 | 把板子日志接进会话:六个动作、三种源、全量落盘 + 环形缓冲 + 折叠 + 骨架采样 + wait 阻塞匹配 | A | [coding-agent/core_tools_log.md](./coding-agent/core_tools_log.md) |
| `packages/coding-agent/src/core/tools/serial.ts` | 371 | 串口的三平台适配:端口名归一、POSIX 开口序列(两次 fd + stty 走 stdin)、Windows PowerShell 读取脚本、端口枚举 | B | [coding-agent/core_tools_serial.md](./coding-agent/core_tools_serial.md) |
| `packages/coding-agent/src/core/tools/netlist.ts` | 192 | 原理图网表解析工具:跑 controller_map / board_ir 引擎,产物写进 .my-pi 并内联关键 JSON | B | [coding-agent/core_tools_netlist.md](./coding-agent/core_tools_netlist.md) |
| `packages/coding-agent/src/core/tools/stm32config.ts` | 259 | 确定性 STM32 配置内核的包装:七个命令拼 argv 跑一次,支持的芯片族由数据包文件名生成 | B | [coding-agent/core_tools_stm32config.md](./coding-agent/core_tools_stm32config.md) |
| `packages/coding-agent/src/core/tools/datasheet.ts` | 490 | 数据手册 RAG 工具:search / read_section / view_figure 三个动作全服务器化,零本地状态 | B | [coding-agent/core_tools_datasheet.md](./coding-agent/core_tools_datasheet.md) |
| `packages/coding-agent/src/core/tools/toolchain.ts` | 198 | 工具链工具:check / resolve / set 三个动作的参数、渲染与 side/manifestText 注入口 | A | [coding-agent/core_tools_toolchain.md](./coding-agent/core_tools_toolchain.md) |
| `packages/coding-agent/src/core/toolchain/index.ts` | 16 | toolchain 子系统的桶文件,汇总转发六个模块 | A | [coding-agent/core_toolchain_index.md](./coding-agent/core_toolchain_index.md) |
| `packages/coding-agent/src/core/toolchain/schema.ts` | 260 | 清单类型定义、JSONC-lite 解析、绝对路径扫描校验、按 side 筛选(manifestForSide) | A | [coding-agent/core_toolchain_schema.md](./coding-agent/core_toolchain_schema.md) |
| `packages/coding-agent/src/core/toolchain/locations.ts` | 378 | 本机探测三档机制:PATH 扫描、平台已知安装位置表、Windows 注册表 Uninstall 键搜索 | A | [coding-agent/core_toolchain_locations.md](./coding-agent/core_toolchain_locations.md) |
| `packages/coding-agent/src/core/toolchain/ledger.ts` | 187 | 本机账本的容错读与原子写,以及项目级 local override 的读取 | A | [coding-agent/core_toolchain_ledger.md](./coding-agent/core_toolchain_ledger.md) |
| `packages/coding-agent/src/core/toolchain/version.ts` | 201 | 从 --version 输出抠版本号、版本范围比较、起子进程探测版本(超时 + 两级 kill) | A | [coding-agent/core_toolchain_version.md](./coding-agent/core_toolchain_version.md) |
| `packages/coding-agent/src/core/toolchain/resolve.ts` | 482 | 唯一“下结论”的模块:六档探测编排,导出 shellEnvFor 与 promptSectionFor | A | [coding-agent/core_toolchain_resolve.md](./coding-agent/core_toolchain_resolve.md) |
| `packages/coding-agent/src/core/toolchain/actions.ts` | 80 | 两个“写”动作:把新鲜结果记回账本、验证并记录用户指的路径 | A | [coding-agent/core_toolchain_actions.md](./coding-agent/core_toolchain_actions.md) |
| `packages/coding-agent/src/core/examples/schema.ts` | 247 | 例程索引的核心类型、JSONL 序列化与逐条容错解析、本机语料账本类型 | A | [coding-agent/core_examples_schema.md](./coding-agent/core_examples_schema.md) |
| `packages/coding-agent/src/core/examples/store.ts` | 302 | 例程库的落盘层:sources/index/enrich/cache 的读写与路径,以及语料三态解析 | A | [coding-agent/core_examples_store.md](./coding-agent/core_examples_store.md) |
| `packages/coding-agent/src/core/examples/search.ts` | 148 | 检索:硬过滤(芯片/生态)在前,确定性打分(外设/关键词/板名/体积)在后,纯函数零 IO | A | [coding-agent/core_examples_search.md](./coding-agent/core_examples_search.md) |
| `packages/coding-agent/src/core/examples/render.ts` | 148 | 检索结果 / 条目卡片 / 预检报告的文本渲染,CLI 与 agent 工具共用 | A | [coding-agent/core_examples_render.md](./coding-agent/core_examples_render.md) |
| `packages/coding-agent/src/core/examples/seed.ts` | 74 | 把选中例程拷进工作区(排除构建产物)并写 .yoma-seed.json 出处文件 | A | [coding-agent/core_examples_seed.md](./coding-agent/core_examples_seed.md) |
| `packages/coding-agent/src/core/examples/index.ts` | 115 | examples 子系统的桶文件(注意 sync 与 generic 不在其中) | A | [coding-agent/core_examples_index.md](./coding-agent/core_examples_index.md) |
| `packages/coding-agent/src/core/examples/preflight.ts` | 203 | 合并预检:比对底盘与供体的资源足迹(引脚/外设/符号/分区),只报事实不做裁决 | B | [coding-agent/core_examples_preflight.md](./coding-agent/core_examples_preflight.md) |
| `packages/coding-agent/src/core/examples/enrich-schema.ts` | 244 | 富化卡片的类型、模型输出净化(字段裁剪/长度封顶/标识符过滤)、JSONL 序列化 | B | [coding-agent/core_examples_enrich-schema.md](./coding-agent/core_examples_enrich-schema.md) |
| `packages/coding-agent/src/core/examples/enrich.ts` | 245 | 富化管线:挑文件 → 模型补全 → 净化 → 追加落盘(离线运维工具) | B | [coding-agent/core_examples_enrich.md](./coding-agent/core_examples_enrich.md) |
| `packages/coding-agent/src/core/examples/indexer.ts` | 95 | 索引器:语料根 → 按生态分派抽取器 → 盖语料戳 → 落盘 + 记账 | B | [coding-agent/core_examples_indexer.md](./coding-agent/core_examples_indexer.md) |
| `packages/coding-agent/src/core/examples/extract-util.ts` | 105 | 抽取器共用小工具:容错读、目录枚举、递归收文件、粗行数统计、路径正斜杠化 | B | [coding-agent/core_examples_extract-util.md](./coding-agent/core_examples_extract-util.md) |
| `packages/coding-agent/src/core/examples/espidf.ts` | 258 | esp-idf 语料抽取器:Supported Targets 表、#include 映射外设、组件依赖、pytest 验收脚本 | B | [coding-agent/core_examples_espidf.md](./coding-agent/core_examples_espidf.md) |
| `packages/coding-agent/src/core/examples/stm32cube.ts` | 217 | STM32Cube 抽取器:doxygen 风格 readme、include + HAL/LL 调用双路证据、H7 双核目录布局 | B | [coding-agent/core_examples_stm32cube.md](./coding-agent/core_examples_stm32cube.md) |
| `packages/coding-agent/src/core/examples/generic.ts` | 249 | generic 生态的 AI 索引器:模型提议条目 + 代码核验(path 存在性、loc 实测、buildable 恒 false) | B | [coding-agent/core_examples_generic.md](./coding-agent/core_examples_generic.md) |
| `packages/coding-agent/src/core/examples/sync.ts` | 349 | 远程语料两级同步:流式下载 + 边下边算 sha256 + 校验通过才原子改名,进程级锁防并发撕裂 | A | [coding-agent/core_examples_sync.md](./coding-agent/core_examples_sync.md) |
| `packages/coding-agent/src/core/examples/cli.ts` | 449 | 例程库离线 CLI:index / enrich / sync / search / show / preflight / list 七个子命令 | B | [coding-agent/core_examples_cli.md](./coding-agent/core_examples_cli.md) |
| `packages/coding-agent/src/core/tools/examples.ts` | 419 | examples agent 工具:search / info / seed / preflight / sync 五个动作,含方法论指引文本 | A | [coding-agent/core_tools_examples.md](./coding-agent/core_tools_examples.md) |
| `packages/coding-agent/src/acp.ts` | 76 | ACP 的 bin 入口:改道 console、装配 agent、把 7 个方法挂到 SDK builder、接 stdio 的 ndjson 流 | A | [coding-agent/acp.md](./coding-agent/acp.md) |
| `packages/coding-agent/src/acp/agent.ts` | 735 | ACP agent 主体:会话表、下拉框构造、斜杠命令、prompt 生命周期(顶替/取消/自动重试/自动压缩) | A | [coding-agent/acp_agent.md](./coding-agent/acp_agent.md) |
| `packages/coding-agent/src/acp/session.ts` | 291 | 纯翻译层:工具名 → ACP 的 kind/title/locations/content,以及 live 与 replay 两条产出 session/update 的路 | A | [coding-agent/acp_session.md](./coding-agent/acp_session.md) |
| `packages/coding-agent/src/acp/models.ts` | 377 | 模型目录与凭据:手写的 provider 表、FileCredentialStore(auth.json,0600)、启动时的 resolveModel | B | [coding-agent/acp_models.md](./coding-agent/acp_models.md) |

## 快速定位

不知道该看哪个文件时,按问题找:

| 我想搞清楚… | 先看 |
|---|---|
| 一次 prompt 到底怎么跑完的 | 全景篇 §4,然后 `agent/agent-loop.md` |
| 「多轮」是谁在驱动 | `agent/agent-loop.md`(答案:`runLoop` 的双层 while,唯一的状态机) |
| 会话历史存在哪、什么格式 | `agent/harness_session_jsonl-storage.md` + `agent/harness_session_session.md` |
| 压缩之后原文去哪了 | `agent/harness_session_session.md` 的投影四函数(答案:哪也没去,只是不在投影里) |
| 什么会被发给模型、什么不会 | `agent/harness_messages.md` 的 `convertToLlm` |
| 为什么我配了 key 却说没配 | `ai/auth_resolve.md` + `coding-agent/acp_models.md` 的 `FileCredentialStore` |
| 某家 provider 的兼容性问题 | `ai/api_openai-completions.md` 的 `detectCompat` |
| 思考档位怎么选、为什么发不出去 | `ai/models.md` 的 `getSupportedThinkingLevels` / `clampThinkingLevel` |
| 怎么加一个新工具 | `coding-agent/core_tools_types.md` → `coding-agent/core_tools_index.md` → `coding-agent/core_tools_read.md` |
| 工具输出为什么被截断了 | `agent/harness_utils_truncate.md` + `agent/harness_utils_shell-output.md` |
| 探针为什么被占着 | `coding-agent/core_tools_engines.md` 的探针租约 |
| 板子死了怎么定位 | `coding-agent/core_tools_gdb-mi.md`(故障现场分析)+ `coding-agent/core_tools_gdb.md` |
| 工位端为什么报「没有清单」 | `coding-agent/core_toolchain_schema.md` 的 `manifestForSide` |
| 怎么把内核接到一个新宿主上 | `coding-agent/acp_agent.md`(内核的第一个宿主,桌面端是照着它写的) |

## 进度

- ✅ **全景篇已完成** —— [`00-内核全景.md`](./00-内核全景.md),约 1050 行。含分层图、三包定位、核心概念词典(七组约 50 条)、一次完整请求的生命周期(48 步编号时间线)、跨包接线表(五张表)、会咬人的地方(按包分列,含三条对仓库 `CLAUDE.md` 的修正)、推荐阅读顺序(五天主线 + 可跳过清单)。
- ⬜ **单文件文档待生成** —— 上表 120 个链接目前均为占位,尚未写入。建议按全景篇 §7 的阅读顺序分批产出,先把 A 档 72 个补齐(它们是主链),B 档 48 个随后。
- 📌 本套文档基于 `learn` 分支的代码状态测绘,行数与行号引用以该状态为准;后续代码变动后需回来核对。
