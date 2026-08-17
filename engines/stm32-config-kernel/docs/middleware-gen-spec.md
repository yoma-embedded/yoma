# Middleware / Project-Structure Codegen Spec

Derived by full dissection of the CubeMX 6.17.0 (FW_F4 V1.28.3) reference project
`D:\embedded_agent\motorcontrol\odrive_cubemx_demo` (STM32F405RGTx, FreeRTOS CMSIS-v1,
USB Device CDC FS, TIM14 HAL timebase, per-peripheral file split, CMake toolchain).
Parameter source: `odrive_cubemx_demo.ioc`. Placeholders written `{{like_this}}`;
everything else in fenced blocks is byte-exact boilerplate (modulo the year in the ST
copyright header, which CubeMX stamps at generation time).

Conventions used below:

* `{{family}}` = `stm32f4xx`, `{{FAMILY}}` = `STM32F4xx`, `{{DEVICE}}` = `STM32F405xx`.
* "USER CODE section" = a `/* USER CODE BEGIN X */ ... /* USER CODE END X */` pair,
  emitted empty (one blank line between the markers) unless stated otherwise.
* Every generated file starts with the ST header comment wrapped in
  `/* USER CODE BEGIN Header */ ... /* USER CODE END Header */`.

---

## 1. FILE SPLIT (`ProjectManager.CoupleFile=true`)

Relevant .ioc keys:

| Key | Value here | Effect |
|---|---|---|
| `ProjectManager.CoupleFile` | `true` | one `Src/<ip>.c` + `Inc/<ip>.h` per IP category instead of everything in main.c |
| `ProjectManager.MainLocation` | `Src` | source dir name (`Src`/`Inc`, not `Core/Src`) |
| `ProjectManager.functionlistsort` | see §1.5 | order + call-site of the `MX_*_Init` calls |
| `ProjectManager.RegisterCallBack` | (empty) | `USE_HAL_PCD_REGISTER_CALLBACKS = 0U` etc. |
| `ProjectManager.LibraryCopy` | `1` | copy only needed HAL/middleware files into project tree |
| `ProjectManager.HeapSize` / `StackSize` | `0x3C00` / `0x800` | linker script `_Min_Heap_Size` / `_Min_Stack_Size` |

File inventory produced by the split (application side):

| File | Contains |
|---|---|
| `Src/gpio.c` / `Inc/gpio.h` | `MX_GPIO_Init` only (no handles, no Msp) |
| `Src/dma.c` / `Inc/dma.h` | `MX_DMA_Init` only: DMA controller clocks + DMA stream NVIC (no handles!) |
| `Src/adc.c` / `Inc/adc.h` | `hadc1..3`, `hdma_adc1`, `MX_ADCx_Init`, `HAL_ADC_MspInit/DeInit` |
| `Src/can.c` / `Inc/can.h` | `hcan1`, `MX_CAN1_Init`, `HAL_CAN_MspInit/DeInit` |
| `Src/spi.c` / `Inc/spi.h` | `hspi3`, `hdma_spi3_tx/rx`, `MX_SPI3_Init`, `HAL_SPI_MspInit/DeInit` |
| `Src/tim.c` / `Inc/tim.h` | `htim1,2,3,4,5,8,13`, `MX_TIMx_Init`, all `HAL_TIM_*_MspInit/DeInit`, **`HAL_TIM_MspPostInit`** |
| `Src/usart.c` / `Inc/usart.h` | `huart4`, `hdma_uart4_rx/tx`, `MX_UART4_Init`, `HAL_UART_MspInit/DeInit` |
| `Src/main.c` | `main()`, `SystemClock_Config()`, `HAL_TIM_PeriodElapsedCallback()` (timebase), `Error_Handler()`, `assert_failed()` |
| `Src/stm32f4xx_hal_msp.c` | `HAL_MspInit()` only (SYSCFG/PWR clocks + PendSV priority) |
| `Src/stm32f4xx_it.c` / `Inc/stm32f4xx_it.h` | fault handlers + per-IRQ handlers (see §2.4) |
| `Src/freertos.c` | see §2.2 |
| `Src/stm32f4xx_hal_timebase_tim.c` | see §3 |
| `Src/usb_device.c`, `usbd_conf.c`, `usbd_desc.c`, `usbd_cdc_if.c` (+ `Inc/*.h`) | see §4 |
| `Src/syscalls.c`, `Src/sysmem.c`, `Src/system_stm32f4xx.c` | static templates (§5) |
| `Inc/main.h` | pin `#define`s + `Mcu.UserConstants` defines + `Error_Handler` proto |
| `Inc/stm32f4xx_hal_conf.h`, `Inc/FreeRTOSConfig.h` | parameterized config headers |

**Key rule — DMA handle ownership:** `DMA_HandleTypeDef hdma_<periph>_<dir>` objects are
defined in the *owning peripheral's* .c file (e.g. `hdma_adc1` in `adc.c`, `hdma_spi3_tx`
in `spi.c`, `hdma_uart4_rx` in `usart.c`) and initialized inside that peripheral's
`HAL_<IP>_MspInit`, linked with `__HAL_LINKDMA(handle, hdmarx/hdmatx/DMA_Handle, hdma_x)`.
`dma.c` only enables `__HAL_RCC_DMAx_CLK_ENABLE()` and sets/enables the stream IRQs.
`dma.h` contains a comment line `/* DMA memory to memory transfer handles ----...*/`
(empty section — only used for MemToMem transfers).

**DMA channel note:** the .ioc `Dma.*` blocks carry `Instance` (stream) but *not* the
channel. `hdma_x.Init.Channel` (e.g. `DMA_CHANNEL_4` for UART4, `DMA_CHANNEL_0` for
ADC1/SPI3) comes from the F4 request-mux table (request → stream/channel), which the
codegen must own as a static database.

### 1.1 Peripheral `.c` skeleton (all of adc/can/spi/tim/usart)

```c
/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    {{ip}}.c
  * @brief   This file provides code for the configuration
  *          of the {{IP}} instances.
  ******************************************************************************
  * ... ST copyright block ...
  ******************************************************************************
  */
/* USER CODE END Header */
/* Includes ------------------------------------------------------------------*/
#include "{{ip}}.h"

/* USER CODE BEGIN 0 */

/* USER CODE END 0 */

{{IP}}_HandleTypeDef h{{instance_lower}};          /* one per instance, no blank line between */
DMA_HandleTypeDef hdma_{{instance_lower}}_{{dir}}; /* owned DMA handles follow the IP handles */

/* {{INSTANCE}} init function */
void MX_{{INSTANCE}}_Init(void)
{

  /* USER CODE BEGIN {{INSTANCE}}_Init 0 */

  /* USER CODE END {{INSTANCE}}_Init 0 */

  /* local config-struct declarations, e.g. ADC_ChannelConfTypeDef sConfig = {0}; */

  /* USER CODE BEGIN {{INSTANCE}}_Init 1 */

  /* USER CODE END {{INSTANCE}}_Init 1 */
  h{{instance_lower}}.Instance = {{INSTANCE}};
  /* ... Init fields from ioc {{INSTANCE}}.* keys ... */
  if (HAL_{{IP}}_Init(&h{{instance_lower}}) != HAL_OK)
  {
    Error_Handler();
  }
  /* ... channel / master / breakdeadtime config blocks, each wrapped in
         if (HAL_...(...) != HAL_OK) { Error_Handler(); } ... */
  /* USER CODE BEGIN {{INSTANCE}}_Init 2 */

  /* USER CODE END {{INSTANCE}}_Init 2 */
  HAL_TIM_MspPostInit(&h{{instance_lower}});   /* TIM with AF output pins only — see §1.4 */

}

void HAL_{{IP}}_MspInit({{IP}}_HandleTypeDef* {{ip}}Handle)
{

  GPIO_InitTypeDef GPIO_InitStruct = {0};      /* only if pins are configured here */
  if({{ip}}Handle->Instance=={{INSTANCE}})
  {
  /* USER CODE BEGIN {{INSTANCE}}_MspInit 0 */

  /* USER CODE END {{INSTANCE}}_MspInit 0 */
    /* {{INSTANCE}} clock enable */
    __HAL_RCC_{{INSTANCE}}_CLK_ENABLE();

    __HAL_RCC_GPIOx_CLK_ENABLE();
    /**{{INSTANCE}} GPIO Configuration
    PXn     ------> SIGNAL
    */
    GPIO_InitStruct.Pin = ...;               /* uses <label>_Pin macros from main.h when the pin has a label */
    ...
    HAL_GPIO_Init(GPIOx, &GPIO_InitStruct);

    /* {{INSTANCE}} DMA Init (if any) — hdma init + __HAL_LINKDMA */

    /* {{INSTANCE}} interrupt Init */
    HAL_NVIC_SetPriority({{IRQn}}, {{prio}}, {{sub}});
    HAL_NVIC_EnableIRQ({{IRQn}});
  /* USER CODE BEGIN {{INSTANCE}}_MspInit 1 */

  /* USER CODE END {{INSTANCE}}_MspInit 1 */
  }
  else if(...next instance...)
  { ... }
}

void HAL_{{IP}}_MspDeInit({{IP}}_HandleTypeDef* {{ip}}Handle)
{
  /* mirror: CLK_DISABLE, HAL_GPIO_DeInit, HAL_DMA_DeInit(handle->hdmarx/tx),
     HAL_NVIC_DisableIRQ; shared IRQs get a commented-out DisableIRQ inside a
     USER CODE "{{INSTANCE}}:{{IRQn}} disable" section instead */
}

/* USER CODE BEGIN 1 */

/* USER CODE END 1 */
```

