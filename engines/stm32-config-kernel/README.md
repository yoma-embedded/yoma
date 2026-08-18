# stm32-config-kernel

确定性 STM32「配置 → 校验 → 代码生成」内核。AI(yoma)决定配置什么;本内核保证如何正确生成 —— LLM 绝不书写驱动代码。

- 数据:CubeMX db 经导入器编译为 IR 包(构建产物,不进 git;开发期需要本机 CubeMX)。
- 引擎:忠实实现 CubeMX 数据语义(条件 DSL、信号量黑板、参数重载、OR/XOR 模式树、时钟 DAG)。
- 输出:HAL 完整可编译工程(CMake + arm-none-eabi-gcc)。
- 契约:`stm32kernel` CLI,JSON stdin/stdout,无状态;同版本 + 同 IR + 同输入 → **字节级相同输出**。

设计文档:`docs/design.md` · opencode/yoma 集成:`docs/integration.md`

## 快速上手

```powershell
cargo build --release   # 产出 target/release/stm32kernel.exe

# 1. 查芯片与引脚
.\target\release\stm32kernel.exe list-mcus --family STM32F1 --pretty
.\target\release\stm32kernel.exe describe-mcu STM32F103C8Tx --pretty

# 2. 写配置文档(JSON Schema: `stm32kernel schema`)
@'
{
  "schemaVersion": 1,
  "mcu": { "part": "STM32F103C8Tx" },
  "clock": {
    "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
    "targets": { "SYSCLK": { "hz": 72000000 } }
  },
  "peripherals": {
    "USART1": { "mode": "Asynchronous", "params": { "BaudRate": 115200 },
                "pins": { "TX": "PA9", "RX": "PA10" }, "nvic": { "enabled": true } }
  },
  "gpio": { "PC13": { "mode": "output", "initHigh": true, "label": "LED" } },
  "project": { "name": "bluepill_demo" }
}
'@ | Out-File -Encoding utf8 cfg.json

# 3. 校验 / 求解 / 生成
.\target\release\stm32kernel.exe validate    --config cfg.json --pretty
.\target\release\stm32kernel.exe solve-clock --config cfg.json --pretty
.\target\release\stm32kernel.exe generate    --config cfg.json --out proj

# 4. 编译(产出 .elf/.hex/.bin,可直接烧录)
cd proj
cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=cmake/gcc-arm-none-eabi.cmake -B build
cmake --build build
```

诊断格式:`{severity, code, path(JSON Pointer), message, suggestion?}` —— 直接可喂给 LLM 迭代修正。

业务代码写在生成文件的 `/* USER CODE BEGIN/END */` 区段内,重新 generate 会保留。

## 命令一览

| 命令 | 作用 |
|---|---|
| `list-mcus [--family] [--package] [--min-flash-kb]` | 器件目录查询 |
| `describe-mcu <part>` | 引脚/信号/外设实例/内存 |
| `candidates --config c.json --peripheral X [--signal S]` | 信号的候选引脚(含 F1 remap 组) |
| `solve-clock --config c.json` | 目标频率 → 确定性时钟树赋值 |
| `validate --config c.json` | 全管线校验,诊断列表 |
| `generate --config c.json --out DIR [--fw-dir data/fw]` | 生成完整工程 |
| `schema` | 配置文档 JSON Schema |

退出码:0 通过 / 1 存在 error 诊断 / 2 内核错误。

## 开发期数据管道

