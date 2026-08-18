# gdb 测试固件(Cortex-M)

给 gdb 工具的测试用的**真固件**。一份 `main.c` 出两个 ELF,能在 QEMU 上无头跑,
覆盖"正常退出 / 断点 / 观察点 / 各类硬件故障 / 死循环 / 栈溢出 / 中断"这些
调试路径。没有 newlib、没有 startup.s、没有 CMSIS,`-nostdlib` 直接编,
输出走 ARM semihosting —— 不需要串口、不需要探针。

## 【为什么把 .elf 提交进 git】

仓库的测试套件**不能要求装 ARM 工具链**:CI 和大多数开发机上没有
`arm-none-eabi-gcc`,但 `qemu-system-arm` 用 brew 一行就有。所以两个编译产物
(`fixture.elf` / `fixture_f4.elf`)是提交进 git 的测试资产,源码放在旁边只是
为了能改、能重建。`.gitignore` 里排除的是 `*.map` / `*.ld` / `*.o` 这些中间物,
**不排除 `*.elf`**。

## 【两个 ELF】

| 文件 | CPU | flash 起始 | 用途 |
| --- | --- | --- | --- |
| `fixture.elf` | cortex-m3 | `0x00000000` | 默认。lm3s6965evb / mps2-* / netduinoplus2 / stm32vldiscovery 都从 0 启动 |
| `fixture_f4.elf` | cortex-m4 | `0x08000000` | 真实 STM32F4 存储映射(Renode / OpenOCD / 真板)。netduinoplus2 把片上 flash 同时别名到 `0x0` 和 `0x08000000`,所以它在 QEMU 上也照跑 |

两者行为完全一致,下面的场景表对两个 ELF 都验证过。

## 【场景怎么选】

同一个 ELF 覆盖所有场景,靠一个 `volatile int g_scenario`。两条选择路径:

1. **命令行**(无头跑):`-semihosting-config enable=on,target=native,arg=hardfault`
   固件在 `main()` 开头用 semihosting 的 `SYS_GET_CMDLINE (0x15)` 把 `arg=` 取回来,
   和名字表比对,命中就写 `g_scenario`。
2. **gdb 里改**(调试时):`(gdb) set var g_scenario = 3` —— 在 `main` 断住之后改,
   然后 `continue`。这条路已验证:在 `main` 停下、`set var g_scenario=2`、
   再 `break corrupt_canary` + `continue`,能停在 `main.c:82` 且 `v == 0xdeadbeef`。

## 【场景表(已验证)】

QEMU 11.0.1 + `-machine netduinoplus2`,`fixture.elf` 与 `fixture_f4.elf` 结果相同。
"退出码"是 qemu 进程的退出码:固件跑完调 semihosting `SYS_EXIT(ADP_APP_EXIT)`,
qemu 以 0 退出。

| `arg=` | 退出码 | CFSR | CFSR 位含义 | BFAR | 说明 |
| --- | --- | --- | --- | --- | --- |
| `hello` | 0 | — | — | — | 冒烟:打印 `hello from cortex-m` |
| `breakpoint` | 0 | — | — | — | `breakpoint_target(i)` 循环 5 次,有局部变量 `local_sq` |
| `watchpoint` | 0 | — | — | — | 读 + 两次写 `g_canary`,结束时 `canary now 0x0badc0de` |
| `hardfault` | 0 | `0x00010000` | UFSR.UNDEFINSTR | `0x00000000` | `udf #0` |
| `unaligned` | 0 | `0x01000000` | UFSR.UNALIGNED | `0x00000000` | 先开 `CCR.UNALIGN_TRP`,再做非对齐 32 位读 |
| `divzero` | 0 | `0x02000000` | UFSR.DIVBYZERO | `0x00000000` | 先开 `CCR.DIV_0_TRP`,再 `42 / 0` |
| `badptr` | 0 | `0x00008200` | BFSR.PRECISERR \| BFSR.BFARVALID | `0xf0000000` | 往未映射地址写 |
| `nullcall` | 0 | `0x00020000` | UFSR.INVSTATE | `0x00000000` | 经空函数指针调用;栈帧 `pc=0`、`psr=0x60000000`(T 位被清) |
| `infloop` | **不退出** | — | — | — | 永远自旋,专门用来测异步中断 / Ctrl-C / `-exec-interrupt`。**跑它必须带超时** |
| `stackovf` | 0 | `0x00009200` | BFSR.PRECISERR \| BFSR.STKERR \| BFSR.BFARVALID | (不打印) | 无界递归;打印的是 `*** HARDFAULT: STACK OVERFLOW ***`,含 `bad frame ptr = 0x1fffffb0` |
| `systick` | 0 | — | — | — | SysTick 中断跑满 5 次,`got 5 ticks`;用来测 NVIC / 中断上下文里的断点 |

