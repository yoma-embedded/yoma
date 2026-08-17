# ODrive parity whitelist (P7)

Consumed by `tools/parity_diff.py` (driven by `crates/codegen/tests/odrive_parity.rs`).
Each row excuses ONE class of normalized per-function diff deltas between the
generated project and the CubeMX reference. Columns are Python regexes
(`file` and `function` must match fully, `line-pattern` is searched in the
delta description; write regex alternation `|` as `&#124;`, or match a
literal pipe with `.`). Rows that stop matching anything FAIL the run — dead
entries cannot rot here.

Delta descriptions have the shapes:

* `GEN_ONLY xN: <normalized statement>` — statement only in the generated function
* `REF_ONLY xN: <normalized statement>` — statement only in the reference function
* `FUNCTION_ONLY_IN_GENERATED <name>` / `FUNCTION_ONLY_IN_REFERENCE <name>`
* `DEFINE_*` — FreeRTOSConfig.h macro-map differences

Every entry is content-equivalent: identical register/HAL end state, only
the textual shape differs. Verified against the reference sources on
2026-07-06.

| file | function | line-pattern | reason |
|---|---|---|---|
| (adc&#124;tim)\.c | HAL_(ADC&#124;TIM)\w*_Msp\w*Init | ^(GEN_ONLY x\d+: if&#124;REF_ONLY x\d+: else if)\(\w+->Instance== | Instance-dispatch chain shape: CubeMX chains `else if`, the kernel emits independent `if` blocks. The compared conditions are mutually exclusive (`Instance` equals exactly one base address), so control flow is identical. |
| (adc&#124;tim)\.c | HAL_(ADC&#124;TIM)\w*_MspInit | ^REF_ONLY x\d+: HAL_NVIC_(SetPriority&#124;EnableIRQ)\((ADC_IRQn, 5, 0&#124;ADC_IRQn&#124;TIM8_UP_TIM13_IRQn, 5, 0&#124;TIM8_UP_TIM13_IRQn)\) | Shared-vector arming: CubeMX re-arms a shared NVIC vector in EVERY sharer's MspInit (ADC_IRQn in ADC1/2/3, TIM8_UP_TIM13_IRQn in TIM8 and TIM13); the kernel arms it once in the owning instance's MspInit. The extra calls are idempotent — same priority, same enable bit, same NVIC end state. |
| (adc&#124;tim)\.c | HAL_(ADC&#124;TIM)\w*_MspDeInit | ^GEN_ONLY x1: HAL_NVIC_DisableIRQ\((ADC_IRQn&#124;TIM8_UP_TIM13_IRQn)\) | Shared-vector deinit: CubeMX never disables a shared vector in MspDeInit (it only leaves a commented-out `HAL_NVIC_DisableIRQ` suggestion inside a USER CODE section); the kernel disables it in the owner's DeInit. Divergence exists only on the runtime deinit path, which this application never calls. |
| gpio\.c | MX_GPIO_Init | ^GEN_ONLY x\d+: (GPIO_InitStruct\.(Pin&#124;Mode&#124;Pull&#124;Speed) = &#124;HAL_GPIO_Init\(GPIO[A-K], &#124;HAL_GPIO_WritePin\(GPIO[A-K], GPIO_PIN_\d+, ) | Per-pad vs batched emission (generated side): the kernel configures each user GPIO pad with its own GPIO_InitStruct fill + HAL_GPIO_Init/WritePin; CubeMX batches same-settings pads of one port into a single call. Every pad receives the identical Mode/Pull/Speed/initial level either way — the reference-side counterpart row below pins the exact batched values. |
| gpio\.c | MX_GPIO_Init | ^REF_ONLY x1: (GPIO_InitStruct\.Pin = GPIO_PIN_\d+(.GPIO_PIN_\d+)+$&#124;HAL_GPIO_WritePin\(GPIOC, GPIO_PIN_13.GPIO_PIN_14, GPIO_PIN_SET\)) | Per-pad vs batched emission (reference side): only multi-pin `Pin = a|b|…` fills and the batched PC13|PC14 initial-level write are excused — single-pin fills and Mode/Pull/Speed values must still match exactly, so a wrong electrical setting cannot hide behind this row. |
| gpio\.c | MX_GPIO_Init | ^REF_ONLY x1: __HAL_RCC_GPIOH_CLK_ENABLE\(\)$ | CubeMX enables the GPIO port clock of the HSE crystal pads (PH0/PH1-OSC); the kernel emits port clocks only for pads it actually configures. The oscillator pads need no GPIO configuration — the port clock is irrelevant to the crystal function. |
| main\.c | SystemClock_Config | ^GEN_ONLY x1: RCC_OscInitStruct\.(OscillatorType = RCC_OSCILLATORTYPE_HSE.RCC_OSCILLATORTYPE_HSI$&#124;HSIState = RCC_HSI_ON$) | The kernel states the HSI explicitly (ON — its reset state) alongside HSE; the reference omits HSI from OscillatorType, leaving it untouched (also ON). Identical oscillator end state. |
| main\.c | SystemClock_Config | ^REF_ONLY x1: RCC_OscInitStruct\.(OscillatorType = RCC_OSCILLATORTYPE_LSI.RCC_OSCILLATORTYPE_HSE$&#124;LSIState = RCC_LSI_ON$) | CubeMX additionally starts the LSI (the ioc clock tree always shows the LSI branch); nothing in the project consumes it (no RTC, no IWDG), so the kernel does not emit it. Functionally inert 32 kHz oscillator. |
