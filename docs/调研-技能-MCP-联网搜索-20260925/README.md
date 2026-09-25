# 调研:技能、MCP、联网搜索(2026-09-25)

**日期**:2026-09-25
**基线**:yoma develop `fe811c7`(详见文末「调研基线」)
**读者**:LJQ、ben。三份文档都是"调研 + 设计方案",**没有改任何代码**;所有方案都要拍板后才开工。

本目录回答三个问题:

1. 技能(Agent Skills)系统要改什么 → [01 技能系统:现状与改造方案](./01-技能系统-现状与改造方案.md)
2. MCP 是什么、和技能是什么关系、主流 agent 怎么做、Yoma 要怎么接 → [02 MCP:是什么、与技能的关系、主流实现与 Yoma 接入设计](./02-MCP调研与yoma接入设计.md)
3. Yoma 怎么联网搜索、别家怎么做、"厂商 API 自带 websearch"是真是假 → [03 联网搜索:调研与 Yoma 方案](./03-联网搜索调研与方案.md)

---

## 三份文档各说了什么

### [01 技能系统:现状与改造方案](./01-技能系统-现状与改造方案.md)

Yoma 今天的技能只有一种用法:系统提示词里列一张 `<available_skills>` 目录,模型自己决定要不要用 `read` 去读 SKILL.md;没有 `/技能名`、没有 skill 工具、没有技能界面、没有内置技能。上游发动机其实已经有 `lane.skill` / `formatSkillInvocation` / `loadSourcedSkills`,Yoma 一处都没用。文档列了 18 个问题,最重的四个是:技能诊断走 `kernel.error`,界面上**只响错误音、一个字都不显示**;测试读的是开发机真实的 `~/.agents/skills`;信箱把技能诊断标成"模型侧故障";同名覆盖不提示。方案是发动机一个字不改,新增 `host/domain/skills/`,分三期:P0 修 bug + `/技能名`(约 4 人日,审校认为 5–6 更现实)、P1 `skill` 工具 + 预算 + 技能设置页 + 压缩保护(约 7 人日)、P2 内置技能 + `context: fork` + 重载 + MCP 技能(约 10 人日,不含写技能内容)。

### [02 MCP:是什么、与技能的关系、主流实现与 Yoma 接入设计](./02-MCP调研与yoma接入设计.md)

MCP 是"AI 应用接外部系统的 USB-C 口":外部系统写一个 server(本地子进程或远端 HTTP 服务),任何支持 MCP 的 agent 都能用它提供的工具、资源、提示词模板。当前规范 2026-07-28 已改成无状态,但现实中的 server 大多还是旧版,官方 SDK v2 缺省也走旧握手,所以 Yoma 的客户端要新旧两代都能连。**MCP 管"连什么",技能管"怎么做"**,两者已经在协议层会合(Skills over MCP 扩展)。Claude Code 做得最全,但它和 Codex 的延迟加载都依赖 Anthropic / OpenAI 的私有 API,DeepSeek 等国产模型用不上;最值得借鉴的是 pi-mcp-adapter 那种与厂商无关的单个代理工具 `mcp`。设计上:进程级连接池 + 每会话工具快照;工具少时直连、多时走静态元工具 `mcp`;项目级 server 首次必须批准;确认门加一道 `mcpGate`。分 P0 验证 → P1 直连 → P2 元工具 → P3 prompts / 资源 → P4 OAuth,合计 22–29 人日,建议先做 P0–P2(约 15–19 人日)。

### [03 联网搜索:调研与 Yoma 方案](./03-联网搜索调研与方案.md)

