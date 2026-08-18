# STM32 确定性配置内核 — 设计文档

日期:2026-07-05 · 状态:已确认(决策经用户逐项批准;§2 起细节由内核作者定稿)

## 1. 背景与哲学

嵌入式代码生成 agent(yoma,基于 opencode fork)需要一个**确定性**的「配置 → 校验 → 代码生成」内核:

- AI 只决定"配置什么"(意图),内核负责"如何正确生成"。
- LLM 绝不参与驱动代码的具体书写;生成代码 = 数据(CubeMX db)× 确定性引擎 × 模板。
- 相当于"AI 在操作 CubeMX":同输入 → 字节级相同输出。

## 2. 决策记录(已经用户确认)

| 决策 | 结论 |
|---|---|
| 芯片数据源 | **IR 是构建产物,不进源码仓**。开发期用导入器解析本机 CubeMX db(v6.x;安装位置自动探测,`STM32CK_CUBEMX_DB` 可覆盖)。桌面安装包可以带上打包机解析出的 pack,源码树不能带。 |
| 家族范围 | 起步 **F1 + F4**(F103 BluePill 为主力;F4 证明 AF 号体制与现代 PLL/VCO 约束),2026-07-31 起加入 **H5 + H7**(小数 PLL、Cortex-M33、多区内存布局)。导入器写成全库通用,其余 18 家族仅跑解析冒烟 |
| 生成目标 | **HAL + 完整可编译工程**(main/msp/it/gpio/clock + 启动文件 + 链接脚本 + CMake + HAL 源码子集);LL 属 v2 |
| API 模型 | **无状态命令 + 查询命令**,JSON stdin/stdout;配置文档是唯一真相文件(可入 git,类比 .ioc) |
| 仓库 | 独立仓库 `D:\embedded_agent\stm32-config-kernel`,Rust workspace;TS 包装层后续放 opencode 的 yoma-config |
| 架构路线 | **通用语义引擎**:忠实实现 CubeMX 数据语义,全库一套代码;不做逐外设手工建模 |

## 3. CubeMX db 关键发现(2026-07-05 实测,CubeMX 6.x)

全部配置知识都是机器可读 XML,无需逆向 Java:

- `db/mcu/STM32*.xml`(2136 个,每封装一份):引脚→候选信号、IP 实例→版本化 IP 定义(`{Name}-{Version}_Modes.xml`)、跨引脚互斥 `<Condition>`、`ClockEnableMode`(HAL 时钟使能宏,直接可用于 MSP 生成)、Die/封装标志。
- `db/mcu/IP/GPIO-*_Modes.xml`(96 个):F4+ 逐 (pin,signal) 的 `GPIO_AF`(AF 号编码在宏名 `GPIO_AF7_USART1` 里);F1 用 `RemapBlock`(AFIO remap 组,整组引脚联动,非默认组携带 `__HAL_AFIO_REMAP_*` 宏)。电气预设三层:RefParameter 默认 → RefMode 预设(钉参数)→ 外设文件 `RefSignal IOMode` 绑定。
- `db/plugins/clock/*.xml`(67 个拓扑)+ `db/mcu/IP/RCC-*_Modes.xml`(68 个约束):**显式时钟 DAG**(节点类型 `fixedSource/variedSource/devisor[sic]/multiplicator/multiplicatorFrac/fractional/multiplexor/output/activeOutput`,`Input/Output` 边,mux 的 `refValue` 映射枚举);RCC Modes 给全部 Min/Max、VCO 范围、USB ±0.25% 窗、Flash 等待周期表(VDD×HCLK 条件表)、VOS 档位。分频因子在 `PossibleValue@Comment`(含 "1.5"),需专项解析校验。
- `db/mcu/IP/*-Modes.xml`(1395 个):OR/XOR 模式树 + `SignalLogicalOp AND` 信号需求 + `Semaphore` 发布 + 条件序 RefParameter 重载(**同名多块,首个条件为真者胜,末块为无条件回退**)+ `PossibleValue` 级 Condition/Action(Disable/Remove)/Semaphore + RefMode 继承(`BaseMode`)+ `$IpInstance/$Index/$IpNumber` 宏 + 跨实例引用 `ADC1:Param`。跨外设耦合(DMA/NVIC/ADC)全部走信号量黑板。
- `db/mcu/IP/NVIC-*_Modes.xml`:向量表为五段冒号记录 `IRQname:flags:ownerIPs:handlerFn:args`;共享向量按 `*_Exist` 条件选择;优先级范围随 PriorityGroup 联动。现代家族有 `force:/warning:` 前缀条件方言。
- `db/mcu/IP/DMA-*_Modes.xml`:F1 固定请求→通道矩阵(XOR 树);参数按请求方信号量约束(如 SPI 半字对齐)。
- `db/mcu/config/*_Configs.xml`(1341)+ `llConfig/*_LLConfigs.xml`(1205):**干净的声明式"参数→HAL/LL 调用序列"**(RefConfig/CallLibMethod/MethodArg/LibMethod/Argument 树)。这是代码生成的语义来源。
- `db/templates/*.ftl`:**不复用**(FreeMarker 方言 + Java 对象图 + `#t/#n` 后处理;所有难点在 Java 侧已做完)。只复刻其输出约定:`MX_<inst>_<halMode>_Init` 命名、USER CODE 区段、`{0}` 局部初始化、`!= HAL_OK → Error_Handler()`、MSP 中时钟使能先于 GPIO。
- 条件表达式 DSL 全库统一且极小:`& | ! = < >` + 括号 + 标识符(信号量/参数名);无 `<=`(写作 `(a<b)|(a=b)`);无 Die/Family 引用(家族差异靠文件分派)。
- `db/contextual/`:纯帮助文本,忽略。`families.xml`:器件目录(搜索/上限用)。
- HAL 固件包(启动文件/链接脚本/HAL 源码/CMSIS)为 BSD-3-Clause,可自由再分发;从 ST 官方 GitHub(STM32CubeF1/F4)获取子集打包。

