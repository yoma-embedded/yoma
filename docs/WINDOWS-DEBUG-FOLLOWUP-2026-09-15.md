# Windows / PowerShell / J-Link 问题调查与修复（2026-09-15）

## 结论

接续 [BK64 真板验收](BK64-YOMA-ACCEPTANCE-2026-09-15.md)，只处理验收中发现的三类问题。
修复落在子进程环境和调试会话生命周期，没有另建重试层或按异常寄存器值自动改写目标。

| 问题 | 调查结论 | 当前状态 |
|---|---|---|
| `Get-FileHash` 不可用 | PS7 → Node/Electron → PS5.1 继承了不兼容的模块搜索路径 | 已复现、修复，普通 Node 和 Electron 回归通过 |
| 已输出哈希却退出 1 | 尾部隐藏的 `Get-Process` 错误可稳定造成此现象；独立 certutil 管线的原始偶发错误未重现 | 保留真实失败退出码；未把所有退出 1 都认作同一个根因 |
| FPB 断点残留 | 原退出流程会截断 GDB/J-Link 的正常清理，且提前释放探针占用 | 改为等待自然断开和服务器退出；真板连续三轮清理通过 |
| 重复异常寄存器值、内存不可读 | 异常已在原始 GDB MI 中出现；具体发生在哪一层仍不明 | 40 次继续/暂停未复现；启用完整服务器输出以补充下次证据 |
| 模型 `Connection error.` | 保存的会话明确进入重试等待，约 6 秒后恢复，期间仍为 busy | 原重试机制有效；补回归并保留历史错误，网络故障的深层原因未知 |

环境：Windows 11，普通 Node 22.23.1，产品 Electron 42.3.3 / Node 24.15.0，Windows PowerShell
5.1.26100.9444。硬件为 BK64 / STM32G473RC，J-Link V11（941000024），GDBServer V9.58，VTref 约 3.29 V。
没有下载、安装、重新烧录、改动原电机工程或修改上游锁定源码，也没有重启用户正在运行的 app。

## 1. PowerShell：在创建子进程时处理版本边界

### 复现与根因

原环境包含 `PowerShell/7/Modules`，且位于 Windows PowerShell 系统模块目录之前。
直接由 Node 转交这份 `PSModulePath` 给 5.1 时，`Microsoft.PowerShell.Utility` 的发现受 PS7 同名模块影响：
部分 cmdlet 可用，但 `Get-FileHash` 函数没有被加载。删除**子进程环境中的**该变量后，5.1 自动构造自己的
模块路径，立即得到正确的 `Get-FileHash` 与 `abc` 的 SHA-256。

这与 Microsoft 明确描述的“经中间进程启动 Windows PowerShell”兼容问题一致，官方建议也是移除传给
子进程的 `PSModulePath`。见 [about_PSModulePath](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath?view=powershell-7.6)。

### 改动

- `domain/engines.ts`：`runEngine` 接受完整子进程环境，由调用者控制需要移除的变量。
- `tools/powershell/session.ts`：仅启动 Windows `powershell.exe` 时，按大小写不敏感规则移除继承的
  `PSModulePath`。不修改宿主 `process.env`、注册表或 `pwsh` 的环境。
- 真实 Windows 回归注入一份冲突的 Utility 模块，验证哈希成功、无关环境变量保留、宿主模块路径未变。

兼容性：只放在父进程临时 `PSModulePath` 中的自定义模块目录也不会传入 5.1。
需要这种目录时，在工具脚本中加入 `$env:PSModulePath`，或用完整路径 `Import-Module`；工具说明已写明。

### 退出码：成功输出不等于整条脚本成功

下面的末尾命令会返回 1，却没有可见 stderr：

```powershell
Get-Process yoma-process-that-does-not-exist -ErrorAction SilentlyContinue | Select-Object Name
```

`SilentlyContinue` 隐藏的是报错展示。若任务只是查询某进程是否存在，使用下面的成功空结果：

```powershell
Get-Process | Where-Object ProcessName -eq yoma-process-that-does-not-exist | Select-Object Name
```

两种行为均已加入真实回归。工具继续保留非零退出码，不用尾部 `exit 0` 掩盖错误。
原验收中三条**独立** `certutil ... | Select-Object -Index 1` 调用的退出 1，直接进程实验和实际工具
12 次复跑（默认、`-Wait` 各 6 次）均未重现。提前关闭管线只是调查过的假设，没有证据可将它认定为根因。
恢复 `Get-FileHash` 后，哈希任务不再需要依赖该替代方案。