```powershell
# ST 发布新 CubeMX 后,重新导入(需要本机 CubeMX 安装;
# db 路径自动探测,也可用 --cubemx-db / $env:STM32CK_CUBEMX_DB 指定)
cargo run --release -p stm32ck-importer -- --all --out data/
cargo run --release -p stm32ck-importer -- --families STM32H7 --out data/   # 单个家族
# 全库解析冒烟(不发射)
cargo run --release -p stm32ck-importer -- --smoke --out /tmp/x

# HAL 固件组件(BSD-3,生成工程编译所需)。三个来源依次尝试:本机 CubeMX 固件
# 缓存($HOME\STM32Cube\Repository,离线)→ ST 官方组件仓库
# (stm32h7xx-hal-driver + cmsis-device-h7)→ 整包仓库(STM32CubeMP1,
# blobless + sparse 只取 Drivers/)。CMSIS Core 全家族共用一份。
powershell -File tools/fetch-fw.ps1 -All
powershell -File tools/fetch-fw.ps1 -Families STM32H5,STM32H7
```

家族划分取自每个 `db/mcu/*.xml` 上的 `Family=` 属性 —— 不能按文件名前缀猜:
STM32WB / WB0 / WBA 与 STM32WL / WL3 / WL4 共享两字符前缀却是不同产品线,HAL 也
不同(`stm32wbxx_hal` / `stm32wb0x_hal` / `stm32wbaxx_hal`)。唯一的别名是
`STM32L4+` → `STM32L4`(ST 只发一套 L4 HAL/CMSIS)。

### 新增一个家族

1. `stm32ck-import --families STM32XX` → `data/stm32xx.irpack`
2. `tools/fetch-fw.ps1 -Families STM32XX` → `data/fw/STM32XX/{HAL_Driver,CMSIS_Device}`
3. 在 `crates/codegen/tests/compile_gate.rs` 的 `FAMILY_PARTS` 里加一行代表器件 ——
   `every_family_project_compiles` 会自动把它纳入交叉编译门禁

引擎与代码生成本身是数据驱动的,通常不需要改代码:

| 事实 | 来源 |
|---|---|
| 器件前缀(`stm32wb0x` 而非 `stm32wb0xx`) | 固件树里唯一的 `<前缀>_hal.c` |
| 设备宏 / 启动文件 | `CMSIS_Device/.../gcc/startup_*.s`,大小写以家族头文件里 `defined(...)` 的写法为准 |
| 是否带 FPU | 器件头文件的 `__FPU_PRESENT`(STM32WLE5 是无 FPU 的 M4) |
| 内存布局 | `db/mcu/memory/*.xml`(CMSIS-Zone) |
| 链接脚本要定义的符号 | 所选启动文件实际引用的(`_sstack`、WB 的 `.MB_MEM2`、WB0 的 `.bssblue`) |
| RCC 结构体字段 / 调用序列 / 电源前置 | `RCC-<家族>xx_Configs.xml` 的调用树(含 `<HardCode>` 原文) |
| hal_conf.h 的模块开关与 `*_VALUE` 宏 | 固件树里实际存在的 `_hal_<m>.h`,以及 ST 自带 `_hal_conf_template.h` 中被基础 HAL 源文件引用到的宏 |

## 工作区结构

```
crates/ir        IR 类型 + 条件 DSL 解析(importer 与 engine 的契约)
crates/importer  [bin stm32ck-import] CubeMX db XML → IR 包
crates/engine    语义引擎:黑板/求值/参数重载/模式树/时钟求解/引脚分配/NVIC
crates/codegen   Resolved 模型 → C 文件 + 工程组装(CMake/链接脚本/启动/HAL 子集)
crates/cli       [bin stm32kernel] JSON 命令行
data/            *.irpack(CubeMX 解析产物,不入库)+ fw/(HAL/CMSIS,fetch-fw.ps1)
```

## 家族支持

db 里能扫到的家族全部可导入(`stm32ck-import --all` → `data/*.irpack`,合计约 5.6 MB,2240 个器件组)。
这些 pack **不进 git**,本机有 CubeMX 时 `bun engines/build.ts` 会生成。
其中 23 个能 `generate` 出交叉编译通过的工程 —— 由 `every_family_project_compiles`
一次性门禁覆盖:每家族一个代表器件,配置为 **UART(含 NVIC 向量)+ DMA 请求 +
求解出来的时钟目标**,`cmake --build` 产出 .elf/.hex/.bin。19/23 带真实 DMA 请求,
其余 4 个(H5/U3/U5/WBA)的 GPDMA 模型未实现,门禁会实测校验这份名单不过期。

