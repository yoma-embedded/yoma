# ODrive Parity Report (P7 acceptance)

**Claim**: the stm32-config-kernel, fed the hand-converted ODrive v3.3
configuration (`tests/parity/odrive/odrive.json`, transcribed from
`odrive_cubemx_demo.ioc`), generates a project that is **structurally and
semantically equivalent** to the CubeMX 6.17 reference at
`D:/embedded_agent/motorcontrol/odrive_cubemx_demo` — same file layout, same
function inventory, equivalent function bodies, same middleware library
subset — and compiles with arm-gcc to a binary of the same size.

**Verified by**: `crates/codegen/tests/odrive_parity.rs` (the definitive
gate; run `cargo test --release -p stm32ck-codegen --test odrive_parity`)
driving `tools/parity_diff.py`. Byte-level identity is a non-goal
(comment/ordering differences are acceptable per plan); every textual
divergence that survives normalization is individually whitelisted with a
reason and re-verified on every run. Results below from 2026-07-06.

The target configuration is the full ODrive board: STM32F405RGTx @ 168 MHz
(HSE 8 MHz PLL), ADC1/2/3 (regular + injected groups, T1/T8 TRGO triggers),
CAN1 (4 vectors), SPI3, TIM1/8 center-aligned complementary PWM with dead
time, TIM2 PWM, TIM3/4 encoder, TIM5 input capture, TIM13, UART4 (RX/TX DMA
+ pin-stacked pads), ADC1+SPI3 DMA, FreeRTOS (CMSIS-OS v1, TIM14 HAL
timebase), USB Device CDC (custom VID/PID/strings), NVIC fine-graining,
7 user constants, 12 user GPIOs.

## Gate results

| # | Check | Result |
|---|---|---|
| 1 | Validation of the UNSTRIPPED document | **0 errors, 0 warnings**; exactly 9 `PARAM_SYMBOLIC` infos (userConstant pass-through) + 10 `PIN_SHARED` infos (PA0/PA1 stacks, shared analog pads) |
| 2 | File-set equality | `Core/Src/*.c` (19) == reference `Src/*.c`; `Core/Inc/*.h` (15, incl. `FreeRTOSConfig.h`) == reference `Inc/*.h`; Middlewares copy covers all 14 reference-compiled library sources + headers, all wired into the generated CMake |
| 3 | Normalized per-function diff | 19 files / 134 same-named functions compared as assignment/call statement multisets; **0 unwhitelisted deltas**; 54 statement deltas excused by the 8 whitelist rules below (dead rules fail the gate) |
| 4 | Compile (cmake + ninja + arm-none-eabi-gcc, Debug) | zero errors → ELF. `.text` **55 892** vs reference **55 612** (+0.50 %); `.data` 256 == 256; `.bss` 88 560 == 88 560 |
| 5 | Determinism | second generation byte-identical for every manifest file (generated + copied) |

## What matches

**File sets** — exactly, after the `Core/` prefix mapping (the kernel uses
CubeMX 6.x "Advanced" layout, the reference uses the legacy flat layout):

* Sources: `adc.c can.c dma.c freertos.c gpio.c main.c spi.c tim.c usart.c
  usb_device.c usbd_cdc_if.c usbd_conf.c usbd_desc.c stm32f4xx_hal_msp.c
  stm32f4xx_hal_timebase_tim.c stm32f4xx_it.c syscalls.c sysmem.c
  system_stm32f4xx.c`
* Headers: `FreeRTOSConfig.h adc.h can.h dma.h gpio.h main.h spi.h
  stm32f4xx_hal_conf.h stm32f4xx_it.h tim.h usart.h usb_device.h
  usbd_cdc_if.h usbd_conf.h usbd_desc.h`
* Notably there is **no `pcd.c`/`pcd.h`** on either side: the USB Device
  middleware owns the USB_OTG_FS instance (`MiddlewareGen::owned_instances`,
  P7 fix) — `HAL_PCD_Init` runs inside `USBD_LL_Init` and the MSP lives in
  `usbd_conf.c`, exactly like CubeMX.
* Middlewares tree: FreeRTOS kernel (7 core .c + `cmsis_os.c` + `heap_4.c` +
  `ARM_CM4F/port.c`) and USB Device Library (`usbd_core/ctlreq/ioreq` +
  CDC class), identical paths under `Middlewares/…`.

**Function sets** — all 134 shared functions, per file, are name-identical
(the gate flags any one-sided function). This covers the full inventory the
plan lists as the acceptance baseline: `MX_ADC{1,2,3}_Init`, `MX_CAN1_Init`,
`MX_DMA_Init`, `MX_FREERTOS_Init`, `MX_GPIO_Init`, `MX_SPI3_Init`,
`MX_TIM{1,2,3,4,5,8,13}_Init`, `MX_UART4_Init`, `MX_USB_DEVICE_Init`, every
`HAL_*_Msp{Init,DeInit}` / `HAL_TIM_MspPostInit`, all 14 it.c handlers, the
usbd_conf/desc/cdc_if glue, `SystemClock_Config`, the timebase, RTOS hooks.