## 2. J-Link：由拥有进程的一方完成释放

### 远程协议确认不能代替硬件清理完成

临时断点地址为 `0x08000414`。GDB 发送 `z0,8000414,2`，服务器回复 `OK`，GDB 也发出
`=breakpoint-deleted`，但目标暂停时 FP_COMP0 仍是 `0x48000415`。
因此，逻辑断点表已删除并不能证明芯片上的比较器已经清空。

同一块板上的对照实验：

| 退出方式 | 关闭后独立用 J-Link Commander 读取 |
|---|---|
| 旧流程：GDB 收到 `^exit` 后立刻终止，随后强杀服务器 | FP_COMP0 残留 |
| 先显式 `-target-detach`，随后强杀服务器 | 仍残留 |
| 先 `monitor clrbp`，随后强杀服务器 | 仍残留 |
| GDB 直接写 FP_COMP0 为 0，随后强杀服务器 | GDB 当场读为 0，但关闭后再次读到残留 |
| `-singlerun`，等待 GDB 断开及服务器自然退出 | 退出码 0；6 个 FPB 比较器全部为 0 |

历史 DEBUGEVT HardFault 与断点地址对应，支持“残留断点触发该故障”的推断；本次进一步确认了
Yoma 退出流程存在确定缺陷。不能由这些结果声称 J-Link/GDB 的所有内部状态都已查清。

### 生命周期改动

1. `GdbSession.stop()` 在 `^exit` 之后等待 GDB 进程真正退出；无响应才杀树，并再次确认退出。
2. Yoma 托管的 J-Link 使用 `-singlerun`，GDB 断开后让服务器正常完成清理。
3. 就绪判据改为 `Waiting for GDB connection`。不再用 TCP 连上又断开的探测消费 single-run 会话；
   `Listening on TCP/IP` 出现在目标初始化之前，也不足以证明可以调试。
4. `stopServer()` 等待服务器退出后才交还探针；进程未退出时保留所有权并报错。
   如果 J-Link 被迫终止或非零退出，结果明确说明硬件断点清理尚未验证。
5. 日志流结束后等待文件句柄关闭，修复 Electron 测试中随后的目录清理 `EPERM`。
6. J-Link 改为 `-nosilent`，原始服务器输出与 MI 一起保存，便于下次关联读寄存器请求和返回值。