## 4. 架构

```
CubeMX db ──(构建期)──> importer ──> IR 包(per-family, postcard+zstd, 不进 git)
                                        │
配置文档 JSON ──> cli ──> engine(validate/solve:模式树+参数+时钟+引脚+NVIC/DMA)
                                        │
                                   codegen ──> 完整工程(main/msp/it/clock/gpio + startup + ld + CMake + HAL 子集)
```

Workspace crates:

- `ir`:IR 类型 + 表达式 AST + serde(版本化 `SCHEMA_VERSION`)。
- `importer`(bin):XML(quick-xml)→ IR;表达式编译;lint(未知元素、Comment 因子解析失败、悬空引用);quirk 表;全库冒烟模式。
- `engine`:信号量黑板、DSL 求值、参数域解析(重载/继承/钉住)、模式树、不动点传播、时钟图 validate/solve、引脚分配、NVIC/DMA。
- `codegen`:Configs.xml 调用树 × 已解析参数 → MiniJinja 模板 → C 文件;工程组装(startup/ld/CMake/HAL 复制/hal_conf.h)。
- `cli`(bin `stm32kernel`):命令分发,JSON in/out。

### 确定性铁律(全 crate 生效)

- 容器一律 `BTreeMap/BTreeSet` 或显式排序;禁止依赖 HashMap 迭代序。
- 频率一律整数 Hz(`u64`);非整分频(1.5)用 `num_rational::Ratio<u64>`;禁止浮点参与判定(VDD 电压比较用 mV 整数)。
- 求解器搜索序固定且文档化;同分决胜取字典序。
- 生成文件头注入内核版本 + IR 包哈希;同版本同输入 → 字节级相同输出。

## 5. 语义引擎

- **黑板**:`semaphores: BTreeSet<Sym>` + `params: BTreeMap<Sym, Value>` + 频率环境。标识符全部驻留(interned symbol)。
- **求值器**:对导入期编译好的 AST 求值;缺失标识符 = false/未定义,记诊断(与 CubeMX 容忍脏数据的行为一致,但显式可见)。
- **参数解析**:同名重载按文档序 first-match-wins;RefMode 链(leaf → BaseMode*)收集 Parameter;Parameter 内 PossibleValue 钉住;值级 Condition+Action 过滤;`Semaphore=` 随选值发布。
- **模式树**:XOR 子节点互斥、OR 可组合;Mode Condition 不满足 → 不可选(诊断带 Diagnostic 文本);激活即发布 Semaphore + 需求 `SignalLogicalOp AND` 信号集(RefSignal `Virtual=true` 不占引脚但占 XOR 互斥)。
- **不动点**:模式激活/参数赋值 → 信号量变化 → 条件重估 → 域变化 → 循环至稳定;迭代上限(如 64 轮)防振荡,超限报内核诊断。
- **实例宏**:`$IpInstance/$Index/$IpNumber` 在实例绑定期展开后驻留。

## 6. 时钟求解器