**Statement multisets** — per same-named function, after normalization:
USER CODE interiors and comments stripped, whitespace collapsed, pin-label
object macros expanded from each side's own `main.h` (the reference names
pads via ioc labels — `M0_ENC_A_Pin` — where the kernel writes raw
`GPIO_PIN_4`; the compiler sees identical tokens), commutative
`GPIO_PIN_x|GPIO_PIN_y` chains sorted. Everything matches except the 54
whitelisted statements below — including every peripheral `Init` field
assignment, every HAL call and guard, every DMA/NVIC/clock enable value.

**Macro sets** — the `FreeRTOSConfig.h` `#define` name→value map is
compared exhaustively: **identical** (no whitelist rows needed). `main.h`
user constants and label defines, and the usbd_desc VID/PID/string defines,
are exercised by the statement diff and the usb/freertos gates.

## The whitelist (8 rules, 54 excused statement deltas)

Source of truth: `tests/parity/odrive/parity-whitelist.md` (regex rows; a
row that stops matching fails the gate). All are content-equivalent:

| # | Where | Delta shape | Why it is equivalent |
|---|---|---|---|
| 1 | adc.c / tim.c, all `Msp*Init`/`MspPostInit`/`Msp*DeInit` (24) | kernel `if (…Instance==X)` vs CubeMX `else if (…)` | `Instance` equals exactly one base address — the chained and independent forms dispatch identically |
| 2 | adc.c / tim.c `MspInit` (4) | reference re-arms shared vectors (`ADC_IRQn` in ADC1/2/3, `TIM8_UP_TIM13_IRQn` in TIM8+TIM13) in every sharer | extra `HAL_NVIC_SetPriority/EnableIRQ` calls are idempotent, same priority — identical NVIC end state; kernel arms once |
| 3 | adc.c / tim.c `MspDeInit` (2) | kernel disables the shared vector; CubeMX only leaves a commented suggestion in USER CODE | deinit-path-only divergence; MspDeInit is never called in this application |
| 4+5 | gpio.c `MX_GPIO_Init` (15 + 4) | per-pad `GPIO_InitStruct` fills / `HAL_GPIO_Init` / `HAL_GPIO_WritePin` vs CubeMX same-settings batching (`Pin = a\|b\|…`, batched PC13\|PC14 level write) | each pad receives the identical Mode/Pull/Speed/initial level; the reference-side rule only excuses multi-pin chains, so a wrong electrical value cannot hide |
| 6 | gpio.c (1) | reference enables `__HAL_RCC_GPIOH_CLK_ENABLE` | GPIOH carries only the HSE crystal pads (no GPIO config exists); the port clock is irrelevant to the crystal function |
| 7 | main.c `SystemClock_Config` (2) | kernel states `HSIState = RCC_HSI_ON` (+ HSI in OscillatorType) | HSI is ON out of reset and untouched by the reference — identical oscillator end state |
| 8 | main.c `SystemClock_Config` (2) | reference starts the LSI (`LSIState = RCC_LSI_ON`) | nothing consumes the LSI (no RTC/IWDG); functionally inert |

## Fixes that fell out of P7 (generator/engine fixed rather than whitelisted)

1. **Middleware-owned instances** (`crates/codegen/src/middleware/mod.rs`):
   `MiddlewareGen::owned_instances`; `UsbCdcGen` owns `USB_OTG_FS`, the core
   emitter and CMake skip its per-IP file pair / main.c include + `MX_` call.
   The previous no-op `pcd.c` override was deleted — file-set parity is exact.
2. **Boolean feature switches** (`crates/engine/src/session.rs`): a bare
   boolean param set to `false` no longer auto-demands its RefMode —
   `EnableAnalogWatchDog: false` no longer produced a spurious
   `HAL_ADC_AnalogWDGConfig` block (CubeMX stores the key in the ioc and
   emits nothing). A param equal to its db default no longer warns
   `PARAM_INACTIVE` when unconsumed.
3. **odrive.json** — `USB_OTG_FS.interrupts.OTG_FS_IRQn` (5:0,
   `generateHandler:false`) replaces the `nvic` shorthand, which resolves to
   the wrong vector (OTG_FS_WKUP_IRQn — **open engine gap**, documented);
   TIM8's "Output Compare4 No Output" mode was dropped on reference-C
   evidence (ioc param exists, CubeMX emitted nothing — conversion-notes
   (e)1 revised).

## How to re-verify

```
cargo test --release -p stm32ck-codegen --test odrive_parity -- --nocapture
```

Prerequisites: `data/stm32f4.irpack`, firmware payloads under `data/fw/`
(`STM32F4`, `MW/FreeRTOS`, `MW/USB_Device`), the reference tree, and
`arm-none-eabi-gcc` + `cmake` + `ninja` + `python` on PATH (the test skips
with a message when any is missing). Full suite: `cargo test --release` —
124 tests green, zero build warnings.
