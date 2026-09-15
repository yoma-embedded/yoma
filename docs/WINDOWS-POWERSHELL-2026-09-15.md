# Windows PowerShell 使用验收（2026-09-15）

## 已修复

通过 Yoma 的真实 PowerShell 工具执行系统 PowerShell 5.1，发现并修复：

1. 工程目录含 `[]` 时，PowerShell 启动后静默落到系统 PowerShell 目录。
   工具现在用 `Set-Location -LiteralPath` 显式定位，并在定位失败时终止。
2. 中文管道输入外部程序变成问号。除了控制台输出编码，工具现在同时将 `$OutputEncoding`
   设为无 BOM UTF-8，保留传给 native stdin 的中文和 emoji。

没有改上游源码，没有重复第 1–6 步迁移，没有提交、推送或重启用户 app。

## 实际验证范围

- Windows 11、自带 PowerShell 5.1；工具分别在普通 Node 和产品 Electron 42.3.3 / Node 24.15.0 下执行。
- 新增 `tools-powershell.windows.test.ts`，使用真实进程和目录 `中文 工程 [1] & 引号'`：
  文件与路径、多行脚本、Unicode stdin/native 参数、stderr/CLIXML、失败退出码、禁止交互、调用隔离、
  UTF-8 BOM 脚本、流式输出、截断全文、超时与取消后的进程树终止，以及 GUI 程序等待。
  杀树测试还等过子进程原定写文件的时刻，验证后台没有继续执行。
- 产品运行时的 GUI 用例启动隔离的 Electron RUN_AS_NODE 子程序；普通命令行夹具用 `YOMA_TEST_NODE`
  指定 console Node，避免把 GUI 程序当成编译器。这条 GUI 用例在普通 Node 测试中跳过。
- 产品运行时 PowerShell 两个测试文件最终 22 通过、13 跳过；跳过的是已有 POSIX 假程序用例，
  本轮新增的 12 个 Windows 真进程用例全部通过。
- host 新增两个真实 PowerShell 会话用例：成功、失败退出码、运行中输出、最终 transcript 状态。
  两项通过。全包与根类型检查通过，lint 为 0 错误、75 个已有警告。
- 在上述特殊字符工程路径，通过 Yoma 工具调用 npm 10.9.8、Git 2.55.0、CMake 4.4.0；
  Arm GCC 以 `-mcpu=cortex-m4 -mthumb` 编译 C 文件，objdump 确认为 `elf32-littlearm` / `armv7e-m`。
- 仅枚举串口，得到 `COM1`、`COM13`。没有打开串口，尚未确认对应硬件。
- 重新构建后，内核/五个引擎/27 个数据包/LA 演示 smoke、IPC 13 项、renderer 15 项、paint 30 项通过。
  paint 覆盖首页、会话、草稿、手册库、调试台，未出现 JS 异常或 console.error。

## 在 Yoma 中写 PowerShell 命令

每次工具调用都是新的进程。将同一任务需要的目录、环境变量和命令写在同一个脚本内。
工具使用 5.1，不支持 PowerShell 7 的 `&&` / `||`；单引号字符串内的单引号写成两个。

### 文件和编译

```powershell
$ErrorActionPreference = 'Stop'
Get-Content -LiteralPath '.\测量 [1].txt' -Encoding UTF8
& 'arm-none-eabi-gcc.exe' -mcpu=cortex-m4 -mthumb -c './probe.c' -o './probe.o'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& 'arm-none-eabi-objdump.exe' -f './probe.o'
exit $LASTEXITCODE
```

- Cmdlet 的非终止错误可能仍退出 0；需要失败即停时显式设置 `$ErrorActionPreference='Stop'`。
  它不代替 native 程序的 `$LASTEXITCODE` 检查；后续成功命令可能掩盖前一步失败。
- 文件操作用 `-LiteralPath`，文本显式 `-Encoding UTF8`。
- 含中文的 `.ps1` 用 UTF-8 **带 BOM** 保存，再用 `& '.\脚本.ps1'` 调用。
- 编码后的内联脚本最多 30000 字符；更长的保存为 `.ps1`。
- 5.1 的 native 参数引用仍有限制：带空格且以反斜杠结尾的目录参数可能失真。
  在接受这些路径格式的程序中使用 `C:/工程 目录/` 或 `C:\工程 目录\.`；复杂含引号内容用文件传递。

### 等待 GUI 程序

直接用 `&` 启动 GUI 程序可能提前返回，退出码也不能按 console 程序处理。
优先使用工具的命令行版本；确实需要 GUI 程序时：

```powershell
$ErrorActionPreference = 'Stop'
$child = Start-Process -FilePath 'C:\Tools\gui.exe' -Wait -PassThru -WindowStyle Hidden `
  -WorkingDirectory ([WildcardPattern]::Escape((Get-Location).Path))
exit $child.ExitCode
```

5.1 的 `Start-Process` 工作目录会解析通配符，上面显式转义了 `[]`。
它的输出重定向参数也存在特殊字符路径问题；需要 `-RedirectStandardOutput` 时使用不含方括号的目的路径，
或让子程序自己写日志。已验证的 GUI 用例使用后者，并核对真实 cwd、完成文件及退出码 7。

## 验收边界与证据

- 首轮安装包及独立安装目录对应上一轮引擎交付修改，**尚未包含本轮 PowerShell 修复**。
  本轮测试使用当前源码与重新构建的 `packages/desktop/out/`，后续发布前需重新打包。
- 旧 netlist/stm32config `.cmd` 假引擎的 32 个 Windows 失败仍未修复；不能声称全仓测试全绿。
  详见 [Windows 引擎与安装验收](WINDOWS-ACCEPTANCE-2026-09-15.md)。
- 沙箱中 `taskkill` / Electron 子进程可能受限；真杀树和桌面测试在获准的宿主环境执行。
- 没有真实板子烧录、串口采集、GDB、HAL/CMSIS 完整工程或双机信箱验收。
- 本机证据在被忽略的 `.yoma/windows-acceptance-20260915/`：`powershell-*.log`、
  `powershell-use.ts`、`powershell-use-razeqy/result.json` 及编译产物。
