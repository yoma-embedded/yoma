# CLAUDE.md

给 Claude Code 在本仓库工作时的说明。`README.md`(英文)与 `README.zh-CN.md`(中文)是面向用户的权威文档。
`packages/app/AGENTS.md` 和 `packages/desktop/AGENTS.md` 是包级规则,必须遵守。

## 这是什么

Yoma 是一个面向**嵌入式调试**的 agent 平台,一棵树上两半:

- **内核**(`packages/{ai,agent}` 两个上游包 + `packages/kernel/src/host`)—— agent 循环、
  会话树、压缩、技能,以及嵌入式应用层(工具链解析 / 示例语料 / 引擎调用)。
  嵌入式工具组(烧录 / 日志 / gdb / 网表 / 数据手册 / STM32 配置 / 逻辑分析仪 / 示波器)2026-09-10
  **归零**:旧实现搬到 `packages/kernel/attic/`(不编译、不跑),按新内核的工具接口一个个重写 ——
  2026-09-11 起按样板 `host/tools/<名字>/{contract.ts,session.ts}` 逐个重写,首个是 flash;2026-09-12 从 pi 的
  coding-agent 移植了 grep / find / ls / powershell(清单:四件套 + grep / find / ls / powershell + flash);
  示波器 2026-09-16 恢复为 `host/tools/scope/` + `host/domain/scope/`,2026-09-17 分出 `ScopeDriver` 接口 + 驱动注册表
  (siglent 一族,USB 与 LAN;demo 按环境变量),带只读历史波形面板,Mac 首轮真机检查通过(重构后未再上真机),
  Windows 与故障恢复稳定性仍待验证;例程库仍停在仓库外 `../yoma-parked/`。
- **桌面端**(`packages/{desktop,app,kernel,ui,session-ui,util,bench}`)——
  Electron 外壳 + SolidJS UI,fork 自 opencode 的前端;`bench` 是无人值守调试台。

**内核与上游 pi 的关系**(2026-08-21 核实;嵌入式应用层的细节在 `packages/kernel/UPSTREAM.md`):
应用层与当年那份 `agent` 分叉自上游 **2026-07-13 的快照 `f8f75544b`**(不是 `v0.80.6`)。
`pi-ai` 现在是仓内上游包(`packages/ai`,0.85.1,哈希锁定);从前那份自有 harness
建在上游的 v1 `AgentHarness` 上 —— **上游自己的 CLI 从没用过它**(生产路径是 `Agent` +
上游 coding-agent 的 `AgentSession`),2026-08-04 上游把它掏空成 v2 空壳、8-11 又定了 v3 规格。
那份自有分叉(`agent-legacy`)已于 2026-09-10 删除,`agent` 现在是**哈希锁定的上游拷贝**;
`kernel/src/host` 里的嵌入式应用层是产品,永久 fork。

**2026-08 之前这是两个仓库**(`yoma` 和 `yoma-desktop`,兄弟目录 + alias 接缝)。
合并的决定性理由是**它们从来不独立发布**:打包时 esbuild 把内核源码整个 inline 进
`out/main/kernel.js`,用户装的 app 里没有"内核这个包",只有一个把两边融在一起的产物。
仓库该按发布节奏切分,而这两半的发布节奏不是相近 —— 是同一个。

分开时代付出的代价(现在都没了):路径映射要维护 4 份、`bun use-yoma` 切检出、
"半切"(app 跑新代码而 typecheck 验旧检出,两边全绿却说的不是同一件事)、
以及**跨仓库的静默断裂** —— 一天之内撞过三次,其中"凭据路径 + 格式变了"那次
类型系统根本抓不到,表现是用户配了 key 而内核静默读不到。

## 内核接缝:一个包、几道门

内核就是本仓的 workspace 包 `@yoma-desktop/kernel`,裸说明符靠 **node_modules 里的软链 +
它自己的 `exports`** 解析 —— typecheck(tsgo)、tsx、vitest、esbuild / electron-vite 全走这一条。
**别名表没有了**(2026-09-10 删:`kernel-alias.ts`、四处 `paths`、各处 `resolve.alias`;
守门的活交给 `packages/kernel/src/host/boundary.test.ts`)。

四个盒子(`boundary.test.ts` 的说法):**餐厅** = app / session-ui / ui / util / desktop,只认**菜单**
(kernel 的门 `.`,浏览器安全);**厨房** = kernel 的门 `./host` + bench;**工具间** =
`kernel/src/host/domain/` 与 `host/tools/<名字>/{contract.ts,session.ts}`(住户:grep、find、ls、powershell、toolchain、flash、log、la、gdb、datasheet、netlist、stm32config);
**发动机** = `packages/{agent,ai,chord,telemetry}`(哈希锁定)。

门就是 `packages/kernel/package.json` 的 `exports`,七道(外加 `./package.json`):

| 门 | 谁用 |
|---|---|
| `.`(`src/index.ts`) | 餐厅:视图模型 / 协议 / 客户端,**浏览器安全** |
| `./host`(`src/host/index.ts`) | 厨房大门:desktop 的 `kernel-entry.ts` 与 bench |
| `./host/datasheet-server`、`./host/models`、`./host/toolchain-schema`、`./host/engines` | 四道**叶子**门:desktop main 的手册库页、bench 的模型目录与信箱工具链清单、main 的信箱守护杀进程树(`killTree`)—— main 走大门等于把整个 host inline 进 `out/main/index.js` |
| `./tools/*/contract`(`src/host/tools/*/contract.ts`) | **契约门**:餐厅的工具卡片只从这里拿一个工具的名字 / 参数 / 结果格式 / 副标题函数,拿不到 `session.ts`。2026-09-11 起有住户了(flash) |
| `./tools/contracts`(`src/host/tools/contracts.ts`) | **契约总表**:餐厅按工具名找契约(只 import 各 `contract.ts`);装配在 `host/tools/index.ts`,那是厨房 |

- 内核必须被 electron-vite **inline**,所以它得留在 `packages/desktop` 的 **devDependencies** 里
  (`externalizeDeps` 只外部化 `dependencies`)。它只发 raw TypeScript(`exports` 指向 `src/*.ts`,
  内部大量 `./x.ts` 后缀说明符),外部化后 Node 的 strip-only 加载器报
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,**无 flag 可关**;`host/domain` 里还有约 9 处 TS
  构造器参数属性(加上 `src/client.ts` 的 `KernelError`)会直接 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。
  inline 时这两样一起消失 —— 也正因为这些参数属性,`tsconfig.yoma.json` 的
  `erasableSyntaxOnly: false` 是**承重的**,别顺手收紧。
- **工具样板**(2026-09-11,flash 是第一个):一个工具一个目录 `host/tools/<名字>/`。`contract.ts`
  是菜单:只许 import `typebox` 与工具间内部的相对路径(不含 session.ts),`as const satisfies ToolContract`
  (`host/tools/contract-types.ts`:name / label(中文短名)/ description / parameters / confirm(按参数决定
  跑前要不要问)/ guidelines(进系统提示词的守则)/ summary(卡片副标题));details 只放能 JSON 往返的字段,
  图片走 attachments。`session.ts` 是厨房:相对路径的工具间(`host/domain/` 的发动机与路径)加 `node:*`
  加发动机包的类型,真去起子进程。餐厅走两道门拿契约:`@yoma-desktop/kernel/tools/<名字>/contract` 与
  总表 `@yoma-desktop/kernel/tools/contracts`(只 import 各 contract.ts)。装配在 `host/tools/index.ts`
  (`createRegisteredTools()`),总表与装配面同名同序由 tool-names.test.ts 钉着。工具清单的真源是
  `kernel/src/types.ts` 的 `TOOL_NAMES`:desktop 的自检、`kernel-smoke.ts`、bench 的 `check` 三处走同一个
  `diffToolNames` 逐字同序比;系统提示词里 `selectedTools` 缺省时的四件套字面量只是兜底,不参与真源。
  boundary.test.ts 第 5 条按白名单扫契约文件,并要求每个工具目录都有 contract.ts。
  **参数写错时模型看到的话**(2026-09-17):校验在发动机里(vendored,原话不列合法值,模型会照着重试),所以装配面给
  每个工具挂 `withFriendlyArguments`(`host/tools/arguments.ts`)—— 走发动机留的 `prepareArguments` 口,先跑工具自己的
  归一(scope 的 `normalizeScopeArguments`:2 / "C2" / {ch:2} 同义),再按契约用发动机同款规矩预校验,失败就抛出
  指名字段、允许值、实收值的一句话。不要在契约文案里"补充说明合法值"来绕这件事,也不要碰 `packages/ai` 的校验。
- **模型流的空闲看门狗**(2026-09-17,`host/stream-guard.ts`):无头验证里 DeepSeek 的流静默断掉后内核等了 15 分钟 ——
  OpenAI SDK 的 timeout 到响应头为止,node fetch 的正文空闲超时约 45 分钟,harness 没有"多久没字节"的概念。修在传输层:
  `resolveModel` 用 `withStreamGuard` 包 `Models`,给 `streamSimple` 默认注入带正文看门狗的 `fetch`(pi-ai 文档写明的注入口),
  正文 90 s 没字节就把流置错,错误文本带 "timeout",发动机按可重试处理、harness 自己重发。`YOMA_STREAM_IDLE_MS` 改阈值,
  写 0 关掉。不要改成 session-manager 里调 `session.abort` 的看门狗 —— 那是用户取消的语义,丢重试。
- **工具进度链路**(2026-09-14):execute 的第三个参数 `onUpdate(partial)` 是工具边跑边上卡片的口。发动机把它
  转成 `tool_update` 事件;`host/session-manager.ts` 的 subscribe 里过一道 `host/tool-progress.ts` 的
  `ToolProgressThrottle`(按调用节流:前沿立即、之后每 100ms 一次、尾沿补发,`tool_end` 时丢掉尾沿),
  再交 `projector.updateToolProgress` 挂到 `ToolStateRunning.output / metadata` 上,走的还是
  `message.part.updated`。为什么必须节流:每一拍投影的是**整张卡片**(part 带着全部输出),不节流就是
  O(n²) 字节过 IPC。投影器对 completed / error 一律 no-op,晚到的一拍倒不回 running;进度不落 transcript。
  `runEngine` 的 `onOutput` 钩子是给 flash / powershell 喂活尾巴的(`appendTail`),内核 bash 自带流式;
  投影器把 running 态的 output 封在 8 KB(卡片是窗口不是记录,全文在 completed 态里),空快照在 subscribe
  里就丢掉(否则白花节流器的前沿)。bench 的 turn-entry 只在状态变化时打 "→ 工具" 行。
  卡片在 running 态可以展开(`session-ui/basic-tool.tsx`,pending 仍锁着)。
- **从 pi 移植的四个文件工具**(2026-09-12):grep / find 用自带的 rg(`engineBin("rg")` 绝对路径,内核进程的
  PATH 上没有它;`runEngineLines` 流式逐行、到 limit 就杀树)。用户的 glob **不交给 rg**:rg 的 `--glob` 是
  override 层,压在 .gitignore 之上(实测 `--glob '*'` 把 node_modules/ 整个放回来),所以 rg 只带 `!.git/`,
  glob 在 JS 侧按 gitignore 语义挑(`domain/paths.ts` 的 matchesToolGlob,**全平台不分大小写**);rg 在搜索根里
  跑、不带路径参数(给它绝对路径时锚定 glob 一个都匹不到);仓库外加 `--no-require-git`(共用 insideGitRepo);
  rg 退 2 但有命中时结果照给、尾部标 partial(一个读不动的目录不该让 grep 永久不可用)。find 用 `rg --files`,
  **只出文件不出目录**(pi 用 fd 会出目录)。ls 用 readdir(withFileTypes)而不是 env.listDir:后者对字符设备 /
  FIFO / socket 静默丢弃,`ls /dev` 会看不见 cu.* 串口。powershell 全平台恒定登记(清单平台无关),非 Windows
  没有 pwsh 时 execute 报未安装;Windows 上用 SystemRoot 绝对路径的 5.1,`-NoProfile -NonInteractive
  -ExecutionPolicy Bypass -EncodedCommand`,脚本头两行关进度条与置 UTF-8 输出(含 `$OutputEncoding`,否则 native stdin 中文变问号),
  接着 `Set-Location -LiteralPath` 定位工程(5.1 启动遇到 `[]` 会静默落回系统目录)。Windows 真进程回归与使用方法见
  `docs/WINDOWS-POWERSHELL-2026-09-15.md`。stderr 上的 CLIXML 块**解码**
  (取出 Error 记录,丢进度)而不是整块删 —— Write-Error 退出码是 0,整块删掉模型就以为成功了。CI 两岗测试前
  `npm run engines:rg` 只装 rg,grep / find 的集成用例在 CI 上缺 rg 直接红而不是跳过。
- **log 工具**(2026-09-14,第 6 步第 4 刀,从 attic/tools/{log,serial}.ts 重写):`host/tools/log/` 五个文件 ——
  `contract.ts`(菜单)、`excerpt.ts`(节选纯函数:折叠、骨架采样、按命中点开窗裁)、`capture.ts`(会话级采集器:
  child / tcp 两种源、环形缓冲 5000 行 / 512 KB、全量落 `<cwd>/.yoma/logs/hw-*.log`)、`serial.ts`(三平台串口:POSIX
  开两次 fd + `cat` 读继承来的 O_NOCTTY fd,Windows 是 PowerShell 5.1 读 System.IO.Ports 原始字节)、`session.ts`
  (六个动作 start / read / wait / status / stop / ports)。**一个会话一个采集器**,活在工具闭包里;装配面的工具多一个
  可选 `dispose()`(`tools/index.ts` 的 `RegisteredTool`),`session-manager.closeEntry` 在 stop 之后逐个调 ——
  桌面内核长驻,不收的话会话关了串口还被占着。log **不碰探针租约**(RTT 从 gdb server 的 TCP 口读,串口是另一个
  USB 接口);确认门只在 `command` 源的命令位站着探针程序时问(同 bash / powershell 那道 `probeCommandIn`)。
  wait 期间把预览行喂 onUpdate(走工具进度链路上卡片)。串口端到端用例靠 python3 的 pty,没有就跳过。
  两条审稿实测出来的规矩:**发动机的 AgentHarness 不读工具上的 `executionMode`**(那是老 agent-loop 的字段),
  同一批里的工具调用是并行的,所以 log 在工具内用一条 promise 队列把自己的调用串起来;采集器的**活性按
  'close' 判而不是按 'exit'**—— `sh -c "reader &"` 这种源 shell 一退 'exit' 就来了,真正吐字节的孙进程还握着
  管道,按 'exit' 判会让第二个 start 静默顶掉旧采集器,串口就被那个孙进程占到内核退出。
- **读图缩放**(2026-09-14,从 pi 的 utils/image-* 移植):`host/domain/image/` 四个文件 ——
  `photon.ts`(加载 wasm 库)、`exif.ts`(方向标记的**纯字节解析**)、`render.ts`(解码→转正→缩放→编码的
  原语 + worker)、`process.ts`(格式归一、限额策略、给模型的尺寸说明)。两个入口都过它:`read` 工具走
  发动机的 `imageProcessor` 钩子,输入框附件走 `session-manager.prompt`。超限**不是"这张图没了"而是整段
  对话被拒**,所以宁可缩、缩不动就明说没送。候选顺序 PNG 在前 JPEG 在后:供应商按**像素尺寸**计 token,
  留着无损不多花钱,波形与小字不会被糊掉。
  三条付过学费的规矩:
  1. **photon 必须对打包器隐形。** 它的 CJS 入口在加载那一刻就 `readFileSync(__dirname + "/*.wasm")`。
     一旦被 inline 进带顶层 await 的 ESM 产物(信箱守护、bench 评测入口),node 判不出模块类型,
     加载即 `ERR_AMBIGUOUS_MODULE_SYNTAX` —— 整个守护起不来,而报错跟图片毫无关系。所以源码里**一个
     import 说明符都不给**,运行期 `createRequire` 按绝对路径 require;包目录走 extraResources 落到
     `resources/photon`,路径由 main 的 `ensurePhotonDirEnv` 塞进 `YOMA_PHOTON_DIR`(内核 utilityProcess
     与信箱守护都从 `process.env` 继承;信箱是纯 node,查不到 `process.resourcesPath`)。
     test/image.test.ts 有一条按语法扫源码的守门用例。
  2. **重活在 worker 线程里。** 实测 4000×3000 一轮约 0.5 秒,而内核是一个进程伺候所有会话和界面 RPC。
     worker 一趟 19 ms。worker 入口**不是文件**而是 `new Worker(源码字符串, { eval: true })` —— 文件就要在
     四种运行环境里各自找得到,正是第 1 条那套麻烦。
  3. **因此 `renderImage` 必须自包含**:它的源码被 `toString()` 塞进 worker,引用任何模块作用域的符号在
     那边都是 ReferenceError。两条路的输出由测试逐字节比对钉着。**但自包含也保不住压缩过的包**:
     tsx 与 `--keep-names` 会把内部函数裹成 `__name(fn,"名字")`(所以源码里那行恒等 `__name` 是承重的),
     而 `--minify` 会把 `__name` 改名成别的字母 —— 名字对不上,shim 救不了。真正的兜底是
     **worker 报错就退回进程内**:`ok:false` 只可能是 worker 那份副本程序性故障(坏图片走的是
     `ok:true` + `undecodable`),所以它按"worker 坏了"处理,连续三次才彻底改走进程内。
     测试里压缩包与不压缩包各打一次,前者钉的正是"worker 坏了结果照样对"。
  4. **"没装这功能"和"这张没弄成"要分开说**:前者是 `runRender` 返回 undefined(压根没找到 photon),
     后者是 `{kind:"failed"}`。混成一句的代价是用户拿着一句"这个版本没装图像功能"去查根本不存在的打包问题。
  5. **压缩附件的那几秒里 lane 上没有操作**,用户这时按"停止",`stop()` 什么都取消不掉,然后这一轮照样
     开跑(对硬件 agent 就是一路跑到烧录确认条)。所以 `Entry.preparing` 是个可取消的标记,`stop()` 会翻它,
     `prompt()` 在 accept 之前回头看一眼。
  6. 说明(转过格式、缩过多少)**跟着消息进模型**,不只弹界面提示:模型看不到原图,不说它就会按缩略图的
     坐标回答。`read` 那条路由发动机拼进工具结果,输入框这条由 `prompt()` 拼进正文。
