# 单测在 Windows 上的两组失败：scope 卡死 与 mailbox 失败（2026-09-06）

> 发现场景：把 main 合进 develop（合并提交 `c22c195`）时跑闸门。两组失败都**与这次合并无关**：
> 涉及的代码在合并后与 `origin/develop@6a21404` 逐字节相同；把 `origin/develop` 原样导出到临时目录、干净装依赖，现象一模一样。
> 本文只讲清楚"为什么会这样、怎么复现、怎么修"，**§1.6 的修法 A 已于同日落地并提交到 develop(f0751a3),验证见 §5。**

环境：Windows 11（10.0.26200）· bun 1.3.14 · node v22.15.0（只用来对照）· git `core.autocrlf=true`。

---

## 0. 一句话

| 现象 | 根因 | 严重程度 |
|---|---|---|
| `packages/coding-agent` 的 `scope-core.test.ts`、`scope-tool.test.ts` **永远跑不完，CPU 100%**，bun 的单测超时也救不了 | scope 驱动里的 `sleep()` 把定时器 `unref()` 了，而连接也都是 `unref()` 的；**bun 1.3.14 在 Windows 上一旦事件循环里只剩 unref 的东西，就既不退出也不触发定时器，空转到死** | 高：Windows 上没法跑 coding-agent 全量单测；任何在 bun 下驱动示波器的脚本都会卡 |
| `packages/bench` 4 个 mailbox/job 测试挂、1 个 error | 三个 Windows 环境问题：路径断言假设 POSIX、autocrlf 把 `\n` 变 `\r\n`、闭环测试的 git 进程链超过 bun 默认 5 s 单测超时 | 中：只影响 Windows 上跑测试，逻辑本身没错 |

产品本体不受第一条影响：桌面端的内核是用 Electron `utilityProcess.fork` 起的（`packages/desktop/src/main/kernel.ts:34`），跑在 Node 运行时里，Node 对 unref 定时器的语义是正常的。受影响的是**所有在 bun 下跑这段代码的场合**：单测、`bun xxx.ts` 脚本、bun 起的 CLI。

---

## 1. scope 测试卡死

### 1.1 症状

- `bun test --cwd packages/coding-agent` 永远不结束。挂在后台 16 分钟，进程累计 CPU 时间 958 s，也就是一直在满负荷空转，不是在等 I/O。
- 输出被管道接走时（`| tail`）一个字都看不到，只有 `bun test v1.3.14` 一行：结果是文件跑完才刷的，而文件永远跑不完。
- bun 的单测超时（默认 5000 ms）不触发。
- `-t` 过滤出的纯函数用例都过：`地址解析`、`块头与图片分帧`、`落盘` 等；一碰"对着假 SDS 跑真 TCP"就卡。

### 1.2 定位过程（照着做 5 分钟能复现）

1. 二分：`timeout 20 bun test test/scope-core.test.ts -t "落盘"` 过；`-t "文本查询"` 卡。所以卡在第一条走 TCP 的用例里。
2. 绕过测试框架，直接驱动传输层（`TcpScpiTransport.connect/write/read` 对着 `FakeSds`）：连接、写 `*IDN?`、`read()` 立刻拿到 62 字节，后续 `read(1500)` 都在 1.5 s 准时抛 `ScpiTimeoutError`。**传输层没问题。**
3. 换成客户端层 `ScpiClient.query()`：**第一条** `*IDN?` 正常返回，**第二条** `:TIMebase:SCALe?` 永远不回来。而 `文本查询` 这条用例恰好是连着发两条查询。
4. 在 `bun test` 下只发一条查询：过。所以不是 bun test 和 bun run 的区别，是"第二条命令"的区别。

第一条和第二条命令唯一的差别在 `ScpiClient.rawWrite`（`src/core/scope/scpi.ts:427-434`）：

```ts
const gap = this.interCommandMs - (Date.now() - this.lastWrite);   // interCommandMs 默认 5
if (gap > 0) await sleep(gap);                                       // scpi.ts:431
```

