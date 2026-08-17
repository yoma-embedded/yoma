# odrive.json conversion notes

Source: `D:\embedded_agent\motorcontrol\odrive_cubemx_demo\odrive_cubemx_demo.ioc` (CubeMX 6.17.0, FW_F4 V1.28.3).

> **P2 addendum (2026-07-06)** — the draft was updated to the schema P2 actually landed:
> 1. **ADC `regular`/`injected` lists dropped** in favor of `-{RefModeName}` suffix params
>    (`"Channel-ChannelRegularConversion"`, `"Rank-ChannelRegularConversion"`,
>    `"SamplingTime-ChannelRegularConversion"`, `"Channel-ChannelInjectedConversion"`,
>    `"InjectedRank-…"`, `"SamplingTime-…"`, `"InjectedOffset-…"`). The engine auto-activates
>    the non-tree RefModes (`ADC_Settings`, `ChannelRegularConversion`,
>    `ChannelInjectedConversion`) from these suffixes/bare settings — plan §P2's sketched list
>    fields were NOT needed for ODrive (single rank per group). Multi-rank (Rank-0#/Rank-1#
>    ioc indexing) remains unexpressible → deferred to P4/P7 as an indexed-suffix or list
>    extension.
> 2. **`project.userConstants` added** with the 7 `Mcu.UserConstants` entries (gap (a) row 1
>    closed). Params referencing them validate as symbolic pass-through (PARAM_SYMBOLIC info)
>    and main.h emits the `#define`s. NOTE: emission order is alphabetical (BTreeMap
>    determinism), not ioc order — constants that reference other constants still compile
>    because C `#define`s are order-independent at use site.
> 3. `PLLP`/`PLLSourceVirtual` added to `clock.assignments` earlier in P2 (see (b)1 — the
>    solver's HSI default would otherwise win).
> 4. **CAN1 dead UI keys dropped**: `TimeSeg1`/`TimeSeg2`/`AutoWakeUp` are CubeMX-UI aliases
>    with no RefParameter in the bxcan db (real names: `BS1`/`BS2`/`AWUM`). The reference
>    can.c proves `CAN1.AutoWakeUp=ENABLE` in the ioc was IGNORED by CubeMX itself
>    (`hcan1.Init.AutoWakeUp = DISABLE;` = AWUM default) — dropped, not translated.
> 5. **`APB2TimCLKDivider` dropped** from clock.assignments (UI-internal knob; RCC clock IR
>    pins the F4 timer multiplier at 2 — value 1 fails CLK_FACTOR, see (b)2 as predicted).
> 6. Hex Periods (`0xffff`, `0xFFFFFFFF`) kept verbatim — the kernel now parses C hex
>    literals for range validation and emits the user's spelling unchanged (matches
>    reference tim.c which emits `Period = 0xffff;`). JSON booleans now map to db
>    `"true"/"false"` literals (`EnableAnalogWatchDog: false` stays a JSON bool).
> Still not parseable (later phases): `dma` (P3), `nvic` on dma entries (P3),
> `middleware.freertos`/`usbDevice` (P5/P6), `project.halTimebase` (P4),
> stacked pads PA0/PA1 (P4). **Shared analog pads** (PA4/PA5/PA6/PC0-3/PC5 double-booked
> across ADC1/2/3) still PIN_UNSAT — same P4 pin-stacking mechanism. With middleware/dma/
> halTimebase stripped, PA0/PA1 gpio levels dropped and a single ADC, the whole draft
> validates CLEAN and the generated project compiles+links with arm-gcc (P2 exit check).
> **P4 addendum (2026-07-06)** — odrive.json updated to the shapes P4 actually landed
> (every edit below is now parsed & exercised by `crates/codegen/tests/parity_gate.rs`,
> which strips ONLY `middleware.*` and `peripherals.USB_OTG_FS` before validating):
> 1. **Pin stacking**: `gpio.PA0` gained `"sharedWith": ["UART4_TX"]`, `gpio.PA1`
>    `"sharedWith": ["UART4_RX"]` (schema decision: per-pad whitelist on the gpio entry,
>    not a global `sharedPads` — matches the SH.SharedStack model where the stack lives on
>    the pad). Analog pads (PA4/5/6, PC0-3, PC5 across ADC1/2/3) share implicitly, no
>    whitelist needed. The shared pad emits ONE GPIO config in the functional signal's
>    MspInit (mode/speed/AF from UART4, pull + label macros from the gpio entry —
>    reference usart.c `GPIO_1_Pin` + `GPIO_PULLDOWN` reproduced); gpio.c skips the pad.
>    Allocator emits `PIN_SHARED` info diags.
> 2. **NVIC fine-grained**: gap rows (a)3/(a)4 closed. Top-level
>    `"nvic": { "priorityGroup": "NVIC_PRIORITYGROUP_4", "systemHandlers": { "PendSV":
>    15:0, "SysTick": 15:0 } }` (priorityGroup default emits no call, matching reference
>    main.c; PendSV lands as `HAL_NVIC_SetPriority(PendSV_IRQn, 15, 0)` in HAL_MspInit;
>    SVCall/SysTick never get SetPriority — CubeMX quirk). Per-vector:
>    `CAN1.interrupts` = 4 vectors at 6:0 (replaces the single `nvic` block),
>    `TIM1.interrupts.TIM1_UP_TIM10_IRQn` 5:0 `generateHandler:false`,
>    `TIM8.interrupts` = TIM8_UP_TIM13 5:0 `generateHandler:false` +
>    TIM8_TRG_COM_TIM14 0:0 (the timebase-vector priority from the NVIC table row that
>    the plan flagged as "lost" — no longer lost). `generateHandler` moved onto NvicCfg
>    (DmaReqCfg.generateHandler kept as deprecated alias; ADC1's DMA entry unchanged).
> 3. **`project.initOrder` added** with the ioc `functionlistsort` rank order
>    (ADC1, ADC2, CAN1, TIM1, TIM8, TIM3, TIM4, SPI3, ADC3, TIM2, UART4, TIM5, TIM13) —
>    reproduces reference main.c exactly; without it the kernel default is
>    instance-sorted.
> 4. `project.halTimebase: "TIM14"` now parses: generates
>    `Core/Src/stm32f4xx_hal_timebase_tim.c` (APB1 variant, EnableIRQ-before-SetPriority
>    quirk kept), the shared `TIM8_TRG_COM_TIM14_IRQHandler` (htim8 then htim14),
>    `TICK_INT_PRIORITY 0U`, and `HAL_TIM_PeriodElapsedCallback` in main.c.
> 5. **File-set parity reached** (P4 gate): generated `Core/Src/*.c` ==
>    reference `Src/*.c` minus {freertos.c, usb_device.c, usbd_conf.c, usbd_desc.c,
>    usbd_cdc_if.c}; full draft (minus middleware/USB) validates CLEAN and
>    compiles+links with arm-gcc.
> Still not parseable (later phases): `middleware.freertos` / `middleware.usbDevice`
> (P5/P6) — the gate strips them; multi-rank ADC indexing (deferred, see P2 addendum).
> **P7 addendum (2026-07-06)** — the FULL draft (nothing stripped) now validates clean
> and passes the acceptance gate (`crates/codegen/tests/odrive_parity.rs`). Final edits:
> 1. **USB_OTG_FS `nvic` shorthand → `interrupts` map**: the single-`nvic` shorthand
>    resolves to the ip's first vector (OTG_FS_WKUP_IRQn — engine gap, still open);
>    the doc now names `OTG_FS_IRQn` explicitly (5:0 per NVIC table (d)) with
>    `generateHandler: false` (the USB middleware owns `OTG_FS_IRQHandler`).
> 2. **TIM8 "Output Compare4 No Output" DROPPED** — revising (e)1: the ioc carries the
>    `TIM8.Channel-Output Compare4 No Output` param but no VP pin, and the reference
>    tim.c proves CubeMX did NOT emit an OC4 block for TIM8 (no `HAL_TIM_OC_Init(&htim8)`,
>    no CH4 ConfigChannel). The reference C is the parity ground truth → mode removed.
> 3. `EnableAnalogWatchDog: false` is now a true no-op, matching CubeMX: a boolean
>    feature switch set to false no longer auto-demands its RefMode (WatchDog →
>    ADC_AnalogWDGConfig block), and a param set to its db default no longer warns
>    PARAM_INACTIVE when unconsumed. The reference adc.c has no watchdog block.
> All remaining generated-vs-reference text deltas are catalogued with reasons in
> `parity-whitelist.md` (8 rules, 54 excused statement deltas, all content-equivalent).

Target: current `config.rs` schema + planned extensions from `docs/odrive-parity-plan.md` §P2 (`X-CHn` suffix params, ADC `regular`/`injected` lists), §P3 (`PeriphCfg.dma`), §P4 (`project.halTimebase`), §P5/P6 (`middleware.freertos` / `middleware.usbDevice`). Fields `regular`, `injected`, `dma`, `middleware`, `project.halTimebase` do NOT parse with today's `deny_unknown_fields` schema — this doc is the P7 draft target.

## (a) ioc keys NOT expressible even with planned extensions (candidate schema gaps)

| ioc key(s) | value | why it has no home |
|---|---|---|
| `Mcu.UserConstants` | `TIM_1_8_CLOCK_HZ,168000000; TIM_1_8_PERIOD_CLOCKS,3500; TIM_1_8_DEADTIME_CLOCKS,20; TIM_APB1_CLOCK_HZ,84000000; TIM_APB1_PERIOD_CLOCKS,4096; TIM_APB1_DEADTIME_CLOCKS,40; TIM_1_8_RCR,2` | **Major.** No schema field for user constants. TIM1/2/8/13 params in odrive.json reference these symbols verbatim (incl. expressions `TIM_APB1_PERIOD_CLOCKS+1` and the TIM13 Period formula). Kernel needs a `project.userConstants` (emitted as #defines in main.h) or the params can't validate/generate. |
| `SH.SharedStack_PA0/PA1/PB8/PB9`, `PXn.Stacked=true` | PA0=GPIO_EXTI0 + UART4_TX; PA1=GPIO_Input + UART4_RX; PB8=CAN1_RX + I2C1_SCL; PB9=CAN1_TX + I2C1_SDA | **Pin stacking** (CubeMX 6.x): one pad, multiple stacked configs. No schema concept. odrive.json deliberately double-books PA0/PA1 (gpio map + UART4.pins) — current pin allocator will report a conflict. PB8/PB9 I2C1 stack level dropped entirely (I2C1 not in `Mcu.IPn` list, so only CAN1 side kept). |
| `NVIC.PriorityGroup` | `NVIC_PRIORITYGROUP_4` | No field. §P4 mentions "NVIC 优先级分组入口" but defines no shape. |
| `NVIC.CAN1_TX/RX0/RX1/SCE_IRQn` (4 vectors) | all `true:6:0` | `PeriphCfg.nvic` is a single block; cannot name individual vectors. Lossless here only because all 4 are identical. |
| Shared vectors: `NVIC.ADC_IRQn` (ADC1/2/3), `NVIC.TIM8_UP_TIM13_IRQn` (TIM8+TIM13), `NVIC.TIM1_UP_TIM10_IRQn` (TIM10 unused) | 5:0 each | No shared-vector concept; carried on one instance each (see NVIC table) — engine must not double-init. |
| `NVIC.TIM8_TRG_COM_TIM14_IRQn` | `true:0:0` (HAL timebase) | `project.halTimebase="TIM14"` carries the timer choice but NOT the timebase IRQ priority (0,0). |
| Cortex system handlers: `HardFault/BusFault/UsageFault/MemoryManagement/NonMaskableInt/DebugMonitor/SVCall` (0:0), `PendSV`/`SysTick` (**15**:0) | | No schema home; PendSV/SysTick=15 is FreeRTOS-mandated, others are defaults, but they are explicit ioc state. |
| NVIC value columns 4-10 (per-IRQ booleans: uses-FreeRTOS-fns / init-sequence / generate-enable / generate-handler / call-HAL-handler flags), `NVIC.ForceEnableDMAVector`, `NVIC.Saved*IrqHandlerGenerated` | see raw values in table (d) | `NvicCfg` only has enabled+priorities. The flag columns differ between IRQs (e.g. TIM1_UP_TIM10 `...:false:false:true:true:true` = no HAL call in handler) and affect it.c codegen. |
| `Dma.Request0..4` ordering | UART4_RX, UART4_TX, ADC1, SPI3_TX, SPI3_RX | Request index (init order inside MX_DMA_Init) dropped; BTreeMap ordering will differ. Cosmetic unless parity diff is order-sensitive. |
| `ADC1.master=1`, `ADCx.NbrOfConversionFlag=1`, ADC slot indices (`Rank-0#`, `-1#`; ADC3 uses `-7#`/`-8#`) | | CubeMX bookkeeping (multi-ADC master election, UI slot ids). Rank *values* kept in lists; slot ids dropped. |
| `ProjectManager.FirmwarePackage` | `STM32Cube FW_F4 V1.28.3` | No field to pin firmware version (candidate `project.firmwarePackage`). Also dropped: `CompilerOptimize=2`, `TargetToolchain=CMake`, `CompilerLinker=GCC`, `LibraryCopy=1`, `MainLocation=Src`, `functionlistsort` (init call order), `RegisterCallBack`, `KeepUserCode`, etc. |
| `Mcu.CPN=STM32F405RGT6`, `Mcu.Package=LQFP64`, `board=Odrive` | | Doc carries only `mcu.part` (STM32F405RGTx = Mcu.Name/UserName). |
| `USB_DEVICE.VirtualMode-CDC_FS=Cdc`, `VirtualModeFS=Cdc_FS` | | CubeMX-internal mode markers; class "CDC" + FS instance implied by middleware.usbDevice. Speed (FS vs HS) has no explicit field in planned shape. |
| Computed/UI-only keys (dropped by design) | `RCC.*Freq_Value`, `RCC.VCO*`, `CAN1.Calculate*`, `SPI3.CalculateBaudRate`, `SPI3.VirtualType`, `UART4.VirtualMode`, `USB_OTG_FS.VirtualMode`, `FREERTOS.FootprintOK`, `PCC.*`, `CAD.*`, `PinOutPanel.*`, `KeepUserPlacement`, `PXn.Locked`, `File/MxCube/MxDb.Version` | Derived or IDE bookkeeping; validation should recompute the Freq_Values. |

## (b) Assumptions / ambiguities

1. **PLLP, AHBCLKDivider, PLLSourceVirtual are NOT in the ioc** (`RCC.IPParameters` omits them → CubeMX defaults). Per "omit HAL defaults" rule they are omitted from `clock.assignments`. Derived cross-check: VCOInput 2 MHz = HSE 8M/PLLM 4 ⇒ **PLL source = HSE**; VCOOutput 336M → PLLCLK 168M ⇒ **PLLP = DIV2**; AHBFreq = SYSCLK ⇒ **AHB = DIV1**. If the solver's defaults differ (e.g. PLL source defaults to HSI), these three must be added explicitly. (The task brief assumed PLLP/AHB were present — they are not.)
2. `RCC.APB2TimCLKDivider=1` kept in assignments verbatim; possibly a UI-internal knob (F4 TIM clock is hardware ×2 rule), drop if the clock IR has no such parameter.
3. **schemaVersion left at 1** — plan calls the extended shape "schema v2" but also promises backward compat; bump when P2 lands.
4. **ADC modes/pins**: `SH.ADCx_INn` entries stack each analog pad onto 2-3 ADC instances (e.g. PA4 = ADC1_IN4 *and* ADC2_IN4). Reproduced as the same pad in multiple ADCs' `pins` maps; kernel must allow shared analog pads (ConfNb 2/3).
5. **ADC_IRQn carried on ADC1 only** (it is `master=1`); ADC2/3 have no nvic block to avoid triple-init of the shared vector.
6. **DMA map keys**: role suffix of the ioc requester ("RX"/"TX"); ADC1's requester has no suffix (`Dma.Request2=ADC1`) so keyed `"ADC1"` with `request` field verbatim in every entry — the planned schema must define the convention for suffix-less requesters. Values kept as verbatim HAL enums (plan sketch used friendly `circular|normal`). `nvic` inside each dma entry is an assumed extension (stream IRQs need a home; see table d).
7. **Channel-suffix normalization**: ioc uses three spellings — context keys (`OCMode_PWM-PWM\ Generation1\ CH1\ CH1N`), numeric suffix (`OCNPolarity_1`, `OCPolarity_3`), and `_CHn` (`ICFilter_CH3`). All normalized to the planned `-CHn` form keeping the ioc base name: `OCMode_PWM-CH1`, `OCNPolarity-CH1`, `OCPolarity-CH3`, `ICFilter-CH3`, `Pulse-CH4`. Context→channel mapping came from `TIMx.Channel-<context>=TIM_CHANNEL_n` keys (those binding keys themselves are then dropped as redundant with mode+suffix).
8. **Mode names verbatim from ioc** (`CAN_Activate`, `Full_Duplex_Master`, `Encoder_Interface`, `Input_Capture3_from_TI3`, `Enable_Timer`, `Internal`, `PWM Generation1 CH1 CH1N`, `Output Compare4 No Output`, `Device_Only`, `Asynchronous`) — must match db mode-tree leaf names.
9. **UART4 has NO BaudRate in the ioc** (`UART4.IPParameters=VirtualMode` only) → params omitted entirely; generator must emit the HAL/CubeMX default (115200 in reference usart.c). Not invented here.
10. Omitted-because-default (present in reference C but absent from ioc): TIM1/8 `Pulse` (=0), TIM1/8 CH4 OCMode (TIMING), TIM8 OCNPolarity (HIGH — note TIM1 *has* explicit OCNPolarity, TIM8 does not), SPI3 `CLKPolarity`, ADC per-pin GPIO settings, all GPIO_Speed values.
11. **Pad renames**: ioc pin names `PC13-ANTI_TAMP`→`PC13`, `PC14-OSC32_IN`→`PC14`, `PC15-OSC32_OUT`→`PC15`, `PA0-WKUP`→`PA0`, `PH0/PH1-OSC_IN/OUT`→HSE source.
12. **PA0 stacking split**: `GPIO_PuPd=GPIO_PULLDOWN` + label `GPIO_1` assigned to the gpio/EXTI stack level; UART4_TX level carries no pull. EXTI0 trigger edge not in ioc → schema default (rising) applies; **EXTI0_IRQn is NOT in the NVIC section** → no `nvic` on gpio.PA0 (vector disabled; ODrive enables it at runtime).
13. FreeRTOS task tuple `defaultTask,0,256,StartDefaultTask,Default,NULL,Dynamic,NULL,NULL` decoded as name/priority/stackSize(words)/entry/codeGen/parameter/allocation/buffer/controlBlock; priority `0` = osPriorityNormal in CMSIS-OS v1, stored verbatim. `heapSize` carries `configTOTAL_HEAP_SIZE`; remaining flags in a verbatim `config` map (shape beyond the plan's sketch). Linker heap `0x3C00`/stack `0x800` (ProjectManager) are separate from the FreeRTOS heap — both captured, don't conflate.
14. `USB_OTG_FS` kept as a peripheral (mode Device_Only, vbus_sensing_enable, DM/DP pins, OTG_FS_IRQn) while `USB_DEVICE` IP became `middleware.usbDevice` — the two are linked implicitly; plan P6 assumes the same split.
15. `power.vddMv=3300` from `PCC.Vdd=3.3`.
16. `debug: swd` from PA13/PA14 `Mode=Serial_Wire`.

## (c) Pin map (all 51 physical + 6 virtual pins)

| Pad | ioc signal | Label | Mode/electrical | Carried in JSON by |
|---|---|---|---|---|
| PC13 (ANTI_TAMP) | GPIO_Output | M0_nCS | out, PinState=SET | gpio.PC13 (initHigh) |
| PC14 (OSC32_IN) | GPIO_Output | M1_nCS | out, PinState=SET | gpio.PC14 (initHigh) |
| PC15 (OSC32_OUT) | GPIO_Input | M1_ENC_Z | input | gpio.PC15 |
| PH0 (OSC_IN) | RCC_OSC_IN | — | HSE crystal | clock.sources.HSE |
| PH1 (OSC_OUT) | RCC_OSC_OUT | — | HSE crystal | clock.sources.HSE |
| PC0 | ADCx_IN10 (ADC1+2+3) | M0_IB | analog | ADC1/2/3.pins.IN10 |
| PC1 | ADCx_IN11 (ADC1+2+3) | M0_IC | analog | ADC1/2/3.pins.IN11 |
| PC2 | ADCx_IN12 (ADC1+2+3) | M1_IC | analog | ADC1/2/3.pins.IN12 |
| PC3 | ADCx_IN13 (ADC1+2+3) | M1_IB | analog | ADC1/2/3.pins.IN13 |
| PA0 (WKUP) | **stack**: GPIO_EXTI0 + UART4_TX | GPIO_1 | pull-down | gpio.PA0 (exti) **and** UART4.pins.TX |
| PA1 | **stack**: GPIO_Input + UART4_RX | GPIO_2 | no-pull | gpio.PA1 **and** UART4.pins.RX |
| PA2 | S_TIM5_CH3 (IC from TI3) | GPIO_3 | AF | TIM5.pins.CH3 |
| PA3 | S_TIM5_CH4 (IC from TI4) | GPIO_4 | AF | TIM5.pins.CH4 |
| PA4 | ADCx_IN4 (ADC1+2) | M1_TEMP | analog | ADC1/2.pins.IN4 |
| PA5 | ADCx_IN5 (ADC1+2) | AUX_TEMP | analog | ADC1/2.pins.IN5 |
| PA6 | ADCx_IN6 (ADC1+2) | VBUS_S | analog | ADC1/2.pins.IN6 |
| PA7 | TIM8_CH1N | M1_AL | AF PWM compl. | TIM8.pins.CH1N |
| PC4 | GPIO_Input | GPIO_5 | input | gpio.PC4 |
| PC5 | ADCx_IN15 (ADC1+2) | M0_TEMP | analog | ADC1/2.pins.IN15 |
| PB0 | TIM8_CH2N | M1_BL | AF | TIM8.pins.CH2N |
| PB1 | TIM8_CH3N | M1_CL | AF | TIM8.pins.CH3N |
| PB2 | GPIO_Input | GPIO_6 | input | gpio.PB2 |
| PB10 | S_TIM2_CH3 | AUX_L | AF PWM | TIM2.pins.CH3 |
| PB11 | S_TIM2_CH4 | AUX_H | AF PWM | TIM2.pins.CH4 |
| PB12 | GPIO_Output | EN_GATE | out (init low) | gpio.PB12 |
| PB13 | TIM1_CH1N | M0_AL | AF | TIM1.pins.CH1N |
| PB14 | TIM1_CH2N | M0_BL | AF | TIM1.pins.CH2N |
| PB15 | TIM1_CH3N | M0_CL | AF | TIM1.pins.CH3N |
| PC6 | S_TIM8_CH1 | M1_AH | AF PWM | TIM8.pins.CH1 |
| PC7 | S_TIM8_CH2 | M1_BH | AF PWM | TIM8.pins.CH2 |
| PC8 | S_TIM8_CH3 | M1_CH | AF PWM | TIM8.pins.CH3 |
| PC9 | GPIO_Input | M0_ENC_Z | input | gpio.PC9 |
| PA8 | S_TIM1_CH1 | M0_AH | AF PWM | TIM1.pins.CH1 |
| PA9 | S_TIM1_CH2 | M0_BH | AF PWM | TIM1.pins.CH2 |
| PA10 | S_TIM1_CH3 | M0_CH | AF PWM | TIM1.pins.CH3 |
| PA11 | USB_OTG_FS_DM | — | Device_Only | USB_OTG_FS.pins.DM |
| PA12 | USB_OTG_FS_DP | — | Device_Only | USB_OTG_FS.pins.DP |
| PA13 | SYS_JTMS-SWDIO | — | Serial_Wire | debug: swd |
| PA14 | SYS_JTCK-SWCLK | — | Serial_Wire | debug: swd |
| PA15 | GPIO_Input | GPIO_7 | input | gpio.PA15 |
| PC10 | SPI3_SCK | — | Full_Duplex_Master | SPI3.pins.SCK |
| PC11 | SPI3_MISO | — | Full_Duplex_Master | SPI3.pins.MISO |
| PC12 | SPI3_MOSI | — | Full_Duplex_Master | SPI3.pins.MOSI |
| PD2 | GPIO_Input | nFAULT | pull-up | gpio.PD2 |
| PB3 | GPIO_Input | GPIO_8 | input | gpio.PB3 |
| PB4 | S_TIM3_CH1 | M0_ENC_A | encoder | TIM3.pins.CH1 |
| PB5 | S_TIM3_CH2 | M0_ENC_B | encoder | TIM3.pins.CH2 |
| PB6 | S_TIM4_CH1 | M1_ENC_A | encoder | TIM4.pins.CH1 |
| PB7 | S_TIM4_CH2 | M1_ENC_B | encoder | TIM4.pins.CH2 |
| PB8 | **stack**: CAN1_RX + I2C1_SCL | — | CAN_Activate | CAN1.pins.RX (I2C1 dropped) |
| PB9 | **stack**: CAN1_TX + I2C1_SDA | — | CAN_Activate | CAN1.pins.TX (I2C1 dropped) |
| VP_FREERTOS_VS_CMSIS_V1 | CMSIS_V1 | | | middleware.freertos.api |
| VP_SYS_VS_tim14 | TIM14 timebase | | | project.halTimebase |
| VP_TIM1_VS_ClockSourceINT | Internal | | | TIM1.mode "Internal" |
| VP_TIM1_VS_no_output4 | Output Compare4 No Output | | | TIM1.mode |
| VP_TIM13_VS_ClockSourceINT | Enable_Timer | | | TIM13.mode |
| VP_USB_DEVICE_VS_USB_DEVICE_CDC_FS | CDC_FS | | | middleware.usbDevice |

## (d) NVIC table (raw ioc value = enabled:preempt:sub:7 flags)

PriorityGroup = `NVIC_PRIORITYGROUP_4` (**not expressible**). `ForceEnableDMAVector=true`.

| IRQ | Pri (pre:sub) | Raw flags after pri | Carried by |
|---|---|---|---|
| ADC_IRQn | 5:0 | `false:false:true:true:true:true:true` | peripherals.ADC1.nvic (shared ADC1/2/3) |
| CAN1_TX_IRQn | 6:0 | `true:false:true:true:true:true:true` | peripherals.CAN1.nvic (one block for 4 vectors) |
| CAN1_RX0_IRQn | 6:0 | `true:false:true:true:true:true:true` | peripherals.CAN1.nvic |
| CAN1_RX1_IRQn | 6:0 | `true:false:true:true:true:true:true` | peripherals.CAN1.nvic |
| CAN1_SCE_IRQn | 6:0 | `true:false:true:true:true:true:true` | peripherals.CAN1.nvic |
| DMA1_Stream0_IRQn | 5:0 | `false:false:true:true:false:true:true` | SPI3.dma.RX.nvic |
| DMA1_Stream2_IRQn | 5:0 | `false:false:true:true:true:true:true` | UART4.dma.RX.nvic |
| DMA1_Stream4_IRQn | 5:0 | `false:false:true:true:false:true:true` | UART4.dma.TX.nvic |
| DMA1_Stream5_IRQn | 5:0 | `false:false:true:true:false:true:true` | SPI3.dma.TX.nvic |
| DMA2_Stream0_IRQn | 5:0 | `false:false:false:true:false:true:true` | ADC1.dma.ADC1.nvic |
| OTG_FS_IRQn | 5:0 | `false:false:true:true:true:true:true` | USB_OTG_FS.nvic |
| SPI3_IRQn | 5:0 | `false:false:true:true:true:true:true` | SPI3.nvic |
| TIM1_UP_TIM10_IRQn | 5:0 | `false:false:false:false:true:true:true` | TIM1.nvic (TIM10 unused) |
| TIM5_IRQn | 5:0 | `false:false:true:true:true:true:true` | TIM5.nvic |
| TIM8_TRG_COM_TIM14_IRQn | **0:0** | `false:false:true:false:false:true:true` | project.halTimebase (priority **lost** — gap) |
| TIM8_UP_TIM13_IRQn | 5:0 | `false:false:false:false:true:true:true` | TIM8.nvic (TIM13 shares vector, no own block) |
| UART4_IRQn | 5:0 | `false:false:true:true:true:true:true` | UART4.nvic |
| SysTick_IRQn | **15**:0 | `false:false:false:true:true:true:false` | not expressible (FreeRTOS) |
| PendSV_IRQn | **15**:0 | `false:false:false:true:true:false:false` | not expressible (FreeRTOS) |
| SVCall_IRQn | 0:0 | `false:false:false:false:true:false:false` | not expressible |
| HardFault / BusFault / UsageFault / MemoryManagement / NonMaskableInt / DebugMonitor | 0:0 | fault-handler defaults | not expressible |

`NVIC.TimeBase=TIM8_TRG_COM_TIM14_IRQn`, `NVIC.TimeBaseIP=TIM14` → `project.halTimebase="TIM14"` (confirms task brief).

## (e) ioc facts that contradict / refine the plan doc

1. **TIM8 OC4-no-output has params but no virtual pin**: `TIM8.Channel-Output Compare4 No Output=TIM_CHANNEL_4` exists, yet `Mcu.PinN` lists only `VP_TIM1_VS_no_output4` (no TIM8 counterpart). Plan §reference says both TIM1/8 have OC4 no-output — true at param level; a pin-list-driven importer would miss TIM8's. TIM8's mode list in odrive.json includes it from the param evidence.
2. **Clock-source virtual pins are inconsistent**: only TIM1 (`Internal`) and TIM13 (`Enable_Timer`) have ClockSource VPs; TIM2/3/4/5/8 have none despite being active. Mode activation can't rely on VP presence.
3. **PLLP / AHB divider / PLL source absent from ioc** — plan §reference states "PLLM4/N168/P2/Q7"; P2 is only *derivable* (VCO values), not stored. See (b)1.
4. Plan's "USB CDC 自定义 VID 0x1209?" — confirmed: `VID-CDC_FS=0x1209`, `PID_CDC_FS=0x0D32`, manufacturer "ODrive Robotics", product "ODrive v3.3", serial "000000000001". The `?` can be removed.
5. Plan §reference groups "TIM2/3/4(编码器类)" — TIM2 is actually center-aligned PWM (AUX_L/AUX_H on PB10/PB11, PWM2, OCPolarity_3 LOW, Pulse-CH4=Period+1); only TIM3/TIM4 are encoder interfaces.
6. Plan P3 sketches dma keys as roles ("RX") — ADC1's DMA request has **no role suffix** in the ioc; key convention needs a decision (see (b)6).
7. CAN1 "4 个 IRQ" (plan) is correct, but all four share prio 6:0 and the single-block `PeriphCfg.nvic` cannot represent them individually — works for parity only by coincidence of equal priorities.
8. UART4 carries **no BaudRate** in the ioc — parity diff of usart.c must treat 115200 as a default emission, not a doc-driven value.
9. FreeRTOS: plan says "defaultTask 256 词" — confirmed (256 words, priority 0 = osPriorityNormal, Dynamic allocation); `configUSE_IDLE_HOOK=1`, `configCHECK_FOR_STACK_OVERFLOW=1`, `INCLUDE_vTaskDelayUntil=1`, `INCLUDE_uxTaskGetStackHighWaterMark=1`, heap 65536 — all as plan assumed.