- **toolchain 工具**(2026-09-14,第 6 步第 5 刀,从 attic/tools/toolchain.ts 重写):`host/tools/toolchain/`
  两个文件,四个动作 check / resolve / set / install。探测、账本、下载解压**一行都没重写** —— 全在
  `host/domain/toolchain/` 里,那套实现同时被设置页的 RPC(`host/toolchain.ts`)用着,所以这一刀真正写的
  只是"参数 → 调用 → 人话"。
  这一刀的三条经验都不在工具本身,而在"同一件事有两个入口"这件事上:
  1. **锁要放在两个入口都够得着的盒子里。** agent 的 `toolchain install` 与设置页的「安装」按钮下载解压到
     **同一棵目录树**,同时跑不会报错,只会解出一棵交错的树。原来的 `InstallRegistry` 住在 `host/toolchain.ts`,
     而工具那一半按 `boundary.test.ts` 第 2 条够不到 `host/*.ts` —— 所以把它搬进 `domain/toolchain/install.ts`,
     `host/index.ts` 在建 SessionManager **之前**建好注册表、两边共用。副作用是白赚的:设置页的取消按钮
     现在能停掉 agent 正在跑的那次下载(两个中止信号在工具里合成一个)。
  2. **读—改—写的队列要长在被写的那个函数身上。** `writeLedgerEntry` 是读整份 JSON、改一条、写回去,中间
     隔着一个 await;同一批工具调用里 set 两个工具(用户一口气报了两个路径)就会丢掉一条。测出来的样子是
     五条并发写只活下来一条。队列放在工具里没用 —— 设置页那条调用路径根本不经过工具。
  3. **确认条的话术不能写死某一个工具。** 被拒时那句 "Do not run this or an equivalent probe command through
     bash" 是为烧录写的;toolchain install 被拒时,模型绕行的办法是 `curl | tar`,不是探针命令。多一个会问的
     工具,那句话就得改成对所有会问的工具都成立的说法。
  4. **一个包可能满足好几个工具**(Arm 那个包同时给 arm-gcc 和 arm-gdb),而锁按**包**去重。两条 MISSING
     行各喊各的 `install id=...`,模型就会在同一批里发两次调用,第二次必然收到 "already installing" ——
     而这正是最常见的那条路(两个都缺)。所以提示行里两条都指向同一个 id,并写明这一次装覆盖了谁。
  5. **描述里不许写"会先问用户"。** 挂不挂确认钩子是宿主的事:只有桌面端传 `confirmTools`,bench 与信箱
     工位端都不传。写了的话,对那两个无人值守的宿主就是假话,而模型据此以为有人把关。`FLASH_CONTRACT`
     一个字都不提自己的门,正是这个原因。
  另外:这个工具**不需要** log 那样的自排队(发动机忽略 `executionMode` 那条教训)—— 账本自己排了队、安装
  由注册表挡着,而 install 要几分钟,真串起来的话装 arm-gcc 期间一句 check 都要等几分钟。
  确认条的短名按工具名查 i18n(`session.confirmDock.tool.<名字>`),**缺键不是回落到工具名而是渲染出
  `undefined`**(solid 的 translator 对缺键返回 undefined,组件里那句 `text === key` 的兜底永远不成立):
  以后每加一个会问的工具,两份 i18n 都要跟着加一条。

- **la 工具**(2026-09-14,第 6 步第 6 刀,从 attic/tools/la.ts 重写):`host/tools/la/{contract,stats,session}.ts`,
  13 个动作。语义(事务聚合、期望差分、时序统计)早在 `host/domain/la` 里 —— 界面的波形图一直在用它,
  这一刀只是把**同一份厨房**也开给 agent。
  1. **有状态的工具第二次踩同一个坑:自排队。** arm 武装着一次采集活在闭包里,而发动机的 AgentHarness
     不读 `executionMode` —— 同一批里两条 `arm` 能同时通过"已经武装了吗"的检查、各起一个子进程,而引擎
     的采集库是全局单例 + 单活动设备。队列同 log。
  2. **dispose 收设备。** 会话关掉时武装着的采集要 abort,否则 DSLogic 被占到内核退出(与 log 还串口同理)。
  3. **数学搬进 `stats.ts` 是为了本机能测。** `yoma-la` 要 cmake + pkg-config + glib + libusb(Windows 上是
     MSYS2 ucrt64)才编得出来,开发机上常常没有;而脉宽 / 周期 / 毛刺算错**不会报错**,只会让模型自信地
     给出错误的根因("时钟是 400 kHz")。测试用**假引擎**(一段 JS,capture 时把仓里的 demo 波形拷成
     capture.dsl)让"采集 → 解析 .dsl → 统计 → 渲染"整条链真跑,只有碰 USB 那一步是假的;假引擎还记下
     自己收到的 argv,于是"通道名翻成通道号"这种拼错了不报错只出垃圾的事成了可断言的东西。
  4. **可选引擎缺席时不许说"重装"。** `engineBin` 那句通用报错是"重装 Yoma / 跑 engines:build",而 yoma-la
     本来就是构建脚本探不到工具链就跳过的可选件 —— 重装一百次也不会多出这个文件。而且少了它这个工具
     **还有一半能用**(别人存的 .dsl 照样 import / summary / timing / events),话术必须把那半条路指出来。
     同 image 那条"没装这功能"与"这张没弄成"要分开说。
  5. **收子进程要看"还没结束的",不能只看"武装着的"。** `collect` 一上来就把 `armed` 清掉,然后 await 那个
     子进程(缺省 30 秒,timeoutMs 能到一小时)—— 那段时间它还攥着 DSLogic,却谁都够不着:dispose 看不见、
     `killOnHostExit` 也不认,而 `runEngine` 是 detached,宿主这时退出就是个孤儿。所以闭包里有一个
     `owned` 集合,一次性的 `capture` 也登记进去;`collect` 不再提前摘,由采集自己结束时摘。
     (审稿实测:dispose 1 ms 返回,子进程 2 秒后才跑完。)
  6. **"会话正在关"的闸门要放在队列里面。** 放外面的话,排在一次采集后面的 `arm` 会在 dispose 之后照跑,
     起一个谁也收不走的子进程;dispose 还要等队列排空再返回。
  7. **只有会动状态的动作该排队。** 13 个动作全塞进一条队列的代价是 `la list` 跟在一次采集后面干等
     (实测 1.7 秒,生产里就是整个触发超时)。排队的只有 capture / arm / collect / stop;另外 `collect`
     要把这一轮的 abortSignal 接到那次采集的 controller 上,否则"永不触发 + 一小时超时"会把工具钉死,
     而停止按钮毫无反应。
  8. 假引擎的坑:分支体是异步的(慢采集要等定时器)时**不能**在它后面补 `process.exit(0)` —— 那会在定时器
     开火前杀掉进程,症状是"引擎退出码 0 但没有输出"。arm 不 await 子进程,所以断言 argv 之前要轮询等它起来。
  9. **"子进程被杀掉了"要用完成标记来断言**:让假引擎跑到最后写一个文件,然后断言 stop / dispose 之后
     那个文件**永远不出现**。而断言窗口必须**比采集自己跑完还长** —— 窗口短于采集时长的话,"杀掉了"和
     "还没跑完"长得一模一样,用例就是空的(第一版 1500/400 就是这个毛病,变异验证时才露出来)。

- **模型目录会过期,而且同步救不了**(2026-09-14):内建目录(`builtinProviders()`)是**随版本冻结的快照**,
  跟着 pi 的生成数据进仓,而上游同步工具明确不动那份数据;更要命的是绝大多数 provider 在 pi-ai 里是
  **静态的**(`createProvider({models:[...]})`,没有联网拉目录的口子)。所以"同步到最新的 pi"也带不来新模型。
  查这件事的全过程值得记:同一个 DeepSeek,pi 的命令行有 `deepseek-flash`,yoma 没有。我先后排除了
  三个地方(yoma 的目录、pi 源码检出的目录、brew 装的 pi 产物)—— 三处都没有这个模型。最后在
  `~/.pi/agent/models-store.json` 找到它,而那条记录带着 `etag` 与 `lastModified`,说明是**从某个 HTTP 目录
  拉来的**。顺着装好的 pi 产物挖出地址:`https://pi.dev/api/models/providers/<id>`,直接请求验证 ——
  返回的正是 `deepseek-flash`,etag 与本机存的一字不差。那一层(`withRemoteCatalog`)住在 pi 的
  **coding-agent 包**里,而我们只同步 ai / agent / chord / telemetry 四个包,所以从来没跟过来。
  yoma 的对应实现:`host/model-catalog.ts`(包装层)+ `host/models-store.ts`(落盘缓存)。三条纪律:
  1. **远端只在比内建数据新时才采用**(比 `lastModified` 与 `getBuiltinModelDataGeneratedAt()`)。合并是
     按 id 覆盖的,一份过期目录会把内建里更新过的条目改回旧值,而"变旧了"没有任何报错。
  2. **不在关键路径上联网**:开会话只 `refresh({allowNetwork:false})` 恢复磁盘缓存;联网只发生在后台那
     一次(首次有人问模型列表时)和用户手点"刷新模型列表"。4 小时节流 + If-None-Match,没变就是 304,
     而 **304 必须保留原有模型和 etag** —— 丢了就等于每 4 小时清空一次列表。
  3. `YOMA_MODEL_CATALOG_URL` 能换成自建镜像或设 `off` 整个关掉(那时就只有内建 + 缓存)。
  2026-09-15 Windows 首启补漏:`ensureModels()` 的在飞解析必须单飞。首屏多个组件同时读目录,
  各建一份注册表会出现“后台刷 A,较晚的 B 盖掉 A”,缓存已更新但本次启动看不到新模型。
  凭据变更同时清在飞解析与自动刷新标记;旧解析晚到也不许覆盖新表。目录指纹包含名称/档位/价格等元数据。
  `host/model-startup.test.ts` 覆盖这些时序,app 的 browser 回归钉住更新事件后旧响应不能盖回列表。
  教训的形状:**"我的清单比别人少"先问"别人那一条是从哪来的",别默认是同步落后。** 这次如果直接去补同步,
  再同步一百次也补不出那个模型。

