# Windows 引擎测试夹具收尾（2026-09-15）

## 范围和结果

只改测试夹具、测试入口和断言，不改产品引擎的启动方式。基线 HEAD 为 `6460184`。

- 修改前：netlist / stm32config 为 32 失败、18 通过、5 跳过（58 项中含分组内跳过）。
- 修改后：两工具 **58/58 通过，零跳过**，包括 Windows 自包含引擎和真实器件数据。
  默认 `engines/bin` 开发目录另跑一次同样 58/58 通过，不要求每次设置覆盖变量。
- 共享夹具相关 engines / gdb / powershell 用例：53 通过、70 既有跳过。
  随后增加二进制 stdin/stdout 往返检查，engines 单文件 18/18 通过。
  这些结果不代表已解除 GDB/QEMU/PowerShell 其他分组的平台跳过。
- 强制 typecheck：11/11 包与根配置通过；lint：0 错误、75 既有警告。

## 改动原因

1. 旧夹具产出 `.cmd`，Node 的无 shell `spawn` 报 `EINVAL`。现在 Windows 夹具用系统
   `.NET Framework 4` 的 `csc.exe` 编译一个小型 `.exe` 启动器，缓存其字节供每个夹具复制。
   启动器转发 argv、二进制标准流和退出码；不依赖 Bash/Bun，也不把产品改成 shell 启动。
   测试覆盖空参数、中文、空格、引号、尾部反斜杠及 shell 特殊字符。
2. 删除两工具真实引擎测试对 Windows 的整组跳过。临时 bin 实体复制并解引用，避免
   Windows junction 下相对符号链接指向错误位置；数据目录使用无需管理员权限的 junction。
3. 路径断言按照 JSON 编码或解码后的 argv 比较，修正反斜杠被转义造成的 Windows 假失败。
4. 支持 `YOMA_TEST_ENGINES` 指定实际交付的自包含引擎，`YOMA_TEST_STM32_DATA` 优先于默认目录。

## 复跑

本机已有 `engines/dist` 自包含产物与 27 个 irpack。生成用例还需要 F4 HAL/CMSIS；本次从本机
`STM32Cube_FW_F4_V1.28.3` 复制到引擎规定的 `data/fw` 布局，没有下载。

```powershell
$env:YOMA_TEST_ENGINES = 'D:\toy\yoma\engines\dist'
$env:YOMA_TEST_STM32_DATA = 'D:\toy\yoma\engines\stm32-config-kernel\data'
node node_modules\vitest\vitest.mjs run --project kernel-domain packages/kernel/test/tools-netlist.test.ts packages/kernel/test/tools-stm32config.test.ts
```

测试需要正常 Windows 子进程权限，特别是 `taskkill` 杀树路径；本机受限沙箱内该路径会超时，
在正常权限下完成验证。未运行全仓单测，未重启桌面端。日志位于
`.yoma/windows-acceptance-20260915/fixtures-*.log` 与 `fixture-consumers.log`。

随后完成的真实板子生成、故障注入和修复闭环见
[BK64 Yoma 验收记录](BK64-YOMA-ACCEPTANCE-2026-09-15.md)。

后续 [Windows 调试问题跟进](WINDOWS-DEBUG-FOLLOWUP-2026-09-15.md)又用交互式 GDB 子进程验证共享夹具，
修正 Windows 启动器的 stdin 转发：每块写入后立即 flush，避免命令等待到 EOF 才送达。