| 家族 | 代表器件 | 核 |
|---|---|---|
| C0 / F0 / G0 / L0 / U0 / WB0 | C031C6 / F030R8 / G071RB / L053R8 / U083RC / WB05KZ | M0 / M0+ |
| F1 / F2 / L1 | F103C8 / F207ZG / L152RE | M3 |
| F3 / F4 / G4 / L4 / WB | F303RE / F411CE / G474RE / L476RG / WB55RG | M4 |
| F7 | F746ZG | M7 |
| H7 | H743ZI | M7 |
| H5 / L5 / U3 / U5 / WBA | H563ZI / L552ZE / U385RG / U575ZI / WBA52CG | M33 |
| WL | WLE5JC | M4(无 FPU) |
| WL3 | WL33CC | M0+ |

仅有数据(list / describe / validate 可用,generate 不可用):

| 家族 | 原因 |
|---|---|
| STM32MP1 | Cortex-A7 应用处理器;要跑它的 M4 上下文需要 CubeMX 那种 context 选择 + 纯 SRAM 镜像 |
| STM32MP2 | Cortex-A35 + M33 多上下文,器件头按核区分(`stm32mp257fxx_cm33`) |
| STM32N6 | 全 TrustZone;需要生成 `partition_<device>.h` 与 FSBL/安全镜像划分 |
| STM32WL4 | 无公开 HAL 固件(ST 既无组件仓库,Cube 缓存里也没有) |

其它已知未覆盖:多核 H7(H745/H747/H755/H757 只生成 CM7 侧)、TrustZone 双工程
(H5/L5/U5/WBA 的 `_s`/`_ns` 划分,当前只生成非 TZ 单工程)、GPDMA/HPDMA 的请求
模型(H5/U3/U5/WBA/N6 —— 它的 mode tree 是 `ENABLE_GPDMACH<n>` + 请求作参数,
不是 `控制器→流→请求叶`)、STM32WB 的 `.MB_MEM2` 放在普通 RAM(无 BLE 协议栈时
该段为空,加了 WPAN 中间件就需要 ST 的共享 SRAM 布局)、`xbar` / `pixelClockSource`
两种时钟节点类型(MP2/N6/LTDC)。

用户直接写时钟目标 `"SYSCLK"` 在 WB0/WL3 上会得到 `CLK_TARGET` 未知目标 —— 这两个
家族的系统时钟参数叫 `CLKSYSFreq_VALUE`,目前没有别名。ETH 外设本身的代码生成
(描述符表、`HAL_ETH_Init` 新签名)未实现,只有它需要的 hal_conf 宏是对的。

### 时钟求解器规模

`solve-clock`(给定目标频率反解分频/倍频)的 wall time 差别很大 —— 每个搜索
节点都要跑一次完整的传播定点,树大就慢。8 MHz 晶振求 SYSCLK 实测:

| 快(< 1 s) | 中(8–30 s) | 超预算 |
|---|---|---|
| C0 48M · F1 72M · F3 72M · F4 168M · F7 216M · G4 170M · WBA 100M | L4 80M(8.6s)· H7 400M(12s)· L5 110M(25s)· H5 250M(26s)· WL 48M(27s) | G0 64M(47 s 后 `CLK_UNSAT`,搜索预算耗尽)· U5 160M(> 10 min) |

不给时钟目标时(只用默认树)所有家族都是毫秒级 —— 上面的 23 家族编译门禁走的
就是这条路。要治本得做增量传播,目前只在 `MAX_VISITS` 上兜底。

## v1 边界

LL 驱动、DMA 端到端生成、CubeMX headless 对拔、低功耗/中间件配置 → 见 `docs/design.md` §13。