Notes:
* NVIC priority numbers inside MspInit come from the `NVIC.<IRQn>` ioc key fields 2–3
  (e.g. `NVIC.SPI3_IRQn=true\:5\:0\:...` → `HAL_NVIC_SetPriority(SPI3_IRQn, 5, 0)`).
* When an IRQ is shared between instances (ADC_IRQn, TIM8_UP_TIM13_IRQn), the MspDeInit
  emits the "Uncomment the line below to disable" commented block quoted above.
* `gpio.c`/`dma.c` differ: after `#include` they have `USER CODE 0`, then a banner
  (`/*---.../* Configure GPIO */...---*/` resp. `/* Configure DMA */`), `USER CODE 1`,
  the single `MX_GPIO_Init`/`MX_DMA_Init` function, then `USER CODE 2`. `MX_GPIO_Init`
  body = GPIO port clock enables (in pin-discovery order), `HAL_GPIO_WritePin` initial
  levels for outputs, then one `HAL_GPIO_Init` block per (port, mode, pull, speed) group.

### 1.2 Peripheral `.h` skeleton (identical shape for gpio/adc/can/dma/spi/tim/usart)

```c
/* USER CODE BEGIN Header */
/**
  ******************************************************************************
  * @file    {{ip}}.h
  * @brief   This file contains all the function prototypes for
  *          the {{ip}}.c file
  ******************************************************************************
  * ... ST copyright block ...
  ******************************************************************************
  */
/* USER CODE END Header */
/* Define to prevent recursive inclusion -------------------------------------*/
#ifndef __{{IP}}_H__
#define __{{IP}}_H__

#ifdef __cplusplus
extern "C" {
#endif

/* Includes ------------------------------------------------------------------*/
#include "main.h"

/* USER CODE BEGIN Includes */

/* USER CODE END Includes */

extern {{IP}}_HandleTypeDef h{{instance_lower}};   /* one extern per instance,
                                                      blank line BETWEEN externs */

/* USER CODE BEGIN Private defines */

/* USER CODE END Private defines */

void MX_{{INSTANCE}}_Init(void);                    /* one per instance, no blank lines */

void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim);  /* tim.h ONLY */

/* USER CODE BEGIN Prototypes */

/* USER CODE END Prototypes */

#ifdef __cplusplus
}
#endif

#endif /* __{{IP}}_H__ */
```

Header-guard details (verbatim quirks):
* Guard is `__GPIO_H__`, `__ADC_H__`, `__CAN_H__`, `__DMA_H__`, `__SPI_H__`, `__TIM_H__`, `__USART_H__`.
* `gpio.h` closes with the typo'd comment `#endif /*__ GPIO_H__ */` and has **no** blank
  line between `#endif` variants; the others close `#endif /* __X_H__ */` after a blank line.
* `dma.h` additionally contains the line
  `/* DMA memory to memory transfer handles -------------------------------------*/`
  directly after `#include "main.h"` (before `USER CODE Includes`).
* DMA handles are **not** externed anywhere; `stm32f4xx_it.c` re-declares them locally
  as `extern` (see §2.4). Only IP handles get externs in their headers.

### 1.3 `main.c` — includes and init-call order (verbatim from reference)

```c
#include "main.h"
#include "cmsis_os.h"
#include "adc.h"
#include "can.h"
#include "dma.h"
#include "spi.h"
#include "tim.h"
#include "usart.h"
#include "usb_device.h"
#include "gpio.h"
```

Rules: `main.h` first, `cmsis_os.h` second (only when FreeRTOS enabled), then coupled
headers alphabetically **except `gpio.h`, which always comes last**. `usb_device.h` is
included even though `MX_USB_DEVICE_Init` is not called from `main()`.

`main()` body (verbatim; USER CODE sections omitted here are: `1`, `Init`, `SysInit`,
`2`, `WHILE`, `3`):

```c
int main(void)
{

  /* USER CODE BEGIN 1 */

  /* USER CODE END 1 */

  /* MCU Configuration--------------------------------------------------------*/

  /* Reset of all peripherals, Initializes the Flash interface and the Systick. */
  HAL_Init();

  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* Configure the system clock */
  SystemClock_Config();

  /* USER CODE BEGIN SysInit */

  /* USER CODE END SysInit */

  /* Initialize all configured peripherals */
  MX_GPIO_Init();
  MX_DMA_Init();
  MX_ADC1_Init();
  MX_ADC2_Init();
  MX_CAN1_Init();
  MX_TIM1_Init();
  MX_TIM8_Init();
  MX_TIM3_Init();
  MX_TIM4_Init();
  MX_SPI3_Init();
  MX_ADC3_Init();
  MX_TIM2_Init();
  MX_UART4_Init();
  MX_TIM5_Init();
  MX_TIM13_Init();
  /* USER CODE BEGIN 2 */

  /* USER CODE END 2 */

  /* Call init function for freertos objects (in cmsis_os2.c) */
  MX_FREERTOS_Init();

  /* Start scheduler */
  osKernelStart();

  /* We should never get here as control is now taken by the scheduler */

  /* Infinite loop */
  /* USER CODE BEGIN WHILE */
  while (1)
  {
    /* USER CODE END WHILE */

    /* USER CODE BEGIN 3 */
  }
  /* USER CODE END 3 */
}
```

Private prototypes in main.c (before `main`):

```c
void SystemClock_Config(void);
void MX_FREERTOS_Init(void);
```

### 1.4 `ProjectManager.functionlistsort` — the init-order source of truth

```
ProjectManager.functionlistsort=1-MX_GPIO_Init-GPIO-false-HAL-true,2-MX_DMA_Init-DMA-false-HAL-true,
3-MX_ADC1_Init-ADC1-false-HAL-true, ... 12-SystemClock_Config-RCC-false-HAL-true, ...
14-MX_USB_DEVICE_Init-USB_DEVICE-false-HAL-false, ...
```

Format per entry: `<rank>-<function>-<ip>-<static?>-<HAL|LL>-<visible/called-in-main>`.
* Entries with trailing `true` are emitted in `main()` in rank order — **except**
  `SystemClock_Config` (rank 12 here), which is always emitted at its fixed slot right
  after `HAL_Init()`, not in the peripheral list. Result: peripheral call order in
  `main()` = rank order with the SystemClock_Config entry removed (matches §1.3).
* `MX_USB_DEVICE_Init` has trailing `false` → NOT called from `main()`; with FreeRTOS
  present it is called from the default task instead (§4.5).

`HAL_TIM_MspPostInit` (single function, if/else-if chain over instances) lives at the
end of `tim.c`, prototype in `tim.h`. It is called as the **last statement** of
`MX_TIMx_Init` (after `USER CODE ..._Init 2`) only for timers whose channel pins are
alternate-function *outputs* configured post-init (TIM1, TIM2, TIM8 here). Encoder/IC
timers (TIM3/4/5) configure pins in their `HAL_TIM_*_MspInit` instead. Body per timer:
GPIO clock enables + `HAL_GPIO_Init` blocks (no NVIC, no timer clock).

### 1.5 `main.h`

Guard `__MAIN_H`; includes only `#include "{{family}}_hal.h"`; exports
`void Error_Handler(void);`; then under `/* Private defines */`:
first the `Mcu.UserConstants` as `#define NAME VALUE` lines (verbatim from ioc key
`Mcu.UserConstants=TIM_1_8_CLOCK_HZ,168000000;...` → `#define TIM_1_8_CLOCK_HZ 168000000`),
then one `#define <label>_Pin GPIO_PIN_n` / `#define <label>_GPIO_Port GPIOx` pair per
labeled pin (ioc `PXn.GPIO_Label`), in pin-scan order. USER CODE sections: `Includes`,
`ET`, `EC`, `EM`, `EFP`, `Private defines`.

---

## 2. FreeRTOS (CMSIS-RTOS v1, kernel V10.3.1, wrapper cmsis_os.c V1.02)

.ioc keys consumed:

| ioc key | Value | Consumed by |
|---|---|---|
| `Mcu.IPx=FREERTOS`, `VP_FREERTOS_VS_CMSIS_V1.Mode=CMSIS_V1` | — | selects v1 wrapper + all of §2 |
| `FREERTOS.Tasks01` | `defaultTask,0,256,StartDefaultTask,Default,NULL,Dynamic,NULL,NULL` | freertos.c task defs |
| `FREERTOS.configTOTAL_HEAP_SIZE` | `65536` | FreeRTOSConfig.h |
| `FREERTOS.configUSE_IDLE_HOOK` | `1` | FreeRTOSConfig.h + hook stub |
| `FREERTOS.configCHECK_FOR_STACK_OVERFLOW` | `1` | FreeRTOSConfig.h + hook stub |
| `FREERTOS.INCLUDE_vTaskDelayUntil` | `1` | FreeRTOSConfig.h |
| `FREERTOS.INCLUDE_uxTaskGetStackHighWaterMark` | `1` | FreeRTOSConfig.h |
| `FREERTOS.FootprintOK` | `true` | GUI-only, ignore |
| (no `FREERTOS.HEAP_NUMBER` key) | default | heap_4.c (default memory scheme) |

`FREERTOS.Tasks01` field order:
`name, priority(0=osPriorityNormal), stackSize(words), entryFunction, codegenMode(Default|Weak|External), parameter, allocation(Dynamic|Static), bufferName, controlBlockName`.

### 2.1 `Inc/FreeRTOSConfig.h` — full skeleton

Header comment is the FreeRTOS/Amazon MIT license block wrapped in
`USER CODE BEGIN/END Header`. Then, verbatim (ioc-driven values marked):