- IR:节点(类型 + 绑定 RefParameter 的域:枚举因子表/整数范围/固定值)+ 有向边 + mux `refValue` 表 + `refEnable`;约束(Min/Max 断言,来自 RCC Modes 的重载块,条件编译为 AST)。
- **validate**:给定全赋值 → 拓扑序正向传播 → 校验所有断言 + USB 窗 + Flash 等待周期/VOS 联动(自动求出写回配置)→ 诊断。
- **solve**:目标(输出频率恰等/至多/至少)+ 部分固定 → 有限域 DFS(VCO/中间范围剪枝)→ 确定性择优:精确命中 > 源偏好(HSE 晶振 > HSI)> 更少 PLL 级数 > 字典序;可返回前 N 备选。
- 失败诊断:定位越限节点、当前值/允许区间、可行建议。

## 7. 引脚分配

- 输入:各外设激活模式的信号需求 + 用户/AI 的 pin hint(显式指定只校验,不改)。
- 约束:一 pin 一信号;F1 remap 组全组一致(选定 `USARTx_REMAPn` 则该组全部信号只能落在该组引脚);跨引脚互斥 Condition;`ExclusiveGroupName/ShareableGroupName`;SWD 引脚默认保留(可显式释放)。
- 求解:确定性回溯,候选序 = hint 优先,其余按 (端口, 位号) 字典序;失败输出解释链(争用双方、被哪条约束挡住、可行替代)。

## 8. NVIC / DMA

- NVIC:五段记录解析进 IR;共享向量按 `*_Exist` 选择;PriorityGroup ↔ 抢占/子优先级范围联动校验;输出 SetPriority/EnableIRQ 序列 + `stm32fXxx_it.c` handler(记录中的 handler 模板 + 参数)。
- DMA:请求→通道(F1)/stream×channel(F4)矩阵占用检查;HAL_DMA_Init 参数按请求方条件约束;`__HAL_LINKDMA` 进 MSP;DMA 中断向量自动带出。

## 9. 代码生成与工程组装

- 语义:`*_Configs.xml` 的 RefConfig/CallLibMethod/LibMethod/Argument 树 + 引擎解析出的参数值(已是 HAL 枚举字面量)→ 调用序列模型。
- 呈现:MiniJinja 模板(自写,风格复刻 CubeMX 输出约定,含 USER CODE 区段);增量再生成时解析既有文件抽取 USER CODE 内容回填。
- 文件:`main.c/h`、`stm32fXxx_hal_msp.c`、`stm32fXxx_it.c/h`、`gpio.c/h`、时钟初始化(`SystemClock_Config`)、`stm32fXxx_hal_conf.h`(按启用外设开模块宏)。
- 工程:startup `.s` + 链接脚本(按 part 的 flash/ram 生成)+ CMSIS Device + HAL 源码子集复制 + `CMakeLists.txt` + `arm-none-eabi-gcc` 工具链文件;FW 子集由 `tools/fetch-fw` 从 ST GitHub 取回并打包(BSD-3)。
- 验证即编译:黄金工程必须 `cmake + ninja + arm-none-eabi-gcc` 零 error 通过。

## 10. CLI 契约(`stm32kernel`)

命令(JSON stdout;`--pretty` 供人读;exit 0=OK,1=有 error 诊断,2=内核错误):

- `list-mcus [--family F] [--package P] [--min-flash N]`
- `describe-mcu <part>`(引脚/信号/IP/内存/电压)
- `candidates --config c.json --peripheral USART1 [--signal TX]`(引脚候选 + remap 组)
- `solve-clock --config c.json [--alternatives N]`(返回 assignments 补丁)
- `validate --config c.json`(诊断列表)
- `generate --config c.json --out DIR [--dry-run]`(文件清单 + 诊断;原子写)
- `schema`(输出配置文档 JSON Schema,供 TS 层/LLM 用)

诊断格式:`{severity: error|warning|info, code: "CLK001", path: "/clock/pll/mul"(JSON Pointer), message, related: [...], suggestion?}`。

配置文档(v1 概形,`schemaVersion: 1`):

```jsonc
{
  "schemaVersion": 1,
  "mcu": { "part": "STM32F103C8Tx" },
  "power": { "vddMv": 3300 },
  "clock": {
    "sources": { "HSE": { "kind": "crystal", "freqHz": 8000000 } },
    "targets": { "SYSCLK": { "hz": 72000000 } },      // solve 输入
    "assignments": { }                                  // validate 输入 / solve 输出
  },
  "peripherals": {
    "USART1": { "mode": "Asynchronous", "params": { "BaudRate": 115200 },
                 "pins": { "TX": "PA9", "RX": "PA10" },
                 "nvic": { "enabled": true, "preemptionPriority": 0, "subPriority": 0 } },
    "GPIO": { "pins": { "PC13": { "mode": "Output", "label": "LED", "initHigh": true } } }
  },
  "project": { "name": "app", "heapSize": "0x200", "stackSize": "0x400" }
}
```

