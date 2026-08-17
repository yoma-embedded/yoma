# ODrive 平价计划(v2 目标)

目标:内核生成的工程达到 `D:\embedded_agent\motorcontrol\odrive_cubemx_demo`(CubeMX 6.x,STM32F405RGTx,ODrive v3.3 配置)同等水平。"同等" = 相同文件布局、相同 MX_* 函数集合、语义等价的函数体、含 FreeRTOS/USB CDC 中间件、arm-gcc 编译通过。非目标:与参考工程字节级相同(注释/顺序差异可接受)。

## 参考工程清单(实测提取)

- **时钟**:HSE 8M → PLLM4/N168/P2/Q7 → SYSCLK 168M,APB1 /4=42M,APB2 /2=84M,USB 48M
- **外设**:ADC1/2/3(规则组+注入组,注入触发 T1_TRGO)、CAN1(4 个 IRQ)、SPI3、TIM1/8(中心对齐 CENTERALIGNED3、PWM2、CH1-3+CH1N-3N 互补、OC4 无输出、死区、TRGO)、TIM2/3/4(编码器类)、TIM5、TIM13、UART4、USB_OTG_FS
- **DMA**:UART4_RX/TX、ADC1(DMA2_Stream0 循环半字)、SPI3_RX/TX;`MX_DMA_Init` 集中开时钟+IRQ
- **中间件**:FreeRTOS(defaultTask 256 词/StartDefaultTask、heap 65536、栈溢出检查 1、idle hook;CMSIS-OS v1)+ USB Device CDC(自定义 VID 0x1209?/PID 0x0D32、厂商串 "ODrive Robotics")
- **结构**:外设文件分拆(adc.c/can.c/dma.c/gpio.c/spi.c/tim.c/usart.c + 同名 .h);`stm32f4xx_hal_timebase_tim.c`(RTOS 占用 SysTick,HAL 时基迁到 TIM14,IRQ 共享 TIM8_TRG_COM_TIM14);syscalls.c/sysmem.c;CMakePresets.json
- **函数清单**(平价验收基准):见 `Src/` 各文件 —— MX_ADC{1,2,3}ـInit、MX_CAN1_Init、MX_DMA_Init、MX_FREERTOS_Init、MX_GPIO_Init、MX_SPI3_Init、MX_TIM{1,2,3,4,5,8,13}_Init、MX_UART4_Init、MX_USB_DEVICE_Init、各 Msp{Init,DeInit}、it.c 14 个 handler

## 阶段划分

### P1 引擎语义修复(audit 四缺口中的 1/2 + 小 bug;一切的前置)
1. **默认值上黑板**:session 参数解析后,把每个活动 RefMode 参数的最终值(含默认)写入 scoped env 并发布其 PossibleValue 信号量(现只发布用户显式设置的)→ 修复 SPI FirstBit 误拒、硬件 NSS 静默错配、DMA 请求条件
2. **HAL 模块接线**:模块集合改为由「实际发射的 MX 函数所需 HAL 模块」推导(hal_mode → 模块名;无 hal_mode 时回退 IP 名映射 SPI→spi 等),四处联动:hal_conf 使能宏、include 块、HAL Src 复制、CMake 源列表
3. **实例数字提取**:`I2C1`→"1"(取末尾连续数字,不是过滤全部数字);修 bind_ident 与句柄命名
4. **GPIO 电气预设**:按信号 IOMode 对应 RefMode 的 GPIO_Speed_High_Default 等替代默认参数取速(SPI SCK/TIM 输出 → HIGH)
5. **空值字段发 0**:LibMethod 简单参数解析为空时,若字段在结构体中,发 `= 0;`(与 CubeMX 一致)而非跳过
验收:重放审计探测,SPI(F1/F4,含硬件 NSS)达 WORKS_VERIFIED;既有 94 测不回归。