断言时**只认 `cfsr` / `bfar`**:`pc` / `lr` 是编译产物地址,换个编译器版本就变。

### 故障是怎么被送到 handler 的

`Reset_Handler` 里置了 `SCB->SHCSR |= USGFAULTENA|BUSFAULTENA|MEMFAULTENA`,
所以 UsageFault / BusFault / MemManage 走的是**各自的专用向量**,不是升级成
HardFault —— 因此上面所有场景的 `hfsr` 都是 `0x00000000`(FORCED 位没置)。
向量表里 3/4/5/6 号全指向同一个 `HardFault_Handler`,所以打印头统一是
`*** HARDFAULT ***`,但 CFSR 里的位是精确的,这正是测试要断言的东西。

另外 `Reset_Handler` 把 `main()` 切到 **PSP** 上跑,MSP 留给异常处理器。
不这么分栈的话,`stackovf` 会把唯一的栈打穿,HardFault handler 压栈无处可去,
内核进 LOCKUP,QEMU 直接打印 `qemu: fatal: Lockup: can't escalate 3 to HardFault`
并杀掉整个进程 —— gdbserver 一起没,测试就没法断言了。

## 【怎么跑(无头)】

```sh
qemu-system-arm -machine netduinoplus2 \
  -kernel packages/coding-agent/test/fixtures/gdb/fixture.elf \
  -semihosting-config enable=on,target=native,arg=hardfault \
  -nographic -serial none -monitor none
```

semihosting 的输出直接进 qemu 的 stdout。

**macOS 没有 `timeout`**,而 `infloop`(以及踩到下面那条观察点坑时)会永远不退出。
用 perl 的 alarm 包一层,超时退 124:

```sh
perl -e 'my $s=shift;my $p=fork();if(!$p){exec @ARGV;exit 127;}
         $SIG{ALRM}=sub{kill "KILL",$p;waitpid($p,0);exit 124;};
         alarm $s;waitpid($p,0);exit($?>>8);' \
     10 qemu-system-arm -machine netduinoplus2 -kernel fixture.elf ...
```

收尸**一律按 PID `kill`**。绝对不要 `pkill -f qemu`:这个模式会匹配到发起它的
那个 shell 命令行本身,把自己一起杀掉。

## 【怎么 gdb】

```sh
# 1) 暂停启动,开 gdbserver
qemu-system-arm -machine netduinoplus2 -kernel fixture.elf \
  -semihosting-config enable=on,target=native \
  -nographic -serial none -monitor none -S -gdb tcp::3333 &

# 2) attach(MI 命令从 stdin 喂,-x 只吃 CLI 命令文件,喂 MI 会报 Undefined command)
printf '%s\n' \
  '-gdb-set mi-async off' \
  '-target-select extended-remote localhost:3333' \
  '-break-insert main' \
  '-exec-continue' \
  '-gdb-exit' \
| arm-none-eabi-gdb --interpreter=mi3 -nx fixture.elf
```

已验证会得到:

```
*stopped,reason="breakpoint-hit",bkptno="1",frame={func="main",file=".../main.c",line="148",...}
```

`-gdb-set mi-async off` 很关键:不关的话 `-exec-continue` 立即返回,`*stopped`
要另外等,脚本化断言会错序。

**DWARF 里记的是构建时的绝对路径**(`/Users/.../test/fixtures/gdb/main.c`)。
ELF 是提交进库的,换台机器后 MI 回的 `fullname` 还是那个老路径,gdb 也就
`list` 不出源码。断言请只认 `file` 的 basename(`main.c`)和 `line`;真要看源码,
在 gdb 里 `set substitute-path <老前缀> <本地 fixtures/gdb 目录>` 即可。