## 11. 测试策略

1. **导入器**:F1+F4 全量导入零 error;全库(2136 MCU)解析冒烟 + lint 快照(insta)。
2. **引擎单测**:重载解析、信号量传播、XOR 互斥、不动点收敛、DSL 求值边界。
3. **时钟黄金例**:F103 经典 72MHz(HSE8×PLL9)+USB48+ADC≤14MHz;F411 100MHz VCO 剪枝;蓄意非法例(超 Max、USB 窗外)必须报对应诊断。
4. **引脚黄金例**:F1 remap 一致性(USART1 REMAP0/1)、跨引脚互斥、SWD 保留。
5. **编译门**:黄金工程(F103 blink+USART+EXTI,F411 等价物)cmake+ninja+arm-gcc 全绿。
6. **对拔 CubeMX**(v1.5,后续):CubeMX headless 脚本生成参考工程,与内核输出做结构化 diff(MX_*_Init 语义等价)。
7. **确定性测试**:同输入跑两遍,输出目录逐字节相同。

## 12. 里程碑

- **M1**:importer:F1+F4 → IR;全库冒烟。
- **M2**:engine:参数/模式/信号量 + 时钟 validate/solve(F103 黄金例过)。
- **M3**:引脚分配 + NVIC/DMA。
- **M4**:codegen + 工程组装;F103 黄金工程编译通过。
- **M5**:F411 黄金路径 + CLI 全命令 + 快照/确定性套件。
- **M6(v2)**:CubeMX 对拔 harness、LL、意图门面、更多家族。

## 13. 非目标(v1)

前端页面、原理图解析、LL 生成、FreeRTOS/中间件、低功耗模式配置、多核家族(H7 双核/MP1)、`force:/warning:` 条件方言完整实现(先解析保留、按 warning 降级)。

## 14. 家族无关性:数据来源清单(2026-07-31,H5/H7 接入时确立)

加家族原则上只是加数据。以下曾经硬编码的东西现在都从 db 或固件树来:

| 事项 | 来源 |
|---|---|
| 启动文件 / CMSIS 设备宏 | 扫 `CMSIS_Device/Source/Templates/gcc/startup_*.s` 现场发现,再按 flash 容量 / 引脚数分桶(`project::device_stems`) |
| 链接脚本 MEMORY | `db/mcu/memory/STM32_<DIE>_<RAM>_<FLASH>.xml`(CMSIS-Zone rzone)。带 `physical=` 的条目是安全/别名视图,丢弃;相邻同类区合并(H5 SRAM1+2+3 → 640K,H7 AHB1+2+3 → 288K);主 RAM = `[0x20000000,0x40000000)` 内最大的一块(H743 落在 0x24000000 的 512K AXI SRAM,与 CubeMX 的 `RAM_D1` 一致)。无该文件的家族(F1/F4)退回单区布局 |
| `_sstack` 等链接符号 | 读所选启动文件里实际引用的符号(H5/U5/WBA 的新版启动要 `_sstack`,F1/F4 不要) |
| 时钟初始化结构体字段 | `RCC-<家族>xx_Configs.xml` 的 `HAL_RCC_OscConfig` / `HAL_RCC_ClockConfig` 参数树(文档序)+ RefConfig 的 `字段 → 参数` 绑定,再走 `+X` / `=LIT` / `+A+|B` 间接层。某字段在该器件上不适用时解析为 `null` → 省略(F405 没有 `PLLR` 就不会印) |
| 电源前置序列 | `RCC_ConfigVoltageScaling` / `RCC_MODIFY_REG` 的调用表:F1 没有;F4 是 `__HAL_RCC_PWR_CLK_ENABLE` + 电压档;H5/H7 的 HAL 根本没有 PWR 时钟门,改为等 `PWR_FLAG_VOSRDY`,H7 另加 `HAL_PWREx_ConfigSupply` |
| hal_conf 振荡器宏 | RCC def 里所有 `<X>_VALUE` RefParameter(排除 `*Freq*` 计算量)。H7/H5 因此自动拿到 `CSI_VALUE`、H5 再加 `HSI48_VALUE` |
| 编译器机器选项 | `Part.core` 字符串 → GCC `-mcpu`/`-mfpu`(长 token 先匹配:`m33` 早于 `m3`) |

两个补上的语义缺口(对全部家族生效,不只 H5/H7):