```c
#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

/*  ... standard "Application specific definitions" comment block ... */

/* USER CODE BEGIN Includes */
/* Section where include file can be added */
/* USER CODE END Includes */

/* Ensure definitions are only used by the compiler, and not by the assembler. */
#if defined(__ICCARM__) || defined(__CC_ARM) || defined(__GNUC__)
  #include <stdint.h>
  extern uint32_t SystemCoreClock;
#endif
#define configENABLE_FPU                         0
#define configENABLE_MPU                         0

#define configUSE_PREEMPTION                     1
#define configSUPPORT_STATIC_ALLOCATION          1
#define configSUPPORT_DYNAMIC_ALLOCATION         1
#define configUSE_IDLE_HOOK                      {{FREERTOS.configUSE_IDLE_HOOK}}
#define configUSE_TICK_HOOK                      0
#define configCPU_CLOCK_HZ                       ( SystemCoreClock )
#define configTICK_RATE_HZ                       ((TickType_t)1000)
#define configMAX_PRIORITIES                     ( 7 )
#define configMINIMAL_STACK_SIZE                 ((uint16_t)128)
#define configTOTAL_HEAP_SIZE                    ((size_t){{FREERTOS.configTOTAL_HEAP_SIZE}})
#define configMAX_TASK_NAME_LEN                  ( 16 )
#define configUSE_16_BIT_TICKS                   0
#define configUSE_MUTEXES                        1
#define configQUEUE_REGISTRY_SIZE                8
#define configCHECK_FOR_STACK_OVERFLOW           {{FREERTOS.configCHECK_FOR_STACK_OVERFLOW}}
#define configUSE_PORT_OPTIMISED_TASK_SELECTION  1
/* USER CODE BEGIN MESSAGE_BUFFER_LENGTH_TYPE */
/* Defaults to size_t for backward compatibility, but can be changed
   if lengths will always be less than the number of bytes in a size_t. */
#define configMESSAGE_BUFFER_LENGTH_TYPE         size_t
/* USER CODE END MESSAGE_BUFFER_LENGTH_TYPE */

/* Co-routine definitions. */
#define configUSE_CO_ROUTINES                    0
#define configMAX_CO_ROUTINE_PRIORITIES          ( 2 )

/* Set the following definitions to 1 to include the API function, or zero
to exclude the API function. */
#define INCLUDE_vTaskPrioritySet             1
#define INCLUDE_uxTaskPriorityGet            1
#define INCLUDE_vTaskDelete                  1
#define INCLUDE_vTaskCleanUpResources        0
#define INCLUDE_vTaskSuspend                 1
#define INCLUDE_vTaskDelayUntil              {{FREERTOS.INCLUDE_vTaskDelayUntil}}
#define INCLUDE_vTaskDelay                   1
#define INCLUDE_xTaskGetSchedulerState       1
#define INCLUDE_uxTaskGetStackHighWaterMark  {{FREERTOS.INCLUDE_uxTaskGetStackHighWaterMark}}

/* Cortex-M specific definitions. */
#ifdef __NVIC_PRIO_BITS
 /* __BVIC_PRIO_BITS will be specified when CMSIS is being used. */
 #define configPRIO_BITS         __NVIC_PRIO_BITS
#else
 #define configPRIO_BITS         4
#endif

/* The lowest interrupt priority that can be used in a call to a "set priority"
function. */
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY   15

/* The highest interrupt priority that can be used by any interrupt service
routine that makes calls to interrupt safe FreeRTOS API functions.  DO NOT CALL
INTERRUPT SAFE FREERTOS API FUNCTIONS FROM ANY INTERRUPT THAT HAS A HIGHER
PRIORITY THAN THIS! (higher priorities are lower numeric values. */
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5

/* Interrupt priorities used by the kernel port layer itself.  These are generic
to all Cortex-M ports, and do not rely on any particular library functions. */
#define configKERNEL_INTERRUPT_PRIORITY 		( configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS) )
/* !!!! configMAX_SYSCALL_INTERRUPT_PRIORITY must not be set to zero !!!!
See http://www.FreeRTOS.org/RTOS-Cortex-M3-M4.html. */
#define configMAX_SYSCALL_INTERRUPT_PRIORITY 	( configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS) )

/* Normal assert() semantics without relying on the provision of an assert.h
header file. */
/* USER CODE BEGIN 1 */
#define configASSERT( x ) if ((x) == 0) {taskDISABLE_INTERRUPTS(); for( ;; );}
/* USER CODE END 1 */

/* Definitions that map the FreeRTOS port interrupt handlers to their CMSIS
standard names. */
#define vPortSVCHandler    SVC_Handler
#define xPortPendSVHandler PendSV_Handler

/* IMPORTANT: This define is commented when used with STM32Cube firmware, when the timebase source is SysTick,
              to prevent overwriting SysTick_Handler defined within STM32Cube HAL */

#define xPortSysTickHandler SysTick_Handler

/* USER CODE BEGIN Defines */
/* Section where parameter definitions can be added (for instance, to override default ones in FreeRTOS.h) */
/* USER CODE END Defines */

#endif /* FREERTOS_CONFIG_H */
```

Static vs derived classification:

| Macro | Class |
|---|---|
| `configUSE_IDLE_HOOK`, `configUSE_TICK_HOOK`, `configCHECK_FOR_STACK_OVERFLOW`, `configTOTAL_HEAP_SIZE`, `INCLUDE_vTaskDelayUntil`, `INCLUDE_uxTaskGetStackHighWaterMark` | ioc-driven (`FREERTOS.*`; only keys the user changed from GUI default appear in the .ioc — absent key = the default shown above) |
| `configUSE_PREEMPTION`, `configTICK_RATE_HZ`, `configMAX_PRIORITIES`, `configMINIMAL_STACK_SIZE`, `configMAX_TASK_NAME_LEN`, `configUSE_16_BIT_TICKS`, `configUSE_MUTEXES`, `configQUEUE_REGISTRY_SIZE`, `configUSE_PORT_OPTIMISED_TASK_SELECTION`, `configSUPPORT_*_ALLOCATION`, `configUSE_CO_ROUTINES`, `configMAX_CO_ROUTINE_PRIORITIES`, remaining `INCLUDE_*` | GUI-default boilerplate, ioc-overridable via same `FREERTOS.<name>` mechanism |
| `configCPU_CLOCK_HZ = ( SystemCoreClock )` | fixed derivation (never a literal) |
| `configENABLE_FPU/MPU=0`, `configPRIO_BITS` block, `configLIBRARY_LOWEST_INTERRUPT_PRIORITY=15`, `configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY=5`, `configKERNEL_INTERRUPT_PRIORITY`, `configMAX_SYSCALL_INTERRUPT_PRIORITY` | static boilerplate (15 = 2^configPRIO_BITS − 1 for the family) |
| `configASSERT` | static, but inside `USER CODE 1` |
| `vPortSVCHandler`/`xPortPendSVHandler` aliases | always emitted |
| `xPortSysTickHandler SysTick_Handler` | emitted **uncommented** because timebase ≠ SysTick (§3). If timebase were SysTick it is emitted commented out. |
| `configMESSAGE_BUFFER_LENGTH_TYPE` | static, inside its own USER CODE section |

### 2.2 `Src/freertos.c` anatomy (full skeleton)

```c
/* USER CODE BEGIN Header */
/**  ... File Name: freertos.c / Description: Code for freertos applications ... */
/* USER CODE END Header */

/* Includes ------------------------------------------------------------------*/
#include "FreeRTOS.h"
#include "task.h"
#include "main.h"
#include "cmsis_os.h"

/* Private includes ----------------------------------------------------------*/
/* USER CODE BEGIN Includes */        ... standard PTD/PD/PM sections follow ...

/* Private variables ---------------------------------------------------------*/
/* USER CODE BEGIN Variables */

/* USER CODE END Variables */
osThreadId {{taskName}}Handle;                       /* one per FREERTOS.TasksNN entry */

/* Private function prototypes -----------------------------------------------*/
/* USER CODE BEGIN FunctionPrototypes */

/* USER CODE END FunctionPrototypes */

void {{entryFn}}(void const * argument);             /* one per task */

extern void MX_USB_DEVICE_Init(void);                /* ONLY because USB init is deferred to a task */
void MX_FREERTOS_Init(void); /* (MISRA C 2004 rule 8.1) */

/* GetIdleTaskMemory prototype (linked to static allocation support) */
void vApplicationGetIdleTaskMemory( StaticTask_t **ppxIdleTaskTCBBuffer, StackType_t **ppxIdleTaskStackBuffer, uint32_t *pulIdleTaskStackSize );

/* Hook prototypes */
void vApplicationIdleHook(void);                     /* iff configUSE_IDLE_HOOK == 1 */
void vApplicationStackOverflowHook(xTaskHandle xTask, signed char *pcTaskName);
                                                     /* iff configCHECK_FOR_STACK_OVERFLOW >= 1 */

/* USER CODE BEGIN 2 */
__weak void vApplicationIdleHook( void )
{
   /* vApplicationIdleHook() will only be called if configUSE_IDLE_HOOK is set
   to 1 in FreeRTOSConfig.h. ... (long stock comment) ... */
}
/* USER CODE END 2 */

/* USER CODE BEGIN 4 */
__weak void vApplicationStackOverflowHook(xTaskHandle xTask, signed char *pcTaskName)
{
   /* Run time stack overflow checking is performed if
   configCHECK_FOR_STACK_OVERFLOW is defined to 1 or 2. This hook function is
   called if a stack overflow is detected. */
}
/* USER CODE END 4 */

/* USER CODE BEGIN GET_IDLE_TASK_MEMORY */
static StaticTask_t xIdleTaskTCBBuffer;
static StackType_t xIdleStack[configMINIMAL_STACK_SIZE];

void vApplicationGetIdleTaskMemory( StaticTask_t **ppxIdleTaskTCBBuffer, StackType_t **ppxIdleTaskStackBuffer, uint32_t *pulIdleTaskStackSize )
{
  *ppxIdleTaskTCBBuffer = &xIdleTaskTCBBuffer;
  *ppxIdleTaskStackBuffer = &xIdleStack[0];
  *pulIdleTaskStackSize = configMINIMAL_STACK_SIZE;
  /* place for user code */
}
/* USER CODE END GET_IDLE_TASK_MEMORY */

void MX_FREERTOS_Init(void) {
  /* USER CODE BEGIN Init */

  /* USER CODE END Init */

  /* USER CODE BEGIN RTOS_MUTEX */
  /* add mutexes, ... */
  /* USER CODE END RTOS_MUTEX */

  /* USER CODE BEGIN RTOS_SEMAPHORES */
  /* add semaphores, ... */
  /* USER CODE END RTOS_SEMAPHORES */

  /* USER CODE BEGIN RTOS_TIMERS */
  /* start timers, add new ones, ... */
  /* USER CODE END RTOS_TIMERS */

  /* USER CODE BEGIN RTOS_QUEUES */
  /* add queues, ... */
  /* USER CODE END RTOS_QUEUES */

  /* Create the thread(s) */
  /* definition and creation of {{taskName}} */
  osThreadDef({{taskName}}, {{entryFn}}, osPriority{{prio}}, 0, {{stackWords}});
  {{taskName}}Handle = osThreadCreate(osThread({{taskName}}), NULL);

  /* USER CODE BEGIN RTOS_THREADS */
  /* add threads, ... */
  /* USER CODE END RTOS_THREADS */

}

/* USER CODE BEGIN Header_{{entryFn}} */
/** @brief  Function implementing the {{taskName}} thread. ... */
/* USER CODE END Header_{{entryFn}} */
void {{entryFn}}(void const * argument)
{
  /* init code for USB_DEVICE */
  MX_USB_DEVICE_Init();                    /* OUTSIDE user code, first statement */
  /* USER CODE BEGIN {{entryFn}} */
  /* Infinite loop */
  for(;;)
  {
    osDelay(1);
  }
  /* USER CODE END {{entryFn}} */
}

/* Private application code --------------------------------------------------*/
/* USER CODE BEGIN Application */

/* USER CODE END Application */
```