### P2 通道机制(TIM/ADC 的解锁钥匙)
1. **配置文档 schema v2**:PeriphCfg 增加 `channels: {CH1: {mode-suffix or per-channel params}}`?决策:采用 CubeMX 语义——通道即模式树叶子(已可多选 mode),**通道参数用后缀键**:`params: {"Pulse-CH1": 500, "OCMode-CH1": "TIM_OCMODE_PWM2"}`,引擎在解析时把 `X-CHn` 映射到 db 的通道条件参数(db 用 `$Index`/通道信号量区分)
2. **通道式 ConfigForMode**:`OC_ConfigChannel_CH1` 类块 → 发射 `HAL_TIM_PWM_ConfigChannel(&htimX, &sConfigOC, TIM_CHANNEL_1)`,sConfig 结构体按通道参数填充;每通道一次调用,共享局部 sConfigOC(CubeMX 风格)
3. **信号量激活 RefMode**(ADC):模式树叶子(IN0 等)发布 `channelSelected$IpInstance` 后,引擎自动激活条件满足的 RefMode(RefMode.condition 求值为真且被 ConfigForMode 引用)→ ChannelRegularConversion/InjectedConversion 参数有家;**索引化多次配置**(Rank-0#、Rank-1#)v2 先支持每 ADC 规则组 N 通道 + 注入组 N 通道(schema:`regular: [{channel, rank, samplingTime}], injected: [{...}]`?)——决策:ADC 通道用显式列表字段而非后缀键(CubeMX ioc 也是索引式)
验收:TIM1 互补 PWM(死区/中心对齐/OC4)与 ADC1 规则+注入组的 MX 函数体与参考工程语义等价并编译。

### P3 DMA 端到端
schema:PeriphCfg 增 `dma: {"RX": {mode: circular|normal, priority, ...}}`;引擎:F4 流×通道矩阵分配(DMA IpDef 模式树)+冲突检查;codegen:MX_DMA_Init(dma.c:时钟+NVIC)、MSP 内 hdma 填充+`__HAL_LINKDMA`、it.c DMA handler、externs。验收:UART4 RX/TX DMA 与参考 dma.c/usart.c 等价。

### P4 结构平价
外设文件分拆为默认(adc.c/h 等,main.c 只留 SystemClock_Config/main/Error_Handler)、HAL 时基 TIM 选项(`project.halTimebase: "TIM14"` → stm32f4xx_hal_timebase_tim.c + NVIC)、syscalls/sysmem、CMakePresets.json、CAN 支持(bxcan Configs 已在 IR)、NVIC 优先级分组入口。

### P5 FreeRTOS
固件源:`STMicroelectronics/stm32_mw_freertos`(含 CMSIS_RTOS 包装)→ data/fw 扩展;schema:`middleware.freertos: {tasks: [...], heapSize, ...}`;生成:FreeRTOSConfig.h(参数映射)、freertos.c(任务+MX_FREERTOS_Init)、main.c 接 osKernelInitialize/Start、it.c SysTick/PendSV/SVC 让渡、强制 NVIC 分组 4 + 时基迁 TIM(与 P4 联动)、CMake/hal_conf 联动。ST 的 FREERTOS IpDef 已在 IR(F4 包 99 IP 含 FREERTOS),参数域可校验。

### P6 USB Device CDC
固件源:`STMicroelectronics/stm32_mw_usb_device`(Core + CDC)→ data/fw;schema:`middleware.usbDevice: {class: "CDC", vid, pid, strings...}`;生成:usb_device.c/h、usbd_conf.c(OTG_FS PCD 胶水)、usbd_desc.c(描述符注参)、usbd_cdc_if.c、USB_OTG_FS init + OTG_FS_IRQHandler、48MHz 时钟校验(引擎已会)、hal_conf PCD/USE_USB、CMake。

### P7 平价门(验收)✅ 完成(2026-07-06)
`tests/parity/odrive/`:内核配置文档(手工从 .ioc 转写)→ generate → (a) 函数清单集合相等;(b) 逐 MX 函数规范化 diff(去注释/空白/USER CODE 后字段赋值集合相等);(c) 全工程 arm-gcc 编译零 error;(d) 与参考工程 .map 的段大小同数量级。差异白名单文档化。

**结果**(定版测试 `crates/codegen/tests/odrive_parity.rs` + 工具 `tools/parity_diff.py`,报告 `docs/parity-report.md`):
1. **验证**:完整 odrive.json(含 middleware/halTimebase/DMA/NVIC/堆叠引脚)0 error、0 warning;9 条 PARAM_SYMBOLIC info(userConstants 透传)+ 10 条 PIN_SHARED info(PA0/PA1 堆叠 + 模拟共享焊盘)。
2. **文件集**:生成 `Core/Src/*.c`(19)== 参考 `Src/*.c`;`Core/Inc/*.h`(15,含 FreeRTOSConfig.h)== 参考 `Inc/*.h`;Middlewares 拷贝覆盖参考 CMake 编译的全部 FreeRTOS(10)+ USB(4)源文件且全部进入生成的 CMake。
3. **逐函数规范化 diff**:19 文件 / 134 个同名函数的赋值/调用行多重集比较;54 条语句级差异全部落入 8 条白名单规则(`tests/parity/odrive/parity-whitelist.md`,全部内容等价:else-if 链形、共享向量重复武装/去初始化、gpio.c 分焊盘 vs 合批、HSI/LSI 振荡器陈述、GPIOH 晶振口时钟),0 条未解释;白名单死行自动报错。
4. **编译**:cmake+ninja+arm-gcc 零 error 出 ELF;`.text` 55892 vs 参考 55612(+0.5%),`.data`/`.bss` 逐字节相同(256/88560)。
5. **确定性**:二次生成全部文件字节相同。

**P7 期间修复**:(a) odrive.json USB_OTG_FS 改用 `interrupts.OTG_FS_IRQn`(nvic 简写落错向量的引擎缺口仍开放、已记录);(b) 中间件占有实例机制(`MiddlewareGen::owned_instances`,USB CDC 占有 USB_OTG_FS → 核心不再发射 pcd.c/pcd.h/main.c 调用/CMake 条目,usb_device.rs 的 no-op pcd.c 覆盖删除,文件集精确平价);(c) 引擎:布尔特性开关为 false 不再自动激活其 RefMode(EnableAnalogWatchDog=false 不再发 AnalogWDG 块,与 CubeMX 一致),等于默认值的未消费参数不再 PARAM_INACTIVE;(d) TIM8 的 "Output Compare4 No Output" 依参考 C 证据从转写文档删除(ioc 参数存在但 CubeMX 未发射,见 conversion-notes (e)1 修订)。全套 124 测试绿。

## .ioc 转写暴露的补充缺口(2026-07-05,详见 tests/parity/odrive/conversion-notes.md)

- **用户常量**(归 P2):TIM 参数引用 `TIM_1_8_PERIOD_CLOCKS` 等符号(ioc 的 Mcu.UserConstants)。schema 增 `project.userConstants: {name: exprString}` → main.h 发 `#define`;codegen 对非字面量参数值原样透传(不做数值校验,发 warning 提示"符号值未经内核校验")
- **引脚堆叠**(归 P4):ODrive 故意双占 PA0=EXTI0+UART4_TX、PA1=GPIO_Input+UART4_RX。schema:GpioPinCfg 增 `allowSharedWith: ["UART4_TX"]` 或 pinout 全局 `sharedPads` 白名单;分配器对白名单引脚放行双占并发 info 诊断
- **NVIC 细粒度**(归 P4):`nvic` 顶层节:`priorityGroup`(默认 GROUP_4)、每向量覆盖表(CAN1 四向量、共享向量 ADC_IRQn/TIM8_UP_TIM13);halTimebase 的 IRQ 优先级随 `project.halTimebase` 一体生成(0,0)
- **DMA 无后缀请求键**(归 P3):`dma` 映射键允许整实例请求(ADC1 的请求名就是 "ADC1"):键 = 请求名去实例前缀后的剩余("RX"/"TX"/"" 空串或用 "_self")→ 决策:键直接用 db 请求名全称("ADC1"、"UART4_RX"),不再做前缀拆分,消除歧义
- ioc 不存 PLLP/AHB 分频/PLL 源(只有派生频率)→ P7 转写配置里显式补 PLLP=RCC_PLLP_DIV2 并以频率断言交叉验证

## 执行纪律

- 每阶段:实现 → 重放相关审计探测 → 全测试套 → 提交;不跨阶段积攒未验证工作
- 现有 94 测是回归底线;快照变更须逐个确认语义
- schema 变更保持向后兼容(v1 文档不带新字段仍然有效)