**别让程序跑到 `sh_exit()`**。它执行 semihosting `SYS_EXIT`,QEMU 会终止整个进程,
gdb 侧看到的是 `Remote communication error`。要在收尾处停住,就
`break test_done` —— 这个空函数就是为此存在的锚点。

## 【为什么是 netduinoplus2,不是 lm3s6965evb】

`lm3s6965evb`(Stellaris)在 QEMU 里的存储映射是"开放"的:往
`0xF0000000` 这种没有设备的地址写,**不会**产生 BusFault,写请求被静默吞掉,
程序若无其事地继续跑。于是 `badptr` 场景永远不出错,`stackovf` 也不会在越过
RAM 边界时faults —— 一半的场景表直接失效。

`netduinoplus2` 建模的是 STM32F405:存储映射紧且真实,未映射区域会真的产生
精确 BusFault(`BFSR.PRECISERR` + `BFAR` 有效)。上面表里的 `bfar = 0xf0000000`
就是它给出来的。所以**测试固定用 netduinoplus2**。

## 【QEMU 已知限制(会咬人的)】

1. **观察点会把 QEMU 挂死,而且是永久挂死。**
   `-break-watch g_canary` 本身返回 `^done,wpt={number="2",...}`,看起来一切正常;
   但接下来的 `-exec-continue` **永不返回**,只能靠外层超时 kill 掉 qemu。
   已实测:同一个场景改用 `-break-insert corrupt_canary` 普通断点就完全正常
   (停在 `main.c:82`,`v == 0xdeadbeef`)。
   → **测试里不要在 QEMU 上验证观察点的"命中"行为**;只能验证"设置成功"这一步,
   或者把观察点测试放到 Renode / 真板上。

2. **断点、观察点的数量上限不被强制执行。**
   真 Cortex-M4 的 FPB 只有 6 个断点比较器、DWT 只有 4 个观察点比较器,超了硬件会
   拒绝。QEMU 的 gdbstub 不建模这些比较器:实测连着塞 **512 个硬件断点
   (`-break-insert -h`)和 512 个硬件观察点全部返回 `^done`,零个 `^error`**。
   → 想测"资源耗尽时的降级路径",QEMU 上测不出来,别把它当回归防线。

3. `infloop` 场景永不退出(这是它的设计目的),任何自动化跑它都必须带超时。

## 【怎么重建】

本机(macOS + ArmGNUToolchain 15.2.rel1)的确切命令:

```sh
make -C packages/coding-agent/test/fixtures/gdb both \
  CROSS=/Applications/ArmGNUToolchain/15.2.rel1/arm-none-eabi/bin/arm-none-eabi-
```

`arm-none-eabi-gcc` 若已在 PATH 上,`make both` 就够(`CROSS` 默认就是它)。
`CROSS` 既接受 PATH 上的名字前缀,也接受绝对路径前缀。

其他目标:

```sh
make                      # 只建 fixture.elf
make TARGET=f4            # 只建 fixture_f4.elf
make run SCEN=hardfault   # 无头跑一遍
make debug SCEN=hello     # 暂停启动 + gdbserver(PORT=3333)
make gdb                  # 另开终端 attach
make clean                # 只删中间产物,保留提交进 git 的 .elf
make distclean            # 连 .elf 一起删(重建前才用)
```

## 【文件清单】

| 文件 | 是否入库 | 说明 |
| --- | --- | --- |
| `main.c` | ✔ | 全部逻辑:semihosting、场景分发、故障处理、启动代码、向量表 |
| `fixture.ld.in` | ✔ | 链接脚本模板,用 cpp 宏参数化存储映射,两个变体共用 |
| `Makefile` | ✔ | 构建 / 跑 / 调试 |
| `fixture.elf` | ✔ | cortex-m3 @ `0x00000000` |
| `fixture_f4.elf` | ✔ | cortex-m4 @ `0x08000000` |
| `.gitignore` | ✔ | 忽略 `*.map` / `*.ld` / `*.o`,**不**忽略 `*.elf` |
| `fixture.ld`, `fixture_f4.ld`, `*.map` | ✘ | 构建生成 |