Hook generation rules: prototypes are unconditional-looking but only emitted when the
corresponding config macro ≠ 0; the `__weak` stub bodies are emitted inside `USER CODE 2`
(idle) and `USER CODE 4` (stack overflow). The static-idle-task memory block is emitted
inside `USER CODE GET_IDLE_TASK_MEMORY` because `configSUPPORT_STATIC_ALLOCATION=1`.
Priority mapping for `FREERTOS.Tasks01` field 2: `0 → osPriorityNormal` (v1 enum;
-3=Idle,-2=Low,-1=BelowNormal,0=Normal,1=AboveNormal,2=High,3=Realtime).

### 2.3 main.c integration (CMSIS v1 — verbatim, already shown in §1.3)

* `#include "cmsis_os.h"` second include.
* Prototype `void MX_FREERTOS_Init(void);` in main.c.
* After the `MX_*_Init` block + `USER CODE 2`:
  comment `/* Call init function for freertos objects (in cmsis_os2.c) */` (yes, it
  says cmsis_os2.c even for v1 — stock CubeMX text), `MX_FREERTOS_Init();`,
  `/* Start scheduler */`, `osKernelStart();`.
* **No `osKernelInitialize()`** — that's v2-only.

### 2.4 `stm32f4xx_it.c` deltas under FreeRTOS + TIM timebase

Handlers **ABSENT** from it.c/it.h (owned elsewhere):

| Handler | Owner |
|---|---|
| `SVC_Handler` | FreeRTOS port.c via `#define vPortSVCHandler SVC_Handler` |
| `PendSV_Handler` | FreeRTOS port.c via `#define xPortPendSVHandler PendSV_Handler` |
| `SysTick_Handler` | FreeRTOS port.c via `#define xPortSysTickHandler SysTick_Handler` |

There is **no** `SysTick_Handler` calling `osSystickHandler()` anywhere in this project.
That pattern only appears when FreeRTOS + SysTick-as-HAL-timebase are combined; here the
HAL tick is TIM14, so CubeMX deletes all three system handlers from it.c and lets the
port own SysTick outright. (`HAL_IncTick` is driven by TIM14, §3.)

it.c structure: standard header, includes `#include "main.h"` + `#include "stm32f4xx_it.h"`,
USER CODE sections (Includes/TD/PD/PM/PV/PFP/0), then the extern block (order as generated):

```c
/* External variables --------------------------------------------------------*/
extern PCD_HandleTypeDef hpcd_USB_OTG_FS;
extern ADC_HandleTypeDef hadc1;
extern ADC_HandleTypeDef hadc2;
extern ADC_HandleTypeDef hadc3;
extern CAN_HandleTypeDef hcan1;
extern DMA_HandleTypeDef hdma_spi3_tx;
extern DMA_HandleTypeDef hdma_spi3_rx;
extern SPI_HandleTypeDef hspi3;
extern TIM_HandleTypeDef htim5;
extern TIM_HandleTypeDef htim8;
extern DMA_HandleTypeDef hdma_uart4_rx;
extern DMA_HandleTypeDef hdma_uart4_tx;
extern UART_HandleTypeDef huart4;
extern TIM_HandleTypeDef htim14;

/* USER CODE BEGIN EV */

/* USER CODE END EV */
```

(Only handles actually referenced by a generated handler are externed.)

Cortex section (always generated): `NMI_Handler` (`while(1)` inside its USER CODE 1
section), `HardFault_Handler`, `MemManage_Handler`, `BusFault_Handler`,
`UsageFault_Handler` (each `while (1) { USER CODE W1_... }`), `DebugMon_Handler` (empty).

Peripheral handler pattern:

```c
/**
  * @brief This function handles {{description from vector table}}.
  */
void {{IRQ}}_IRQHandler(void)
{
  /* USER CODE BEGIN {{IRQn}} 0 */

  /* USER CODE END {{IRQn}} 0 */
  HAL_{{IP}}_IRQHandler(&h{{instance}});     /* one line per mapped handle */
  /* USER CODE BEGIN {{IRQn}} 1 */

  /* USER CODE END {{IRQn}} 1 */
}
```

Handlers generated here (in this order): `DMA1_Stream0` (→`hdma_spi3_rx`),
`DMA1_Stream2` (→`hdma_uart4_rx`), `DMA1_Stream4` (→`hdma_uart4_tx`),
`DMA1_Stream5` (→`hdma_spi3_tx`), `ADC` (→hadc1, hadc2, hadc3 — three calls),
`CAN1_TX`/`CAN1_RX0`/`CAN1_RX1`/`CAN1_SCE` (each →`hcan1`),
`TIM8_TRG_COM_TIM14` (→`htim8` then `htim14`), `TIM5`, `SPI3`, `UART4`,
`OTG_FS` (→`HAL_PCD_IRQHandler(&hpcd_USB_OTG_FS)`).

Handlers *enabled in NVIC but with no it.c function* (per-IRQ "generate handler" flag
off in ioc): `DMA2_Stream0`, `TIM1_UP_TIM10`, `TIM8_UP_TIM13`. Codegen must honor this
flag or the vector falls through to `Default_Handler`.

### 2.5 NVIC ioc keys — system handlers + flag decoding

```
NVIC.PriorityGroup=NVIC_PRIORITYGROUP_4
NVIC.SVCall_IRQn=true\:0\:0\:false\:false\:false\:false\:true\:false\:false
NVIC.PendSV_IRQn=true\:15\:0\:false\:false\:false\:true\:true\:false\:false
NVIC.SysTick_IRQn=true\:15\:0\:false\:false\:false\:true\:true\:true\:false
NVIC.SavedPendsvIrqHandlerGenerated=true
NVIC.SavedSvcallIrqHandlerGenerated=true
NVIC.SavedSystickIrqHandlerGenerated=true
```

Value format (10 `\:`-separated fields):
`enabled : preemptionPrio : subPrio : f4 : f5 : generateHandlerInIt.c : f7 : f8 : f9 : f10`.
Field 6 is verified across all 25 NVIC lines in the reference: it is `true` exactly for
the IRQs that have a function in it.c (faults included) and `false` for SVCall/PendSV/
SysTick (FreeRTOS-owned), DMA2_Stream0, TIM1_UP_TIM10, TIM8_UP_TIM13. Fields 2–3 feed
every `HAL_NVIC_SetPriority` call. The `Saved*IrqHandlerGenerated=true` keys record the
pre-FreeRTOS checkbox state (restore-on-disable); emit them verbatim when FreeRTOS is on.
PendSV priority 15 additionally produces `HAL_NVIC_SetPriority(PendSV_IRQn, 15, 0);` in
`HAL_MspInit()` (stm32f4xx_hal_msp.c) — SVCall and SysTick get **no** SetPriority call.

`HAL_MspInit` verbatim body:

```c
void HAL_MspInit(void)
{

  /* USER CODE BEGIN MspInit 0 */

  /* USER CODE END MspInit 0 */

  __HAL_RCC_SYSCFG_CLK_ENABLE();
  __HAL_RCC_PWR_CLK_ENABLE();

  /* System interrupt init*/
  /* PendSV_IRQn interrupt configuration */
  HAL_NVIC_SetPriority(PendSV_IRQn, 15, 0);

  /* USER CODE BEGIN MspInit 1 */

  /* USER CODE END MspInit 1 */
}
```

### 2.6 CMake additions for FreeRTOS (`cmake/stm32cubemx/CMakeLists.txt`)

Include dirs appended to `MX_Include_Dirs`:

```
Middlewares/Third_Party/FreeRTOS/Source/include
Middlewares/Third_Party/FreeRTOS/Source/CMSIS_RTOS
Middlewares/Third_Party/FreeRTOS/Source/portable/GCC/ARM_CM4F
```

New OBJECT library `FreeRTOS` (added to `MX_LINK_LIBS`) with sources:

```
FreeRTOS/Source/croutine.c
FreeRTOS/Source/event_groups.c
FreeRTOS/Source/list.c
FreeRTOS/Source/queue.c
FreeRTOS/Source/stream_buffer.c
FreeRTOS/Source/tasks.c
FreeRTOS/Source/timers.c
FreeRTOS/Source/CMSIS_RTOS/cmsis_os.c          # v1 wrapper
FreeRTOS/Source/portable/MemMang/heap_4.c      # heap scheme: heap_4 (ioc default; no key emitted)
FreeRTOS/Source/portable/GCC/ARM_CM4F/port.c
```

`Src/freertos.c` is appended to `MX_Application_Src` (after gpio.c, see full list §6).
Copied library payload = the whole `Middlewares/Third_Party/FreeRTOS/Source` tree
(kernel V10.3.1) incl. `include/`, `CMSIS_RTOS/cmsis_os.[ch]`, `portable/GCC/ARM_CM4F/`,
`portable/MemMang/heap_4.c`, `LICENSE`.

---

## 3. TIM timebase (`VP_SYS_VS_tim14`, `NVIC.TimeBase=TIM8_TRG_COM_TIM14_IRQn`, `NVIC.TimeBaseIP=TIM14`)

.ioc keys: `Mcu.Pin52=VP_SYS_VS_tim14`, `VP_SYS_VS_tim14.Mode=TIM14`,
`VP_SYS_VS_tim14.Signal=SYS_VS_tim14`, `NVIC.TimeBase`, `NVIC.TimeBaseIP`,
`NVIC.TIM8_TRG_COM_TIM14_IRQn=true\:0\:0\:...` (priority 0!).

### 3.1 `Src/stm32f4xx_hal_timebase_tim.c` — full anatomy

Overrides the three `__weak` functions from `stm32f4xx_hal.c`. Parameterization is
purely textual on `{{TIMn}}` (=TIM14) and `{{TIM_IRQn}}` (=TIM8_TRG_COM_TIM14_IRQn);
the APB bus selection (`APB1CLKDivider` / `HAL_RCC_GetPCLK1Freq`) follows the timer's
bus — for an APB2 timer CubeMX emits `APB2CLKDivider`/`GetPCLK2Freq` instead.

```c
/* Includes ------------------------------------------------------------------*/
#include "stm32f4xx_hal.h"
#include "stm32f4xx_hal_tim.h"

/* Private variables ---------------------------------------------------------*/
TIM_HandleTypeDef        htim14;        /* handle DEFINED here, externed in it.c */

HAL_StatusTypeDef HAL_InitTick(uint32_t TickPriority)
{
  RCC_ClkInitTypeDef    clkconfig;
  uint32_t              uwTimclock, uwAPB1Prescaler = 0U;

  uint32_t              uwPrescalerValue = 0U;
  uint32_t              pFLatency;

  HAL_StatusTypeDef     status;

  /* Enable TIM14 clock */
  __HAL_RCC_TIM14_CLK_ENABLE();

  /* Get clock configuration */
  HAL_RCC_GetClockConfig(&clkconfig, &pFLatency);

  /* Get APB1 prescaler */
  uwAPB1Prescaler = clkconfig.APB1CLKDivider;
  /* Compute TIM14 clock */
  if (uwAPB1Prescaler == RCC_HCLK_DIV1)
  {
    uwTimclock = HAL_RCC_GetPCLK1Freq();
  }
  else
  {
    uwTimclock = 2UL * HAL_RCC_GetPCLK1Freq();
  }

  /* Compute the prescaler value to have TIM14 counter clock equal to 1MHz */
  uwPrescalerValue = (uint32_t) ((uwTimclock / 1000000U) - 1U);

  /* Initialize TIM14 */
  htim14.Instance = TIM14;

  htim14.Init.Period = (1000000U / 1000U) - 1U;
  htim14.Init.Prescaler = uwPrescalerValue;
  htim14.Init.ClockDivision = 0;
  htim14.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim14.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;

  status = HAL_TIM_Base_Init(&htim14);
  if (status == HAL_OK)
  {
    /* Start the TIM time Base generation in interrupt mode */
    status = HAL_TIM_Base_Start_IT(&htim14);
    if (status == HAL_OK)
    {
    /* Enable the TIM14 global Interrupt */
        HAL_NVIC_EnableIRQ(TIM8_TRG_COM_TIM14_IRQn);
      /* Configure the SysTick IRQ priority */
      if (TickPriority < (1UL << __NVIC_PRIO_BITS))
      {
        /* Configure the TIM IRQ priority */
        HAL_NVIC_SetPriority(TIM8_TRG_COM_TIM14_IRQn, TickPriority, 0U);
        uwTickPrio = TickPriority;
      }
      else
      {
        status = HAL_ERROR;
      }
    }
  }

 /* Return function status */
  return status;
}

void HAL_SuspendTick(void)
{
  /* Disable TIM14 update Interrupt */
  __HAL_TIM_DISABLE_IT(&htim14, TIM_IT_UPDATE);
}

void HAL_ResumeTick(void)
{
  /* Enable TIM14 Update interrupt */
  __HAL_TIM_ENABLE_IT(&htim14, TIM_IT_UPDATE);
}
```

Quirks to reproduce exactly: `EnableIRQ` is called **before** `SetPriority` (stock ST
template ordering), and this file contains **no** period-elapsed callback and **no**
direct `uwTick` increment.

### 3.2 The tick increment lives in **main.c**

`HAL_TIM_IRQHandler(&htim14)` (from it.c, §3.3) dispatches the update event to the
common weak callback, which CubeMX overrides at the bottom of `main.c`:

```c
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  /* USER CODE BEGIN Callback 0 */

  /* USER CODE END Callback 0 */
  if (htim->Instance == TIM14)
  {
    HAL_IncTick();
  }
  /* USER CODE BEGIN Callback 1 */

  /* USER CODE END Callback 1 */
}
```

(Emitted between `USER CODE 4` and `Error_Handler`; doc-comment above it names TIM14.)

### 3.3 it.c handler (shared vector — verbatim)

```c
void TIM8_TRG_COM_TIM14_IRQHandler(void)
{
  /* USER CODE BEGIN TIM8_TRG_COM_TIM14_IRQn 0 */

  /* USER CODE END TIM8_TRG_COM_TIM14_IRQn 0 */
  HAL_TIM_IRQHandler(&htim8);
  HAL_TIM_IRQHandler(&htim14);
  /* USER CODE BEGIN TIM8_TRG_COM_TIM14_IRQn 1 */

  /* USER CODE END TIM8_TRG_COM_TIM14_IRQn 1 */
}
```

Because TIM8 shares the vector, `tim.c`'s `HAL_TIM_PWM_MspInit(TIM8)` also does
`HAL_NVIC_SetPriority(TIM8_TRG_COM_TIM14_IRQn, 0, 0); HAL_NVIC_EnableIRQ(...)`
(priority 0 from the NVIC key — the timebase priority wins for the shared vector).

### 3.4 Side effects elsewhere

| File | Delta vs SysTick timebase |
|---|---|
| `Inc/stm32f4xx_hal_conf.h` | `#define TICK_INT_PRIORITY 0U` (SysTick default template value is 15U); `USE_RTOS 0U` stays 0 always |
| `Src/main.c` | gains `HAL_TIM_PeriodElapsedCallback` (§3.2). Nothing else changes; `HAL_Init()` call unchanged (it calls the overridden `HAL_InitTick(TICK_INT_PRIORITY)`) |
| `Src/stm32f4xx_it.c` | no `SysTick_Handler`; shared `TIM8_TRG_COM_TIM14_IRQHandler`; `extern TIM_HandleTypeDef htim14;` |
| CMake | `Src/stm32f4xx_hal_timebase_tim.c` added to `MX_Application_Src`; `stm32f4xx_hal_tim.c`/`_tim_ex.c` guaranteed in `STM32_Drivers_Src` |
| `Inc/stm32f4xx_hal_conf.h` | `HAL_TIM_MODULE_ENABLED` (needed by timebase even if no other TIM used) |

---

## 4. USB Device CDC (FS) — `Mcu.IP18=USB_DEVICE`, `Mcu.IP19=USB_OTG_FS`, `VP_USB_DEVICE_VS_USB_DEVICE_CDC_FS.Mode=CDC_FS`

.ioc keys and where they land:

| ioc key | Value | Lands in |
|---|---|---|
| `USB_DEVICE.CLASS_NAME_FS` | `CDC` | selects Class/CDC library + usbd_cdc_if files |
| `USB_DEVICE.VID-CDC_FS` | `0x1209` | `usbd_desc.c: #define USBD_VID 0x1209` |
| `USB_DEVICE.PID_CDC_FS` | `0x0D32` | `usbd_desc.c: #define USBD_PID_FS 0x0D32` |
| `USB_DEVICE.MANUFACTURER_STRING-CDC_FS` | `ODrive Robotics` | `#define USBD_MANUFACTURER_STRING "ODrive Robotics"` |
| `USB_DEVICE.PRODUCT_STRING_CDC_FS` | `ODrive v3.3` | `#define USBD_PRODUCT_STRING_FS "ODrive v3.3"` |
| `USB_DEVICE.SERIALNUMBER_STRING_CDC_FS` | `000000000001` | **NOWHERE** — see §4.2 |
| `USB_DEVICE.APP_RX_DATA_SIZE-CDC_FS` | `64` | `usbd_cdc_if.h: #define APP_RX_DATA_SIZE 64` |
| `USB_DEVICE.APP_TX_DATA_SIZE-CDC_FS` | `64` | `usbd_cdc_if.h: #define APP_TX_DATA_SIZE 64` |
| `USB_OTG_FS.VirtualMode` | `Device_Only` | PA11/PA12 AF10, PCD `phy_itface = PCD_PHY_EMBEDDED` |
| `USB_OTG_FS.vbus_sensing_enable` | `DISABLE` | `usbd_conf.c: hpcd.Init.vbus_sensing_enable = DISABLE;` |
| `NVIC.OTG_FS_IRQn` | `true\:5\:0\:...` | `HAL_PCD_MspInit` NVIC calls + it.c handler |