第一次 `lastWrite` 是 0，gap 是个大负数，不睡；第二次紧跟着来，gap 是 4 ms 左右，进入 `sleep()`：

```ts
// scpi.ts:66-71
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const t = setTimeout(resolve, ms);
		(t as unknown as { unref?: () => void }).unref?.();   // 等待不该拖住进程退出
	});
}
```

而这时事件循环里**没有任何 ref 着的句柄**：客户端 socket 在 `connect` 时 `socket.unref()`（`scpi.ts:118`），假仪器的 server 也 `server.unref()`（`test/fixtures/scope/fake-sds.ts:240`）。

### 1.3 最小复现（三段，去掉了所有项目代码）

```ts
// C1：只有一个 unref 的 10 ms 定时器
await new Promise<void>((resolve) => { const t = setTimeout(resolve, 10); (t as any).unref?.(); });
console.log("resolved");
```

| 运行方式 | 结果 |
|---|---|
| `bun c1.ts`（bun 1.3.14，Windows） | **不打印、不退出，空转**，8 s 后被 `timeout` 杀掉（exit 124） |
| `node --input-type=module -e ...`（node 22.15） | 立刻退出，exit 13，`Warning: Detected unsettled top-level await`。Node 的语义：没有 ref 的东西了就退出，定时器不算 |
| C2：同上，但另外挂一个 ref 的 `setInterval(() => {}, 1000)` | bun 17 ms 后正常 resolve |
| C3：一个 `unref()` 的 `net.createServer` + 一个 `unref()` 的客户端 socket + 同样的 unref sleep | bun 卡死，同 C1 |

结论：bun 1.3.14 在 Windows 上，事件循环里只剩 unref 的定时器和 unref 的 socket 时，**既不像 Node 那样退出，也不把定时器跑掉，而是空转**。在 `bun test` 里，测试框架自己在等用例的 promise，进程退不掉，就成了 CPU 100% 的死等；框架的单测超时实测在这个状态下也不触发。

我没找到与之一一对应的上游 issue；bun 定时器的 `unref` 语义历史上就是个缺口（oven-sh/bun#880），Windows 事件循环又是单独一套实现。Linux/macOS 上应该没这个问题：ben 本机和 CI 的 Ubuntu 岗都跑过这些测试（本机没法验证这一点，见 §4）。

### 1.4 波及范围

同一个 `sleep` 写法一共三处，都会中招：

| 位置 | 用在哪 |
|---|---|
| `src/core/scope/scpi.ts:66-71` | 命令间隔 5 ms（`:431`）、USBTMC 清障轮询 20 ms（`:353`） |
| `src/core/scope/siglent.ts:140-144` | 驱动层所有"设完等一拍"：SETTLE_SHORT / SETTLE_TIMEBASE / 状态轮询 / 2500 ms / 150 ms（`:288 :303 :307 :336 :352 :374 :383 :394 :493`） |
| `test/fixtures/scope/fake-sds.ts:133-137` | 假仪器分段发送的 `chunkDelayMs`（`:328`） |

也就是说不只是"第二条查询"：`SiglentScope` 的几乎每个操作都要过 `sleep`，`scope-tool.test.ts` 整份和 `scope-core.test.ts` 里 `SiglentScope(对着假 SDS)`、`readWaveform 的窗口语义` 两组全都会卡。

### 1.5 为什么 CI 没抓到

`.github/workflows/ci.yml`：`check` 岗在 `ubuntu-latest` 跑 `bun run test`（全量）；`windows` 岗只跑 `bun test packages/agent && bun --cwd packages/kernel test`。coding-agent 的单测**从来没在 Windows 上跑过**。

### 1.6 修法建议

**A. 推荐，最小改动：三个 `sleep` 都不要 `unref`。(已做,见 §5)**
删掉 `scpi.ts:70`、`siglent.ts:143`、`fake-sds.ts:136` 那一行。理由：这些等待全都发生在一次正在进行的操作里，调用方本来就在 `await` 它，最长的一次也就 2.5 s，根本"拖不住进程退出"；真正需要"空闲时不拖住进程"的是连接本身，而 socket 已经 `unref()` 了（`scpi.ts:118`），这一条保留。改完在 Node 下行为不变，在 bun 下不再空转。