参数语义依据 [SEGGER J-Link GDB Server 文档](https://kb.segger.com/J-Link_GDB_Server)。
没有通过写死 FPB 寄存器地址、自动复位或盲目重连来替代进程清理。

兼容性：Yoma 托管 J-Link 的 `stop keepServer:true` 现在明确拒绝，并保持当前会话打开。
手工交接可以保留当前会话，或使用外部管理的服务器配合 `connect`。
OpenOCD/QEMU 的 `keepServer` 行为保留。宿主被操作系统强杀时仍不能保证硬件清理完成。

### 真板复核

通过修改后的真实 `createGdbTool` 连续三轮：连接 → 命中 SysTick 临时断点 → 确认比较器仍有值 →
`gdb stop` → 独立 Commander 读取。每轮 6 个 FPB 比较器均为 0，`uwTick` 在约 1 秒内增加 1001。
停止 GDB 时 RTT TCP 客户端仍保持连接，也没有妨碍 J-Link 正常退出。
首轮 RTT 收到 139 条（含既有缓冲），后两轮各 2 条，不能把首轮缓冲当成新采集的 139 秒。
最终未留下 J-Link/GDB 进程，MCU 继续运行原先修复后的 demo。

### 重复异常寄存器：仍未定位

历史两次异常的原始 MI 中已经分别出现整片 `0xe0dff630`、`0x37aff920`，同时 Flash、RAM、SCB
读取失败，因此可以排除“只是 UI 显示错了”。但旧服务器没有保留详细读取日志，无法继续区分 GDB、
J-Link GDBServer、驱动或链路哪一层先失常。

本轮单独的 40 次继续/暂停压力检查没有复现；另有正常短循环、写比较器实验及上述三轮真实工具测试。
关闭重连曾恢复是现象，不足以确定根因，也不足以证明此次生命周期修复消除了这一偶发异常。

## 3. 模型连接失败：重试有效，深层网络原因未知

保存的 journal 指明 provider 为 DeepSeek，模型 `deepseek-flash`，错误为 `Connection error.`。
错误时间戳为 `1789453493148`；随后状态为 `assistant.retry_wait`，control 仍为 `running`。
下条成功 assistant 消息创建于 `1789453499174`，相差 6026 ms；投影到宿主的状态只有 `[busy, idle]`。

上游 `ai/src/utils/retry.ts` 已识别 connection error，宿主 `drive({ waitForRetry: true })` 正常等待。
`UnknownError` 是现有投影器对非鉴权错误的通用名称，不表示又发生了一次独立异常。
bench 的 `errors[]` 收集历史错误，也不等同于任务终局失败。

本轮补充“Connection error 后成功”回归，要求连续 busy、最终完成且错误仍留在 transcript。
保留既有重试机制；上游错误归一化没有保存完整 cause 链，旧记录无法追溯 DNS、代理或服务端的具体故障。
未凭这一条短暂恢复的错误增加第二层重试或修改上游锁定包。

## 验证与证据

| 检查 | 结果 |
|---|---|
| Electron：PowerShell 两文件 + GDB 生命周期 | 27 通过，13 既有 POSIX 用例跳过；Windows 新用例全部执行 |
| 普通 Node：engines / tools-gdb / gdb-lifecycle | 47 通过，57 个既有平台用例跳过；包含真实无响应进程杀树 |
| host 轮级重试分组 | 4 通过；33 项因名称筛选未执行 |
| 类型检查 | 11/11 包与根配置通过 |
| lint | 0 错误，75 个既有警告 |
| 上游哈希闸门 | 364 个 Git 文件、40 个快照文件通过 |
| 最终桌面构建、内核/引擎 smoke、生产 IPC | 通过；smoke 加载 27 个器件包、2240 条记录 |
| renderer/contextBridge | 本轮通过；最后的日志流关闭变更后未重复 UI 测试 |
| 真板退出清理 | 3/3 通过；另 40 次继续/暂停没有复现异常寄存器 |

没有运行全仓单测，已有 GDB/QEMU/POSIX 平台跳过不计为通过。旧 netlist/stm32config 的 32 项失败已在
[上一阶段](WINDOWS-ENGINE-FIXTURES-2026-09-15.md)消除。新交互式 GDB 夹具又发现 Windows `.exe`
启动器的 stdin 转发需要逐块 flush，已修正；二进制往返和交互请求均有覆盖。

产品修复已进入重新构建的 `packages/desktop/out/`；开发模式的内核不支持 HMR，正在运行的旧内核要在
下次启动后才使用修复。没有重新制作安装包。

本机原始证据位于 Git 忽略的 `.yoma/windows-followup-20260915/`，不随提交迁移：

- `powershell-before.json`、`powershell-pipeline.json`：模块对照与退出码实验。
- `gdb-break-*/`、`gdb-stress-*/`：各对照实验的 MI、服务器和 Commander 输出。
- `gdb-tool-check.json`、`gdb-tool-events.jsonl`、`gdb-tool-post-*.log`、`gdb-tool-rtt-*.log`：三轮真实工具结果。
- `model-error-evidence.json`：历史 journal 的错误、重试和状态摘录，不包含凭据。
- `electron-tests.log`、`gdb-tests-final.log`、`retry-tests.log`、`typecheck-final.log`、`lint-final.log`、
  `build-final.log`、`smoke-final.log`、`ipc-final.log`、`renderer.log`：软件验证结果。

普通 Node 回归复跑（无需模型或硬件）：

```powershell
node node_modules/vitest/vitest.mjs run --project kernel-domain packages/kernel/test/tools-powershell.windows.test.ts packages/kernel/test/gdb-lifecycle.test.ts
node node_modules/vitest/vitest.mjs run --project kernel packages/kernel/src/host/host.test.ts -t '轮级自动重试'
```

杀树用例需要正常 Windows 子进程权限。Electron 复跑使用本机证据目录的 `electron-check.mjs`，该脚本仅
使用现有 Electron 与 console Node。调查脚本和全部失败对照记录保留，方便复核，没有自动提交或推送。