### 4.1 `Src/usb_device.c` / `Inc/usb_device.h`

No VID/PID/strings here — pure init sequence. usb_device.c includes:
`usb_device.h, usbd_core.h, usbd_desc.h, usbd_cdc.h, usbd_cdc_if.h`; defines
`USBD_HandleTypeDef hUsbDeviceFS;`; USER CODE sections `Includes, PV, PFP, 0, 1,
USB_DEVICE_Init_PreTreatment, USB_DEVICE_Init_PostTreatment`. Core function verbatim:

```c
void MX_USB_DEVICE_Init(void)
{
  /* USER CODE BEGIN USB_DEVICE_Init_PreTreatment */

  /* USER CODE END USB_DEVICE_Init_PreTreatment */

  /* Init Device Library, add supported class and start the library. */
  if (USBD_Init(&hUsbDeviceFS, &FS_Desc, DEVICE_FS) != USBD_OK)
  {
    Error_Handler();
  }
  if (USBD_RegisterClass(&hUsbDeviceFS, &USBD_CDC) != USBD_OK)
  {
    Error_Handler();
  }
  if (USBD_CDC_RegisterInterface(&hUsbDeviceFS, &USBD_Interface_fops_FS) != USBD_OK)
  {
    Error_Handler();
  }
  if (USBD_Start(&hUsbDeviceFS) != USBD_OK)
  {
    Error_Handler();
  }

  /* USER CODE BEGIN USB_DEVICE_Init_PostTreatment */

  /* USER CODE END USB_DEVICE_Init_PostTreatment */
}
```

usb_device.h: guard `__USB_DEVICE__H__`, includes `stm32f4xx.h`, `stm32f4xx_hal.h`,
`usbd_def.h`; declares `void MX_USB_DEVICE_Init(void);`. (Doxygen `@addtogroup`
scaffolding throughout all four USB app files — static template text.)

### 4.2 `Src/usbd_desc.c` / `Inc/usbd_desc.h`

Parameterized defines block (verbatim shape):

```c
#define USBD_VID     {{USB_DEVICE.VID-CDC_FS}}
#define USBD_LANGID_STRING     1033
#define USBD_MANUFACTURER_STRING     "{{USB_DEVICE.MANUFACTURER_STRING-CDC_FS}}"
#define USBD_PID_FS     {{USB_DEVICE.PID_CDC_FS}}
#define USBD_PRODUCT_STRING_FS     "{{USB_DEVICE.PRODUCT_STRING_CDC_FS}}"
#define USBD_CONFIGURATION_STRING_FS     "CDC Config"
#define USBD_INTERFACE_STRING_FS     "CDC Interface"

#define USB_SIZ_BOS_DESC            0x0C
```

`"CDC Config"` / `"CDC Interface"` are derived from the class name, not separate ioc keys.

**Serial number:** the ioc `SERIALNUMBER_STRING_CDC_FS` value is *ignored by codegen*.
`USBD_FS_SerialStrDescriptor` fills the static `USBD_StringSerial[USB_SIZ_STRING_SERIAL]`
(0x1A bytes, first two = length + `USB_DESC_TYPE_STRING`) via `Get_SerialNum()`, which
reads the 96-bit UID (`DEVICE_ID1/2/3` = `UID_BASE + 0/4/8`, defined in usbd_desc.h),
computes `deviceserial0 += deviceserial2;` and renders `IntToUnicode(deviceserial0, &USBD_StringSerial[2], 8)`
+ `IntToUnicode(deviceserial1, &USBD_StringSerial[18], 4)` — i.e. a 12-hex-digit UTF-16
string. There is a `USER CODE USBD_FS_SerialStrDescriptor` section inside the function.

Fixed content (static template): `USBD_DescriptorsTypeDef FS_Desc = { USBD_FS_DeviceDescriptor,
USBD_FS_LangIDStrDescriptor, USBD_FS_ManufacturerStrDescriptor, USBD_FS_ProductStrDescriptor,
USBD_FS_SerialStrDescriptor, USBD_FS_ConfigStrDescriptor, USBD_FS_InterfaceStrDescriptor
[, USBD_FS_USR_BOSDescriptor iff USBD_LPM_ENABLED==1] };`
18-byte `USBD_FS_DeviceDesc` (bcdUSB 2.00/2.01 per LPM, class 0x02/0x02/0x00 = CDC,
`LOBYTE/HIBYTE(USBD_VID/USBD_PID_FS)`, bcdDevice 2.00, string indices, 1 configuration);
`USBD_LangIDDesc` from `USBD_LANGID_STRING`; shared `USBD_StrDesc[USBD_MAX_STR_DESC_SIZ]`
scratch buffer filled by `USBD_GetString`; each string-descriptor getter is a trivial
`USBD_GetString((uint8_t *)USBD_X_STRING..., USBD_StrDesc, length); return USBD_StrDesc;`
(Product/Config/Interface have a vestigial `if(speed…) else` with identical branches).
usbd_desc.h: guard `__USBD_DESC__C__` (sic), `DEVICE_ID1/2/3`, `USB_SIZ_STRING_SERIAL 0x1A`,
`extern USBD_DescriptorsTypeDef FS_Desc;`.

### 4.3 `Src/usbd_conf.c` / `Inc/usbd_conf.h`

usbd_conf.c top: includes `stm32f4xx.h, stm32f4xx_hal.h, usbd_def.h, usbd_core.h,
usbd_cdc.h`; then

```c
PCD_HandleTypeDef hpcd_USB_OTG_FS;
void Error_Handler(void);

/* External functions --------------------------------------------------------*/
void SystemClock_Config(void);
...
/* USER CODE BEGIN PFP */
USBD_StatusTypeDef USBD_Get_USB_Status(HAL_StatusTypeDef hal_status);
/* USER CODE END PFP */
```

(the `USBD_Get_USB_Status` prototype ships inside a USER CODE block — reproduce as-is).

`HAL_PCD_MspInit` / `HAL_PCD_MspDeInit` (verbatim; priorities from `NVIC.OTG_FS_IRQn`):

```c
void HAL_PCD_MspInit(PCD_HandleTypeDef* pcdHandle)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  if(pcdHandle->Instance==USB_OTG_FS)
  {
  /* USER CODE BEGIN USB_OTG_FS_MspInit 0 */

  /* USER CODE END USB_OTG_FS_MspInit 0 */

    __HAL_RCC_GPIOA_CLK_ENABLE();
    /**USB_OTG_FS GPIO Configuration
    PA11     ------> USB_OTG_FS_DM
    PA12     ------> USB_OTG_FS_DP
    */
    GPIO_InitStruct.Pin = GPIO_PIN_11|GPIO_PIN_12;
    GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    GPIO_InitStruct.Alternate = GPIO_AF10_OTG_FS;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

    /* Peripheral clock enable */
    __HAL_RCC_USB_OTG_FS_CLK_ENABLE();

    /* Peripheral interrupt init */
    HAL_NVIC_SetPriority(OTG_FS_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(OTG_FS_IRQn);
  /* USER CODE BEGIN USB_OTG_FS_MspInit 1 */

  /* USER CODE END USB_OTG_FS_MspInit 1 */
  }
}

void HAL_PCD_MspDeInit(PCD_HandleTypeDef* pcdHandle)
{
  if(pcdHandle->Instance==USB_OTG_FS)
  {
    /* USER CODE ...MspDeInit 0 ... */
    __HAL_RCC_USB_OTG_FS_CLK_DISABLE();
    HAL_GPIO_DeInit(GPIOA, GPIO_PIN_11|GPIO_PIN_12);
    HAL_NVIC_DisableIRQ(OTG_FS_IRQn);
    /* USER CODE ...MspDeInit 1 ... */
  }
}
```

PCD→USBD callback glue (each wrapped in
`#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U) static void PCD_XxxCallback #else void HAL_PCD_XxxCallback #endif`):

| Callback | Body (one-liner unless noted) |
|---|---|
| SetupStage | `USBD_LL_SetupStage((USBD_HandleTypeDef*)hpcd->pData, (uint8_t *)hpcd->Setup);` |
| DataOutStage | `USBD_LL_DataOutStage(..., epnum, hpcd->OUT_ep[epnum].xfer_buff);` |
| DataInStage | `USBD_LL_DataInStage(..., epnum, hpcd->IN_ep[epnum].xfer_buff);` |
| SOF | `USBD_LL_SOF(...)` |
| Reset | map `hpcd->Init.speed` → `USBD_SPEED_HIGH/FULL` (else `Error_Handler()`), `USBD_LL_SetSpeed`, `USBD_LL_Reset` |
| Suspend | `USBD_LL_Suspend`, `__HAL_PCD_GATE_PHYCLOCK(hpcd)`, then inside `USER CODE 2`: `if (hpcd->Init.low_power_enable) { SCB->SCR |= SLEEPDEEP|SLEEPONEXIT; }` |
| Resume | `USER CODE 3` (empty) then `USBD_LL_Resume` |
| ISOOUTIncomplete / ISOINIncomplete | `USBD_LL_IsoOUTIncomplete/IsoINIncomplete(..., epnum)` |
| Connect / Disconnect | `USBD_LL_DevConnected/DevDisconnected(...)` |