- **gdb 第一刀:纯函数层**(2026-09-14,第 6 步第 7 刀,从 attic/tools/gdb-mi.ts + gdb.ts 的纯函数部分移植):
  `host/domain/gdb/{mi,cortex-m,render,elf,eval-policy,index}.ts` —— MI3 分帧与解析、Cortex-M 故障解码、帧渲染、
  ELF 头与 gdb 候选名、eval 闸门。不起进程、不碰硬件;会话与工具壳(`host/tools/gdb/`)是第二刀。测试
  `test/gdb-mi.test.ts`(110)+ `test/gdb-eval-policy.test.ts`(14)。gdb 拆两刀的理由:解析器错了会以"调用栈
  看着合理其实是编的"这种方式出错,最该先钉死;而一口气 2700 行的审稿面太大。
  1. **不接板子也有真语料。** `arm-none-eabi-gdb --interpreter=mi3 -nx -q` 对着 `test/fixtures/gdb/fixture_f4.elf`
     就能给出断点、反汇编、符号表、BreakpointTable、`echo 我` 的 `\346\210\221` 三个八进制字节 —— 这些都是
     静态的。17 条带 token 的命令抓成 `fixtures/gdb/mi-corpus.txt`(5 KB),测试按 1/7/64/1000 字节切块喂分帧器,
     CI 上没有 gdb 也跑;PATH 上有 gdb 时再对真进程发一遍、按真实 chunk 边界分帧,同一组断言。
  2. **变异验证抓到三条空转用例**(审稿人逐条改源码再跑测试):`TextDecoder` 改成 `fatal:true` 全绿(而真 gdb
     打印 `(char)0xff` 就是孤立的 `\377`,fatal 会在 stdout 回调里抛 —— 正是文件头说绝不能发生的事);
     `miNumber` 去掉十六进制分支全绿(现有样本 `Number()` 也认;真 gdb 给指针拖着符号:`0x8000274 <main>`,
     `Number()` 判成 NaN,指针求值静默变 undefined);`escapeCString` 不转义 `\t` 全绿(往返测试看不出,
     readCString 收裸 tab 也过)。三条都补了直接断言。
  3. **寄存器表要逐位对手册钉,而且要覆盖新架构。** ARMv8-M 的 UFSR bit 4(CFSR bit 20)`STKOF`(MSPLIM/PSPLIM
     栈限检查)原表没有 —— M33/M55/M85 上真正的栈溢出证据会被报成"CFSR 里什么都没有"。审稿人按 DDI 0403 逐位
     探针核对,现在每一位都有一条按 `1 << bit` 的断言,保留位断言不出声。
  4. **故障话术按组合定,不按单个位定。** FORCED 而 CFSR 为空 ≠ "向量表读失败",多半是处理代码已写 1 清零;
     BFAR 与 MMFAR 同时有效是两次粘滞故障,两个都要说、要标寄存器;IMPRECISERR 与 PRECISERR 并存时 BFAR 属于
     精确那次(规范:非精确错误不写 BFAR),只有入栈 PC 要打折。flag 的 meaning 只陈述位本身,可信与否由
     `decodeFault` 的尾句说。`decodeFault` 改收 `{cfsr,hfsr,mmfar,bfar}`:四个 u32 按位置传,换个位置类型看不出。
  5. **QEMU 上 FP_CTRL / DWT_CTRL / DHCSR / DFSR 经内存读出来全是 0**(实测):预算 0 是"不知道"不是"零预算",
     第二刀存 `total || undefined`,让 gdb 的 Z0/Z2 回复说了算。
  6. **eval 闸门比阁楼版多认四样**,都是实测能绕过去的:`load` / `flash-erase`(经 gdb server 改写 flash,和烧录
     一样贵却不经过 flash 工具)算写目标;表达式里藏的赋值 / `++` / `--`(`p x = 5`、`printf "%d", i++`)算写目标,
     字符串与字符字面量先剥掉;`set {int}0x2000 = 1` 这种按类型写内存的写法是正经的写而不是"裸 set";行首 `|`
     是 gdb 的 pipe 别名,会往 stdout 裸写。后者第一版就漏了:`|` 与空格之间**没有单词边界**,`\b` 套不住非单词
     字符 —— 写测试时抓到的。`exec` 的 `show` 表达式要用同一把尺(`expressionWrites`)。
  7. **Windows 上 DWARF 路径用 `/`、cwd 用 `\`,按 `path.sep` 硬比永远对不上**:`shortenPath` 两边各自归一成 `/`
     再比(win32 再忽略大小写),剥的是原串的前缀。
  8. 审稿人跑了真 QEMU + 真 gdb 的 badptr 场景把 `$psp` 上的异常帧整条链(parseRecord → unwrapList → hexToWords →
     decodeStackedFrame)对了一遍:pc=0x080003c6 = main.c:200 的那条 store,与固件自己打印的 hardfault_report
     逐字段一致;读 `$msp` 得到的是垃圾 —— 正是 EXC_RETURN 选栈那段注释在防的事。

- **gdb 第二刀:会话与工具壳**(2026-09-14,第 6 步第 8 刀,从 attic/tools/gdb.ts 重写):`host/tools/gdb/` 五个文件 ——
  `contract.ts`(菜单:六个动作 start / break / exec / eval / status / stop,确认门只在 `eval` 带 `write:true` 时问)、
  `servers.ts`(OpenOCD / J-Link / QEMU 的 argv、就绪判据、能力表,`connect` 解析,空闲端口)、`mi-session.ts`(gdb 子进程 +
  MI 收发状态机:token 派发、先装 waiter 再 resume、停止落盘)、`target.ts`(认核、`$psp`/`$msp` 上的异常帧、停止报告、
  源码路径映射、镜像校验、按 ELF 架构挑 gdb)、`session.ts`(六个动作 + 一条队列 + dispose)。TOOL_NAMES 末尾加 "gdb",
  共 13 个工具。测试 `test/tools-gdb.test.ts`:假 gdb(一段说 MI3 的 JS,行为从 mode 文件读)跑整条链,加上**真 QEMU +
  真 gdb 的端到端**(本机有 arm-none-eabi-gdb 与 qemu-system-arm 时才跑:attach、断点、continue、badptr 的故障现场、
  单步表、按停止时 interrupt、收尸)。
  1. **全部动作排一条队列**,不像 la 只排有状态的:gdb 是单个 REPL、探针是独占设备,没有一个动作适合并发;两条
     `start` 并发时第二条要看到"already attached"而不是起第二个 gdb。
  2. **等停止的那几十秒要能被停止按钮打断,打断时把目标 interrupt 住**:停住的目标能恢复,悄悄跑着的不能。
     `dispose()` 也走同一条路(一个 closing 信号并进每一轮的 abortSignal),否则关会话要等满 waitMs。
  3. **`show` 表达式每次停止都会被求值**,所以 `x=1` 这种写目标的表达式在 exec 入口就拒(与 eval 同一把尺
     `expressionWrites`);`load` 成功后更新 flash-state,否则下一次 start 会把刚 load 进去的镜像报成"不符"。
  4. **QEMU 的 FP_CTRL 读出来是 0**:预算按"不知道"处理(`total || undefined`),报告里明说,让 gdb 的 Z0 回复决定。
  5. **报告里的文件名优先 `fullname`**:`set substitute-path` 映射之后它才是本机路径、能剥掉工程根;`file` 是编译机上
     写的名字,永远剥不掉。编辑器位置(details.path)只在文件本机存在时才给。
  6. 夹具 ELF 的 DWARF 路径是编译它的那台机器的(`…/my-pi/…`),本机可能存在也可能不存在 —— 端到端断言按存不存在
     分两支,映射那一支由假 gdb 钉死(假的报一个不存在的 fullname、cwd 里放同名文件,断言 `set substitute-path` 真发了)。
  7. hello 场景 500 ms 内就跑完退出,"按停止"的用例要先把 `g_scenario` 改成 infloop(8)再 continue。
  审稿(两位,一个跑真 QEMU 对每个动作做实验、一个做生命周期变异)抓到 20 条,全部属实、全部修了。挑几条以后
  还会再踩的:
  8. **MI 对软件与硬件的写观察点都回 `wpt=`**(只有 console 文本不同),硬/软只能看 `-break-info` 的 `type`。阁楼
     那套"没有 hw- 前缀就是软件"把每一个写观察点都报成 SOFTWARE —— 假 gdb 回 `hw-awpt` 所以套件看不见。
  9. **断点表要跟着 gdb 的通知走**:临时断点命中后 gdb 发 `=breakpoint-deleted`,不处理的话预算表里留着幽灵单元,
     "没断点别 continue"的门也被幽灵放行。
  10. **对已经停住的目标发 `-exec-interrupt`,gdb 回 `^done` 但永远不来 `*stopped`** —— 等下去就是一份假的
      WFI / SWD 掉线诊断;目标退出后 gdb 照样回答 `p x`(值来自 ELF 的 .data 初值),`start` 也照样"复用"那个没有
      目标的会话。运行控制前先看 `state`:halted 就给现状,exited / connection-lost 就明说并让它 stop + start。
  11. **宿主退出只收了 gdb 没收 server**:SIGTERM 内核之后 qemu 被 launchd 接管继续跑(openocd 就是攥着探针)。
      `spawnServer` 现在也挂 `killOnHostExit`;gdb 崩了再 `start` 也要先 teardown —— 否则新起的 openocd 和旧的
      抢同一个探针,而旧的再也没人认。
  12. **确认门按效果判,不按动作判**(与 bash / powershell / log 的探针门同一条规矩):`start server:"openocd"`
      起的正是 bash 里会被问的那个程序,`exec reset-*` 发的正是 eval 要 write:true 才肯发的 `monitor reset`。
  13. **QEMU 上固件的 semihosting 打印只在 server 的 stdout 上**:落到 `.yoma/gdb/server-<tag>.log`,目标退出 /
      掉线的报告里带最后几行,status 里 server 死了要说 EXITED 而不是报一个 pid。
  14. OpenOCD 的 `monitor reset` 失败不走 `^error`("Error: timed out …" 是 `^done` 下面的普通文本):按文本判,
      没成功就别宣布"复位了"、别 bump epoch;成功但没等到 `*stopped` 时要说旧报告已过期。
  15. `info line` 要写 `*addr`(不带星号是行号);`info symbol` 不用。审稿人对着固件自己打印的 hardfault_report
      逐字段核了工具的故障报告,加上 xPSR(IPSR + T 位)之后两边一致。
  16. 探针租约与 server 收尸原本零覆盖(删掉 `releaseProbe` 或杀树全绿):假 openocd(打就绪串、真的在端口上听、
      写 pid、活到被杀)一条用例同时钉住租约、收尸、崩溃重起、keepServer;宿主退出那条用子进程 `node --import tsx`
      跑 spawnServer 再 SIGTERM 自己。

- **datasheet 工具**(2026-09-14,第 6 步第 9 刀,从 attic/tools/datasheet.ts 重写):`host/domain/datasheet/{section,hits,chips}.ts`
  (章节抽取、命中格式与产物路径检查、芯片 / 分卷 / 封面型号解析,纯函数)+ `host/tools/datasheet/{contract,client,session}.ts`
  (菜单;带超时的 fetch + 错误翻译 + 芯片索引单飞缓存;四个动作 search / read_section / view_figure / chips)。TOOL_NAMES 末尾加
  "datasheet",共 14 个工具。没有确认门(全部只读)、没有队列(无状态)、没有 dispose。session-manager 传 `datasheet: { configDir }`,
  地址与手册库页同解。测试 `test/datasheet-domain.test.ts`(35)+ `test/tools-datasheet.test.ts`(75 条假服务器 + 5 条真服务器,
  后者只在 `YOMA_DATASHEET_LIVE=1` 时跑,别让 CI 依赖公网)。
  1. **对着真 manifest 写,不对着阁楼写**:757 本里 305 本是按页切的卷(`RM0390_p401-800`),模型自然写 `rev:"RM0390"`,而服务器对
     不存在的 rev **一条都不回**(不是 GENERAL 噪声,是空)。`resolveRev` 把基名解析成全部卷、每卷各搜一次(并发)再按分数合并;
     `chips` 里一本分卷手册显示成一行并说明两种写法。服务器源码在 `../yoma-tools/RAG_yoma/server/app.py`,rev 的过滤语义在
     `rag_yoma/query.py`(给 rev = 只这一本、不折 GENERAL;不给 = 全家族 + GENERAL)。
  2. **三种无声失败各有一条兜底**:chip 是型号 → manifest 解析成家族重查(阁楼已有);名字不合法(空格、中文)→ 不打会 422 的那一枪,
     直接去索引解析;家族收录了但前 k 条全是 GENERAL(Cortex-M 内核手册在泛问题上分数高)→ 放宽到服务器上限 20 条把本家挖出来、
     本家排前 GENERAL 压后并说明,20 条里还是没有才说"没搜到"。阁楼版把第三种直接报成"chip 里没有匹配",是假话。
  3. **服务器的错误码要分别翻**:404 = 没有 /api/search,503 = 索引没发布,422 = 名字不合法;只有连不上 / 超时 / 5xx 才是
     "DATASHEET LOOKUP UNAVAILABLE"。把 422 翻成"服务器挂了"会让模型从此不查手册。
  4. **manifest 的拉取不绑任何一次调用的 abortSignal**:它 4.3 MB、所有会话共用一份缓存(模块级、10 分钟 TTL、单飞);按停止时那一次
     调用立刻返回(raceAbort),下载在后台走完进缓存。失败不缓存,端点不在(404)缓存 —— 旧服务器不该每次多打一枪。
  5. **view_figure 走 domain/image 那道**(与 read 工具读图同一条):大图压到供应商内嵌上限以内,缩过了给模型一句比例说明;阁楼版是
     8 MB 硬上限直接塞,超 5 MB base64 的图会让整段对话被拒。
  6. **封面型号**:33 本手册的 manifest 带 `covered_devices`,是**一个字符串**、带 `x` 通配与 `/` 备选(`STM32G081xB`、
     `STM32G071x8/xB`、`STM32G0B0KE/CE/RE/VE`、`STM32G0x1`)。第一版按 `string[]` 字面前缀写、测试用编的夹具全绿、线上一次都
     没触发 —— 审稿对着真数据抓出来的。现在展开成模式、`x` 匹配一个字符;夹具改成真 manifest 的切片(`test/fixtures/datasheet/
     manifest-slice.json`),别再对着编出来的形状写测试。
  7. 测试里地址一律显式注入(env + mkdtemp configDir):本机 `~/.yoma/.env` 指着旧地址,不注入的话断言取决于跑测试的人的 .env。
  审稿两位(一个对真服务器逐动作实验,一个做生命周期变异)抓到 21 条,全部属实全修。以后还会踩的:
  8. **read_section 要对着 Docling 的真产物写**:所有标题都是 `##`(位域行 "Bits 3:0 …"、"Reset value:"、"Note:" 都提成了标题),
     "到下一个同级标题为止"只给四行、寄存器表永远被切掉 —— 编号章节的边界按**编号深度**算;标题里的标点是转义的
     (`USART\_BRR`、`TIM6&amp;TIM7`)而命中的 `headings` 字段是裸的,13% 的标题(恰好是寄存器节)按面包屑找不到 —— 两边都
     `unescapeMarkdown`;有一个标题就叫 `2`,"wanted 以标题开头"这种反向宽松匹配会被它吞掉且 `mode:"section"` 看不出错 ——
     反向匹配要求标题撑起 wanted 的大半、在词边界上断(`30.6` 不是 `30.6.2` 的前缀)、取最长;命中的标题不是要的那个时
     输出第一行说 "(Closest heading to …)"。目录只列编号章节。
  9. **说给模型的数字要算对**:GENERAL 兜底的 "N 条压过本家" 要数真正压过本家最好一条的,不是 20 条里 GENERAL 的总数;
     返回的条数不超过 topK(本家优先、剩下的位子给 GENERAL);"几本手册"按文档数,分卷另注(chips 说 "14 manual(s)" 却只列 4 行,
     模型会以为藏了 10 本);候选清单截断要写 "+N more",不然 "Closest" 冒充全表。
  10. **索引拉不到时的全 GENERAL 也是落空**:第一版在 manifest 404 / 断线时把 GENERAL 原样递出去、一句不说 —— 这正是这个
      工具存在的理由;精确 chip + rev 零命中也要说"这本在、但没匹配",阁楼版有这句,重写丢了。
  11. **分卷扇出先试一枪**:服务器对每个请求重做一次 embedding,10 卷并发实测比一枪慢 6 倍;先一枪家族范围 20 条,目标卷够
      k 条就不扇出。服务器侧真正的解法是 `/api/search` 收 rev 列表,一次 embedding 服务所有卷(已建议)。
  12. 非 2xx 响应体的读取也要过中止:`res.text().catch(() => "")` 把用户按停止吞成一份"服务器不可达"的正常结果。命中整条
      归一(缺 `score` 时 `toFixed` 会把整个调用炸成裸 TypeError;`chip: null` 会冒充本家命中)。写完测试**再跑一次 typecheck**
      (第一版提交前 tsgo 只跑了源码,测试文件里三个类型错误是审稿抓的)。

- **netlist 与 stm32config 工具**(2026-09-15,第 6 步第 10 刀,从 attic/tools/{netlist,stm32config}.ts 重写,第 6 步到此收尾):
  `host/tools/netlist/{contract,session}.ts`(不带 part 跑 `controller_map` 出原始逐 pin 图,带 part 跑 `board_ir` 出三个 JSON)、
  `host/tools/stm32config/{contract,args,session}.ts`(七个子命令原样透给 `stm32kernel`)。TOOL_NAMES 末尾加 "netlist"、
  "stm32config",共 16 个工具。都没有确认门、没有队列、没有 dispose。测试 `test/tools-netlist.test.ts` + `test/tools-stm32config.test.ts`:
  假引擎(fixtures/fake-exe.ts)+ 真引擎层(仓库 engines/bin 在就跑;irpack 从 `engines/data/stm32` 或 `YOMA_TEST_STM32_DATA` 找,
  没有就跳过那几条)。
  1. **irpack 不进 git,但 `engines/build.ts --dist` 会随包出货**:它是 CubeMX 器件库的解析产物。普通分发要求至少 20 个包;
     Windows 发布 CI 显式传 `--allow-missing-irpacks`,没有 CubeMX 时可出缺数据的包 —— `schema` 之外的命令与 board_ir 都跑不了。所以:话要说成"这台机器没有器件
     数据"(不是"引擎坏了"、不是"跑 engines:build"),`schema` 不再要求数据目录,守则写成条件式("有数据时不许手写外设初始化;
     报没有数据时回落到手册 + 手写 HAL"),覆盖范围从数据目录现算、追加在工具描述末尾(契约是浏览器安全的菜单,读不了数据目录)。
     上轮 Mac 的 `engines/data/stm32` 是指向 `../stm32-config-kernel/data` 的悬空软链;当时可用的 irpack 在 `../my-pi/engines/stm32-config-kernel/data`
     (27 个 pack),`../yoma-tools/stm32-config-kernel/data` 那两个是旧格式(反序列化失败)。
  2. **stm32kernel 的退出码分类学**:0 干净;1 + diagnostics JSON = 正常诊断结果;其余退出码一律抛,即使 stdout 有内容。
     schema 是字段参考文本,其余命令要求 JSON 对象。配置文档先查普通文件再 spawn;不带 config 的 candidates 失败时引导修查询参数,
     不能叫模型修一份不存在的配置。
  3. controller_map 对不存在的文件回 Python traceback + exit 1:工具先查存在,给一句确定的 "netlist file not found"。原始图 42 KB
     截到 10 000 字符,截断前先把整份 JSON 解析出主控 ref 与 low_confidence 进 details。
  4. 引擎的 stderr 进度("loaded pack …"、"Detected main controller …")边跑边上卡片(onUpdate + appendTail),结果仍以 stdout 为准。
  5. **审查收尾修复**:默认产物住 `.yoma/tool-output/`(自带忽略规则),每次 board_ir 调用创建独立子目录;显式 outDir 也在其下
     创建独立子目录。同名网表、不同 part、并发调用不再互相覆盖。三个文件全部能读且是 JSON 才报告成功,旧文件不能冒充本轮产物。
  6. **截断不能是死路**:controller_map 原始图与 stm32config 大输出截断前保存全文,`details.outputFile` 和正文都给绝对路径。
     大芯片 describe-mcu 曾把 144 个 pad 截到 79 个,被藏起来的 ADC 通道没有别的读取入口。stderr 预览与异常也有长度上限;
     Python traceback 保留末行原因。board_ir 调内核失败时保留 stdout 诊断(`MCU_UNKNOWN` 原来被空 stderr 吞掉)。
  7. **参数必须对着真生成结果验证**:STM32F4 USART 的数据库枚举是 `STOPBITS_2` / `WORDLENGTH_9B`,不是 HAL 常量前缀;
     还必须指定 `mode: "Asynchronous"`,否则可生成空 init。回归用例直接核对 usart.c 的波特率、停止位、字长。
     覆盖描述明确列的是 pack 文件名,不是完整族目录(L4 pack 包含 L4+);查具体型号仍走 list-mcus。
  8. 旧审查里“偶发丢检测说明”的失败与另一个审查者变异删 stderr 的实验重叠,不能据此归因 runEngine;
     独立实测 8 次底层调用 + 72 次并发工具调用未复现。此次保留探测行断言,不改共用杀树/收流逻辑。
  9. 收尾验收:两工具 58 项(含真引擎 / 真数据包)、全仓 206 文件 / 2603 通过 / 7 跳过;typecheck 强制重跑 11/11 + 根,
     lint 75 warnings / 0 errors,桌面构建与六项 smoke/e2e 全通过;controller_map 的 check_board_ir.py 58 项通过。


- 新开一道深引用 = 改 `exports`(从前是改四份别名表)。`boundary.test.ts` 钉住五条:菜单里没有 Node;
  工具间不反调会话间(`host/domain` 往外只拿 `host/models.ts`、`host/datasheet-server.ts`);餐厅只许走
  `@yoma-desktop/kernel`、`@yoma-desktop/kernel/tools/<名字>/contract` 或 `@yoma-desktop/kernel/tools/contracts`;
  desktop 的 main 只有 `kernel-entry.ts` 能走 `./host`;契约文件按白名单只许 `typebox` 与工具间内部的相对路径
  (不含 `session.ts`),且每个工具目录都得有 `contract.ts`。

## 仓库结构

npm workspace,`packages/` 下 11 个包 —— 四个 pi 上游包、七个桌面端包。

pi 上游包(`ai` / `agent` / `chord` / `telemetry`,包名保留 `@earendil-works/*`)由根目录的 `upstream-lock.json` +
`npm run upstream:check|diff|update` 逐文件哈希锁定,**源码一个字都不改**,见 `UPSTREAM.md`。其中 `agent`
(`@earendil-works/pi-agent-core`,pi `b2602be77` 的新 AgentHarness)2026-09-09 搬进来,2026-09-10 起
kernel 接它 —— 从前那份自有 harness(`agent-legacy` / `@yoma/agent`)同日删除。

嵌入式应用层**不再是单独的包**:2026-09-10 `@yoma/coding-agent` 并进 `kernel` —— 工具链解析、
引擎辅助、逻辑分析仪与示波器的语义进 `kernel/src/host/domain/`(示例语料仍停在仓库外
`../yoma-parked/`),系统提示词、资源发现、模型目录、数据手册地址解析进 `kernel/src/host/`,用例文件进 `packages/kernel/test/`
(单独一个 vitest 项目 `kernel-domain`),归零的工具实现进 `packages/kernel/attic/`。

桌面端这 7 个:

| 包 | 名字 | 职责 |
|---|---|---|
| `desktop` | `@yoma-desktop/desktop` | Electron 外壳:main/preload/renderer、内核进程、打包、自动更新 |
| `app` | `@yoma-desktop/app` | SolidJS UI —— 一个**库**,两个宿主(web + desktop);页面、路由、状态、i18n |
| `kernel` | `@yoma-desktop/kernel` | **内核接缝**:浏览器安全的视图模型/协议/客户端 + Node 侧 host + 嵌入式应用层(`host/domain`) |
| `ui` | `@yoma-desktop/ui` | 领域无关的基础组件(Kobalte)、OKLCH 主题引擎、图标 |
| `session-ui` | `@yoma-desktop/session-ui` | transcript 渲染:消息、工具卡片、流式 markdown、Pierre diff |
| `util` | `@yoma-desktop/util` | 纯函数小工具 |
| `bench` | `@yoma-desktop/bench` | **无人值守调试台**:job 交给内核跑到底,判据自验,产出分支与报告 |

分层单向:`ui`(叶) → `session-ui` → `app` → `desktop`;`kernel` 被 `app`、`desktop`
和 `bench` 消费(`bench` 是 host 的**第二个宿主**,不经 Electron)。

`engines/` 是仓内真目录(2026-08-17 吸收),`npm run engines:build` 把各引擎装进 `engines/bin` +
`engines/data`。其中 `engines/logic-analyzer/` 是 **GPLv3**(vendored 自 DSView,见下文
"逻辑分析仪"),目录自带 LICENSE;Yoma 主体只经命令行与它对话,保持 MIT。

`packages/kernel` 的门(见"内核接缝")必须守住:

- `.`(`src/index.ts`)—— **浏览器安全**,不 import `./host`、不 import `node:*`、不 import 发动机。
  视图模型不解释任何工具的结果:`ToolState` 的 `metadata` 是 `Record<string, unknown>`,
  界面对所有工具统一走 `GenericTool` 万能卡(2026-09-10 卡片归零,专用卡待重写工具时按名注册)。