- **导线级范围断言**:时钟树 `<Signals>` 把边上的 signal id 绑到 RefParameter,中间导线的 Min/Max **只**存在那里。H7 的 PLL 输入窗(1–16 MHz)和 VCO 窗(150–960 MHz)就是这么表达的;不查它,求解器会心满意足地给出 64 MHz PLL 输入 + 1.6 GHz VCO。检查前先过 `refEnable` 门(否则 `HSERTCDevisor` 会在 RTC 没用时误报)。
- **选值信号量**:list 参数选中某个 `PossibleValue` 时要发布它的 `Semaphore`。资格限于「绑在时钟元件上」或「带条件重载(即 db 自己算出来的)」两类 —— F4 的 `FamilyName` 只有一条无条件重载,它默认值发布的 `TM` 会把 `SYSCLKFreq_VALUE` 打到 84 MHz 档,让 F405 的 168 MHz 变成不可达。有了这个,`scale1` 才发布得出来,`FLatency` 才知道 200 MHz HCLK 要 2 个等待周期。

## 15. 全家族接入(2026-08-03,27 家族)

家族身份改为读每个 `db/mcu/*.xml` 上的 `Family=` 属性。按文件名前两个字符猜是错的:
STM32WB / WB0 / WBA 与 STM32WL / WL3 / WL4 共享两字符前缀但 HAL 不同,MP1 / MP2 同理;
`STM32L4+` 是 db 自己的家族名,但 ST 只发一套 L4 树,故别名到 `STM32L4`(`Part::family`
仍保留 db 原文 —— 黑板把它当信号量抬起来,条件会测它)。

新增的数据来源(在 §14 表格之外):

| 事项 | 来源 |
|---|---|
| 器件前缀 | 固件树里唯一的 `<前缀>_hal.c`。25 个家族是 `<family>xx`,WB0 是 `stm32wb0x`、WL3 是 `stm32wl3x`;前缀是 include 名、HAL 源文件名和 `Core/Src/<前缀>_it.c` 的共同词根,猜错就全错 |
| 设备宏大小写 | 家族头文件里 `defined(...)` 的实际写法 —— ST 并不统一(`STM32F103xB` / `STM32WBA52xx` / `STM32WL3XX`),而 `#if defined` 区分大小写 |
| 启动文件核后缀 | `startup_stm32wb55xx_cm4.s` 的 `_cm4` 只在启动文件上有,器件头没有;多核产品线按 `Part.core` 选 |
| 是否 hard-float | 器件头的 `__FPU_PRESENT`。STM32WLE5 是没有 FPU 的 Cortex-M4,按核名给 `-mfloat-abi=hard` 会被 `core_cm4.h` 直接 `#error` |
| RCC 子结构体名 | db 结构体形状里以 `PLL` 开头的 struct 成员:多数家族是 `PLL`,N6/WBA6 是 `PLL1`,C0/WB0/WL3 根本没有(硬印 `PLL.PLLState = RCC_PLL_NONE` 编译不过) |
| `HAL_RCC_ClockConfig` 参数个数 | db 的 LibMethod 签名。N6 从外部存储执行,没有 flash 等待周期参数 |
| 电源前置的逐条语句 | `RCC_ConfigVoltageScaling` 的调用表逐项翻译,含 `<HardCode Text="#n#twhile(!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {}">` —— VOSRDY 自旋等待是 db 自带的原文,不是我们的家族判断;L0/L1/WB/WL 没有它,它们的 HAL 也确实没有 `PWR_FLAG_VOSRDY` |
| hal_conf 模块开关 | 固件树里实际存在的 `Inc/<前缀>_hal_<m>.h`。N6 没有 `hal_flash` |
| hal_conf 其余宏 | ST 自带 `<前缀>_hal_conf_template.h` 里、且被常编译的基础 HAL 源文件引用到的宏。L4/L5/U5 的 `EXTERNAL_SAI1_CLOCK_VALUE`(db 里叫 `EXTERNALSAI1_CLOCK_VALUE`,拼法不同)、WB 的 `MSI_VALUE`、WB0 的 `CFG_HW_RCC_HSE_CAPACITOR_TUNE` / `LSE_DRIVE_LEVEL` 都是这么来的;F1/F4 模板里的 40 个以太网 PHY 宏因为没被基础源文件引用而不会印出来 |
| 链接脚本额外段 | 所选启动文件引用的 `_s<N>`/`_e<N>`(有 `_si<N>` 就是从 flash 搬运,否则清零)。WB 的 `.MB_MEM2`、WB0 的 `.bssblue` |

三个引擎修正(全家族生效):

