# BK64：Windows 上由 Yoma 完成真板闭环（2026-09-15）

## 结果

通过本次单板、单故障验收。Windows 测试夹具的 32 项失败已修复，netlist / stm32config
真实引擎在 Windows 上 **58/58 通过、零跳过**；软件改动与复跑命令见
[夹具收尾记录](WINDOWS-ENGINE-FIXTURES-2026-09-15.md)。

用户提供 BK64 网表，并确认 MCU 已供电、只有 J-Link，没有电机或电机电源。
根据网表选择 STM32G473RCTx，J-Link 实测连接 STM32G4 Cortex-M4，Flash 容量 256 KiB，
VTref 约 3.28 V。使用 RTT 日志；没有连接或验收 UART。

| 阶段 | 真实板上结果 |
|---|---|
| 从零生成并建立基线 | HSI 16 MHz、SysTick、RTT；编译、烧录及校验成功；BOOT 1 条、连续心跳 53 条 |
| 注入已知故障 | 将 SysTick_Handler 中唯一的 HAL_IncTick() 换成空语句；烧录该镜像后两次均只有 BOOT，心跳 0 条 |
| Yoma 定位与修复 | GDB 两次运行约 6 秒，uwTick 始终为 0；中断断点能命中；定位 HAL_Delay 等不到时间前进，恢复一行调用 |
| 重新上板 | 干净重编译、烧录及校验成功；BOOT 1 条、连续心跳 60 条，count 1..60；相邻 tick_ms 差值全部为 1001 |

RTT 初次读取包含缓冲数据；1001 ms 是固件 tick 的差值，不把开始时批量到达的日志解释成主机逐秒采样。
日志尾部还包含持续约 43 秒的现场接收。结束时停止日志并关闭 GDB，随后 J-Link 读到
uwTick 在 2 秒内从 77753 增至 79755，断开后留 MCU 运行修复后的 demo。

## 谁做了什么

协调侧仅准备本机数据、复制网表与 RTT 源码、安排阶段、保存基线并注入一行故障。
生成、编译排错、探针识别、原固件备份、烧录、日志采集、GDB 诊断及修复均由实际 Yoma
`runTurn` 内核执行，模型为 `deepseek/deepseek-flash`（本机目录显示 DeepSeek V4.1 Flash），思考档位 max。
修复使用新会话，提示词没有透露故障位置。协调侧最后独立解析原始日志、比较源码及固件哈希。

实测经过 netlist、stm32config、datasheet、powershell、flash、gdb、log 和文件工具。
手册工具能查询本次 G4 手册。生成与修复阶段仍出现 Bash 调用，因此本次不能称为纯 PowerShell 工作流。
未通过桌面 UI 执行，也未重启正在使用的桌面 app。

本机现有 STM32Cube FW G4 V1.6.3 提供 HAL/CMSIS，原工程提供 RTT 源码与许可证；没有下载或安装。
demo 单独放置，原电机工程没有被改写。demo 的 MX_GPIO_Init 为空，没有配置 PWM、EN 或电机控制逻辑。

## 本机交付和证据

以下路径均相对仓库根目录，`.yoma/` 中的内容被 Git 忽略，不随代码提交迁移：

- demo：`.yoma/bk64-acceptance-20260915/demo/`；最终固件为 `fw/build-debug/rtt-heartbeat.{elf,hex,bin}`。
- 原固件备份：`demo/evidence/original-flash.bin`，完整 262144 字节，两次独立读取哈希一致。
- 基线原始日志：`demo/.yoma/logs/hw-20260915-141206341.log`。
- 故障原始日志：`demo/.yoma/logs/hw-20260915-141751289.log`、`hw-20260915-142133568.log`。
- 恢复原始日志：`demo/.yoma/logs/hw-20260915-142424809.log`。
- GDB、修复差异、烧录与异常记录：`demo/evidence/repair/`。
- Yoma 完整工具事件：`{generate,baseline,repair}.events.jsonl`；三阶段结果及全文同目录保存。
- 独立复核：`verify.mjs`、`verification.json`；复核命令：
  `node .yoma/bk64-acceptance-20260915/verify.mjs`。

| 对象 | SHA-256 |
|---|---|
| 原固件备份 | `f395c0226c458707e9247f9be13f592e11014a8e3bcd2b1c7e8c0a014e9155cb` |
| 基线 ELF | `b3ab48cb16a56dc7ada1614bbc9eb72fc1f7716b559f7298ea510fd2dfb5e800` |
| 故障 ELF | `a50e17a51ad819f02957fd8161a67292a228c75216b14d465d30f33aa45a8e1c` |
| 修复 ELF（最终烧录记录一致） | `5a016554f3405bdccdfb7e17889cd3f438ade2c664d62ef3c1f8745a47fe08b7` |

修复后的中断源码与基线一致，原固件备份哈希未变。当前板上是 demo，原固件未自动恢复。

## 发现但未纳入本次修复的问题

以下为原验收时的记录。后续已完成模块环境和调试退出流程修复；偶发寄存器及独立 certutil 退出码仍未定位。
根因、修改、真板复核与剩余边界见 [Windows 调试问题跟进](WINDOWS-DEBUG-FOLLOWUP-2026-09-15.md)。

1. Yoma 的 Windows PowerShell 环境中 `Get-FileHash` 不可用；另有本机命令管线已输出哈希却返回 1。
   Yoma 改用其他本机方法继续执行。模块发现及退出码行为需要单独复现，不能宣称 PowerShell 全面通过。
2. J-Link GDBServer V9.58 会话中两次出现重复异常寄存器值、内存不可读，关闭重连后恢复，根因未定。
   调试期间还观测到 FPB 比较器残留与 DEBUGEVT HardFault，清除后恢复；残留断点导致该 HardFault
   是由寄存器和地址对应关系支持的推断，尚未定位到 Yoma、GDB 或 J-Link 中哪一层应负责清理。
3. 修复会话记录过一次模型 `UnknownError: Connection error.`，随后继续调用工具并正常完成。
   独立复核保留了该错误和工具错误，没有把本次描述成全程零错误。

本次覆盖最小固件闭环；电机、UART、逻辑分析仪、双机信箱和桌面交互仍不在此次验收范围。