"厂商 API 自带联网搜索"**是真的**:模型厂商在自己服务器上替模型搜、读、写出带引用的回答(最主流的形态叫"服务端工具"),但受厂商、端点、模型三重限制,且按次另收费。关键事实:DeepSeek 只在 Anthropic 兼容端点(`api.deepseek.com/anthropic`)上有 `web_search`,Yoma 现在走的 OpenAI 兼容端点没有;Kimi 的 `$web_search` 预计 2026-10-20 下线,改推 ¥0.01/次的独立搜索接口。锁定的 pi-ai 会丢掉服务端搜索块和引用,所以**不在主请求里开原生搜索**。方案是新增内建工具 `websearch` + `webfetch`:搜索后端可插拔(DeepSeek 子请求照 Claude Code 的形状、Kimi / 智谱独立搜索、博查 / Tavily / Brave 自填 key,P1 再加 yoma1 服务器代理),读网页全在本机做(GBK 解码、PDF 抽文本、SSRF 护栏)。P0 约 1.5–2 人周(审校建议按 2–3 人周算),P1 约 2–3 人周(含服务端)。

### 建议阅读顺序

- **只想看结论**:本页的「合并决定表」+ 每份文档开头的「摘要」。
- **完整读**:先读 [02](./02-MCP调研与yoma接入设计.md) 的 §1–§2(MCP 是什么、和技能是什么关系 —— 三份文档共用的概念底子)→ [01](./01-技能系统-现状与改造方案.md) 全文 → 02 的 §3–§8 → [03](./03-联网搜索调研与方案.md)(先看 §0 "直接回答三个问题")。

---

## 三份文档的统一约定

对齐审校时把三份文档里"同一件事"的说法统一了,结论如下(各文档里已补互相引用)。

### 新工具名与 `TOOL_NAMES` 顺序

三份文档一共要加 4 个静态工具。`TOOL_NAMES` 今天是 22 个(CLAUDE.md 写的"今天 21 个"已过时,少算了 `project`),子 agent 四件必须留在末尾(`packages/kernel/test/tools-agent.test.ts:376` 断言最后四个就是它们)。全部落地后的顺序:

```
read, bash, edit, write, grep, find, ls, powershell, toolchain, project,
flash, log, la, scope, gdb, datasheet, websearch, webfetch, netlist, stm32config,
skill, mcp, agent, task_output, task_stop, send_message
```

| 工具 | 来自 | 期 | 何时激活 |
|---|---|---|---|
| `websearch` / `webfetch` | 03 | 03-P0 | 缺省激活;`YOMA_WEB_SEARCH` / `YOMA_WEB_FETCH=off` 时摘掉;bench 缺省不激活 |
| `skill` | 01 | 01-P1 | 会话快照里至少有一个模型可调的技能 |
| `mcp`(元工具) | 02 | 02-P2 | 本会话有走代理的 MCP server 时 |

直连的 MCP 工具(`mcp__<server>__<tool>`)**不进 `TOOL_NAMES`**,作为运行时尾巴追加在静态工具之后(02 §5.5)。每加一个静态工具,`tool-names.test.ts`、desktop 自检、`kernel-smoke.ts`、bench `check` 在同一个提交里跟着改。

### 配置与密钥放哪

| 内容 | 位置 | 出处 |
|---|---|---|
| 技能开关(开 / 仅用户 / 关)、`readClaudeUser` | `~/.yoma/settings.json` 的 `skills` 段 | 01 M3 |
| 用户级 / 本机项目级 MCP server | `~/.yoma/mcp.json`(0600) | 02 §5.2 |
| 项目级 MCP server | `<工程根>/.yoma/mcp.json`、只读兼容 `<工程根>/.mcp.json`(都要批准) | 02 §5.2 |
| MCP 批准记录 / OAuth token | `~/.yoma/mcp-approvals.json`、`~/.yoma/mcp-auth.json` | 02 §5.2.4、§5.10 |
| 联网开关、第三方搜索 key | `~/.yoma/.env`(`YOMA_WEB_SEARCH`、`BOCHA_API_KEY` 等),优先级与 datasheet 服务器地址相同 | 03 §6.6 |
| 模型厂商 key | `~/.yoma/auth.json`(不变;03 的 DeepSeek / Kimi / 智谱后端直接复用,第三方 key **不进**这里) | 03 §6.6 |