**B. 只救测试，不碰产品代码：** 在 `beforeAll` 里挂一个 ref 的 `setInterval(() => {}, 1000)`，`afterAll` 里清掉。能让测试过，但陷阱留给了以后在 bun 下跑驱动的人，不建议单独用。

**C. 流程：** `ci.yml` 的 Windows 岗加上 `bun --cwd packages/coding-agent test`（至少加 scope 和 examples 两组）；本机在 Windows 上跑测试一律按文件单跑、外面套 `timeout`，别裸跑全量。

---

## 2. bench 的 mailbox / job 失败

`bun --cwd packages/bench test`：145 过、4 挂、1 error（跑了 151 s）。mailbox 目录与 `origin/develop` 逐字节相同，与合并无关。逐个说：

| # | 用例 | 现象 | 原因 | 修法 |
|---|---|---|---|---|
| 1 | `src/job.test.ts:48` `parseJob · 必填 > repo.directory 不再必填` | `resolveWorkspace(job, "/tmp/ws")` 期望 `/tmp/ws`，拿到 `D:\tmp\ws` | `resolveWorkspace` 走了 `path.resolve`，Windows 上会补盘符；断言假设 POSIX | 断言改成和 `path.resolve("/tmp/ws")` 比，或用 `tmpdir()` 拼一个真实绝对路径 |
| 2 | `src/mailbox/host.test.ts:168` `sim 自我 spawn:假模型全闭环` | `readFile(proof.txt)` 期望 `"bench-ok\n"`，diff 显示为空（肉眼相同） | 附件经过 git clone/checkout，`core.autocrlf=true` 把 `\n` 换成了 `\r\n`（推断，置信度高：差异不可见只能是换行符） | 断言前 `replace(/\r\n/g, "\n")`，或测试里的 git 一律带 `-c core.autocrlf=false` |
| 3 | `src/mailbox/loop.test.ts` `两轮修复剧本从头走到尾`；`src/mailbox/runner.test.ts` `轮执行失败:error 如实回填…` | 都在 5062 / 5079 ms 处 `timed out after 5000ms` | 每一轮要起十几个 git 进程（clone / fetch / commit / push），Windows 起进程慢得多，撞上 bun 默认 5 s 单测超时 | 给这几条显式超时 `it(name, fn, 60_000)`，或在 `packages/bench` 加 `bunfig.toml` 设 `[test] timeout` |
| 4 | `runner.test.ts:362` "Unhandled error between tests"：期望 `ran` 拿到 `blocked` | 出现在 #3 超时之后 | 超时的用例函数体并没有停，bun 已经往下走了，它后面的断言在"测试之外"抛出来 | 是 #3 的连带，不用单独修 |

注意 #2 的 `host.test.ts` 之前有 `killed 1 dangling process`：闭环用例超时/失败后留下的子进程被 bun 收了，这一行不是新问题。

---

## 3. 验证记录

| 项 | 命令 | 结果 |
|---|---|---|
| 合并真正碰到的代码 | `bun test test/examples-search.test.ts` / `examples-schema` / `system-prompt` | 21 / 17 / 18 全过 |
| bench 全量 | `bun --cwd packages/bench test` | 145 过、4 挂、1 error，两次跑结果一致（含 main 新加的 eval 测试，全过） |
| scope 纯函数 | `bun test test/scope-core.test.ts -t "parseScpiAddress\|认 usb\|nr3\|normalize"` | 4 过 |
| scope 落盘 | `... -t "落盘"` | 3 过 |
| scope 第一条 TCP 用例 | `timeout 20 bun test test/scope-core.test.ts -t "文本查询"` | 卡死，exit 124 |
| 关掉工具沙箱再跑 | 同上 | 一样卡死，排除沙箱 |
| 干净的 develop | `git archive origin/develop \| tar -x` 到临时目录，`bun install --ignore-scripts`，跑 `scope-core.test.ts` | 一样卡死，排除合并 |
| 传输层探针 | 见 §1.2 第 2 步 | 正常 |
| 客户端两条查询 | 见 §1.2 第 3 步 | 第二条卡 |
| 最小复现 C1 / C2 / C3 | 见 §1.3 | 卡 / 过 / 卡 |
| Node 对照 | 见 §1.3 | 立刻退出 exit 13 |
| `usb` 模块本身 | `await import("usb")` | 2 s 装载完成，不是它 |