- **条件表达式支持乘除**。`((SYSCLKFreq_VALUE/2) < 10000000)` 之前解析失败 —— 而解析失败的 `<Condition>` 被当成「没有条件」,于是那条重载变成无条件的,把 db 真正的兜底重载全部遮住:F3 的 APB1 下限因此被永久钉在 10 MHz,任何 F3 配置都报 `CLK_RANGE`。现在 `*`/`/` 进了文法(`+`/`-` 仍是标识符字符,db 的 `STM32H7-DUAL`、`2V1` 需要),并且**解析不了的条件一律变成永假**而不是消失。
- **没被使用的 PLL 不参与范围断言**。PLL 节点普遍没有 `refEnable`,但 db 用 `<PLL><n>Used` 参数表达同一件事(G0 的 `PLLRCLKFreq_Value` 上限只在 `PLLUsed=1 & SysSourcePLL` 下才从 16 放宽到 64 MHz)。缺这条,一台停在 HSI 上的器件会把空转 PLL 的频率报成越界。顺带把 F3 求 72 MHz 的 wall time 从 >90 s 压到 0.1 s —— 之前搜索树里全是无解的暗 PLL 分支。
- **重载选择:满足的条件优先,其次首个带值的**。db 用「条件满足但值为空」表示「本器件没有这个东西」:WBA52 的 `SupplySource` 命中 `(STM32WBAx4|STM32WBAx2|STM32WBAx0)` 拿到空值(它的 PWR 没有 REGSEL,HAL 里那个函数也只在 `#if defined(PWR_CR3_REGSEL)` 下声明),WLE5 的 `ClockTypeHCLK2` 同理。但无条件的 `null` 是另一回事 —— 那是 `*ARG` 的门闩惯用法,门在 CubeMX 内部标志上(`HCLKtoConfigure`),不能据此丢字段,否则 H7 的 APB3/APB4 分频器全没了。两者靠「空 vs null」区分。
- 结构体成员还要过一道固件头检查:STM32WL 的 `RCC_ClkInitTypeDef` 里 `AHBCLK2Divider` 包在 `#if defined(DUAL_CORE)` 内,单核 WLE5 上不存在。判断方式是拿器件头 `#define` 的集合去跑 HAL 头里的 `#if defined(...)` 结构。

## 16. 门禁加宽后暴露的问题(2026-08-03,对照 CubeMX 反编译后)

`every_family_project_compiles` 原本用空配置,只证明了工程骨架能链接。改成
**UART + NVIC + DMA + 已求解的时钟目标**(HSE 8 MHz 直通 —— 全家族 < 0.5 s 且电气
合法;H743 自己的默认 64 MHz HSI 直上 PCLK2 在 VOS3 下真的超了 USART 的 50 MHz
上限)之后,一次撞出六类 F1/F4 之外从未走过的路径:

| 事项 | 之前的错误假设 | db 实际怎么说 |
|---|---|---|
| DMA 流节点 | 一个节点 = 一条流 | DMAMUX 系是**范围**:`DMA1_Channel[1-7]`,还可以是**跨控制器候选列表** `DMA1_Channel[1-7]:DMA2_Channel[1-5]`。F1/F4 早于 DMAMUX,所以字面读法一直没露馅 |
| DMA 控制器名 | 父 Mode 的名字 | G4 的控制器 Mode 叫 `"DMA1, DMA2"`(逗号列表);控制器应当从流名自己推 |
| DMA 中断向量 | `<flow>_IRQn` | 向量是**共享**的,F0 把通道 2、3 合并成 `DMA1_Channel2_3_IRQn`。`IRQn` 的 PossibleValue 记录里就写着 `<name>:<flags>:<ip>:<controller>:<first>,<last>` |
| DMA 时钟使能 | 一个宏名 | `ClockEnableMode` 是 `;` 分隔的宏名**列表**(G4 要同时开 DMAMUX1 和 DMA1);WB0 还把它声明在 IP 层而非控制器 RefMode 上,宏名是 `__HAL_RCC_DMA_CLK_ENABLE` |
| DMA 服务 IP | 实例名固定是 `DMA` | H5/U5/N6/WBA 叫 `GPDMA1`,H7 同时有 `DMA` + `BDMA` + `MDMA` 三棵独立的树 |
| 外设内核时钟 | `f1 && (用了 ADC 或 USB)` | 见下 |

### HAL_RCCEx_PeriphCLKConfig:从 db 调用树来

原实现两个判据都以 `f1 &&` 短路,于是整块**只对 F1 生效**;H5/H7 工程能编译,
但外设内核时钟停在复位值 —— 编译通过、硬件行为错,是最坏的失败模式。

改成完全数据驱动后有三处值得记:

- **调用点位置不固定**。H7 放在 `RCC_PeriphClockConfig`,F1 挂在 `RCC_ClockConfig`
  里。所以要搜「哪个 RefConfig 调用了这个方法」,而不是按名字取。名字里带
  `Common` 的是双核共享变体(H7 的 `C_` 前缀参数集),单上下文工程要非 Common 那个。