- **"工程根"只有一个定义**:从 cwd 往上最近的 git 根(不在仓库里就是 cwd),由 01 的 `domain/skills/roots.ts` 提供;01 的技能祖先遍历与 02 的项目级 MCP 配置共用。"会话 cwd 就是项目根"是 Zed 时代的前提,已不成立(01 §2.1)。
- `${VAR}` 展开与第三方 key 的来源都是"环境变量 > `~/.yoma/.env`"(02 §5.2.3、03 §6.6)。
- 快照语义一致:技能、MCP 工具、联网开关都是**开会话时定一次**,改了要新开会话(或在设置页点"应用 / 重连"),为的是保住供应商的前缀缓存。

### 确认门

2026-08-10 起没有权限系统,确认门只在桌面端开。三份文档对它的用法:

- 01:`skill` 工具**不挂**确认门(加载技能不执行任何东西);`allowed-tools` 只展示、不授权。
- 02:加一道 host 侧的 `mcpGate`:用户级 server 不问、项目级 server 非只读就问、`hardware: true` 的每次都问。
- 03:`websearch` 不问;`webfetch` 只在 URL 里直接写了私网 IP 时问一次。

02 和 03 都把确认门从"烧录 / 探针类命令 / toolchain install"扩到了别的地方,这是同一个产品问题,合并成下面决定表里的 **X1**。

### 子 agent、fork、/btw、bench、信箱

| | 技能(01) | MCP(02) | 联网(03) |
|---|---|---|---|
| 子 agent | 复用主会话的技能快照;`skill` 是只读工具,通用 agent 自动拿到 | 缺省继承主会话的 MCP 工具(`hardware` 的除外);后台子 agent 要确认的直接拒 | general-purpose、Explore 自动拿到 |
| datasheet 子 agent(白名单) | 要不要加 `skill` 待定 | 只有被逐个点名才给 | 要不要加两者待定 |
| fork | `SkillHost` 用主会话快照,工具定义逐字相同 | 工具定义取主会话 `harness.getTools()` | 工具描述(含年月)沿用主会话那份字符串 |
| /btw | 不用改 | 不用改 | 不用改 |
| bench | 评测缺省不读机器上的用户级技能 | 只加载用户级且 `unattended: true` 的 server | 缺省不激活两个工具 |
| 信箱 | 工位端只有本机的用户级技能 | 两端都不加载项目级 server | 待定,倾向由任务书字段决定 |

共同原则:**无人值守宿主一律收紧**;开关走宿主选项或任务书,不能只加在 `cli.ts` 上(bench 每一轮跑在子进程里,传不进去)。三处合并成决定 **X4**、**X5**。

### 对 Claude Code 的借鉴程度

三份都按团队约定"能照 Claude Code 做就照做,偏离写理由"。01 照 CC 的骨架(`/名字`、Skill 工具、预算、压缩后重附),偏离处在 §4.2、§6;02 照 CC 的配置形状、命名、截断、项目批准,偏离 13 条列在 §5.13;03 的 DeepSeek 后端照抄 CC WebSearch 的子请求形状,偏离 11 条列在 §6.12。三份共同的偏离理由有三条:没有权限系统;默认模型是国产模型,用不上 Anthropic / OpenAI 的私有能力;要保住前缀缓存。

### 技能、MCP、内建工具的分工

三份口径一致:**MCP 管"连什么",技能管"怎么做",内建工具保证默认可用**。碰 Yoma 管着的硬件(探针、串口、仪器)的继续做内建工具;用户自己的外部系统(GitLab、禅道、飞书、内网器件库)走 MCP;流程知识做技能;联网搜索做内建工具,MCP 只作额外后端(03 §6.11;02 §2.4、§4.1 已按此更正)。智谱的搜索 MCP,server 名是 `web-search-prime`,URL 路径里是 `web_search_prime`(官方文档核过)。

### "我们自己的服务器代理"

只有 03 用到:P1 在 yoma1 上加 `/api/web/search`(和 datasheet RAG 同一台机器、同一套 frp),上游智谱 search_std 为主、博查备用;在自动选择顺序里排在用户自己的资源之后,只兜底。01、02 都不依赖服务器。另外,2026-09-25 yoma1 上已经有一套维护者自用的 SearXNG(口令门 + 限速,缺省 Yandex + 360)。它可以作为代理的零成本兜底上游,但不能直接暴露给客户端(03 §6.7 补记)。