---

## 4. 可信度声明

- 带 `file:line` 的都是读代码得来的，可以直接跳过去核。
- "bun 在 Windows 上只剩 unref 句柄时空转"是本机实测（C1/C3），**没有**在 Linux/macOS 上对照过，也没查到一一对应的上游 issue。"ben 本机和 CI 的 Ubuntu 岗没问题"是从 develop 能发到 v0.1.3 反推的，本机没法看 CI 记录（gh 未登录）。
- #2 的 `\r\n` 是推断，没有 hexdump 过那个文件。
- "产品本体不受影响"的依据是内核跑在 Electron utilityProcess（Node）里；如果将来内核改成 bun 起，或者有人用 `bun` 跑示波器脚本，这个坑就会回来。

---

## 5. 修复与验证（2026-09-06 补）

按 §1.6 的 A 改了三处：删掉 `unref()`，各留一行注释说明为什么不能加回去。

| 文件 | 改动 |
|---|---|
| `src/core/scope/scpi.ts:66-73` | `sleep` 不再 unref；注释指向本文 |
| `src/core/scope/siglent.ts:140-145` | 同上 |
| `test/fixtures/scope/fake-sds.ts:133-138` | 同上 |
| `test/scope-tool.test.ts:298` | screenshot 用例的路径断言改成 `[\\/]`，Windows 的反斜杠也认（顺手修的另一个问题） |

diff 一共 +9 / −8；`tsgo --noEmit` 过；oxlint 对这些文件零告警。**已提交到 develop：f0751a3，已 push。**

验证（同一台 Windows 机器，bun 1.3.14）：

| 项 | 修前 | 修后 |
|---|---|---|
| `bun test test/scope-core.test.ts` | 永不结束 | **66 / 66 过，9.4 s** |
| `bun test test/scope-tool.test.ts` | 永不结束 | **19 / 19 过，14.5 s**（路径断言修掉之前是 18 / 19） |
| coding-agent 32 个测试文件逐个跑（每个 90 s 上限） | 跑不到头 | **全部结束，最慢的十几秒** |

逐文件跑之后还剩 5 个文件有失败。scope-tool 那一个随后一并修掉了（下表第一行）；其余 4 个都是 Windows 环境 / 移植问题，与 scope 的等待逻辑无关，也都在这次改动之前就存在（本机之前根本跑不到它们）。**这 4 个也在同日修掉了，见 §6。**

| 文件 | 结果 | 原因 |
|---|---|---|
| `test/scope-tool.test.ts:298` | 曾 18 过 1 挂，**已修，19 / 19 过** | `screenshot` 用例断言路径匹配 `/\.yoma\/scope\/screens\/…\.png$/`，Windows 给的是反斜杠。已改成 `[\\/]` 接受两种分隔符（同一提交 f0751a3） |
| `test/engines.test.ts` | 20 过 27 挂 | 用例直接 spawn `/bin/sh`、`/bin/echo`（ENOENT），`stm32config` 的退出码用例也靠它们 |
| `test/log.test.ts` | 28 过 19 挂 | 把 `.sh` 脚本当可执行文件起（`Executable not found in $PATH`） |
| `test/serial.test.ts` | 12 过 0 挂 2 error | 需要 `python3` 在 PATH 里 |
| `test/acp-agent.test.ts` | 28 过 1 挂 | `session/new` 的 slash 命令清单断言不等，未深究 |

---

## 6. 剩下 4 个文件的修法（2026-09-06 补）

根子只有一个：这些用例把"假引擎 / 假日志源"写成 `#!/bin/sh` 脚本再 spawn。Windows 没有 sh，`.sh` 也不是可执行文件，
所以整组用例一个都起不来。修法是把假货换成**一段 JS + 按平台包一层启动器**，逻辑只写一份：