`USBD_LL_Init` — the only parameterized LL function (verbatim):

```c
USBD_StatusTypeDef USBD_LL_Init(USBD_HandleTypeDef *pdev)
{
  /* Init USB Ip. */
  if (pdev->id == DEVICE_FS) {
  /* Link the driver to the stack. */
  hpcd_USB_OTG_FS.pData = pdev;
  pdev->pData = &hpcd_USB_OTG_FS;

  hpcd_USB_OTG_FS.Instance = USB_OTG_FS;
  hpcd_USB_OTG_FS.Init.dev_endpoints = 4;
  hpcd_USB_OTG_FS.Init.speed = PCD_SPEED_FULL;
  hpcd_USB_OTG_FS.Init.dma_enable = DISABLE;
  hpcd_USB_OTG_FS.Init.phy_itface = PCD_PHY_EMBEDDED;
  hpcd_USB_OTG_FS.Init.Sof_enable = DISABLE;
  hpcd_USB_OTG_FS.Init.low_power_enable = DISABLE;
  hpcd_USB_OTG_FS.Init.lpm_enable = DISABLE;
  hpcd_USB_OTG_FS.Init.vbus_sensing_enable = {{USB_OTG_FS.vbus_sensing_enable}};   /* DISABLE here */
  hpcd_USB_OTG_FS.Init.use_dedicated_ep1 = DISABLE;
  if (HAL_PCD_Init(&hpcd_USB_OTG_FS) != HAL_OK)
  {
    Error_Handler( );
  }

#if (USE_HAL_PCD_REGISTER_CALLBACKS == 1U)
  /* ... 11 HAL_PCD_Register*Callback calls ... */
#endif /* USE_HAL_PCD_REGISTER_CALLBACKS */
  HAL_PCDEx_SetRxFiFo(&hpcd_USB_OTG_FS, 0x80);
  HAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 0, 0x40);
  HAL_PCDEx_SetTxFiFo(&hpcd_USB_OTG_FS, 1, 0x80);
  }
  return USBD_OK;
}
```

FIFO sizing (words) is fixed for CDC FS: Rx 0x80, Tx EP0 0x40, Tx EP1 0x80.

Remaining `USBD_LL_*` — all fixed boilerplate following one of two patterns.
Pattern A (status-mapped):

```c
USBD_StatusTypeDef USBD_LL_{{Name}}(USBD_HandleTypeDef *pdev, {{args}})
{
  HAL_StatusTypeDef hal_status = HAL_OK;
  USBD_StatusTypeDef usb_status = USBD_OK;

  hal_status = {{HAL_call}}(pdev->pData, {{args}});

  usb_status =  USBD_Get_USB_Status(hal_status);

  return usb_status;
}
```

| LL function | HAL call |
|---|---|
| `USBD_LL_DeInit` | `HAL_PCD_DeInit` |
| `USBD_LL_Start` / `USBD_LL_Stop` | `HAL_PCD_Start` / `HAL_PCD_Stop` |
| `USBD_LL_OpenEP(pdev, ep_addr, ep_type, ep_mps)` | `HAL_PCD_EP_Open(pdev->pData, ep_addr, ep_mps, ep_type)` (note arg swap) |
| `USBD_LL_CloseEP` / `USBD_LL_FlushEP` | `HAL_PCD_EP_Close` / `HAL_PCD_EP_Flush` |
| `USBD_LL_StallEP` / `USBD_LL_ClearStallEP` | `HAL_PCD_EP_SetStall` / `HAL_PCD_EP_ClrStall` |
| `USBD_LL_SetUSBAddress` | `HAL_PCD_SetAddress` |
| `USBD_LL_Transmit(…,pbuf,size)` | `HAL_PCD_EP_Transmit` |
| `USBD_LL_PrepareReceive(…,pbuf,size)` | `HAL_PCD_EP_Receive` |

Pattern B (direct): `USBD_LL_IsStallEP` (reads `hpcd->IN_ep/OUT_ep[..].is_stall`),
`USBD_LL_GetRxDataSize` → `HAL_PCD_EP_GetRxCount`,
`USBD_LL_SetTestMode` (inside `#ifdef USBD_HS_TESTMODE_ENABLE`, returns `USBD_OK`),
`USBD_static_malloc` (`static uint32_t mem[(sizeof(USBD_CDC_HandleTypeDef)/4)+1]; return mem;`),
`USBD_static_free` (empty), `USBD_LL_Delay` → `HAL_Delay`,
`USBD_Get_USB_Status` (switch HAL_OK→USBD_OK, HAL_ERROR/HAL_TIMEOUT/default→USBD_FAIL,
HAL_BUSY→USBD_BUSY).

usbd_conf.h (guard `__USBD_CONF__H__`): includes `<stdio.h> <stdlib.h> <string.h>
"main.h" "stm32f4xx.h" "stm32f4xx_hal.h"`; defines
`USBD_MAX_NUM_INTERFACES 1U`, `USBD_MAX_NUM_CONFIGURATION 1U`, `USBD_MAX_STR_DESC_SIZ 512U`,
`USBD_DEBUG_LEVEL 0U`, `USBD_LPM_ENABLED 0U`, `USBD_SELF_POWERED 1U`,
`DEVICE_FS 0` / `DEVICE_HS 1`; aliases `USBD_malloc (void *)USBD_static_malloc`,
`USBD_free USBD_static_free`, `USBD_memset memset`, `USBD_memcpy memcpy`,
`USBD_Delay HAL_Delay`; the three `USBD_UsrLog/ErrLog/DbgLog` printf-macro tiers gated
on `USBD_DEBUG_LEVEL`; prototypes for `USBD_static_malloc/free`.

### 4.4 `Src/usbd_cdc_if.c` / `Inc/usbd_cdc_if.h`

usbd_cdc_if.h: guard `__USBD_CDC_IF_H__`, includes `usbd_cdc.h`, ioc-driven buffer sizes

```c
/* Define size for the receive and transmit buffer over CDC */
#define APP_RX_DATA_SIZE  {{USB_DEVICE.APP_RX_DATA_SIZE-CDC_FS}}
#define APP_TX_DATA_SIZE  {{USB_DEVICE.APP_TX_DATA_SIZE-CDC_FS}}
```

`extern USBD_CDC_ItfTypeDef USBD_Interface_fops_FS;` and
`uint8_t CDC_Transmit_FS(uint8_t* Buf, uint16_t Len);`.

usbd_cdc_if.c essentials:

```c
uint8_t UserRxBufferFS[APP_RX_DATA_SIZE];
uint8_t UserTxBufferFS[APP_TX_DATA_SIZE];

extern USBD_HandleTypeDef hUsbDeviceFS;

static int8_t CDC_Init_FS(void);
static int8_t CDC_DeInit_FS(void);
static int8_t CDC_Control_FS(uint8_t cmd, uint8_t* pbuf, uint16_t length);
static int8_t CDC_Receive_FS(uint8_t* pbuf, uint32_t *Len);
static int8_t CDC_TransmitCplt_FS(uint8_t *pbuf, uint32_t *Len, uint8_t epnum);

USBD_CDC_ItfTypeDef USBD_Interface_fops_FS =
{
  CDC_Init_FS,
  CDC_DeInit_FS,
  CDC_Control_FS,
  CDC_Receive_FS,
  CDC_TransmitCplt_FS
};
```

Default bodies (each inside a numbered USER CODE section — 3,4,5,6,7,13 respectively):
* `CDC_Init_FS`: `USBD_CDC_SetTxBuffer(&hUsbDeviceFS, UserTxBufferFS, 0); USBD_CDC_SetRxBuffer(&hUsbDeviceFS, UserRxBufferFS); return (USBD_OK);`
* `CDC_DeInit_FS`: `return (USBD_OK);`
* `CDC_Control_FS`: empty `switch(cmd)` over the 10 `CDC_*` request codes (incl. the
  big line-coding ASCII table comment before `CDC_SET_LINE_CODING`), `return (USBD_OK);`
* `CDC_Receive_FS`: `USBD_CDC_SetRxBuffer(&hUsbDeviceFS, &Buf[0]); USBD_CDC_ReceivePacket(&hUsbDeviceFS); return (USBD_OK);`
* `CDC_Transmit_FS` (public): busy-check on `hcdc->TxState`, `USBD_CDC_SetTxBuffer`,
  `result = USBD_CDC_TransmitPacket(&hUsbDeviceFS);`
* `CDC_TransmitCplt_FS`: `UNUSED(Buf); UNUSED(Len); UNUSED(epnum); return result;`

### 4.5 Init call site + IRQ + config deltas

* **`MX_USB_DEVICE_Init()` is NOT called from `main()`.** With FreeRTOS enabled it is
  emitted as the first statement of `StartDefaultTask` in `freertos.c` (outside USER
  CODE), with `extern void MX_USB_DEVICE_Init(void);` at file scope (§2.2).
  `main.c` still includes `usb_device.h`.
* it.c gains `OTG_FS_IRQHandler` → `HAL_PCD_IRQHandler(&hpcd_USB_OTG_FS)` and the
  `extern PCD_HandleTypeDef hpcd_USB_OTG_FS;` (first extern in the block).
* `stm32f4xx_hal_conf.h`: `#define HAL_PCD_MODULE_ENABLED`;
  `#define USE_HAL_PCD_REGISTER_CALLBACKS 0U` (from `ProjectManager.RegisterCallBack` empty).