### 分期编号怎么对应

三份文档的 P0/P1/P2… **各自独立编号**,不是同一条时间线。跨文档的依赖:

- 01 P2 的"MCP 技能"要等 02 P1(连接池)和 P3(资源读取);02 把 Skills over MCP 放在它自己 P4 之后,排期以 02 为准。
- 02 P3 的"MCP prompts 进斜杠菜单"要用 01 P0 的 `/` 补全和 `skill.list`(命令表字段在同一次评审里对齐,02 §5.9)。
- 03 P2 的"MCP 搜索后端"要等 02 P1;但智谱 `web-search-prime` 可以像 opencode 那样手拼 JSON-RPC 调用,03 P0/P1 就能用,不依赖 02。
- 03 P2 的 `embedded-web-research` 内置技能要等 01 P2 的内置技能分发。
- "内核 HTTP 走系统代理"是 02 P1 与 03 P1 共用的一项(决定 **X2**)。

【推断】总体顺序建议:01 P0(修 bug,独立,收益最大)和 03 P0(独立,DeepSeek 用户立刻能搜)可以并行先做;02 P0 的验证实验穿插进行;01 P1 和 02 P2 都要改 `TOOL_NAMES` 和系统提示词,最好排在相邻的两次评审里。

---

## 合并决定表

去重后共 33 条(原三张表合计 34 条,其中 8 条合并进 X1、X3–X6 五条,另新增 X2、X7 两条跨文档决定)。编号:**X** = 跨文档,**S** = 技能(01),**M** = MCP(02),**W** = 联网搜索(03)。"原编号"指在原文档决定表里的编号,细节和理由看原文。

### 跨文档(X)