| 平台 | 启动器 | 说明 |
|---|---|---|
| POSIX | `<dir>/<name>` = `#!/bin/sh` + `exec "<bun>" "<name>.js" "$@"` | 和从前一样是个可执行脚本，CI 的 Ubuntu 岗行为不变 |
| Windows | `<dir>/<name>.cmd` = `@"<bun>" "<name>.js" %*` | libuv 能直接 spawn `.cmd`，退出码与 stdout/stderr 原样透出（实测含空格、反斜杠、`$`、`;` 的参数都不走样；`&` `|` 之类会被 cmd.exe 吃掉，测试没用到） |

落点 `test/fixtures/fake-exe.ts`（`writeFakeExe(dir, name, js)` / `fakeExeName` / `ECHO_ARGV_JS`），两份测试都从它取假货。

| 文件 | 改了什么 | 结果 |
|---|---|---|
| `test/engines.test.ts` | 所有 `#!/bin/sh` 假引擎、假烧录器换成 JS；`runEngine` 那组用 `bun -e` 起子进程；"孙进程握着管道"两例改成 JS 自己 spawn 孙进程 | 20 过 27 挂 → **47 / 47** |
| `test/log.test.ts` | 12 个假日志源换成 JS（`sleep` → `setTimeout`，循环 → `setInterval`）；"杀整个进程组"一例改成父脚本 spawn 孙脚本、孙脚本写自己的 pid；pin-check 用 `process.execPath` 起 | 28 过 19 挂 → **47 / 47** |
| `test/serial.test.ts` | `havePython()` 包一层 try/catch：Windows 上找不到可执行文件时 `Bun.spawnSync` 直接抛，不是回非零退出码 | 2 error → 19 过 2 跳过（真 pty 的两例本来就该跳） |
| `test/acp-agent.test.ts` | `homeDir` 也注入临时目录 | 28 过 1 挂 → **29 / 29** |

两处产品代码，都很小：

- `src/core/tools/engines.ts` `engineBin`：Windows 上 `<name>.exe` 缺席时认 `<name>.cmd`。假引擎靠它被找到；顺带让脚本形态的引擎（比如手写的 python 壳）在 Windows 上也能挂进 `engines/bin/`。
- `src/acp/agent.ts`：`YomaAcpAgentOptions` 加 `homeDir?`，透传给 `discoverSkills`。那个 acp 用例挂的原因其实不是 Windows，是环境泄漏：`discoverSkills` 还会扫 `~/.agents/skills`，开发机上装的 8 个 `understand-*` 全局技能以 `skill:xxx` 混进了命令清单；从前只隔离了 `configDir`，没隔离这一处。

验证（同一台 Windows 机器）：coding-agent 32 个测试文件逐个跑（每个 120 s 上限）**全部结束，854 过 / 0 挂 / 44 跳过**；`tsgo --noEmit` 过；oxlint 告警数不变（121，都是老的）。
Linux 上也实跑了：把工作树导出到 `oven/bun:1.3.14` 容器（装 git、`git init` 成真检出、`bun install --ignore-scripts`），coding-agent 全量 **867 过 / 31 跳过 / 0 挂，32 个文件 40 s**。第一次跑时唯一挂的 `examples-tool.test.ts` 的 seed 用例是容器没有 git、也不是 git 检出（`detectGitCommit` 探不到提交），补上之后全绿，与代码无关。macOS 没跑，机制与 Linux 相同。

`ci.yml` 的 Windows 岗已把 `bun --cwd packages/coding-agent test` 加进去（4b616de），从此这一整轮修好的东西有闸门守着；bench 的 mailbox 那 5 个 POSIX 依赖用例仍未进 Windows 岗。macOS 至今没有任何岗（私有仓 macOS runner 按 10 倍计费，见 engines.yml 的注释），要补的话建议单独一个 workflow 走 `workflow_dispatch` 加 kernel 三包路径过滤，只跑单测。