* **No `USE_USB_FS` compile definition** is added by the CMake flow (`MX_Defines_Syms`
  is only `USE_HAL_DRIVER; STM32F405xx; $<$<CONFIG:Debug>:DEBUG>`). (Older Makefile
  flows added `-DUSE_USB_FS`; the CMake generator does not.)

### 4.6 CMake additions for USB

Include dirs: `Middlewares/ST/STM32_USB_Device_Library/Core/Inc`,
`.../Class/CDC/Inc`. New OBJECT library `USB_Device_Library` (in `MX_LINK_LIBS`):

```
Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_core.c
Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ctlreq.c
Middlewares/ST/STM32_USB_Device_Library/Core/Src/usbd_ioreq.c
Middlewares/ST/STM32_USB_Device_Library/Class/CDC/Src/usbd_cdc.c
```

App sources add `usb_device.c, usbd_conf.c, usbd_desc.c, usbd_cdc_if.c`.
`STM32_Drivers_Src` gains `stm32f4xx_hal_pcd.c`, `stm32f4xx_hal_pcd_ex.c`,
`stm32f4xx_ll_usb.c`. Copied library payload: `Middlewares/ST/STM32_USB_Device_Library/`
`Core/{Inc,Src}` (usbd_core/ctlreq/ioreq/def/conf-template-less) + `Class/CDC/{Inc,Src}`
(usbd_cdc.[ch]) + `LICENSE.txt`.

---

## 5. `syscalls.c` / `sysmem.c` / CMakePresets.json

* `Src/syscalls.c` — **static CubeMX template, copy verbatim** (header: "Auto-generated
  by STM32CubeMX", "Minimal System calls file", (c) 2020-2025 STMicroelectronics; no
  USER CODE sections; no project-specific content). Provides newlib syscall stubs:
  `initialise_monitor_handles`, `_getpid`, `_kill`, `_exit`, weak `_read`/`_write`
  (looping on weak `__io_getchar`/`__io_putchar`), `_close`, `_fstat`, `_isatty`,
  `_lseek`, `_open`, `_wait`, `_unlink`, `_times`, `_stat`, `_link`, `_fork`, `_execve`,
  plus `char **environ`. Role: satisfies newlib-nano link (`--specs=nano.specs`) so
  printf/exit don't drag in semihosting.
* `Src/sysmem.c` — **static CubeMX template, copy verbatim** ((c) 2025 ST). Implements
  `_sbrk(ptrdiff_t)` growing from linker symbol `_end` up to `_estack - _Min_Stack_Size`,
  `errno = ENOMEM` on overflow; picolibc `__strong_reference(_sbrk, sbrk)` alias.
  Role: newlib heap for `malloc` (independent of FreeRTOS heap_4). Both files are listed
  in `MX_Application_Src` (sysmem before syscalls).
* `CMakePresets.json` — static template, project-independent (version 3; hidden
  `default` configure preset: generator `Ninja`, `binaryDir ${sourceDir}/build/${presetName}`,
  `toolchainFile ${sourceDir}/cmake/gcc-arm-none-eabi.cmake`, empty cacheVariables;
  `Debug`/`Release` configure presets inheriting `default` and setting
  `CMAKE_BUILD_TYPE`; matching `buildPresets` pair referencing the configure presets).
* `cmake/gcc-arm-none-eabi.cmake` — static except two lines: `TARGET_FLAGS`
  (`-mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard` — from MCU core/FPU) and the
  linker-script name (`-T "${CMAKE_SOURCE_DIR}/STM32F405XX_FLASH.ld"`). Also fixed:
  `--specs=nano.specs`, `-Wl,--gc-sections -Wl,--print-memory-usage`, map file,
  Debug `-O0 -g3` / Release `-Os -g0`, `TOOLCHAIN_LINK_LIBRARIES "m"`.
* Root `CMakeLists.txt` — generated **once** (comment says "not re-generated"): C11,
  project name = `ProjectManager.ProjectName`, `add_subdirectory(cmake/stm32cubemx)`,
  empty user hooks, `list(REMOVE_ITEM CMAKE_C_IMPLICIT_LINK_LIBRARIES ob)`,
  links `stm32cubemx` (the interface lib) — note the app links the *interface* lib plus
  `MX_LINK_LIBS` (STM32_Drivers, USB_Device_Library, FreeRTOS OBJECT libs) via
  `cmake/stm32cubemx/CMakeLists.txt`.

---

## 6. Final checklist: file → template class → params consumed

Template classes: **S** = static template (byte-identical for any project of this
family/toolchain), **P** = parameterized template (`{{param}}` substitution), **L** =
copied library (from STM32Cube FW pack `ProjectManager.FirmwarePackage`).

| File | Class | Params consumed |
|---|---|---|
| `Src/main.c` | P | functionlistsort (order+call set), RCC.\* (SystemClock_Config), NVIC.TimeBaseIP (callback), FreeRTOS on/off (cmsis_os include, MX_FREERTOS_Init/osKernelStart), coupled-header list |
| `Inc/main.h` | P | Mcu.UserConstants, `PXn.GPIO_Label` pin defines, family header |
| `Src/gpio.c` / `Inc/gpio.h` | P | `PXn.Signal=GPIO_*`, `GPIO_PuPd/PinState/Label/ModeDefaultOutputPP` |
| `Src/dma.c` / `Inc/dma.h` | P | `Dma.RequestN`, `Dma.<REQ>.<n>.Instance`, `NVIC.DMAx_StreamY_IRQn` (prio + enable) |
| `Src/adc.c|can.c|spi.c|tim.c|usart.c` + headers | P | `<INSTANCE>.*` IPParameters, `Dma.<REQ>.*`, `NVIC.*` prios, pin AF tables, `SH.*` shared-signal mapping |
| `Src/stm32f4xx_hal_msp.c` | P | `NVIC.PendSV_IRQn` prio (FreeRTOS), family clock macros |
| `Src/stm32f4xx_it.c` / `Inc/stm32f4xx_it.h` | P | `NVIC.*` field 6 (handler gen), handle→IRQ map, FreeRTOS (removes SVC/PendSV/SysTick), TimeBase (shared TIM handler, htim14 extern), USB (OTG_FS) |
| `Inc/stm32f4xx_hal_conf.h` | P | enabled `HAL_x_MODULE_ENABLED` set, `HSE_VALUE` (RCC.HSE_VALUE), `TICK_INT_PRIORITY` (0U iff TIM timebase), `USE_HAL_PCD_REGISTER_CALLBACKS` (RegisterCallBack) |
| `Inc/FreeRTOSConfig.h` | P | `FREERTOS.config*`, `FREERTOS.INCLUDE_*`; SysTick-alias comment state from `NVIC.TimeBase` |
| `Src/freertos.c` | P | `FREERTOS.Tasks01` (+TasksNN), configUSE_IDLE_HOOK / configCHECK_FOR_STACK_OVERFLOW (hook stubs), configSUPPORT_STATIC_ALLOCATION (idle-task memory), USB-init-deferral |
| `Src/stm32f4xx_hal_timebase_tim.c` | P | `NVIC.TimeBaseIP` (TIM14), `NVIC.TimeBase` (IRQn), timer's APB bus |
| `Src/usb_device.c` / `Inc/usb_device.h` | S (given CDC FS) | class name only (`USBD_CDC`, `USBD_Interface_fops_FS`) |
| `Src/usbd_desc.c` / `Inc/usbd_desc.h` | P | `USB_DEVICE.VID/PID/MANUFACTURER/PRODUCT` (serial string ioc key ignored — UID-derived) |
| `Src/usbd_conf.c` / `Inc/usbd_conf.h` | P | `USB_OTG_FS.vbus_sensing_enable`, `NVIC.OTG_FS_IRQn` prio, pins PA11/PA12, `USE_HAL_PCD_REGISTER_CALLBACKS` |
| `Src/usbd_cdc_if.c` / `Inc/usbd_cdc_if.h` | P | `USB_DEVICE.APP_RX_DATA_SIZE-CDC_FS`, `APP_TX_DATA_SIZE-CDC_FS` |
| `Src/syscalls.c`, `Src/sysmem.c` | S | none |
| `Src/system_stm32f4xx.c`, `startup_stm32f405xx.s`, `STM32F405XX_FLASH.ld` | L / P | CMSIS device template; linker script: RAM/CCMRAM/FLASH sizes + `_Min_Heap_Size`(`ProjectManager.HeapSize`)/`_Min_Stack_Size`(`.StackSize`) |
| `Drivers/STM32F4xx_HAL_Driver/**`, `Drivers/CMSIS/**` | L | module set from hal_conf |
| `Middlewares/Third_Party/FreeRTOS/Source/**` | L | port `GCC/ARM_CM4F`, heap scheme `heap_4` |
| `Middlewares/ST/STM32_USB_Device_Library/{Core,Class/CDC}/**` | L | class = CDC |
| `CMakeLists.txt` (root) | P (once) | project name |
| `cmake/stm32cubemx/CMakeLists.txt` | P | full source/include/define lists (§2.6, §4.6, §6 app list) |
| `cmake/gcc-arm-none-eabi.cmake` | P | cpu/fpu flags, linker-script filename |
| `CMakePresets.json` | S | none |
| `.mxproject`, `odrive_cubemx_demo.ioc` | — | CubeMX bookkeeping (regen input), not build inputs |

`MX_Application_Src` exact order for reference: `main.c, gpio.c, freertos.c, adc.c,
can.c, dma.c, spi.c, tim.c, usart.c, usb_device.c, usbd_conf.c, usbd_desc.c,
usbd_cdc_if.c, stm32f4xx_it.c, stm32f4xx_hal_msp.c, stm32f4xx_hal_timebase_tim.c,
sysmem.c, syscalls.c, startup_stm32f405xx.s`.