| # | 问题 | 推荐 | 原编号 / 出处 |
|---|---|---|---|
| X1 | 确认门要不要扩到"动硬件 / 改机器"之外 | **扩,但只扩两处**:MCP 按档位(用户级 `never`、项目级 `writes`、`hardware` 每次问);webfetch 只在 URL 写了私网 IP 时问、域名解析到私网直接拒、无确认台的宿主一律拒。想守住"确认门只管动手",就 MCP 全 `never` 且 webfetch 一律拦私网 | [02 D5](./02-MCP调研与yoma接入设计.md#8-需要拍板的决定)、§5.7;[03 决定 4](./03-联网搜索调研与方案.md#11-需要拍板的决定)、§6.4 |
| X2 | 内核 HTTP 怎么走系统代理(MCP、websearch、webfetch、模型请求共用) | **P1 做一项**。两种做法不互斥:① main 用 `resolveProxy` 翻成 `HTTPS_PROXY` 等 + `NODE_USE_ENV_PROXY=1` 写进 utilityProcess 的 env(改动小,stdio server 子进程也能用上);② 宿主注入 `electron.net.fetch`(PAC 分流更准)。03 倾向 ①,02 推荐 ②;P0 在没开 TUN、用系统代理模式的 Windows 上实测后定 | 02 §5.3.8、未决 U2;03 §6.4.1 |
| X3 | 项目级配置的发现范围(技能、MCP,以及 agent 定义要不要跟) | **技能**:从 cwd 往上遍历到最近的 git 根(不在仓库里走到 home),读项目级 `.claude/skills`,用户级 `~/.claude/skills` 缺省不读。**MCP**:只读"工程根"(同一个 git 根)那一层。agent 定义暂不动 | [01 D4](./01-技能系统-现状与改造方案.md#9-需要拍板的决定)、F1;02 §5.2.1、§5.13 第 6 条、未决 U3 |
| X4 | 无人值守宿主(bench、信箱)默认给什么 | **一律收紧,开关走宿主选项或任务书**:bench 评测不读机器上的用户级技能(加开关);MCP 只加载用户级且 `unattended: true` 的 server,两端都不加载项目级;联网工具 bench 缺省不激活,信箱倾向由任务书字段决定、缺省关 | 01 A4;[02 D10](./02-MCP调研与yoma接入设计.md#8-需要拍板的决定);[03 决定 8](./03-联网搜索调研与方案.md#11-需要拍板的决定) |
| X5 | datasheet 子 agent(工具白名单)要不要加 `skill` / `websearch` / `webfetch` / MCP 工具 | **加 `websearch`、`webfetch`**,提示词写"手册库优先,网上只查勘误和新版本,并标注来源是网页";`skill` 跟着 S1 一起定;MCP 工具不默认加(白名单点名才给) | 01 T1(随 D1 定);[03 决定 6](./03-联网搜索调研与方案.md#11-需要拍板的决定);02 §5.8 |
| X6 | 第三方密钥放哪 | **MCP**:设置页填的写 `~/.yoma/mcp.json`(0600),项目级配置只许写 `${VAR}`;**搜索 key**:P0 放 `~/.yoma/.env`,P1 上设置页时再评估挪到 0600 文件;都**不进** `auth.json`;OAuth token 先存 `~/.yoma/mcp-auth.json`(0600),P4 再评估用 `safeStorage` 加密 | 02 §5.2.3、[D9](./02-MCP调研与yoma接入设计.md#8-需要拍板的决定);[03 决定 7](./03-联网搜索调研与方案.md#11-需要拍板的决定) |
| X7 | MCP server 分发的技能(Skills over MCP)怎么处理扩展里的"用户同意"要求 | **只实现不触发这些条款的子集**:不做嵌套技能、不跨 server 读、`allowed-tools` 不授权、宿主不执行技能里的代码;剩下的同意复用 MCP 配置批准,项目级的批准绑定清单 digest。排在 02 P4 之后 | 01 §6.10;02 §5.9(本次审校补的推荐) |

### 技能(S,来自 01 §9)

| # | 问题 | 推荐 | 原编号 |
|---|---|---|---|
| S1 | 模型怎么调技能 | **新增 `skill` 工具,`read` 保留兜底**(P1) | [01 D1](./01-技能系统-现状与改造方案.md#9-需要拍板的决定) |
| S2 | `/名字` 在哪解析 | **内核在 `session.prompt` 里解析**(不用 `lane.skill`,不改 `PromptInput`),三个宿主共用 | 01 D2 |
| S3 | 用户调用语法 | **`/名字`**,与内置命令同名时内置优先 | 01 D3 |
| S4 | 依赖 CC 插件变量 / shell 注入的"不兼容"技能 | **标出来、缺省不进模型列表**,用户可手动打开、仍可 `/名字` 调;要不要再按来源(插件目录 / junction)判定一起定 | 01 D5 |
| S5 | CC 兼容的变量替换 | **只做 `$ARGUMENTS` 与 `${CLAUDE_SKILL_DIR}`**(另加 `${SKILL_DIR}` 别名) | 01 D6 |
| S6 | 技能开关的粒度与存储 | **全局按名字三态(开 / 仅用户 / 关)**,存 `~/.yoma/settings.json` | 01 D7 |
| S7 | 项目技能要不要"信任"门控 | **不做**(与没有权限系统一致),技能页标来源、用户文档写明风险。对照:MCP 项目级 server 必须批准(02 §5.2.4),因为那是"在本机起进程",规范 MUST | 01 D8 |
| S8 | `routine-driven-development` 放哪(**请 ben 定**) | **挪到仓外例程库旁**,主线不放 | 01 D9 |
| S9 | 做不做内置技能 | **做**,首批 3 个排障技能 + 1 个写技能的元技能,用 IoT-SkillsBench 做有 / 无对照 | 01 D10 |
| S10 | 技能列表的体积预算 | **上下文窗口的 1%**(取不到窗口时 8000 字符),真机观察后再调 | 01 D11 |

### MCP(M,来自 02 §8;D5、D9、D10 已并入 X1、X6、X4)

| # | 问题 | 推荐 | 原编号 |
|---|---|---|---|
| M1 | 做不做、做到哪 | **做 P0–P2**;P3 跟技能改造一起做;P4(OAuth)等有用户点名要接再做 | [02 D1](./02-MCP调研与yoma接入设计.md#8-需要拍板的决定) |
| M2 | 协议实现用什么 | **官方 `@modelcontextprotocol/client` v2(2.1.0)+ zod v4**,不用 v1 单包、不自己写 | 02 D2 |
| M3 | 工具怎么暴露给模型 | **预算内直连**(约 8k token 且 ≤ 20 个,P0 实测后定),**超出的走元工具 `mcp`** | 02 D3 |
| M4 | 配置文件与兼容 | `~/.yoma/mcp.json` + 项目 `.yoma/mcp.json` + **只读兼容 `.mcp.json`**(同样要批准);Claude Desktop / Cursor / Claude Code 的配置**不静默读**,做"导入"按钮 | 02 D4 |
| M5 | stdio 子进程的环境变量 | **白名单 + 补齐**(代理变量、`PYTHONUTF8` 等),`inheritEnv: true` 才全量继承 | 02 D6 |
| M6 | 工具描述变了(防 rug pull) | **项目级 server 重新批准,用户级只提示** | 02 D7 |
| M7 | 老的 HTTP+SSE 传输 | **首版不做**,P3 视国内 server 实际情况再定 | 02 D8 |
| M8 | 硬件类 MCP server(probe-rs、J-Link 等) | **允许,但必须标 `hardware`**:每次确认、子 agent 拿不到,并提示它不受 Yoma 的探针互斥保护 | 02 D11 |
| M9 | OAuth 客户端注册要不要支持 CIMD | **先只做预注册 + DCR**(CIMD 要 HTTPS 域名,官网现在是裸 IP + http),P4 前再定 | 02 D12 |
| M10 | 元工具叫什么 | **`mcp`**(与 pi-mcp-adapter 同名) | 02 D13 |

### 联网搜索(W,来自 03 §11;决定 4、6、7、8 已并入 X1、X5、X6、X4)

| # | 问题 | 推荐 | 原编号 |
|---|---|---|---|
| W1 | `auto` 模式下后端的先后顺序 | **用户自己的资源优先**(自填 key → 当前模型的厂商 → 其他厂商 key),Yoma 服务器代理只兜底 | [03 决定 1](./03-联网搜索调研与方案.md#11-需要拍板的决定) |
| W2 | 服务器代理做不做、何时做、上游用谁 | **P1 做,智谱 search_std 为主、博查备用**;前提是条款书面确认,并设日预算和限流 | 03 决定 2 |
| W3 | DeepSeek 用户的默认后端 | **DeepSeek 子请求**(照 CC 的形状,复用用户的 DeepSeek key),看 P0 实测;不通过就把服务器代理提前到 P0 | 03 决定 3 |
| W4 | robots.txt 与 UA 口径 | **不强制遵守 robots**(用户单次触发的抓取),**始终如实写 UA**,被拦就如实告诉模型 | 03 决定 5 |
| W5 | webfetch 用不用小模型摘要、缺省返回多少 | **原文分页返回,缺省 3 万字符**,评测后再调 | 03 决定 9 |
| W6 | 搜索是否只靠 MCP | **做成内建工具**,MCP 在 P2 作为额外后端 | 03 决定 10 |

---

## 调研基线

| 对象 | 版本 / 位置 |
|---|---|
| Yoma | 本仓(yoma-pi),develop `fe811c7`(2026-09-24 的合并提交) |
| Claude Code | 2.1.88 还原源码(`claude-code-sourcemap/restored-src`);新版行为对照官方 CHANGELOG(到 2.1.282)与 code.claude.com 文档 |
| pi | 上游 0.85.1 @`6b94ae2ec`(2026-09-10);另看了社区扩展 pi-mcp-adapter、pi-skills(GitHub) |
| OpenAI Codex CLI | @`c098f97e53`(2026-09-24) |
| opencode | @`ea2d89854`(2026-06-28) |
| 其他 | Cline(本机 cline-main)、GitHub Copilot Chat @`5863f5a70`、oh-my-openagent @`4b300e06b`、Gemini CLI(GitHub main,在线读)、VS Code / Cursor 官方文档 |
| 规范与 SDK | MCP 规范 2026-07-28(Current);`@modelcontextprotocol/client` 2.1.0、`@modelcontextprotocol/sdk` 1.30.1(npm 实查);Agent Skills 规范(agentskills.io,页面无版本号);MCP Skills 扩展 SEP-2640(Final) |
| 调研日期 | 2026-09-25。外部事实(价格、API 形状、厂商功能)都是这一天在官方页面上看的,会变 |

---

## 方法

- **多 agent 并行调研**:三个题目各自分出若干调研子任务(读 Yoma 代码、读各家参考源码、查官方文档与定价页),笔记汇总后由一个写作 agent 成稿;每份文档再由**独立的审校 agent** 回到源码和官方页面逐条复核关键引用,改掉不准的说法,核不了的标【未核实】。
- **对齐审校**(本页):通读三份,统一了工具顺序、工程根定义、代理方案、确认门、无人值守宿主和命名等说法,补了互相引用。改动都是对齐性的小改动,没有改各文档的结构。
- **标记**:三份文档都区分【事实 / 核实】、【推断】、【未核实】。本机网络走 Clash TUN(出口在境外),凡是"中国大陆能不能直连"的判断都是引用资料,不是实测。
- **没做的**:没有改代码、没有跑会改状态的命令;所有"实测"都只是读代码、查文档,或跑只读的小实验(如 Node 解码 GBK、yaml 解析冒号)。

### 仍未核实的关键点(开工前要先测)

1. **DeepSeek `/anthropic` 端点的 `web_search`**:返回什么形状、另不另收搜索费、`max_uses` 和域名过滤生不生效、大陆直连能不能用(03 P0 第 0 步,花几分钱)。W3 取决于它。
2. **国产模型对 MCP 工具的容忍度**:工具名长度上限;`$ref` / `oneOf` / `additionalProperties` 等 JSON Schema 关键字认不认(02 P0)。
3. **前缀缓存怎么把 tools 数组算进去**(DeepSeek 等):决定工具表变化的真实代价,影响 M3 的阈值和几处"开会话定一次"的取舍。
4. **Coding Plan / Token Plan 的 key 能不能调各家的独立搜索接口**(Kimi、智谱、通义)。
5. **`net.fetch` 在 utilityProcess 里认不认 PAC / 系统代理**,以及"系统代理翻成 env"在 Windows 系统代理模式下是否可靠(X2)。
6. **Windows 上用 `cmd /c npx` / cross-spawn 起 MCP server 会不会被安全软件同步审查、卡住内核**;SDK v2 + zod v4、`turndown` / `defuddle` / `unpdf` inline 进 kernel.js(以及信箱 / bench 的 ESM 产物)后能不能加载、体积涨多少。
7. **技能侧的几处推断**:带 BOM 或冒号的 SKILL.md 被丢弃(只分件验证过);包装 `ExecutionEnv` 的做法是否可行;压缩后用 custom 消息补回技能正文的方案。
8. **中文搜索质量**:各家对 CSDN、ST 社区、电子发烧友、GitHub 的覆盖没有权威评测,03 P0 要先建 20 条嵌入式查询的评测集再定默认顺序。
9. **旁支发现(与本题无关,建议另开一条线)**:Google 适配器拒绝自定义 fetch,而 `withStreamGuard` 会给所有请求注入 fetch,Yoma 现在选 Google 模型可能直接报错(推断,未实测,03 §5.2)。

### 顺带发现的仓库文档问题(未改,留给开工时顺手改)

- CLAUDE.md 里"`TOOL_NAMES` 今天 21 个"已过时,实际是 22 个(含 `project`)。
- CLAUDE.md 里"依赖版本钉在根 `workspaces.catalog`"已过时:根 `package.json` 的 `workspaces` 是数组,仓里没有 `"catalog:"`(02 §5.12)。
- CLAUDE.md 和几处代码注释说 `kernel.error` 会"弹系统通知、把会话标红",实际缺省只响错误音(01 Q17)。