- **`PeriphClockSelectionARG` 是累加的**,不是首个命中。H7 上它有 **144 条重载**,
  每条被一个 `<IP>Used_ForRCC` 守卫、各贡献一个 `RCC_PERIPHCLK_*` 标志;CubeMX 把
  满足的全部 OR 起来。只取第一条 = 只配一个外设的内核时钟,其余静默丢失。
- **结构体字段按守卫是否满足来取舍**。这些 `*ARG` 的守卫是 `<IP>Used_ForRCC` ——
  引擎真的建模了的信号量,不同于 `HAL_RCC_ClockConfig` 那些分频器 ARG 背后的
  CubeMX 对话框内部标志。所以这里「守卫不满足」就是「该外设没配」,应当省略字段,
  而不是退回首个带值重载。

验证:H743 + USART1 得到 `RCC_PERIPHCLK_USART1` + `Usart16ClockSelection =
RCC_USART16CLKSOURCE_D2PCLK2`;H563 得到 `Usart1ClockSelection = RCC_USART1CLKSOURCE_PCLK2`;
F1 + ADC1 仍然是 `RCC_PERIPHCLK_ADC` + `AdcClockSelection = RCC_ADCPCLK2_DIV6`
(与旧的硬编码逐字相同,只是现在来自 db)。

### distinctValsSource:20 个家族的默认时钟源

`type="distinctValsSource"`(MSI/MSIS 档位振荡器)之前 `parse_kind` 返回 `None`,
而 `None` 会**整节点丢弃、连带 Input/Output 边一起消失**。它是 L0/L1/L4/L5/U0/U3/
U5/WB/WL 等 20 个家族的默认系统时钟源 —— 也就是说,一份不接晶振的 L4 配置(最常见
的那种)在此之前**根本没有到 SYSCLK 的路径**。

频率取法:选中的 `PossibleValue` 的 `Comment` 就是频率,单位取参数自己的 `Unit`
(`RCC_MSIRANGE_6` 注释 `4000`,参数标 `Unit="KHz"`,即 4 MHz)。与
[`node_factor`] 同一套查表,只多一步单位换算 —— 因为这里的数字是频率不是比例。

回归锚点:`crates/engine/tests/msi_source.rs`,断言 L4 默认 MSI 4 MHz 直达 SYSCLK,
且求解器能在无晶振时用 MSI 驱动 PLL 到 80 MHz(4/1×40/2)。

### 静默丢弃 → 有声

台账里反复出现的形态是「解析进 IR 了,下游没接,而且不报」。这一轮把三处改成有声:

- **RefMode `<Parameter>` 的 `@RefParameter` 重定向与 `<Condition>` 守卫**。`Name` 是
  模式内的标签,`RefParameter` 才是它钉的参数,全库约一半的 `(Name, RefParameter)`
  对不相同(`Name="ADC1_Secure" RefParameter="IP_Secure"`)。之前只读 `Name`,查不到
  就是 `else { continue; }` —— 该模式静默退化成「什么都没钉」。现在两者都进 IR,
  解析不了的守卫按 [`unsatisfiable`] 处理,真的查不到时发
  `MODE_PIN_UNRESOLVED` 警告(db 确实存在跨器件共享 RefMode 的情况,所以是警告
  不是错误)。顺带把 lint 从 236,232 条降到 178,883 条。
- **空的 `GPIO_Pin` 宏**。9263 个引脚里有 192 个(振荡器焊盘、JTAG 复用脚)有表项
  但没有 `GPIO_Pin` SpecificParameter,而兜底只在「整体查不到」时触发 —— 于是生成
  `#define PC14_Pin`(无值)。改成空字符串也算未命中。
- **`ShareableGroupName` / `ExclusiveGroupName`**。解析进 IR 后从没有人读,引脚共享
  完全靠「两个信号都是 analog」的启发式加用户自己写的 `sharedWith` 白名单。现在
  两者都接进分配器:同一 shareable 组授权共享(db 明说 `ADCx_IN0` 就是 ADC1/2/3 的
  IN0 共享),同一 exclusive 组一票否决 —— **且优先级高于用户白名单**,因为用户不能
  让器件把两个互斥信号真的接到一个焊盘上。

  这里有个坑:属性值是 `<组名>:<该组适用的实例列表>`,组名里还带 `$IpInstance` 宏
  (`S_$IpInstance_CH1:TIM1,TIM3,TIM4`、`S_TIM2_CH1_ETR:TIM2`)。直接拿原始字符串比较
  会让所有定时器的 CH1 看起来同组,反而**授权出器件并不存在的共享**。