- `./host`(`src/host/`)—— 只跑在 utilityProcess(与 bench 的子进程)里,碰内核、碰文件系统。
- `host/domain/`(工具间)—— 嵌入式领域代码,往外只拿 `host/models.ts` 与 `host/datasheet-server.ts`,
  碰不到 session-manager / projector / protocol。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev:desktop` | 开发模式(renderer 有 HMR;**内核进程没有**) |
| `npm run build:desktop` | 生产构建 → `packages/desktop/out/` |
| `npm run package:mac` / `:win` / `:linux` | electron-builder 安装包 |
| `npm run typecheck` | turbo 跑全部 11 个包,再加根 `tsconfig.json` —— **必须常绿 11/11 + 根**(`packages/kernel` 自己那份 include 的是 `src` + `test`;从前只有被 kernel 的 paths 拉到的内核源码受检,test 目录没人查) |
| `npm run lint` | oxlint |
| `npm test` | 全量单测:`vitest run`,项目清单在根 `vitest.config.ts`(每个包一份 `vitest.config.ts`,app 另有 browser / perf 两份)|
| `npm run smoke -w packages/desktop` | 内核冒烟:对 **构建产物** 验证内核装配(内核自带的 4 个工具)+ 4 个引擎二进制 |
| `npm run e2e:ipc -w packages/desktop` | 生产路径:真 utilityProcess + 真 MessagePort + 真协议帧(不开窗口) |
| `npm run e2e:renderer -w packages/desktop` | 最后一跳:真窗口 + 真 preload + **真 contextBridge**(含 mailbox 桥三条) |
| `npm run e2e:paint -w packages/desktop` | 真窗口首屏 + 点一遍:Electron 跑构建产物 + 接 CDP,首页 / 会话页(含逻辑分析仪面板)/ 草稿页 / 手册库 / 调试台全点一遍,零 `exceptionThrown` 零 `console.error` / Log 错误(含资源 404)(窗口会在屏幕上闪几秒,别去点它) |
| `npm run smoke:mailbox -w packages/desktop` | 调试台冒烟:Electron RUN_AS_NODE 对打包产物跑完整**本机演练**(假模型,零 key 零硬件) |
| `npm run e2e:mailbox -w packages/desktop` | main 托管端到端:真 kernel.js 的 `mailbox.setActive` 往返 + 假守护喂 `@@event` + 停止杀树 + 锁冲突人话 |
| `tsx packages/bench/src/cli.ts check <job.json>` | 校验任务书 + 本机内核装配 |
| `tsx packages/bench/src/cli.ts mailbox sim <job.json> --project <工程目录>` | 信箱闭环单机模拟(`init`/`runner`/`mother`/`status` 是生产形态的四个子命令;工程目录是本机事实,任务书里没有) |
| `tsx engines/logic-analyzer/build.ts [--dist --out DIR]` | 只构建/安装逻辑分析仪引擎 yoma-la(`engines/build.ts` 会顺带做;Windows 要 MSYS2 ucrt64) |
| `engines/logic-analyzer/run.sh decode --in X.dsl --pd "i2c0=1:i2c:scl=1:sda=0"` | 开发期直接跑 build/ 里的引擎(把 ucrt64 的 DLL 放进 PATH) |

`smoke` / `e2e:ipc` / `e2e:renderer` / `e2e:paint` 是 CI(Windows 岗)里挡住"yoma 一次重构悄悄搞死桌面端"的东西 —— 我们是把它整个 inline
进 bundle 的,内核的改动可以在我们这边零编译错误地把 app 弄坏,直到用户点下去才发现。

`e2e:renderer` 单独存在是因为 **contextBridge 是一道序列化边界**,而它的失效是运行时行为:
typecheck 全绿、单测全绿、`e2e:ipc` 全绿,照样可以在这一跳把结构化错误剥成一句话
(见"会咬人的地方")。只有真起一个窗口、让值真的穿过去才看得见。

### 测试

- 测试跑在 Node 上(vitest),不再用 `bun test`;`bun:test` 的 import 已全部换成 `vitest`
- 全量:根目录 `npm test`;单包:`npx vitest run --project kernel`(项目名 = 包名;app 的浏览器条件用例是 `app-browser`)
- 也可以进包目录直接 `vitest run`,用的是该包自己的 `vitest.config.ts`
- `packages/kernel` 有**两个**项目:`kernel`(`src/**/*.test.ts` —— 投影器不变式、事件流、
  边界闸门、端到端 host)与 `kernel-domain`(并包搬来的 `test/**`,25 个文件 546 个用例,
  配置在 `vitest.domain.config.ts`,`fileParallelism: false` **串行**跑 —— 它们碰真实文件系统与子进程)。
  根 `vitest.config.ts` 里显式列了第二份;CI 的 Windows 岗跑的就是 `--project kernel-domain`。
- **会真跑 flash / gdb 的用例文件必须隔离探针锁**(2026-09-17):`beforeAll` 里把 `YOMA_PROBE_LOCK` 指到
  `tmpdir()/yoma-probe-test-<pid>.lock`。探针租约除了进程内那份还落一把**跨进程**的锁(`~/.yoma/probe.lock`),
  而 vitest 把用例文件分给不同的 worker **进程**:不隔离的两个文件共用机器上同一把锁,flash 一重叠,后到的拿不到
  租约、工具回 "探针被占"(error 不是 completed),等"完成数恰好为 N"的那一处就**永远**等不到。这是 `ci` 时红时绿
  里反复出现那两条的根因 —— `host.test.ts` 的「flash 跑之前先问用户」与 `session-manager-toolchain.test.ts` 的
  「settings set…」,恰好是仅有的两个会跑 flash 却没隔离的文件(kernel-domain 那三个早就隔离了)。先前把它当成
  "被饿到"去放大等待,第一轮 CI 就露馅:平时 1.2 秒的用例 **30 秒**都没等到 —— 等不到和等得慢是两回事,
  放大期限只治后者。用一个活着的外部进程占锁原样复现过(同一行的「等待超时」)。不隔离还会误伤开发机上正开着的 Yoma。
- **Windows 上删临时目录要真的等,别指望 `rmSync` 的重试**(2026-09-18,`packages/kernel/test/cleanup.ts` 的
  `removeTempDir`)。用例 abort 一个正在跑的假引擎之后,detached 的 taskkill 还没把它杀掉,`<临时目录>\stm32kernel.exe`
  这个映像还在运行,目录删不掉(EPERM)。Node 24 的 `fs.rmSync` 把重试交给原生实现,**实测 `retryDelay` 并不真的等**:
  设成 10 次 × 200 ms(名义上最多 11 秒)之后,整个用例文件仍然 7.2 秒就报了 EPERM —— 上一版"多重试几次"因此是空转,
  这条在 ci 上又挂了一次并挡住了 v0.2.9 的发版(发版脚本见 ci 红就不打 tag,是对的)。`removeTempDir` 每次失败让出
  事件循环、真睡 100 ms,只重试 EPERM / EBUSY / ENOTEMPTY,到期限把原错误抛出来。今天只有 `tools-stm32config` 接了它;
  别的用例文件在 afterEach 里清"刚 abort 过子进程"的目录时照着接。与上面探针锁那条是同一个教训的第二次:
  **"等不到"和"等得慢"要分开,先看那个东西到底有没有在等。**
- **CI 上的等待是放大过的**(2026-09-17,`packages/kernel/test/patience.ts`)。那之前 develop 的 `ci` 时红时绿,
  每次挂的用例都不一样、全是超时,真回归会被淹在里面。用例自己的期限大多已给到 20–30 秒,先到期的是**里面**
  那些 5 / 10 / 15 秒的轮询等待,和没写期限、吃 vitest 缺省 5 秒的用例。拿一次绿的 Windows 运行对过:同一条
  用例平时 1.2–1.3 秒,挂的那次是 5 秒、10.4 秒(慢 4–8 倍);「真实 PowerShell 退出 0」平时就要 5.9 秒 ——
  runner 只有 4 核,vitest 的 worker 把它吃满,而这些用例还要再起子进程。所以 `CI` 下:kernel 两个项目的
  `testTimeout` 是 20 秒,七份轮询等待(`waitFor` / `waitForCall` / `until` …)的期限过 `patient()` ×4。
  **本机不放大** —— 5 秒等不到的东西在开发机上就是坏了;慢机器用 `YOMA_TEST_PATIENCE=<倍数>`。
  新写轮询等待时照着接 `patient()`;**"这段时间内不该发生"的断言窗口不要接**(放大只会让 CI 白等),
  `vcs-watch` 那套自己调过节奏的也没接。另:笔记本用电池跑全量单测会被空闲睡眠打断,一段睡眠挂一条用例
  (实测 6 段对 6 条,耗时逐段吻合)—— 长跑前套一层 `caffeinate -i`。

## 架构

### 数据面:renderer ↔ 内核

没有 HTTP、没有端口、没有密码、没有 CORS、没有 SSE。

```
renderer  --window.api.kernel-->  preload(MessagePort 留在这一侧)
                                        |
                                   MessageChannelMain
                                        |
main/kernel.ts (只牵线,不在数据通路上)  --> utilityProcess: out/main/kernel.js
                                                          = kernel/src/host + yoma(inline)
```

- **只 fork 一个内核进程。** yoma 的 probe 租约(`claimProbe`/`releaseProbe`)、gdb session 表、
  log capture 都是 **模块级全局**,分片 fork 会让两个进程各自以为自己独占探针。
- **MessagePort 不能过 contextBridge**,所以端口留在 preload world,只暴露
  `{request, subscribe, reattach}`(形状就是 `KernelTransport`)。
- **失败也不能用 Error 过 contextBridge**,只能用普通对象 —— 见"会咬人的地方"。
- **attach 必须挂在 `did-finish-load` 上**,不能只在建窗时调一次。每次 reload
  renderer 的端口都会失效,不重新牵线就是一个哑通道 —— 不报错,表现为"点什么都没反应"。
- **请求可能早于端口到达**(provider 树一挂载就拉数据,而 `kernel-port` 是一条 IPC 消息)。
  preload 里排队,不 reject —— 直接 reject 的那一版是启动即崩,而且随机。

### 投影器:yoma 的模型 → 前端认得的形状

`packages/kernel/src/host/projector.ts`。三条不变式,违反时全部 **静默**:

1. **live 与 replay 共用同一个 `applyMessage()`。** 快照始终从 `partial.content` 重算,
   delta 只是叠在上面的增量,于是"累积 delta 是快照的严格前缀"天然成立。
   yoma 自己的 ACP 适配器在这里分了叉(`pipeHarnessToAcp` / `replayUpdatesOf`),
   代价是 datasheet 图片只在重放时可见。
2. **id 自己铸,而且确定。** 内核的 `generateEntryId()` 是 `uuidv7().slice(-8)` ——
   取的是 **随机尾部**,不可排序;而前端每个集合都用 `Binary.search` 按 id 字符串序维护。
   投影器从(消息序号, 时间戳)确定性铸 id,并对时钟回拨做严格递增钳制。
   (上游后来改成了完整 uuidv7 + 可注入 `idGenerator`,可排序;但投影器从不消费 harness
   的 entry id,这条不受影响。要干掉时钟回拨钳制的话,正路是给存储层的 Entry 加 `seq`。)
3. **发射顺序**:父 `message.updated` 早于它的任何 part;`part.updated` 早于该 part 的 delta。
   reducer 会静默丢弃孤儿 part 和未知 part 的 delta。

### 内核事件只能用 `subscribe()`

`packages/agent/src/harness/agent-harness.ts:230-248` 的 `emitOwn` 和 `emitAny`
**字节相同**,都只遍历订阅者桶。所以这 **11 个** `on()` 类型 **永远不会触发**:
`save_point` / `settled` / `abort` / `session_compact` / `model_update` / `tools_update` /
`resources_update` / `queue_update` / `after_provider_response` / `session_tree` / `thinking_level_update`。

只有走 `emitHook` 的是活的:`tool_call` / `tool_result` / `context` / `before_agent_start` /
`session_before_compact` / `session_before_tree` / `before_provider_request` / `before_provider_payload`。

**这是上游遗传的,而且不会被上游修好**:v1 从 0.80.6 到被掏空的 16 个提交里这两段逐字未变
(上游没人消费 harness,所以没人发现);v2/v3 是另一套事件模型。要修就自己修,而且要照上游
v3 规格(`pi/packages/agent/docs/harness.md` §5.5/§5.6)的形状 —— hooks 可拦截、events 按类型
分发且被动 —— 把 `emitHook` 与 `emitOwn` 收敛成一条,否则同一 handler 会被调两次。

### harness 的三个行为

1. 一个 harness = 一个 session = 一个在飞轮次。phase 非 idle 时 `prompt()` **同步抛** busy,不排队。
2. `abort()` 之后 phase 不会立刻清 —— 必须 `await abort(); await waitForIdle()`。
3. `prompt()` 在 abort 后是 **resolve 而不是 reject**(中断是数据不是异常),
   要区分"取消"和"完成"只能自己拿 AbortController。

### 我们补的、内核只给了机制的五件事

> "内核只给了机制"说的是 `packages/agent` 的 harness。上游**有**策略层,住在 coding-agent 的
> `AgentSession`(`pi/packages/coding-agent/src/core/agent-session.ts`,0.80.6 就在,3400+ 行),
> 是 yoma 删掉整层之后在 `kernel/src/host` 里重建了只服务桌面端的最小子集。要找参照
> (比如"响应完成但已溢出 → 压缩而不是重试"这类溢出策略、压缩可中断的 abort controller)
> 去那份看,不要以为上游没有。

> **没有权限系统。**2026-08-10 起整套权限保护(内核权限门、bench 三档策略与角色边界、
> 桌面弹窗 UI、探针互斥锁)全部删除 —— 这是产品决定,不是遗漏。agent 想调什么工具就
> 调什么工具,不问不拦。约束 agent 能做什么靠的是**它手上有什么**:工位端没有项目
> 检出,不把脚本送过去它就跑不了(见"信箱闭环")。代价一并写在这:同机的交互会话与
> 调试台任务可以同时抢探针,实测会撞 `0xe00002c5`。
>
> 2026-09-12 回来的**不是**它:下面第五条那条"烧录前先问"只有一条规则(契约自己声明
> `confirm`)、不记住选择、没有策略档位、没有角色边界,而且只在有人看着屏幕的宿主上开。

- **自动压缩与轮级重试**(2026-09-10 起**交回内核**:`host/compaction.ts` / `host/retry.ts` 已删)。
  新 core 自己做阈值压缩与 provider 失败重试,`lane.drive({ waitForRetry: true })` 把整段退避留在
  这一次调用里,于是重试对外是**一个连续的 busy** —— 这正是自己实现时最难的一条:退避窗口里
  漏出 idle,bench 会当真去跑判据,而 agent 正要重试,两边同时动板子。压缩状态由内核的
  `compaction_start`/`compaction_end` 事件出去;"这条分隔线是人手动按的"仍是我们自己补的
  (`yoma/compaction` 自定义 entry,见"投影器")。
- **模型目录**(`SessionManager.providers()`)。目录本身是 pi-ai 的内建目录
  (`@earendil-works/pi-ai/providers/all` 的 `builtinProviders()`,0.84.2 是 40 家),
  2026-08-23 起**不再手写 provider 表** —— 从前 `core/models.ts`(当时在 `acp/`)手抄两家、kernel 再抄一份
  id/name 给连接对话框,靠防漂移测试钉住,结果就是"只支持 DeepSeek 和 Kimi"。
  `resolveModel()` 的不变式是**注册 == 已配置**:全部注册、逐个 `checkAuth()`、没凭据的删掉,
  所以注册表里的一律 `authenticated`。连接对话框列的是 `configurableProviders()`:运行时
  用假交互跑一遍各家的 `apiKey.login`,只问一个 secret 的才算"一个 key 就能用";
  bedrock / vertex / cloudflare(还要账号 id、区域、项目)、openai-codex(只有 OAuth)、
  radius(目录要联网拉)由此自动排除 —— 这些家填了 key 也永远亮不起"已连接"。
  `thinkingLevels` 必须走 pi-ai 的 `getSupportedThinkingLevels(model)` 去问,编错的后果是
  档位能选但发不出去。
- **默认思考档位**(`src/thinking.ts` + `KernelHostOptions.defaultThinkingLevel`)。
  yoma 没人指定档位时落到 `"off"`(`agent-harness.ts:214`),而 `"off"` 会把
  `reasoning` 整个从请求里摘掉(同文件 `:429`)—— 对 reasoning 模型这就是**最强的
  那一档默认关掉,且没有任何地方提示**。这是注入位而不是常量,因为两个宿主的答案
  不一样:**桌面端不传**(档位是模型对话框里的现场选择,经 `setModel` 下发),
  **bench 传**(无人值守,没人看着那个开关)。实测代价:2026-08-11 的信箱闭环,
  工位端跑 deepseek-v4-pro(支持 high/max)5 轮、107 条 assistant 消息,
  reasoning token **0**,平均每条输出 146 token —— 一步一句话一个工具调用,
  从不停下来想;同机交互式会话选 max 时同一家的更弱模型反而 4 倍的思考量。
  档位由 `pickThinkingLevel` 按模型实际支持的表落定,所以给一个模型没有的档位是
  安全的。它与 pi-ai 的 `clampThinkingLevel` **必须同解**(renderer 只拿得到
  `ModelInfo.thinkingLevels` 字符串数组而不是 `Model`,所以另写了一份),
  这道闸门在 `thinking.test.ts` 里直接拿真 pi-ai 对答案。
  另:`setModel` 换模型之后**必须重钳当前档位** —— 构造期那次是按 `ensureModels()`
  的默认模型算的,而调用方紧接着要换成任务书钉的那个。
- **调试台的默认模型**(`bench/src/job.ts` 的 `DEFAULT_MODEL`,`parseJob` 里落定)。
  任务书不写模型时,两端都跑 `deepseek/deepseek-v4-flash`,档位 `max`
  (`DEFAULT_THINKING_LEVEL` 因此从 `high` 提到 `max`:Flash 的单价只有 V4 Pro 的
  三分之一,省下的换成想得更狠;想得不够的代价是多跑一轮,比 token 贵得多)。
  **不落定的话它是看不见的**:两侧各自回落到内核的"本机第一个有凭据的 provider 的
  默认模型",可以是两家不同的模型,而信箱里没有一处记着这回事。落定在 `parseJob`
  是因为入箱的 `job.json` 本来就是"归一化后的 spec"(`init.ts`),工位端读到的于是
  是答案本身而不是它那台机器的猜测。只填一半的 model **整个**落回默认,不猜另一半。
  代价一并写在这:机器上没有 deepseek 凭据时,第一轮会硬报 `未知模型 deepseek/…`
  —— 这是有意的,任务书里写 `model` 或配 key 就好;`yoma-bench check` 会把落定后的
  两端模型印出来。faux 演练(`smoke:mailbox` / `sim`)例外:注入了 `resolveModels`
  时 `turn.ts` 不下发模型,否则演练会撞上"注册表里只有假模型"。

- **烧录前先问用户**(`host/confirm.ts` 的确认台 + `host/session-manager.ts` 的 `before_tool` 钩子)。
  内核只给了钩子:`before_tool` 的 handler 可以异步,返回 `{ block: { reason } }` 就是"这次别跑",
  reason 原样变成模型看到的工具结果。"问谁、问什么、没人答怎么办"全在我们这边:
  - **问不问是契约的事**,不是钩子的事。`host/tools/contracts.ts` 的 `confirmNeeded(name, args)`
    问契约的 `confirm?(input)`(flash 每次都问;toolchain 将来只在 install 时问,所以它是函数不是
    布尔),界面短名与确认条那段命令都用契约的 `label` / `summary(input)` —— 前端再拼一遍的后果是
    确认条上显示的命令和真跑的那条不是一条。
  - **门按"跑了哪个程序"判,不按工具名判**。只认 flash 的门是假门:模型被拒之后改用 bash /
    powershell 起同一条 openocd,一个字都不问(2026-09-13 猎漏确认)。所以 `flash/contract.ts` 的
    `probeCommandIn(commandLine)` 扫命令位(跳过 sudo / & / python -m 这类包装,不扫参数 ——
    `grep openocd log` 不该问)找 openocd / JLink / STM32_Programmer_CLI / esptool / `west flash` 等,
    powershell 的契约与 bash 的 `BASH_GATE` 都接它。这是纱窗不是墙:故意把程序名拼进变量再执行的
    写法拦不住,那一层靠 guidelines。确认条整段显示命令(换行、超高滚动),不再 truncate ——
    mass_erase 藏在省略号后面用户就点了允许。
  - **四种结局都得 emit 一条 `tool.confirm` 事件**(`pending` 进、`allowed`/`denied`/`cancelled`/
    `expired` 出)。前端的确认条按 id 加、按"status 不是 pending"删;漏发一条的表现不是报错,
    是输入框上永远挂着一条答不掉的确认,而模型早就收到拒绝走了。
  - **桌面端开(`confirmTools: true`),bench 与信箱不开**。无人值守的宿主没人点"允许":挂起会
    一路等到确认台的十分钟超时,而 bench 判一轮结束看的是 idle 静默 700ms,整轮只能等到
    一小时硬超时才收场,报告里看起来是"agent 卡住了"。
  - **十分钟没人答按拒绝**。不设上限的代价是一条挂死的确认把会话永久钉在 busy 上,
    而那条确认条可能早被一次 reload 刷掉了。
  - **`stop()`、`closeEntry()`、`fail()`、`run_end` 各自先 `desk.cancel()` 再往下走**。挂起中的钩子
    占着这一轮的 drive,取消与 `waitForIdle` 都要等它先回来;内核交给 handler 的 gate 信号是另一条路,
    `cancel()` 覆盖的是信号不会来的路径(fail 把状态打回 idle、操作已不在飞、会话被关)。两条路各自
    成立,别互相指望。钩子本身**不**并进 `entry.unsubscribes`:closeEntry 先摘订阅再 stop,而 cancel
    结算掉第一条之后同一批里的第二条工具会立刻轮到 before_tool —— 钩子要活到 stop 之后再摘。
  - **三种拒绝给模型三段话**(`beforeTool`):用户拒绝 → "别在问过用户之前重试";十分钟没人答 →
    "没人批准,问了再试"(说成"用户拒绝"会让模型换招绕开,而用户只是没看屏幕);会话被停 → "没跑"。
  - **钩子里绝不 throw**。抛出去会被内核先转成一条错误上报、再当作拒绝(`harness/hooks.ts` 的
    `beforeTool` catch 分支),于是用户点一下"拒绝",屏幕上多一条"内核出错"。
  - **事件不重放**,所以 `resync()` 把未决的确认整批再推一遍,另有 `session.confirms` 给首屏
    / reload 问现状(同 `toolchain.installsActive` 的存在理由)。

项目上下文与技能走 `host/resources.ts`(从上游 coding-agent 搬来的 `loadContextFiles` / `discoverSkills`),
不重写:"从哪些目录找"是内核那边的产品决策,抄一份的结果是"Zed 读得到项目的 AGENTS.md、
桌面端读不到"。全局目录默认 `~/.yoma`,与 ACP 同一份,于是同一份技能两处都生效;
`configDir` 可注入,**测试必须传它**(否则读的是开发机真实的 `~/.yoma`,结果取决于
跑测试的人装了什么技能)。快照式:建会话时读一次,改了技能文件重开会话即生效。

模型凭据走 `host/models.ts` 的 `resolveModel(configDir)` → `<configDir>/auth.json`,默认
`~/.yoma/auth.json` —— **2026-08 起不再跟 pi 共用 `~/.pi/agent/auth.json`**,当时
把凭据独立了出去,同时把 `resolveModel` 改成必须显式收目录(在我们这边是编译期
硬失败,接缝的设计目的正是如此)。配过 Zed(当年那条 ACP 路径)的机器仍然零配置开跑。

两个必须记住的点:

- **格式带判别字段**:条目是 `{"deepseek":{"type":"api_key","key":"sk-…"}}`,少了
  `type` 会被 pi-ai 的 `resolveProviderAuth` 静默忽略(表现是"我明明配了 key 却说没配")。
  所以写入端直接用 yoma 导出的 `FileCredentialStore`,不自己拼 JSON。
- **迁移只在没注入 configDir 时做**(`host/auth.ts` 的 `migrateLegacyPiAuth`):
  注入的调用方(测试、隔离跑的 bench)显然是在隔离,不该反手去读真实 HOME 的老凭据
  —— 否则隔离是假的,还会把用户真实的 key 复制进临时目录(实测踩过)。
  迁移幂等、不删旧文件(用户可能还在用 pi 命令行)。

`configDir` 一处管三样:凭据、技能、上下文文件,与 yoma ACP 的 `CONFIG_DIR` 同义。
凭据解析还有第二个注入口 `authContext`(pi-ai 的 `AuthContext`:环境变量 + 文件存在性,
`KernelHostOptions` / `SessionManagerOptions` / `resolveModel()` 都收):**测试必须传
`NO_AMBIENT_AUTH`**。目录有 40 家,开发机上一个 `ANTHROPIC_API_KEY` 或一份
`~/.aws/credentials` 就会让"首跑无凭据"的测试说谎,逐个删环境变量列不全。生产不传。

### 调试台(`packages/bench`)

host 的**第二个宿主**:`createKernelHost()` 是纯 Node 装配(零 Electron 依赖),
bench 直接 import 它跑无人值守任务,于是投影器、自动压缩、工具装配、会话协议全部白得。
`sessionsRoot` 默认指向 desktop 的 userData —— 跑完在桌面端直接回放。

两条不变式,动这个包之前先读:

1. **一轮一个子进程**(`turn-entry.ts`)。yoma 的探针租约/gdb 会话表/log 采集器都是
   模块级全局,进程边界 = 免费且可靠的清理,下一轮不会撞上"探针被占着"。
   子进程协议是单向的:输入一个 JSON 文件、输出一个 JSON 文件、stdout 是进度。
2. **代码不裁决任何东西**。跑几轮、花多少、算不算做完,全归模型 —— 没有轮数/token/
   墙钟上限。代码只在"决定 JSON 连着两次读不出来"时终局(记 `by:"policy"`),
   那不是裁决,是没法把它的话变成动作。要提前收工就在桌面端按停止。

**yoma 在用户项目里只有一个落脚点:`<工程>/.yoma/`**(2026-08-11 起;从前是 `.bench/`
与 `.yoma/` 两个目录、两份 .gitignore、两套相反策略):

```
<工程>/.yoma/
  .gitignore                     ensureYomaDir 写的那一份(黑名单,含忽略自己)
  gdb/  logs/  flash-state.json  工具运行产物
  bench/
    mailbox.template.json        项目配置,**要提交**
    turns/  mailbox-sim/         调试台运行产物
```

它必须自带 `.gitignore`,否则运行产物被 `git add -A` 卷进提交(实测:信箱闭环首跑,
17 个改动文件里 16 个是 `.yoma/gdb/*.mi`);`.gitignore` 还要**忽略它自己**,否则
工作树永远不干净,而研发端每轮开局都要求树干净(实测被自己挡死过)。
`ensureYomaDir` **会升级自己写过的旧版**(认第一行的 `# yoma` 标志)—— 从前是"文件
不存在才写",于是老仓库停在旧规则上,合并之后 `bench/turns/` 会照旧漏进版本库。
用户手写的 .gitignore 一律不动。

工程根从模板路径反推时**往上找 `.git`,不数目录层数**(`mailbox.ts` 的
`inferProjectDir`)。写死 `dirname×2` 的那一版在模板深一层之后会把工程根推成
`<工程>/.yoma`,而且不报错 —— 症状是"agent 说它看不到代码"。
`result.text` 只收 **assistant** 消息的非 synthetic text part(用户消息的 part 也是
text part,不过滤的话提示词会原样出现在终报的"根因分析"里)。

### 信箱闭环(`bench/src/mailbox/`)

跨机器多轮调试,唯一通道是一个 git 仓库(信箱)。两侧都是 yoma 内核跑的 agent。

**分工**:角色字符串是 `mother`/`runner` ——

- **mother = 研发端**:有工程检出与构建环境。读证据 → 改代码 → 构建 → 把产物当
  **附件**塞进本轮 → 用大白话写指令。它在项目仓上开分支、每轮提交、终局推交付分支。
  碰不到硬件(板子根本不在这台机器上)。进程内跑,不需要子进程。
- **runner = 工位端**:板子在这儿,而且**只有板子**。领指令与附件 → 自己决定怎么
  上板 → 复现观察 → 把看到的现象回填。

分工的依据是**手上有什么**:改代码要工具链和完整检出,那在研发机;上板要探针,那在工位机。

**工位端没有项目代码**(2026-08-10 起)。它的工作目录是一个一次性目录,住在信箱克隆的
**兄弟位置**(不能在克隆里 —— `pullReset` 的 `clean -fd` 会把附件删掉),内容全部来自
附件。于是这一侧不需要 git、不需要构建工具链、不需要"工作树干净"这套纪律。

两条由此而来的硬性话术要求(落在 `mailbox/prompts.ts`):

1. **上下文由研发端补全**。工位端读不到源码,所以"这个地址是什么变量""这一版改了
   什么""该盯哪个符号"必须写进指令。研发端的角色提示词专门交代了这一段。
2. **附件是工位端拿到任何东西的唯一通道** —— 固件、诊断脚本、参考数据都走它。
   要给 agent 加工具,就是往 `artifacts` 里多列一个文件,不需要改协议。
   反方向那条是**回传**(2026-08-12 起):工位端工作目录下的 `outbox/`,丢进去的东西
   被收进本轮 `back/`,再落到研发机的 `.yoma/back/<轮次>/`,路径每轮列进提示词。
   上行**不设"声明"这一步** —— 工位端是唯一挨着板子的一侧,给它加一个"必须写出可解析
   结构"的契约等于在最不该失败的地方多一个解析失败模式;扫目录是确定性动作,不经模型。
   收过的移进 `outbox/.sent/<轮次>/`(留底 + 不重传);超限**跳过不报错**并记进
   `backSkipped`(拦住上行等于把整轮结果一起毙掉),单轮默认 16MB。
3. **工具链清单是唯一的例外,它走自己那条路**:研发端每轮下发时把
   `<工程>/.yoma/toolchain.json` 原样复制进信箱根(`store.ts` 的
   `syncToolchainManifest`,幂等),工位端读出来经 `TurnInput.toolchainManifestText`
   灌进内核,并钉死 `toolchainSide: "runner"`。不这么做的话工位端那侧
   `resolveToolchain` 找不到清单、**静默返回空**,于是它对"缺什么、按什么方法装"
   一无所知 —— 表现是 agent 撞一个 `ModuleNotFoundError` 再把它当成"脚本坏了"
   报回去,研发端拿到一条误导性证据。side 必须传:那台机器上只有板子,核 cmake /
   arm-gcc 会一路报 MISSING,盖住真正缺的那条。清单是提交进库、零绝对路径的项目
   配置,所以复制它是安全的 —— 两台机器读同一份声明,各自对着**自己的**账本
   (`<configDir>/toolchains.json`)和 `toolchain.local.json` 解析。

- **协议里不预设"怎么把新固件弄上板"**:附件 + 一句人话就是全部机制。换成 OTA 或
  远端 CI 产物时,变的只是指令里那句话和工位端手上的脚本 —— 不用改协议。
  代价是"它可能忘了烧却接着测" —— 挡它的是研发端把**自证**写进指令(让工位端报出的
  数字本身能说明版本,比如读构建指纹),不是协议。
- **状态由文件存在性推断,不落状态文件**:零轮次 → `kickoff`(等研发端开第一轮,
  init 不再写死"只复现取证");instruction 有而 result 无 → 等工位端;裁决是
  `await-human` 而 `human-ack.json` 没来 → 挂起等人;result 有 → 等研发端;
  `verdict.json` 出现 → 终局。工位端的 result.json **最后写**(回传件 `back/*` 与
  自述全文 `bench-report.md` 都在它之前),研发端的 decision + 下轮 instruction +
  附件 + patch **同一次提交**。
- **人工动作有自己的状态**(2026-08-12 起):`await-human` 不是终局,是"这一轮到此为止,
  等人去板子边上动手"。接电源、换负载、动机械不是任何 agent 能做的;没有这个值时,
  研发端唯一能表达"我在等人"的方式是再下发一轮"请转达……"——实测一次真任务 5 轮里
  3 轮是这么空转掉的。挂起期间**两侧都不跑轮**;回执 `rounds/NNN/human-ack.json`
  一落地,状态自己滑回"等研发端裁决"(没有别的唤醒机制),挂起那次分析的花费结转进
  重裁的 decision。回执**两台机器都写得了**(桌面端进度页两个按钮 / CLI 的
  `mailbox ack`),用**自己一个克隆**写,绝不碰守护那两个。开局轮不接受 `await-human`
  ——那一刻挂起没有地方落。
- **pull 是 `fetch + reset --hard + clean -fd`**,工作树永远等于远端已推真相 ——
  崩溃写了一半的文件在下次轮询自动消失,协议退回"重跑本步",没有恢复逻辑可写错。
  两侧的本地状态(会话指针、token 计数)住在自带 `.gitignore` 的目录里,clean 不删
  被 ignore 的文件,这是它们的护身符。
- **裁决全归模型**。研发端给 `continue` / `done` / `fail` / `await-human`,包括什么时候停 —— 没有
  轮数/token/墙钟上限,也没有独立判据机制。"通过"就是研发端读完工位端自述之后的判断,
  "够了"也是。代价是它可能一直 `continue`:提前收工靠桌面端的停止按钮。
  唯一的例外是单机模拟(`mailbox sim`)有一个 60 分钟的看门狗 —— 那是演练台要在 CI 里
  收敛,不是产品预算。
- **交付 push 在研发端**(代码在它那儿),而且必须在"刚写下 verdict"那一步就做 ——
  守护循环见到 done 就返回退出,留到下一轮等于永远不做(测试逮住过)。
- **任务书里不许有绝对路径**:它要在两台机器上被读。研发端的工程目录由本机配置提供
  (`resolveWorkspace(job, localDir)`;桌面端是配置页的"工程目录",CLI 是 `--project`),
  `serializeMailboxJob` 会主动摘掉 `repo.directory`。工位端根本不需要这个配置。
- 附件落在工位端工作目录的**根**,`result.incoming` 里是纯文件名。
  **不清空**:某轮没带附件不代表旧固件失效,板上跑的还是它。
- **工位端自述进提示词时头尾都留**(头 6000 + 尾 14000 字,`prompts.ts` 的 `clipEnds`):
  汇总行、RESULT、结论永远在末尾,只截头部正好砍掉最该看的那半(实测一次五轮任务里
  每一轮都超过当时 4000 字的上限,首轮丢掉 44%)。全文另存 `bench-report.md` 并落到
  研发机,提示词给路径 —— 细节让它自己去读,不进会话历史一轮轮累积。
- 单机模拟(`mailbox sim`)起 **两个真子进程 + 各自的克隆 + 本地裸仓**,与生产的
  差别只有远端 URL(`--remote` 换私有 GitHub 仓即是跨机器形态)。

**产品形态(2026-08-08 起,P1–P3 已进桌面端;协议见 `docs/信箱闭环-协议与双机部署.md`)**:

- 引擎打包成两个纯 node 产物(`out/main/mailbox-host.mjs` 五角色一个入口 +
  `mailbox-turn-entry.mjs`,esbuild 见 `desktop/scripts/build-mailbox.ts`);
  守护 stdout 上的 `@@event {json}` 行是唯一事件通道。
- 桌面 main 托管守护(`main/mailbox-controller.ts` 纯逻辑 + `main/mailbox.ts` 接线;
  child_process.spawn + RUN_AS_NODE,**不用 utilityProcess.fork** —— 它的 kill 没有
  信号可选,POSIX 优雅停机依赖 SIGTERM 链);renderer 走 `window.api.mailbox`,
  app 页面在 `/bench`(四分区:配置/任务/进度/终报)。
- **配置页的"工程目录"只有研发端角色要填**(`mailbox-controller` 的开跑守卫按角色
  分):工位端没有项目检出。
- **信箱克隆落在 `<configDir>/mailbox/clones/<远端+分支哈希>/<角色>`**(configDir 默认
  `~/.yoma`,与凭据/技能/上下文同一个目录),**不在 Electron 的 userData 里**
  (2026-08-11 搬的)。理由是单实例锁:`.yoma-lock/<role>.pid` 住在**克隆目录里面**,
  锁的是"这个物理目录"而不是"这个信箱" —— 桌面端在 userData、CLI 让你自己指路径,
  两边落在不同目录时两把锁互不知情,同一个信箱同一个角色能被跑起来两个守护,同时推
  同一个远端、同时抢同一块板子(实测撞过:CLI 跑 mother 的同时桌面端也能启动)。
  位置只有**一份实现**:`bench/src/mailbox/paths.ts`,CLI 与桌面端都用它。
  该文件必须保持**叶子模块**(只依赖 `node:crypto`/`node:os`/`node:path`)并经 bench 的
  `./mailbox/paths` 深引用导出 —— desktop 的 main 要 import 它,而 bench 在 desktop 的
  devDependencies 里,`externalizeDeps` 不碰它,走主入口等于把整个内核 inline 进
  `out/main/index.js`(实测走叶子模块只涨 373 字节)。它与内核 `yomaConfigDir()` 的漂移
  由 `paths.test.ts` 的断言兜住。
  **会话(sessions)不跟着搬**,仍在 userData —— 它是给桌面端回放看的,不是跨进程共享的
  agent 状态。
- **退出 app 必须带走守护树**(`stopSidecars` → `mailboxMain.stopAll`):任务在飞时
  Cmd+Q 或自动更新 relaunch,守护与 turn 孙进程会变成**还在烧录/gdb 的孤儿**。
  先 SIGTERM 让守护自己转杀孙进程,宽限后硬杀。`runner.ts` 的 `activeTurnChildren`
  是这条杀树链的中间一环 —— 漏掉就是孤儿 gdbserver/烧录器攥着探针不放,而报错长得和
  "没插板子"一模一样。
- 浏览器侧类型是 kernel 的 `mailbox-view.ts`(结构化复制,View 后缀),漂移由
  bench 的 `mailbox/view-check.ts` 约束式断言兜住 —— 与工具 details 同一套纪律。

### 逻辑分析仪(`la` 工具 / `engines/logic-analyzer`)

2026-08-21 起。DreamSourceLab DSLogic 的采集与协议解码**原生集成**,用户不装 DSView。

**形态**:一个 C 引擎 `engines/bin/yoma-la`(子命令 `devices` / `capture` → `.dsl` / `decode` → NDJSON
注解流 / `decoders` 元数据),vendored 自 DSView 的 `libsigrok4DSL`(采集)+ `libsigrokdecode4DSL`
(内嵌 CPython 跑 150 个 `pd.py` 解码器)+ `res/`(固件与 FPGA 位流,MIT)+ 一个 `.dsl` 样例。
`engines/logic-analyzer/vendor.ts --from <DSView 检出>` 重新 vendored,提交钉在 `vendor/UPSTREAM.json`,
`patches/*.patch` 自动应用。引擎只做"碰硬件"和"跑解码器";**一切语义在 TS**:
`packages/kernel/src/host/domain/la/`(`.dsl` 读取与边沿列表、注解解析、事务模型、expect 差分、
`store.ts` 的采集缓存与落盘布局 —— 工具与 kernel 的 `la.view`/`la.captures` 共用这一份)+
`attic/tools/la.ts`(13 个动作,待重写)。浏览器侧的列位图编解码与格式化在 kernel 的 `la-codec.ts`,画法与
主题读取在 session-ui 的 `la-preview.ts`,卡片与面板共用,不许有第二份读法。

**在 DSView 的树里它们不是库**(全树唯一 `add_executable`),公共 API 是自家的 `ds_*` 单例门面,
不是 sigrok 的 `sr_*`。上游 sigrok-cli 不认新版硬件(PID 0x0030 的 Plus 用 Pango FPGA +
`DSLogicPlus-pgl12.bin`,上游只认 0x0001/0003/0020/0021),DSView GUI 没有任何命令行入口 —— 这两条
决定了"自建引擎"是唯一解。

上游的怪癖,全部在 `src/srdx.h` / `decode.c` / `capture.c` 吸收,改解码路径前先读:

- 解码器按**目录名** import(`1-i2c`),自报 id 是 `1:i2c`;DSView 自己的 I²C/SPI/UART 叫
  `1:i2c` / `1:spi` / `1:uart`(`0:*` 是精简变体,没有 OUTPUT_PYTHON、不能堆叠),UART 是**单根
  `rxtx`**,与上游的 rx/tx 不同 —— 模型按上游记忆写参数必错,`la decoders` 先查。
- `srd_decoder.annotations` 是倒序的(`g_slist_prepend` 后没反转,DSView 从不按类号读它),3 元组存
  `[type, id, desc]`。I²C 的 row 只有 `bits / addr-data / warnings`,ACK/NACK/START/STOP 是 class,
  `warnings` 类从不被 put,"Write"/"Read" 方向注解也标成 class 0 —— 异常(NACK@地址、缺 STOP)
  在 `model.ts` 自己推。
- 解码器按 **PD 通道序号**直接索引 `inbuf`(`dec_channelmap` 只供前端组装),所以**一个协议栈一个
  srd 会话**;`.dsl` 的每通道位面不用转置就能喂 `srd_session_send`(fork 签名就是每通道一个缓冲)。
- 字节写成 `'@41'`、I²C 写成 `'Data write: {$}'`,数值在 `str_number_hex`;引擎输出还原成 `h`/`n`。
- **`LA_CROSS_DATA`**:硬件、文件回放、demo 三条路都发"64 位字按通道轮转"的布局,唯一规范是
  `DSView/pv/data/logicsnapshot.cpp` 的 `append_cross_payload`。写错不报错、像噪声。闸门:
  `yoma-la capture --device file:<.dsl>`(session_driver 按同样规则交织后回放)采回来的 `.dsl`
  必须与输入**逐块字节相同**;`--device demo` 是无硬件的全链路演练。
- **libusb ≥ 1.0.24 的 Windows 后端没有 pollfds**,上游 `dev_acquisition_start` 直接解引用 NULL
  段错误(DSView 官方包自带老 libusb 所以没撞过)。`patches/0001` 改成 fd=-1 哑源 + `receive_data`
  在 libusb 里阻塞一个 poll 超时 + `remove_sources` 认哑源。
- 内嵌 CPython 靠 PYTHONHOME 找标准库:分发时 `data/la/python/` 是裁过的(去 test/idle/tk,15 MB);
  开发期 `data/la/python.home` 是指向 MSYS2 ucrt64 前缀的**文本指针**,**不用 junction** ——
  `stage-engines.ts` 的 `cpSync({dereference:true})` 会把整个 ucrt64 卷进暂存目录。
  `bin/` 里的 MinGW DLL 是伴随文件,`stage-engines` 不按 ".exe 后缀的 PE" 规则挑错。
- `PyEval_InitThreads` / `Py_SetPythonHome` 在 3.14 只是弃用未移除,暂不需要补丁。
- 只能 MinGW(源码 `#include <unistd.h>`);CI 的 Windows 岗经 `msys2/setup-msys2` 装 ucrt64,
  经 `YOMA_LA_MSYS2` 告诉 `build.ts` 位置。没有工具链的机器**跳过并在 manifest 写明**
  `la.bundled=false`,不静默。

TS 侧的纪律:

- **不占 `probe.lock`**。DSLogic 是独立 USB 设备(VID 2A0E),与 J-Link/ST-Link 不互斥,"gdb 握着
  ST-Link 同时抓总线"是核心用例。设备自身的互斥(DSView 开着、另一个 la 进程)由引擎打不开
  设备的人话兜住。一次采集一个子进程;`arm` 的子进程挂 `killOnHostExit`。
- **details 只放摘要 + 1024 列 × 2bit 预览**(让旧会话重放时卡片仍能画波形),原始样本永远在
  `<工程>/.yoma/la/<id>/`(`capture.dsl` + `decode.ndjson`),`YOMA_IGNORE` 已含 `la/`。
- 事务聚合**在全量注解上做、再按窗口过滤**:在窗口切过的注解上聚合会把被切掉的 STOP 误报成
  missing STOP(实测)。位级行默认折叠、`events` 默认 200 行、`decode` 超 32M 采样要求给窗口 ——
  防线在生成端不在截断端。
- 开发机实机:DSLogic Plus PID 0x0030,Windows 原生 WinUSB(`winusb.inf`,非 Zadig),FX2 固件固化在板上
  (驱动按 "USB-based DSL Instrument v2" 产品串判定已有固件),运行期只需 FPGA 位流;HDL 版本 14
  与引擎期望一致。4ch @ 25 MHz 1M 采样 201 ms 实测通过。
- 黄金文件:`engines/logic-analyzer/vendor/demo/logic/protocol.demo`(改了后缀的 `.dsl`,16 通道
  25 MHz,I²C SDA=D0/SCL=D1、UART D5、SPI D12–15)。I²C 解出 **300 条注解 / 6 个事务**,UART 47 字节
  "DSLogic series USB-based LA from DreamSourceLab",SPI 5 次传输 288 字。smoke 与 `build.ts` 自检都钉这个数。

### 调试工作台(`packages/app/src/pages/session/{bench,console}`,2026-09-18)

会话页的仪器布局。从前右栏"调试"档永远堆着示波器 + 逻辑分析仪,没有日志 / GDB 视图,任何地方看不到板子状态——
看着就是一个通用的深色聊天应用。2026-09-18 夜里在同一份地基上并行做了四种布局(仪器轨 / 底部控制台 / 右侧工作台 /
时间线优先)+ 一套工具卡片,截图与对比在仓外 `.claude/worktrees/_ui-lab/`;维护者选了**底部控制台**,另三种里各借了一样。

- **按数据的形状分家,不按"是不是调试功能"分家。** 注册表 `bench/instruments.ts` 每台仪器一条记录,带
  `tier`(core / frequent / occasional)与 `surface`(`"text"` | `"wave"`):文本流(日志、GDB,将来的上位机 / RTT 终端)
  要宽度,住会话页底部的**控制台**(`console/session-console.tsx`,`Mod+J`,缺省收着,可拖高,再点当前页签 = 收起);
  波形(示波器、LA,将来的功耗曲线)要高度,住右栏"调试"档,页内页签一次一台(`console/instrument-rail.tsx`)。
  最底下 24px 的**状态栏**(`console/session-status-bar.tsx`)横跨聊天栏与右栏:最左是目标格(工程 · 芯片短名,悬停 /
  点住弹目标卡:芯片 · 内核 · 探针**只转述**烧录输出与 gdb 回执,认不出就只剩工程名),然后是烧录 / GDB / 日志三格。
  加一台仪器 = 注册表一条 + 两份 i18n;布局里没有一处写死"日志在下面"。
- **可见性规则**:core 永远在;occasional 只在 agent 本会话用过 ∪ 磁盘上有采集 ∪ 用户钉住(`yoma.bench.pins`)时露面,
  露面是多一格 + 提示点,**不自动顶开面板**。"有我还没看过的新证据"按纯函数指纹判(`bench/evidence.ts`,
  `yoma.bench.seen`,键 `<会话>::<仪器>`,120 条上限):按会话记,否则切到没用过 LA 的会话时指纹缩水会被读成"有新东西";
  日志格有未看过的 error 时优先黄灯 + 条数,不再叠点。**磁盘证据是工程级的**:跑过几轮的工程里开新会话,日志 / 波形格
  会立刻有点 —— 与可见性规则同解,但不等于"这次对话刚产出的",这是明知的取舍。
- **数据层全在渲染端,零内核改动**:`bench/bench-status.ts` 从 transcript 的 ToolPart(flash / log / gdb / la / scope 的
  `metadata`)折出 `BenchStatus`;日志尾巴读 `.yoma/logs/hw-*.log`(`bench/log-feed.ts`,按工程目录引用计数、2 s 一拍、
  最后一个消费者卸载即停;`file.read` 从头截断,>2 MB 的日志只看得到开头);磁盘有没有采集走 `la.captures` /
  `scope.captures` / `file.list`(`bench/bench-disk.ts`,不轮询)。`bench/bench-context.tsx` 是 status / disk / 钉住的唯一
  共享来源 —— 三处消费者各折一遍的代价不是多一个 memo,是每次触发 3× 只读 RPC。gdb 的 `stop` 之后 details 是
  `{state:"no-session", epoch:0}`,照常比 epoch 会把故障现场连同停止历史一起清掉:no-session 不算换目标,面板说"已结束"
  并保留最后一次现场;状态条的故障位置用报告里"出事 PC"那一行(`foc.c:45`),不是 HardFault 处理函数所在行。
- **工具卡片**(`session-ui/src/components/{hw-tool,flash-tool,log-tool,gdb-tool,la-tool,scope-tool}.tsx` + `*-card.ts`,经
  `ToolRegistry.register` 按名挂):折叠态一行 LED + 短名 + 动作 + 结论(`调试器 exec continue · BusFault PRECISERR ·
  foc_zero_isense() foc.c:45`),展开态是排好版的读数;details 认不出就回落 `GenericTool`(旧会话的 details 可能是老形状)。
  卡片右上角「在面板中打开」走 session-ui Data 上下文的可选回调 `onOpenInstrument`(缺席时一个像素都不渲染),
  app 侧 `console/reveal-instrument.ts` 是"亮出一台仪器"的**唯一**实现(状态栏点格与卡片按钮共用):text → 控制台那一页,
  wave → 右栏那一台,藏着的先钉住。**`bench.css` 与 `log-lines.ts` 住在 session-ui**(卡片与面板共用同一套 LED / 读数行 /
  通道色原语与同一份"哪一行算 error"),app 侧只经样式表拿到,别再加相对 import。
- 截图工装 `.claude/worktrees/_ui-lab/shots/`(仓外、gitignored):`seed.ts` 用 bench 的 faux 模型 + 真内核种一段真实调试会话
  (真 gdb + QEMU 的 BusFault、日志、烧录、LA import、scope demo),`shots.ts` 对任意检出的构建产物按 steps.json 截图,
  `paint-gate.sh` 带锁跑 `e2e:paint`(9222 端口全机只有一个)。改这块界面**看图是唯一的闸门**:`overflow-y: auto` 把 popover
  裁没、按钮压住卡片结论、两个 tooltip 叠在一格 —— 这些 `querySelector` 照样找得到、report.json 全绿,只有看图看得见。
  提示点"看过即熄",steps 里验它的那几步要排在打开面板的步骤之前。

### 示波器(`host/domain/scope` + `host/tools/scope`,2026-09-16 恢复,2026-09-17 分出驱动层)

工具层只认 `domain/scope/driver.ts` 的 `ScopeDriver` 接口;厂商驱动在 `domain/scope/registry.ts` 登记(今天是 siglent,
`YOMA_SCOPE_DEMO=1` 时多一个无硬件的 demo)。地址 `[driver@]transport`:`usb[:serial]`、`<ip>[:5025]`、`siglent@usb:SN`;
裸地址按 `*IDN?` 自动挑驱动,USB 与 LAN 都开放,raw 命令仍不开放。租约按传输部分算,config.json 存带前缀的地址。
`connect` / `status` 返回 `capabilities`(按已开通道数给的合法深度、采样率、耦合、探头、触发源、量测类型 —— 量测名是 `driver.ts` 的中性词表,`measurementName()` 认别名,仪器特有名走 `vendorMeasureTypes`)与驱动 `warnings`
(未验证型号、demo)。设计约定、加厂商的步骤、不照搬 ngscopeclient 的清单在 `docs/scope-drivers.md`;
`test/scope-conformance.ts` 是任何驱动都要过的一致性套件,`YOMA_SCOPE_HARDWARE=<address>` 时对真机再跑一遍。
工具具备设备独占、设置读回、arm/collect、完整采样与显式概览抽样、截图、离线 samples。波形落在 `<工程>/.yoma/scope/<id>/`,
截图与采集元数据关联;本机仪器地址存 `.yoma/scope/config.json`(兼容读取旧 `.yoma/scope.json`),目录自带忽略规则。
前端的 `scope.captures/view/screenshot` 只读磁盘,拖动和缩放不会操作硬件。完整原始数据不进会话历史。
analyze.ts 2026-09-17 按 ngscopeclient 的测量滤波器修了三处(阈值处插值、直方图 base/top、跨度估频),新增 acRms / top /
base / overshoot / clipped 与逐字段单位;Siglent 驱动把时基与深度都放进 AUTO 触发模式窗口里改并读到稳、连接时 `CHDR OFF`、
容忍短窗、校验触发状态词表 —— **这些都还没在真机上验证**,只过了假仪器与一致性套件。

USB 依赖 `usb@3.1.0` 同时登记在 kernel 与 desktop 的 dependencies,预编译 `@node-usb` 模块必须解出 asar。
取消必须等待 native transfer 结算再释放租约;close 并不保证立即中断正在等待的USB读取,截图可能等约15秒。
旧驱动真机协议经验、接线验收与本次验证范围在 `docs/scope-usb.md`；2026-09-04 的旧真机结果不等于新集成验收。
2026-09-16 Mac 实测:仪器重启后设置、双通道完整采样、arm/collect 与真实数据前端通过;重启前旧新驱动均有读回超时,
拔插未恢复,根因与可靠软件恢复仍未解决。当前探头为 CH1 Little Bee H1(用户确认 1 V/A)、CH2 1× 校准信号;
不要把这份具体接线当作后续用户的默认事实。正常 disconnect/dispose 只释放 USB;仅未结束的武装操作需要 STOP。

### 工具链自动安装(`toolchain install` / `host/domain/toolchain/{catalog,install}.ts`)

2026-09-05 起。从前工具链只"核账"(装没装、在哪),装是用户的事;现在 catalog 里有包的工具
(Arm GNU Toolchain 15.2.rel1 = arm-gcc + arm-gdb、CMake、Ninja、xpack OpenOCD、Windows 上的 MinGit)
桌面设置页一键装、agent 撞到"命令不存在"时自己装。**不打进安装包**:Arm 工具链一个 zip 就 296 MB,
比整个安装包(166 MB)还大,按需下载。

- **目录是数据**(`catalog.ts`):包 → 宿主(`win32-x64` / `darwin-arm64` / `darwin-x64` / `linux-x64` /
  `linux-arm64`)→ 官方发布 URL + sha256(抄厂商自己的校验文件)+ 字节数 + 压缩格式 + 解开后的 root/binDir。
  版本钉死,升版本是一次显式的目录改动。`YOMA_TOOLCHAIN_MIRROR`(基址)与 artifact.mirrors 排在官方 URL
  之前逐个试。ESP-IDF / Keil / CubeMX / CubeProgrammer / J-Link 不在目录里(账号 / 许可 / 安装器),只给人话指引。
  Arm 没有 darwin-x64 的 15.x 构建,Intel Mac 走 brew。
- **落点 `<configDir>/toolchains/<包>/<版本>/`**(与账本 `toolchains.json` 同一个 configDir;bench / 信箱工位端
  读同一处;app 升级不丢)。绝不落 `process.resourcesPath`。完整性纪律:`downloads/*.part`
  边写边算 sha、对不上就删;解压到 `<包目录>.extracting` 再整体 rename,包目录里写 `.yoma-toolchain.json`
  标记 —— 半个树不可能顶着最终名字出现;同一个包一把 pid 锁。zip 走 `@zip.js/zip.js`(进程内,
  Reader **必须继承 `zip.Reader`**,鸭子对象在 getData 里炸;挡 zip-slip;从 external attribute 恢复可执行位),
  tar.gz/tar.xz 走系统 tar(Windows 用 System32\tar.exe,但目录里 Windows 的产物全是 zip)。**GNU tar 靠 PATH
  找 gzip / xz**(bsdtar 是库内置的),tar 子进程的 PATH 空了就是 `Child returned status 2` —— 注入 env 只给
  `PATH: ""` 的测试在 Windows / macOS 全绿、Ubuntu 岗红,`tarEnv` 因此在 PATH 为空时回落到进程 PATH。
- **账本不改 schema**:装完对包 provides 的每个 id 调 `recordToolchainPath`(by:"user"),"Yoma 装的"由
  位置(managed 根)与标记文件识别。resolve.ts 多了 **`managed` 一档**(ledger 之后、env 之前)扫这个根 ——
  否则设置页"重新探测"(skipLedger)一按,刚装好的就报 MISSING。非 ok 的工具带 `installable`
  (包名/版本/字节数),UI 的安装按钮与提示词的自助建议都看它。
- **PATH**:会话 bash 环境 = engines/bin ⊕ 项目清单解析到的目录 ⊕ **机器级目录**(managed binDir + 账本
  by:"user" 的目录;by:"auto" 的**不**前置 —— 它们本来就在 PATH/已知位置探到,再前置会遮蔽用户 venv 里的
  python)⊕ process.env。没有项目清单的工程(绝大多数)从前什么都拿不到,现在拿得到机器级目录。
  机器级目录同时前置进**内核进程自己的** PATH(`applyMachinePathToProcess`):gdb / flash 起 openocd /
  JLinkGDBServer 用的是 process.env,不是会话 shellEnv。装完 `SessionManager.refreshMachineEnv()` 重算每个
  在飞会话的 env(`NodeExecutionEnv.setShellEnv`,packages/agent 新加的 setter),下一条命令就看得见。
- **RPC / 事件**:`toolchain.install {id}`(几分钟;注册表按**包** id 去重 —— arm-gcc 与 arm-gdb 同一个包,
  第二个 reject "already")、`toolchain.installCancel`、`toolchain.installsActive`(设置页重开时接上进度行,
  进度事件不重放);进度是 `KernelEvent` `toolchain.install`,StreamSink 把同 id 的相邻进度折叠成最后一条。
  agent 的 toolchain 工具多了 `install` 动作,**宿主必须传 `onInstalled`**(SessionManager 传的是
  refreshMachineEnv)否则装完这一会话里仍然找不到;`execute` 要把 harness 的 signal 递给下载,不然用户按停止
  要等几百 MB 下完。提示词从"叫用户去装"改成"installable 的自己装,其余转告";catalog 钉的版本满足不了
  清单 `version` 时提示词明说"装了也不够",免得模型在装 → 核 → 再装里空转。
- **"已装好"看可执行文件,不看目录**(reuse 与解压后的验收都是 `anyBinResolves`):被杀毒软件掏空的包目录
  若被当成装好,记账会把目录本身记成可执行文件,之后核账永远 ok、构建永远 command not found,而且 install
  永远走复用分支修不好(评审时实测)。旧包目录先挪到一边再换新的;所有 rmSync 带重试(Windows EBUSY)。
  `ToolchainInstallError.data`(`_tag` / phase / toolId / packageId)是跨 MessagePort 唯一能带过去的结构化
  信息,UI 靠它把"用户点了取消"和真失败分开。
- 退出时装更新(`autoInstallOnAppQuit`)要求 `before-quit` **先拦下来等 stopSidecars 真的结束再 quit**
  (main/index.ts 的 `quitting` 旗):electron-updater 挂在 `quit` 事件上,fire-and-forget 的 stopSidecars
  要几秒,不拦的话 NSIS 会在烧录 / gdb 孙进程还活着时换文件。`relaunch()`(app.exit)前先关掉退出时安装,
  否则 NSIS 换文件和拉起旧 exe 撞在一起。
- 目录里的五个包在 Windows 上都真装过一遍(2026-09-05,隔离的临时 configDir):ninja / cmake / openocd /
  arm-gnu-toolchain(29 s 装完,arm-gcc 15.2.1 + arm-gdb 16.3.90)。**厂商的包装方式不统一**:Arm 的 Windows
  zip 内容直接在根上(bin/ lib/ arm-none-eabi/),tar.xz 才有 `arm-gnu-toolchain-<ver>-<host>-arm-none-eabi/`
  这一层(darwin-arm64 / x86_64 / aarch64 三个都核过);第一版 catalog 按 tar 的惯例给 zip 也写了 root,
  真装就炸。`locateRoot` 因此按 root → 根上直接有 binDir → 唯一顶层目录 四步试,改 catalog 时**以真实
  压缩包为准**。macOS / Linux 的 tar 路径还没在真机上跑过。

### 数据手册服务器默认地址(`host/datasheet-server.ts`)

2026-09-05 起**有内置默认**(`DEFAULT_DATASHEET_SERVER`,一处常量),推翻 ad6df94 的"公开仓不放地址":
产品决定是用户装完即可查手册,防线在服务器侧(限流 / 反代)。解析规则只有这一份(叶子模块,经
`@yoma-desktop/kernel/host/datasheet-server` 这道叶子门可达,不再靠别名):**显式 > 环境变量
`YOMA_DATASHEET_SERVER` > `<configDir>/.env`(或 `$YOMA_ENV_FILE`)> 内置默认**,值 off / none / false / 0 =
显式关闭。datasheet 工具收 `{configDir, server, env, builtIn, timeoutMs, artifactTimeoutMs}`(session-manager 经
`createRegisteredTools({ datasheet: { configDir } })` 传 configDir,bench 因此不再是盲区);desktop main 的手册库页经叶子模块解析,和内核
说同一个地址。**每个请求都带超时**(API 20 s、产物与 manifest 60 s):内置地址意味着所有安装都会去碰一台可能挂掉的
机器,没有超时就是整轮吊死。2026-09-14 维护者确认了这个地址(`http://47.122.110.137:8301`,757 本 / 78 个家族,
`/api/search`、`/api/manifest`、`/artifacts/` 都在);旧地址 47.122.120.208 已下线。
2026-09-15 Windows 实测旧地址连接失败、新地址返回 757 本。环境变量或 `.env` 中残留的旧官方 HTTP 基址
现在在解析时归一到新默认,不改配置文件;自建地址、显式 server 参数、off 和注入的 builtIn 仍按原意处理。
删掉 `ensureDatasheetServerEnv` 薄壳:把文件值灌进 process.env 会永久压住后续文件修改,也会丢失配置来源。
工具现在每次调用重读,连接失败明确说明配置来源与内置远端服务,不再误导用户必须自建服务器。
内置的是地址,不是在 Windows 本机运行一份检索服务器。验收见 `docs/WINDOWS-STARTUP-BUGS-2026-09-15.md`。

### 热升级(electron-updater)

2026-09-05 核实:仓库公开、GitHub 的 latest 是 app Release、latest.yml + blockmap 都在,差分下载走
NsisUpdater 的 blockmap 路径 —— 通道本来就通。这次修的是**用户感知不到**这件事:
- `updater.ts` 不再设 `channel`(setter 会顺手 `allowDowngrade = true`)、`allowDowngrade = false`、
  `autoInstallOnAppQuit = true`(下好了退出就装,不必点重启;before-quit 已先 stopSidecars)、订阅
  `download-progress`。状态机(`updater-controller.ts`)多了 `downloading.percent/transferred/total`、
  `ready.notes`(Release 说明剥成纯文本)、`prefs.autoCheck`(启动 / 定时检查看它;手动 `check()` 不看)、
  `checkPeriodic()`。不能自己装更新的安装(今天是没有 Developer ID 的 mac 包)停在 `available`,见「macOS 出包」。
- UI:标题栏药丸之外,`ready` 时 layout 弹一次 toast(带"重启安装");设置 → 更新有版本行、状态行、
  自动检查开关(`window.api.updater.getAutoCheck/setAutoCheck`,store `yoma.updater.autoCheck`)、更新说明。
- `engines.yml` 的 Release 加了 `make_latest: false`:引擎 Release 和 app Release 同仓,engines-v* 一旦被
  标成 latest,所有用户的更新检查都去找 `engines-v*/latest.yml`,404 到下一个 app 版本为止。
- `packages/desktop` 有了 `test` 脚本,进根 `npm test` 与 CI 的 Windows 岗 —— 更新器状态机的测试从前
  没有任何闸门跑它。`scripts/finalize-latest-{yml,json}.ts` 是 tauri 时代的死代码,删了。

### macOS 出包(`.github/workflows/desktop-mac.yml`,2026-09-17)

**Release 说明只留自动生成的变更记录**(2026-09-17,维护者要求):两条流水线都不再往说明里写东西 —— 从前 desktop-win 写
一个「未签名」Warning 框加一段 STM32 套话、desktop-mac 再追加一个 macOS 的 Warning 框,每版重复、把真正的变更挤到中间。
安装时怎么放行写在两份 README 的「安装」一节;别再加回 Release 说明(应用里「更新内容」显示的也是这段说明)。

tag `v*` 上与 `desktop-win.yml` 并行跑:当场编引擎 → `package:mac` → 验签 → 挂载 dmg 拷出 .app → 对装好的
app.asar 跑 `e2e:renderer` / `smoke`,再 `e2e:paint` → 把 dmg / zip / blockmap / `latest-mac.yml` / `SHA256SUMS-mac.txt`
追加到**同名 Release**。**Release 只由 desktop-win.yml 建**,这里轮询等它出现(两边抢着建会撞 already_exists;
Windows 失败时这里超时变红,本来也不该有只含 mac 的 Release)。第一次本机演练(把 YAML 里的 run 步骤原样抽出来按序跑)
撞出来的四件事,都是"Windows 永远撞不上、mac 一打必炸":
- **`electronDist` 不能写死 `packages/desktop/node_modules/electron/dist`**:npm workspace 把 electron 提到了仓库根。
  Windows 打包走"跨平台 → 自己下载"那条分支,所以这条死路径活了很久。现在两处都找、都没有就不设。
- **electron-builder 26 找不到证书时是跳过签名,不是回落到 ad-hoc**。打包照样"成功",但 Electron 自带的封印在改过
  Info.plist、塞进 resources 之后对不上:`codesign --verify` 报 "code has no resources but signature indicates they
  must be present",用户下载后 macOS 说的是**"已损坏,移到废纸篓"**,连"仍要打开"都没有。所以没有 Developer ID 时
  配置显式给 `mac.identity: "-"`;钥匙串里的 "Apple Development" 证书不算数(别人机器上照样拦,codesign 用它还会弹
  授权框把无人值守的打包挂住)。工作流的"验签"一步挡的就是这条回归。
- **ad-hoc 包装不上自动更新,所以走"只通知"**:Squirrel.Mac 要求新包满足当前运行那一份的 designated requirement,
  Developer ID 的 requirement 是 Team ID(跨版本成立),ad-hoc 的是 cdhash(每版不同)。而更新器状态机一查到新版
  就自动下载 —— 不拦就是每次定时检查白下 170 MB 再报错。打包时把 `yoma.macDeveloperId` 写进包内 package.json
  (`extraMetadata`),main 的 `UPDATER_SELF_UPDATE` 经 `platformCanSelfUpdate` 看它;读不到按"不是"算。config 测试
  钉着 identity 与这个标志同真同假。为 false 时 controller 收 `selfUpdate: false`:检查照常(那一步只读
  `latest-mac.yml`,electron-updater 到 `doDownloadUpdate` 才碰 Squirrel —— 读源码确认、再真机确认),查到新版停在
  新状态 **`available`**,不下载、不落 ready 记录、`autoInstallOnAppQuit` 关掉。**界面上所有"装这个更新"的入口
  (toast、标题栏药丸、设置页按钮、错误页、菜单对话框)走的都是同一个 `install()`**,所以只在 controller 里把
  `available` 的 install 换成 `shell.openExternal(<homepage>/releases/tag/v<版本>)`,没有新的 IPC 通道。已在 `available`
  上的定时再查是安静的(不过 `checking`、断网不落 `error`)—— 否则药丸每十分钟闪一下、断一次网就消失。
  真机验收(2026-09-17):beta 渠道的包(appId 独立,不碰 prod 的 userData)+ 改指本地假更新源的 `app-update.yml`
  + 重新 ad-hoc 签名;假源**只收到一次 `GET /latest-mac.yml`、零次 zip 请求**,日志 `idle → checking → available`,
  CDP 读到药丸的无障碍名是 "Open download page",`install()` 后状态仍是 `available`。
  (`--remote-debugging-port` 作为命令行参数对打包后的 app 也生效,装后验收可以用它;`electron-builder --dir` 不生成
  `app-update.yml`。)由此而来的一条发版纪律:**每个 Release 都必须带 `latest-mac.yml`**,缺了它 mac 用户的检查更新
  就是 404 —— desktop-mac 这次红了的话,修好重跑,别留一个只有 Windows 文件的 latest。
- **非 Windows 的 `engines:build --dist` 明确跳过 yoma-la**:`installLa` 只会收 MinGW DLL 与裁过的标准库;mac 构建机
  有 brew 的 glib 时照样编得出来、自检也过,但产物链着 `/opt/homebrew/…dylib`,到用户机器上是 dyld 报错,la 工具会
  说成"引擎崩了"而不是那句干净的"这份安装里没有"。开发期(非 --dist)不受影响。
另两件顺路查实的事(`gh run view` 逐个任务核过):`engines.yml` 两次 tag 运行(engines-v0.1.0 / v0.2.0)里
`build (macos-13, darwin-x64)` 都是**整 24 小时后被取消** —— 那个 runner 标签拿不到机器时任务不失败、只排队;
同两次运行里 macos-14 与 windows 两个岗是成功的。desktop-mac 因此用不会退役的 `macos-latest`,engines.yml 的矩阵还没改。
以及:今天仓里**没有任何 engines-v\* 的 Release**(tag 在,Release 不在),`engines.lock.json` 钉的 `engines-v0.2.0`
下载不到 —— "在 Mac 上打 Windows 包"那条预编译路径现在是断的;两条发版流水线都是当场编引擎,不受影响。

## 约定与规矩

- **绝不重启 app 或内核进程**(`packages/app/AGENTS.md`)。优先级:稳定 > 简单 > 性能。
  动 session/timeline 代码前先记录生产基准。
- **SolidJS:一律用 `createStore`,不要堆 `createSignal`。**
- 属性驱动 CSS(`data-component` / `data-variant`),**不写 CSS-in-JS、不用工具类 props**。
- 依赖版本钉在根 `workspaces.catalog`,包里写字面量 `"catalog:"`。
- 用 **`tsgo`**(`@typescript/native-preview`)而不是 `tsc`。新包必须有 `typecheck` 脚本。
- turbo 的 `typecheck` 有 `dependsOn: ["^typecheck"]` —— 没有它,改了 kernel 的类型,
  依赖它的包会拿到过期缓存命中,typecheck 变成 **假绿**。验证时用 `--force`。
- Prettier 配置内联在根 `package.json`(`semi:false, printWidth:120`)。

## 会咬人的地方

- **contextBridge 会把 Error 剥成一句话。** Electron 在 world 之间重建 Error 时只保留
  `message` 和 `stack`,自定义属性和 `cause` **全丢**(实测 `getOwnPropertyNames` 只剩
  `["stack","message"]`)。所以 preload 的内核请求失败时 reject 的是 **普通对象**
  `{ message, stack, data }`,不是 Error —— 包成 Error 就等于把 `data` 扔进黑洞。
  实机代价:host 标好的 `data._tag = "SessionNotFoundError"` 蒸发,前端把"上个版本残留的
  标签页"当成致命错误,整个 app 崩到错误页。这一跳由 `e2e:renderer` 钉住,**类型系统永远
  抓不到**。
- **engines 目录必须显式传**,别依赖 yoma 的 `enginesDir()` 向上查找 —— 它只认
  "名字叫 engines 且存在",会高高兴兴找到一个没有 `bin/` 的空壳,然后报
  "去跑 `npm run engines:build`",让你以为是没编译。合库后 `engines/` 就是仓内真目录
  (引擎源码 + build.ts;2026-08-17 起两个引擎仓已整个吸收进本仓,不再是 submodule
  —— `data/*.irpack` 是 CubeMX 解析出的构建产物,不入库;`npm run engines:build`
  本机有 CubeMX 时会导入。`data/fw/` 这 1.1GB 的 HAL/CMSIS 除外,要跑
  stm32-config-kernel 的编译门禁测试先 `tools/fetch-fw.ps1`)。
- **探针栈不在引擎里**(2026-08-17 起,probe-rs 整体移除):烧录命令由模型自带
  (OpenOCD / J-Link / 厂商 CLI),flash 工具只管探针租约 + 超时杀树 + flash-state
  落账;RTT 从 gdb server 的 TCP 口读(J-Link 19021 / OpenOCD `rtt server start`,
  log 工具的 `tcp` 源);gdb 只剩 openocd/jlink/qemu/external 四后端。移除的动机是
  Windows 驱动:probe-rs 要 WinUSB(Zadig),与厂商驱动互斥,对 J-Link 用户等于
  弄坏 SEGGER 全家。代价:零安装探针故事结束 —— 用户机器(尤其工位机)必须自装
  J-Link 软件或 OpenOCD,声明走 `toolchain.json`(J-Link 的 well-known/注册表探测
  已内建);首跑预检的"探针在不在"横幅一并移除(它就是 `probe-rs list`)。
- **2026-09-15 Windows 安装验收补充**:desktop 的 `pi-ai` 也必须在 devDependencies。
  它曾在 dependencies,导致 kernel.js 保留裸 import,安装后加载 node_modules 下 raw TS 报
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`;源码冒烟因 workspace 软链可以通过。安装目录 smoke 与 renderer E2E 才能挡住这条断裂。
- **engines 有两个来源,`scripts/stage-engines.ts` 按目标平台自动选**:本地
  `engines/`(跑过 `npm run engines:build` 之后,仅当它满足目标平台)或**预编译 Release
  产物**(按 `packages/desktop/engines.lock.json` 钉住的 tag,用 `gh` 下载)。
  后者让"在 Mac 上打 Windows 包"第一次真正成立 —— 以前只能靠
  `YOMA_ALLOW_FOREIGN_ENGINES=1` 打出一个引擎全坏的包。
  优先级:`YOMA_ENGINES_DIR` > `YOMA_ENGINES_BUNDLE`(显式指一个压缩包,离线打包
  和验证用)> 满足平台的本地目录 > 下载。私有仓的 Release 要鉴权,但**下载发生在
  打包期**(手上有凭据的机器),终端用户拿到的是包里已经躺好的文件。
- **electron-builder 对 extraResources 里的软链原样保留、不 dereference**
  (实测:.app 里出现断链,签名阶段 stat ENOENT),所以 stage-engines 要**实体化**
  到 `.engines-stage/`,extraResources 只认暂存目录;预编译产物还会按 bundle 自带的
  `manifest.json` 逐个核 sha256(挡住"文件在但内容被截断")。
- **Python 三件套的 shebang 曾经是分发的死穴**:board_ir/connections/controller_map
  在开发期是 venv console script,第一行写死构建机绝对路径,拷到别人电脑必坏,
  而且报"找不到解释器",看起来像没编译。已由 yoma 的 `npm run engines:build -- --dist`
  用 PyInstaller 冻结解决(那边的 CI 产出的就是冻结版);本地开发跑普通 `build.ts`
  仍是 console script,所以 stage-engines 的那条警告要留着。
- **逐 chunk `Buffer.toString()` 会劈断多字节 UTF-8**。守护的一条 `@@event` 行可以
  远超一个 pipe chunk(≤64KiB):终局快照带着几万字终报,中文 3 字节/字,轻松十几万
  字节。chunk 边界大概率落在字符中间,各自解码就是两个 U+FFFD —— 而 JSON 的结构
  字符全是 ASCII,`JSON.parse` 照样成功,**乱码静默进终报**。跨 chunk 的行拼接必须用
  `new TextDecoder()` + `{ stream: true }`(turn-entry 的 stdin 读法是对的样板)。
- **子进程默认不按 UTF-8 输出,中文 Windows 上尤其**。Python 在 stdout 不是终端时用
  `locale.getpreferredencoding()` 编码 —— 中文 Windows 上是 cp936(GBK),而我们按
  UTF-8 解管道。解出来的 U+FFFD **不可逆**(编回字节再按 GBK 读只得到"锟斤拷")。
  实测:双机首跑三条判据全过,证据却是
  `xTickCount@0x200002a8: 24920 -> 25665 (?=745) | ????????` —— 退出码不受影响,
  所以裁决是对的,坏掉的恰恰是这套系统的产品:证据,而且一声不吭。
  凡是要读中文输出的子进程,环境里钉死编码(`PYTHONIOENCODING=utf-8` + `PYTHONUTF8=1`)。
  **落点在 `packages/agent/src/harness/env/nodejs.ts` 的 `getShellEnv`**,覆盖所有 agent 经
  bash 工具起的子进程 —— 工位端的诊断脚本走的正是这条路,所以 2026-08-10 删掉判据层之后
  防线还在(这里从前写的"没有落点了"是错的,2026-08-21 核实纠正)。当时真正的洞是
  `inheritEnv:false` 的分支在钉子之前就 return 了,已修并有测试。agent 自己另起的非 bash
  子进程(比如 `runEngine` 起的引擎)不走这条路,各自要自己钉。
  **它的测试不能写成"跑个打中文的脚本看花不花"** —— 开发机 locale 本来就是 UTF-8,
  那是一个永远不会响的闸门(实测确认);要断言的是环境变量本身有没有到子进程。
- **bun 的 `spawnSync`/`spawn` 省略 `env` 时不认运行时改过的 `process.env.PATH`**,
  它按进程启动那一刻的环境解析 argv[0](与 `os.homedir()` 同一类)。想让子进程看到
  当前环境就得显式传 `env`。实测:改了 PATH 之后不传 env,解析到的仍是旧 PATH 上那个
  可执行文件 —— 探测类代码会探到另一个程序,而结论看起来完全合理。
- **`detached` 起的读进程自己 open 一个 tty(串口/pty),SIGTERM 就杀不掉它**。
  `detached` 会 setsid,子进程于是是 session leader;session leader 打开 tty 且没带
  `O_NOCTTY`,那个 tty 就成了它的控制终端。实测(macOS,同一段代码两种写法各 4 次):
  `cat /dev/ttysNNN` 每次都是 `Ss+`、SIGTERM 后 >1500ms 仍活着、'exit' 事件永不到;
  `cat` 读继承来的 O_NOCTTY fd 每次都是 `Ss ??`、21ms 内退出。表现是 `log stop` 每次
  等满 5 秒再强杀,并如实报"设备可能还被占着"—— 于是每次停采都像出了硬件故障。
  所以串口这类源:**父进程开好 fd(O_NOCTTY)当 stdin 传下去,读进程不许自己 open**
  (`tools/serial.ts`)。bench 的 grader 有一份独立的采集管线,写 `command: "cat /dev/…"`
  会踩同一个坑。
- **串口的 termios 属于设备而不是 fd,最后一个 fd 一关就复位**。流传甚广的
  `stty … && cat …` 因此是错的:实测在 ST-Link VCP 上设完 921600、stty 一退出回读就是
  9600,而症状是整屏乱码 —— 看起来像固件坏了。配置用的 fd 必须活到读用的 fd 开好为止。
- **内核事件批处理的定时器是 unref 的,纯 node 下会把等事件的进程放空**。
  host/stream.ts 的 16ms 合并窗口刻意 unref(给 utilityProcess 退出让路),而 bench
  `runTurn` 的完成恰恰依赖那批事件送达 —— 进程没有别的 ref 句柄时(mother 的进程内
  分析轮),node 在事件冲出来之前判定事件循环已空,带着未决 await 直接退出
  (`unsettled top-level await`,实测:打包冒烟里 mother 走到"分析中"就消失)。
  bun 的存活语义不同,开发态永远暴露不了。修法是 runTurn 全程持一个 ref 的
  keepalive interval;任何"在纯 node 里等内核事件"的新代码都要记得这一条。
- **Bun 的 `os.homedir()` 在进程启动时定死**,运行时改 `process.env.HOME` 对它无效。
  想在测试里隔离 `~/.pi/agent/auth.json` 这类真实凭据文件,要么走函数的 dir 注入参数,
  要么起一个出生时就带干净 HOME 的子进程(见 `host/auth.test.ts`)。实测踩过:
  以为换了 HOME,实际把开发机真实的 auth.json 洗掉了。
- **打包 app 不能用"假 HOME"模拟新用户**(实测):Electron 主进程的 userData/crashpad
  走系统 API 拿真实家目录(不理 `$HOME`),而 macOS 钥匙串查找**跟着 `$HOME` 走** ——
  结果是数据落真实位置、钥匙串却"找不到",Chromium 初始化 safeStorage 时弹系统级
  "找不到钥匙串"对话框,app 几秒后安静退出。两边语义相反,假 HOME 两头都不干净。
  验证打包产物就用真实 HOME;无 key 首跑路径由 `host/auth.test.ts` 的子进程 e2e 覆盖。
- **内核没有 HMR。** 改了 yoma 之后必须重启 `npm run dev:desktop`。
- **这是一个 fork**:2026-08 起运行时身份已统一为 Yoma(`app.setName("Yoma")`、
  运行时 appId = bundle id = `com.yoma.desktop`、深链 `yoma://`),旧的
  `ai.opencode.desktop*` userData 弃在原地(当时明确决定旧数据不要,顺带消灭了
  跨签名钥匙串弹窗;tauri→electron 的 .dat 迁移一并摘除)。**内部 persist/store/env 已改成 yoma**:
  localStorage `yoma.*`、store 文件 `yoma.updater`、`YOMA_CHANNEL` 等
  env。旧的 `opencode.*` 键不迁移,设置会重置一次。shiki 主题名、pi-ai 的 OpenCode Zen
  provider id、以及 Linux 遗留 desktop entry 仍是 opencode —— 那些不是我们的产品标识。
- `@tanstack/virtual-core` 的 patch 是承重的,没有它 timeline 会抛
  `getLogicalScrollOffset is not a function`。

## 已知的未完成项

- **工具链自动安装只在 Windows 上真装过**(五个包都装过,见「工具链自动安装」一节);macOS / Linux 的
  tar 路径与可执行位处理没有真机验过。运行期镜像只有 `YOMA_TOOLCHAIN_MIRROR` 一个口子,维护者若要自建
  镜像,把包放到 `<镜像>/<文件名>` 即可。内核 utilityProcess 里的 `fetch` 不认系统代理设置(main 进程的
  `setGlobalProxyFromEnv` 不覆盖它)。
- **数据手册地址没有设置页字段**:内置默认 2026-09-14 已由维护者确认可用;换地址只能 `~/.yoma/.env` 或环境变量。
  内置的是裸 IP + 明文 HTTP:服务器一搬家就得发版,查询语句在路上是裸的 —— 挂域名 / TLS 是服务器侧的事。
- **热升级没有真跑过一次两版本升级**:controller 有单测、bridge 有 e2e,但"装 vN → 发布 vN+1 → 自动下载
  → 退出时安装"的完整路径要一次真实 Release 才验得到。
- **信箱调试台:2026-08-10 大幅简化之后还没上过真板子。** 这一版删掉了判据层、
  权限层与工位端的项目检出(见"信箱闭环"),`npm run smoke:mailbox -w packages/desktop`
  与单机 `mailbox sim` 都过了,但**双机真跑一次是必须的**:研发端能不能把上下文
  写够、工位端在只有附件的目录里能不能干活,只有真跑才知道。同时补 Windows 侧
  (打包冒烟 + taskkill 杀树)。仓里已有 Windows 出包 CI
  (`.github/workflows/desktop-win.yml`);两台机器的上手步骤见
  `docs/调试台-Windows双机上手.md`(**需按这一版重写**)。

- `ServerConnection` / `ServerKey` 这套概念还散在 app 的路由与标签页里(现在只是空壳,
  `serverReady` 用占位值立刻 resolve)。清除它是独立一件事。
- **终端(PTY)没有实现** —— yoma 的 `NodeExecutionEnv.exec` 是一次性 spawn,不是伪终端。
  相关设置行现在是退化状态而不是造假。
- **Python 开发期启动器不可直接分发**:出包必须走 `engines/build.ts --dist` 的 PyInstaller 冻结。
  2026-09-15 已在 Windows 上构建并从独立安装目录启动三件套,见 `docs/WINDOWS-ACCEPTANCE-2026-09-15.md`;
  干净机器上的独立运行仍须验收。
- **mac 没有 Developer ID**:`desktop-mac.yml` 现在出的是 ad-hoc 签名包(见「macOS 出包」)—— 首次打开要去
  「隐私与安全性」点"仍要打开",而且**不能自动更新**。仓库 secrets 配齐 `MAC_CSC_LINK` + `MAC_CSC_KEY_PASSWORD`
  (Developer ID Application 的 .p12)与 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` 即自动变成
  已签名 + 已公证 + 能自动更新,无需改代码;这条路**还没真跑过**。只出 arm64;yoma-la 不在 mac 包里。
  2026-09-17 决定先不买:ad-hoc 包的更新器走"只通知"(有新版 → 提示 → 打开发布页),每次覆盖安装后要再放行一次。
  desktop-mac.yml 本身**还没在 GitHub 上真跑过**(本机把它的 run 步骤原样抽出来按序跑过)。
- 每轮的 diff 汇总留空了。要做的话应该从 `edit`/`write` 工具的 `details.patch` 合成,
  而不是找回 opencode 的文件快照(内核没有快照)。
- i18n 仍有 19 个 locale;非中英的那些和内核无关,可以另行瘦身。
- **逻辑分析仪还缺的**:高级/串行触发、DSO 通道、Linux/macOS 的引擎构建未做;真信号(非悬空探头)的实机验证
  待接线后做。面板(右栏"调试"档的波形页签,`la-waveform.tsx`,走 `la.view` RPC)与卡片缩略图 2026-09-18 起经
  截图工装在真窗口里看过(导入的 demo 采集);卡片右上角的「在面板中打开」同日做了(见「调试工作台」)。