### 声明范围内的实功能缺口(本轮补上)

| 事项 | 之前 | 现在 |
|---|---|---|
| hal_conf 的模板宏 | 只收「被基础 HAL 源引用」的 | 记录**每个宏被哪个模块读**,按工程实际启用的模块取舍。F4+ETH 的 `PHY_READ_TO`/`PHY_WRITE_TO` 没有 `_VALUE` 后缀、也没有基础源引用,任何更窄的规则都会漏掉;而 F1 模板里那 40 个以太网 PHY 宏在不开 ETH 时仍然不会印出来 |
| `<CCMRam>` | 全仓零引用 | 进 IR 并落进链接脚本。它是 rzone 之前的家族**唯一**声明核心耦合内存的地方,且不计入 `<Ram>`(F407 是 `<Ram>128` + `<CCMRam>64`)。地址 db 里没有 —— 那是架构常量,按核推:Cortex-M4 的 CCM 在 0x10000000;M7 把 DTCM 也标成 `<CCMRam>` 但它在 0x20000000、与主 RAM 同基址,所以交给 rzone 路径 |
| 晶振引脚 | 从不产生 `SignalReq` | HSE/LSE 晶振按 `RCC_OSC_IN/OUT`、`RCC_OSC32_IN/OUT` 参与分配。只在该封装真的引出、且引脚类型是通用 I/O 时才请求 —— 多数家族这两个焊盘是专用的(`MonoIo`),永远不与 GPIO 争用。它们参与冲突检测但不产生 GPIO 初始化(CubeMX 也不产生) |
| 再生成的陈旧文件 | 永久残留 | `REGEN_STALE` 警告列出本次不再产出的 `Core/{Src,Inc}` 文件。**报告而非删除** —— 里面可能有用户代码,内核不替用户删东西 |
| 固件包版本 | 无处可查 | 工程壳 banner 记 `HAL <ver>`,取自 `Src/<前缀>_hal.c` 的 `__STM32<F>xx_HAL_VERSION_*`。C 源文件的头部不动,那里要与 CubeMX 逐字可比 |

### GPDMA / HPDMA:第二套 DMA 模型(未做)

H5/U3/U5/WBA/N6 的 DMA 不是 `控制器→流→请求叶`,结构完全不同,已勘明如下:

- 通道是顶层 XOR 模式 `ENABLE_GPDMACH<n>`(H5 有 8 个),每个下面再 XOR 出
  `SIMPLEREQUEST_` / `LINKEDLIST_` 两种;
- 请求不是模式叶子,而是 `REQUEST_GPDMACH<n>` 这个 list 参数的取值
  (163 个,`GPDMA1_REQUEST_USART1_TX` 这种命名);
- 每个通道有自己一整套参数命名空间(`SRCINC_GPDMACH0`、`DIRECTION_GPDMACH0`……
  约 30 个),HAL 结构体也不同(`Request`/`BlkHWRequest`/`SrcInc`/`DestInc`/
  `SrcDataWidth`… 13 个字段,不是 `PeriphInc`/`MemInc` 那套);
- 初始化调用树在 `GPDMA-STM32H5xx_Configs.xml` 的 `Init_GPDMACH<n>`(24 个
  RefConfig),`Instance` 是 FValue `GPDMA$Index_Channel0`,并按
  `SEM_CIRCULAR_*` / `SEM_REQ_PSSI_*` 等信号量分支到不同的 HAL 调用。

好消息是 codegen 那侧已经是通用的:`dma_init_field_order` 从 db 的 LibMethod 取字段
顺序,`msp_dma_init` 只是遍历 `params`。所以缺的是引擎侧的第二条发现/求解路径,
外加 `dma_init_field_order` 改成按实际服务实例取 config。

现状是**诚实的**:这五个家族列在 `DMA_UNMODELLED`,门禁每次实测校验它们确实拒绝
请求、其余家族确实接受 —— 名单不会悄悄过期。

### 求解器规模(未解决)

搜索的尾部(对目标无影响的自由变量)改成「取第一个合法值、不回溯」,把那一段
从域的乘积降成域的和 —— 一个深处不可行的变量原本会逼着重走前面所有组合。这治
好了 F3(>90 s → 0.1 s),但没治好根因:**每个搜索节点都要跑一次完整的传播定点**。
`RCC_ClkInitTypeDef` 里 PLLN 这类 500 值域的参数一乘,节点数就上到十万量级。
实测 G0 求 64 MHz 会耗尽 `MAX_VISITS` 后报 `CLK_UNSAT`,U5 求 160 MHz 十分钟不返回。
根治要做增量传播(只重算受赋值影响的子图)——留给后续。
